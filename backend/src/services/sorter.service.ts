import { getClient, query } from '../config/database';
import { config } from '../config/env';
import { AppError } from '../utils/appError';
import { logger } from '../utils/logger';
import { listDefectsForOrder, DefectRecord } from './defect.service';
import { createJobForOrder, dispatchJob } from './dispatch.service';
import {
  listAdjustmentsForOrder,
  listNotificationsForOrder,
  AdjustmentRecord,
  NotificationRecord,
} from './defectAdjustment.service';

/* ===================================================================
 * WHAT THE SORTER IS NOT SHOWN
 * ===================================================================
 *
 * NO PRICE REACHES THIS MODULE'S CALLERS. Not the unit price, not the line
 * amount, not the order total, not the invoice or payment position.
 *
 * The shop floor's job is pieces: how many arrived, how many are damaged, how
 * many are finished. What those pieces are worth is a billing question, and
 * the Sorter has no decision that depends on the answer — the backend does
 * every calculation itself, from the order's own snapshot, and ignores
 * anything a client sends about price.
 *
 * THIS IS ENFORCED IN THE PAYLOAD, NOT IN THE UI. Hiding a field in React
 * leaves it in the JSON for anyone who opens the network tab; the fields are
 * therefore never selected, never mapped and never returned. `SorterOrderItem`
 * and `SorterAdjustmentRecord` below are the whole of what a Sorter session
 * can learn about an order's money, which is nothing.
 */

/**
 * A defective adjustment, as the Sorter is allowed to see it.
 *
 * The same audit row `defectAdjustment.service` records, with every financial
 * field dropped: `unit_price`, `original_amount` and `adjusted_amount` stay in
 * the database and on the billing side, and simply do not travel here.
 */
export interface SorterAdjustmentRecord {
  id: string;
  order_id: string;
  order_item_id: string;
  item_name: string;
  original_quantity: number;
  previous_defective_quantity: number;
  defective_quantity: number;
  final_quantity: number;
  reason: string | null;
  adjusted_by: string | null;
  adjusted_by_name: string | null;
  adjusted_at: Date;
}

/** Drops the money from an adjustment before it leaves for a Sorter client. */
function toSorterAdjustment(a: AdjustmentRecord): SorterAdjustmentRecord {
  return {
    id: a.id,
    order_id: a.order_id,
    order_item_id: a.order_item_id,
    item_name: a.item_name,
    original_quantity: a.original_quantity,
    previous_defective_quantity: a.previous_defective_quantity,
    defective_quantity: a.defective_quantity,
    final_quantity: a.final_quantity,
    reason: a.reason,
    adjusted_by: a.adjusted_by,
    adjusted_by_name: a.adjusted_by_name,
    adjusted_at: a.adjusted_at,
  };
}

/**
 * Sorter module — the shop-floor view of the order pipeline.
 *
 * The Sorter owns exactly two transitions and nothing else:
 *
 *   ORDER_PLACED (confirmed) -> RECEIVED_AT_FACILITY (accepted)
 *   RECEIVED_AT_FACILITY     -> READY_FOR_DELIVERY   (ready)
 *
 * Those are statuses the orders enum already had, so the workflow reuses the
 * existing pipeline rather than introducing a parallel one. Delivery and
 * completion stay with whoever owned them before — the Sorter cannot reach
 * them.
 */

/** The workflow, in the vocabulary the Sorter UI speaks. */
export const SORTER_STATUS = {
  confirmed: 'ORDER_PLACED',
  accepted: 'RECEIVED_AT_FACILITY',
  ready: 'READY_FOR_DELIVERY',
  /**
   * Some items went, some are still here.
   *
   * NOT a step the Sorter asks for. It is what `ready` RESOLVES TO when the
   * Sorter answers that items are pending, and it is set by deriving the
   * order's status from its items — never by a client naming it.
   */
  partially_completed: 'PARTIALLY_COMPLETED',
  out_for_delivery: 'OUT_FOR_DELIVERY',
} as const;

export type SorterStage = keyof typeof SORTER_STATUS;

/** Database status -> the stage the Sorter sees. */
const STAGE_OF: Record<string, SorterStage> = {
  ORDER_PLACED: 'confirmed',
  RECEIVED_AT_FACILITY: 'accepted',
  READY_FOR_DELIVERY: 'ready',
  PARTIALLY_COMPLETED: 'partially_completed',
  OUT_FOR_DELIVERY: 'out_for_delivery',
};

/**
 * The only moves the Sorter may make. Anything not listed here — skipping a
 * stage, going backwards, or touching delivery — is rejected.
 *
 * `partially_completed` moves on exactly as `ready` does: its READY items are
 * free to leave with the next dispatch, and holding them because a different
 * item needs more time is the thing this whole feature exists to prevent.
 * Nobody may TARGET it — see `updateStatus` — because whether an order is
 * partially completed is decided by its items, not by a request.
 */
const ALLOWED_TRANSITIONS: Record<SorterStage, SorterStage[]> = {
  confirmed: ['accepted'],
  accepted: ['ready'],
  ready: ['out_for_delivery'],
  partially_completed: ['out_for_delivery'],
  out_for_delivery: [],
};

/**
 * The stages a Sorter may ASK for. `partially_completed` is absent: it is an
 * outcome of answering the pending-items question, never a request.
 */
const REQUESTABLE_STAGES: SorterStage[] = ['accepted', 'ready', 'out_for_delivery'];

/* ===================================================================
 * ITEM STATUS
 * =================================================================== */

/**
 * Where one line of an order stands, independently of the others.
 *
 *   PROCESSING  with Swachham, being worked on. Every line starts here.
 *   READY       finished; free to leave with the order's next dispatch.
 *   PENDING     deliberately held back — it needs more time while the rest
 *               of the order goes out.
 *
 * PENDING IS NOT DEFECTIVE, and the two never interact. A defective piece is
 * a QUANTITY on the line (`defective_quantity`) that changes what is billed;
 * holding an item back changes nothing about price, quantity, invoice or
 * payment, and nothing in this file writes any of them.
 */
export const ITEM_STATUSES = [
  'PROCESSING',
  'READY',
  'PARTIALLY_PENDING',
  'PENDING',
] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

/**
 * A line's status, DERIVED from how many of its pieces are being held.
 *
 * The status is never chosen; it is what the numbers already say. Deriving it
 * is what stops a line claiming to be fully pending while three of its five
 * pieces are on a van.
 *
 *   held === 0        READY      every piece goes
 *   held === ordered  PENDING    nothing goes
 *   otherwise         PARTIALLY_PENDING
 */
function deriveItemStatus(orderedQuantity: number, pendingQuantity: number): ItemStatus {
  if (pendingQuantity <= 0) return 'READY';
  if (pendingQuantity >= orderedQuantity) return 'PENDING';
  return 'PARTIALLY_PENDING';
}

/**
 * How many pieces of a line go out with the next dispatch.
 *
 * `ordered - pending`, and never anything a client sent. This is the one
 * definition; nothing stores a copy of it, so no stored figure can drift from
 * the two it is derived from.
 */
function deliveryQuantityOf(orderedQuantity: number, pendingQuantity: number): number {
  return Math.max(0, orderedQuantity - pendingQuantity);
}

/**
 * The order's status, DERIVED from its items.
 *
 * This is the whole of the partial-completion rule, in one place, so the
 * answer cannot differ between the code that holds items back and the code
 * that releases them later:
 *
 *   nothing ready, something pending   the order is not ready. It stays where
 *                                      it is — an order with no finished item
 *                                      is simply still being worked on, which
 *                                      is what RECEIVED_AT_FACILITY already
 *                                      says.
 *   something ready AND something
 *   pending                            PARTIALLY_COMPLETED.
 *   nothing pending                    READY_FOR_DELIVERY.
 *
 * `current` is returned unchanged whenever the order has already moved past
 * the facility, so releasing the last pending item on an order that is
 * OUT_FOR_DELIVERY cannot drag it backwards.
 */
function deriveOrderStatus(
  items: Array<{ ordered: number; pending: number }>,
  current: string
): string {
  // Only the Sorter's own stages are ever re-derived. Anything else — a
  // cancelled order, one already dispatched — keeps the status it has.
  if (!['RECEIVED_AT_FACILITY', 'READY_FOR_DELIVERY', 'PARTIALLY_COMPLETED'].includes(current)) {
    return current;
  }
  if (items.length === 0) return current;

  /*
   * COUNTED IN PIECES, NOT IN LINES.
   *
   * An order with one line of five, two of them held, has SOMETHING going and
   * SOMETHING staying — so it is partially completed, even though every line
   * it has is "the pending one". Counting lines would call that order fully
   * pending and hold three finished pieces back with it, which is the whole
   * fault this exists to prevent.
   */
  const held = items.reduce((sum, i) => sum + Math.max(0, i.pending), 0);
  const going = items.reduce(
    (sum, i) => sum + deliveryQuantityOf(i.ordered, i.pending), 0
  );

  if (held === 0) return 'READY_FOR_DELIVERY';
  // Nothing at all is leaving: the order is simply not ready, which is what
  // RECEIVED_AT_FACILITY already says.
  if (going === 0) return 'RECEIVED_AT_FACILITY';
  return 'PARTIALLY_COMPLETED';
}

/**
 * Barcode scanning is an OPTIONAL tool, not a gate.
 *
 * Scanning still records which pieces were seen — the scan endpoints and the
 * counts they return are unchanged — but no transition is blocked because a
 * garment was not scanned. The shop floor can always move an order forward.
 */

export interface SorterOrderSummary {
  id: string;
  order_number: string;
  customer_name: string;
  /**
   * The number to CALL about this job. The account's own -- the business
   * contact's, or the customer's -- which is the number the shop floor needs
   * and which stays reachable however the order happened to be placed.
   */
  customer_contact: string | null;
  /**
   * The number this order was PLACED ON -- `orders.placed_by_mobile`.
   *
   * A different question from `customer_contact` and deliberately kept apart
   * from it: this one is what the person proved by OTP for the session that
   * placed the order, and it is what the Order Confirmation PDF prints. NULL
   * for orders placed before the field existed.
   */
  placed_by_mobile: string | null;
  laundry_type: string | null;
  order_type: string | null;
  status: string;
  stage: SorterStage | null;
  item_count: number;
  total_quantity: number;
  total_weight_kg: number;
  has_confirmation_pdf: boolean;
  created_at: Date;
  accepted_at: Date | null;
  ready_at: Date | null;
  /** Defect reporting, summarised for the queue card. */
  defect_count: number;
  latest_defect_whatsapp_status: 'PENDING' | 'SENT' | 'FAILED' | null;
}

export interface SorterOrderDetail extends SorterOrderSummary {
  items: Array<{
    id: string;
    item_name: string;
    laundry_service_name: string | null;
    category_name: string | null;
    /** The BILLABLE quantity: original_quantity - defective_quantity. */
    quantity: number;
    /** The pieces the order was placed for. The PHYSICAL count. */
    original_quantity: number;
    /** Pieces this Sorter (or another) found damaged. 0 until adjusted. */
    defective_quantity: number;
    /**
     * Where this line stands on its own.
     *
     * Derived from the two quantities below, never chosen: READY when nothing
     * is held, PENDING when everything is, PARTIALLY_PENDING in between.
     */
    item_status: ItemStatus;
    /** Pieces being held back for further processing. */
    pending_quantity: number;
    /** ordered - pending. What goes out with the next dispatch. */
    delivery_quantity: number;
    /** Why they are being held, when they are. */
    pending_reason: string | null;
    unit: string;
    weight_kg: number | null;
    total_weight_kg: number;
  }>;
  confirmation_pdf_url: string | null;
  defects: DefectRecord[];
  /**
   * The defective-piece adjustments recorded against this order, newest
   * first, and the WhatsApp notifications sent about them.
   *
   * Read-only here. Writing one is `PATCH .../items/:itemId/defective`, which
   * validates and re-prices inside a transaction.
   */
  adjustments: SorterAdjustmentRecord[];
  adjustment_notifications: NotificationRecord[];
  /** True when any line carries a defective adjustment. */
  has_adjustment: boolean;
  /** True when any piece anywhere on the order is being held back. */
  has_pending_items: boolean;
  /** Pieces held, and pieces going out, across the whole order. */
  pending_quantity: number;
  delivery_quantity: number;
}

/**
 * Only the statuses the Sorter works with are listed here, so the queue can
 * never surface a cancelled or already-delivered order.
 */
const QUEUE_STATUSES = Object.values(SORTER_STATUS);

/**
 * Business identity doubles as the customer for a Business order. Contact
 * details are limited to the ordering contact — no addresses, no email, no
 * account data beyond what the shop floor needs to identify the job.
 */
const ORDER_SELECT = `
  SELECT o.id, o.order_number, o.laundry_type, o.order_type, o.status,
         o.created_at, o.accepted_at, o.ready_at, o.confirmation_pdf_url,
         -- The ESTABLISHMENT name is what a business is known by, and it is
         -- what its documents lead with; the record's own name is the
         -- fallback for the ones that have no separate establishment name.
         COALESCE(NULLIF(TRIM(b.establishment_name), ''), b.name, u.name, 'Customer') AS customer_name,
         COALESCE(bu.mobile_number, u.mobile_number) AS customer_contact,
         o.placed_by_mobile,
         COALESCE(o.total_weight_kg, 0) AS total_weight_kg
    FROM orders o
    LEFT JOIN business_users bu ON bu.id = o.business_user_id
    LEFT JOIN businesses b ON b.id = bu.business_id
    LEFT JOIN users u ON u.id = o.user_id`;

function toSummary(
  row: any,
  counts: { item_count: number; total_quantity: number },
  defects: { count: number; latestWhatsAppStatus: DefectRecord['whatsapp_status'] | null } = {
    count: 0,
    latestWhatsAppStatus: null,
  }
) {
  return {
    id: String(row.id),
    order_number: row.order_number,
    customer_name: row.customer_name,
    customer_contact: row.customer_contact || null,
    placed_by_mobile: row.placed_by_mobile || null,
    laundry_type: row.laundry_type,
    order_type: row.order_type,
    status: row.status,
    stage: STAGE_OF[row.status] || null,
    item_count: counts.item_count,
    total_quantity: counts.total_quantity,
    total_weight_kg: Number(row.total_weight_kg || 0),
    has_confirmation_pdf: Boolean(row.confirmation_pdf_url),
    created_at: row.created_at,
    accepted_at: row.accepted_at,
    ready_at: row.ready_at,
    defect_count: defects.count,
    latest_defect_whatsapp_status: defects.latestWhatsAppStatus,
  };
}

/** YYYY-MM-DD, the only shape the date filter accepts. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The business-day calendar date, as the shop floor reckons it.
 *
 * Derived from BUSINESS_TZ_OFFSET rather than the database server's clock:
 * the DB runs in UTC, so an order placed at 02:00 IST would fall on the
 * previous UTC day and land under the wrong heading near midnight.
 */
async function currentBusinessDate(): Promise<string> {
  const result = await query<{ d: string }>(
    `SELECT DATE_FORMAT(DATE(CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', ?)), '%Y-%m-%d') AS d`,
    [config.BUSINESS_TZ_OFFSET]
  );
  return String(result.rows[0].d);
}

/**
 * The Sorter queue: everything sitting in one of the workflow states, newest
 * first so the most recent job is at the top of the shop floor's list.
 *
 * `date` narrows the result to one calendar day, compared in the business
 * timezone. `today` resolves that date on the server instead of trusting the
 * handset's clock or locale.
 *
 * Either way the filtering happens in SQL, so one day's rows are fetched
 * rather than the whole history.
 *
 * `limit` caps how much comes back; the default is generous enough for a
 * single day but stops an unbounded read.
 */
async function listOrders(
  stage?: string,
  options: { date?: string; today?: boolean; limit?: number } = {}
): Promise<{
  orders: SorterOrderSummary[];
  counts: { confirmed: number; accepted: number; ready: number; active: number };
  business_date: string | null;
}> {
  if (stage !== undefined && !(stage in SORTER_STATUS)) {
    throw new AppError('Unknown stage filter', 400);
  }
  if (options.date !== undefined && !DATE_ONLY.test(options.date)) {
    throw new AppError('date must be in YYYY-MM-DD format', 400);
  }

  const statuses = stage ? [SORTER_STATUS[stage as SorterStage]] : QUEUE_STATUSES;
  const placeholders = statuses.map(() => '?').join(', ');

  // "Today" is resolved here, from the configured business timezone, so the
  // handset's clock and locale never decide which day the shop floor sees.
  const targetDate = options.today ? await currentBusinessDate() : options.date;

  const params: any[] = [...statuses];
  let dateClause = '';
  if (targetDate) {
    // Compared in the business timezone, so an order placed just after
    // midnight IST is not filed under the previous UTC day.
    dateClause = ` AND DATE(CONVERT_TZ(o.created_at, '+00:00', ?)) = ?`;
    params.push(config.BUSINESS_TZ_OFFSET, targetDate);
  }

  const limit = Math.min(Math.max(options.limit ?? 200, 1), 500);

  const result = await query<any>(
    `${ORDER_SELECT}
      WHERE o.status IN (${placeholders})${dateClause}
      ORDER BY o.created_at DESC
      LIMIT ${limit}`,
    params
  );

  const orders: SorterOrderSummary[] = [];
  for (const row of result.rows) {
    const totals = await query<{ item_count: number; total_quantity: number }>(
      `SELECT COUNT(*) AS item_count, COALESCE(SUM(quantity), 0) AS total_quantity
         FROM order_items WHERE order_id = ?`,
      [row.id]
    );
    // Defect summary for the card: how many, and where the newest one's
    // WhatsApp notification got to.
    const defect = await query<any>(
      `SELECT COUNT(*) AS n,
              (SELECT whatsapp_status FROM order_defects
                WHERE order_id = ? ORDER BY id DESC LIMIT 1) AS latest_status
         FROM order_defects WHERE order_id = ?`,
      [row.id, row.id]
    );
    orders.push(
      toSummary(
        row,
        {
          item_count: Number(totals.rows[0]?.item_count || 0),
          total_quantity: Number(totals.rows[0]?.total_quantity || 0),
        },
        {
          count: Number(defect.rows[0]?.n || 0),
          latestWhatsAppStatus: defect.rows[0]?.latest_status || null,
        }
      )
    );
  }

  // One pass for the dashboard cards, so the UI never counts client-side.
  const countResult = await query<{ status: string; n: number }>(
    `SELECT status, COUNT(*) AS n FROM orders
      WHERE status IN (${QUEUE_STATUSES.map(() => '?').join(', ')})
      GROUP BY status`,
    QUEUE_STATUSES
  );
  const byStatus = new Map(countResult.rows.map((r) => [r.status, Number(r.n)]));
  const counts = {
    confirmed: byStatus.get(SORTER_STATUS.confirmed) || 0,
    accepted: byStatus.get(SORTER_STATUS.accepted) || 0,
    ready: byStatus.get(SORTER_STATUS.ready) || 0,
    active: 0,
  };
  counts.active = counts.confirmed + counts.accepted + counts.ready;

  return { orders, counts, business_date: targetDate ?? null };
}

async function getOrderById(orderId: string): Promise<SorterOrderDetail> {
  const result = await query<any>(`${ORDER_SELECT} WHERE o.id = ?`, [orderId]);
  const row = result.rows[0];
  if (!row) {
    throw new AppError('Order not found', 404);
  }

  // Per-line service, resolved the same way the Business order detail does it:
  // the order's own service when it has one, else the item's single supported
  // service. Never guessed at beyond that.
  const itemsResult = await query<any>(
    // No price column is selected. See the note above SorterAdjustmentRecord.
    `SELECT oi.id, oi.service_name AS item_name, oi.unit,
            oi.quantity,
            COALESCE(oi.original_quantity, oi.quantity) AS original_quantity,
            COALESCE(oi.defective_quantity, 0) AS defective_quantity,
            COALESCE(oi.item_status, 'PROCESSING') AS item_status,
            COALESCE(oi.pending_quantity, 0) AS pending_quantity,
            oi.pending_reason,
            oi.weight_kg, COALESCE(oi.total_weight_kg, 0) AS total_weight_kg,
            c.name AS category_name,
            COALESCE(
              (SELECT st.name FROM services st WHERE st.id = o.service_id),
              (SELECT MIN(st.name)
                 FROM item_service_types m
                 JOIN services st ON st.id = m.service_id
                WHERE m.item_id = oi.service_id
                  AND st.kind = 'SERVICE_TYPE' AND st.is_active = true
               HAVING COUNT(*) = 1)
            ) AS laundry_service_name
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       LEFT JOIN service_categories c ON c.id = oi.category_id
      WHERE oi.order_id = ?
      ORDER BY oi.id ASC`,
    [orderId]
  );

  const items = itemsResult.rows.map((item) => {
    const ordered = Number(item.original_quantity);
    const held = Number(item.pending_quantity || 0);
    return {
      id: String(item.id),
      item_name: item.item_name,
      laundry_service_name: item.laundry_service_name || null,
      category_name: item.category_name || null,
      quantity: Number(item.quantity),
      original_quantity: ordered,
      defective_quantity: Number(item.defective_quantity || 0),
      item_status: String(item.item_status) as ItemStatus,
      pending_quantity: held,
      // Computed, never read from a column: there is one definition of it.
      delivery_quantity: deliveryQuantityOf(ordered, held),
      pending_reason: item.pending_reason || null,
      unit: item.unit,
      weight_kg: item.weight_kg === null ? null : Number(item.weight_kg),
      total_weight_kg: Number(item.total_weight_kg || 0),
    };
  });

  const [defects, adjustments, adjustmentNotifications] = await Promise.all([
    listDefectsForOrder(orderId),
    listAdjustmentsForOrder(orderId),
    listNotificationsForOrder(orderId),
  ]);

  return {
    ...toSummary(
      row,
      {
        item_count: items.length,
        total_quantity: items.reduce((sum, item) => sum + item.quantity, 0),
      },
      {
        count: defects.length,
        latestWhatsAppStatus: defects[0]?.whatsapp_status ?? null,
      }
    ),
    items,
    confirmation_pdf_url: row.confirmation_pdf_url || null,
    defects,
    // Stripped of every financial field before it leaves. See the note above
    // SorterAdjustmentRecord.
    adjustments: adjustments.map(toSorterAdjustment),
    adjustment_notifications: adjustmentNotifications,
    has_adjustment: items.some((item) => item.defective_quantity > 0),
    has_pending_items: items.some((item) => item.pending_quantity > 0),
    pending_quantity: items.reduce((sum, item) => sum + item.pending_quantity, 0),
    delivery_quantity: items.reduce((sum, item) => sum + item.delivery_quantity, 0),
  };
}

/**
 * Moves an order one step along the Sorter's part of the pipeline.
 *
 * The row is locked and re-read inside the transaction, so two Sorters tapping
 * Accept at the same moment cannot both succeed — the second sees the new
 * status and is rejected.
 */
async function updateStatus(
  orderId: string,
  targetStage: string,
  sorterUserId: string,
  /**
   * The answer to the pending-items question, asked when the order is marked
   * ready.
   *
   *   undefined   the question was not asked (any stage but `ready`), and no
   *               quantity is touched. This is what every existing caller
   *               passes, so the existing workflow is untouched.
   *   { items: [] }
   *               "No" — nothing is held, every line goes out in full, and
   *               the order goes to READY_FOR_DELIVERY exactly as before.
   *   { items: [{ orderItemId, pendingQuantity }] }
   *               "Yes" — that many PIECES of that line stay, and every other
   *               piece of every line goes out.
   *
   * A LINE NOT MENTIONED HOLDS NOTHING. Saying "two bedsheets are pending"
   * says nothing about the towels, so the towels go — all of them. That is
   * the rule the previous whole-item version got wrong.
   */
  pending?: { items: Array<{ orderItemId: string; pendingQuantity: unknown }>; reason?: string | null }
): Promise<{
  id: string;
  order_number: string;
  status: string;
  stage: SorterStage;
  /** Pieces held back by this step, and pieces going out. */
  pending_quantity: number;
  delivery_quantity: number;
  /** Per line, so the app can show the split it just saved. */
  items: Array<{
    id: string;
    item_name: string;
    ordered_quantity: number;
    pending_quantity: number;
    delivery_quantity: number;
    item_status: ItemStatus;
  }>;
}> {
  if (!(targetStage in SORTER_STATUS)) {
    throw new AppError(
      `Unsupported status. The Sorter can set: ${Object.keys(ALLOWED_TRANSITIONS)
        .filter((s) => ALLOWED_TRANSITIONS[s as SorterStage].length)
        .map((s) => ALLOWED_TRANSITIONS[s as SorterStage])
        .flat()
        .join(', ')}`,
      400
    );
  }
  const target = targetStage as SorterStage;
  /*
   * PARTIALLY_COMPLETED CANNOT BE ASKED FOR. Whether an order is partially
   * completed is decided by its items, in `deriveOrderStatus`, so accepting
   * it as a target would let a request assert a state its items contradict.
   */
  if (!REQUESTABLE_STAGES.includes(target)) {
    throw new AppError(
      'An order becomes partially completed by having pending items, not by being set to it.',
      400
    );
  }

  const connection = await getClient();
  try {
    await connection.beginTransaction();

    const [rows]: any = await connection.execute(
      `SELECT id, order_number, status FROM orders WHERE id = ? FOR UPDATE`,
      [orderId]
    );
    const order = rows[0];
    if (!order) {
      throw new AppError('Order not found', 404);
    }

    const currentStage = STAGE_OF[order.status];
    if (!currentStage) {
      throw new AppError(
        `This order is at "${order.status}" and is not part of the Sorter workflow`,
        409
      );
    }
    if (!ALLOWED_TRANSITIONS[currentStage].includes(target)) {
      throw new AppError(
        `Cannot move an order from "${currentStage}" to "${target}". ` +
          (ALLOWED_TRANSITIONS[currentStage].length
            ? `Allowed next step: ${ALLOWED_TRANSITIONS[currentStage].join(', ')}.`
            : 'This order has left the Sorter workflow.'),
        409
      );
    }

    /*
     * THE PENDING-ITEMS ANSWER, resolved BEFORE anything is written.
     *
     * Asked only at `ready`, the point the shop floor finishes with an order.
     * Every line named is held back; every other line is marked READY,
     * because saying "these are pending" also says the rest are not.
     *
     * The ids are checked against the order's OWN lines inside the same
     * locked transaction, so a request cannot reach into another order.
     *
     * The order's resulting status is worked out here, before the first
     * write, so the item-history rows below can be stamped with it in one
     * pass rather than being written and then corrected.
     */
    let heldPieces = 0;
    let goingPieces = 0;
    let resolvedStatus: string = SORTER_STATUS[target];
    let itemMoves: Array<{
      id: string;
      name: string;
      ordered: number;
      pendingBefore: number;
      pending: number;
      from: string;
      to: ItemStatus;
    }> = [];
    let splitSummary: Array<{
      id: string;
      item_name: string;
      ordered_quantity: number;
      pending_quantity: number;
      delivery_quantity: number;
      item_status: ItemStatus;
    }> = [];

    if (target === 'ready' && pending !== undefined) {
      const [itemRows]: any = await connection.execute(
        `SELECT id, service_name, quantity, original_quantity, pending_quantity, item_status
           FROM order_items WHERE order_id = ? ORDER BY id ASC FOR UPDATE`,
        [orderId]
      );
      if (itemRows.length === 0) {
        throw new AppError('This order has no items.', 409);
      }

      /*
       * WHAT THE SORTER ASKED FOR, checked against the order's OWN lines
       * inside the same lock. An id that is not on this order is refused
       * rather than ignored: silently dropping it would hold back nothing and
       * report success.
       */
      const own = new Map<string, any>(itemRows.map((r: any) => [String(r.id), r]));
      const asked = new Map<string, number>();
      for (const entry of pending.items || []) {
        const id = String(entry.orderItemId);
        const row = own.get(id);
        if (!row) {
          throw new AppError(`Item ${id} is not part of this order.`, 400);
        }
        asked.set(id, parsePendingQuantity(
          entry.pendingQuantity,
          Number(row.original_quantity ?? row.quantity),
          row.service_name
        ));
      }

      for (const row of itemRows) {
        const id = String(row.id);
        const ordered = Number(row.original_quantity ?? row.quantity);
        // A LINE NOT MENTIONED HOLDS NOTHING -- see the note on the parameter.
        const held = asked.get(id) ?? 0;
        const going = deliveryQuantityOf(ordered, held);
        const next = deriveItemStatus(ordered, held);

        heldPieces += held;
        goingPieces += going;
        splitSummary.push({
          id,
          item_name: row.service_name,
          ordered_quantity: ordered,
          pending_quantity: held,
          delivery_quantity: going,
          item_status: next,
        });

        const pendingBefore = Number(row.pending_quantity || 0);
        if (String(row.item_status) !== next || pendingBefore !== held) {
          itemMoves.push({
            id,
            name: row.service_name,
            ordered,
            pendingBefore,
            pending: held,
            from: String(row.item_status),
            to: next,
          });
        }
      }

      resolvedStatus = deriveOrderStatus(
        splitSummary.map((i) => ({ ordered: i.ordered_quantity, pending: i.pending_quantity })),
        // Derived from where the order is ABOUT to be, not where it was: the
        // Sorter has just finished its pass over it.
        'READY_FOR_DELIVERY'
      );
    }

    // Only accepted and ready have audit columns; out_for_delivery is carried
    // by the status and its history row.
    //
    // `ready_at` is stamped even when the order resolves to
    // PARTIALLY_COMPLETED: the shop floor DID finish its pass, which is what
    // the column records. The items say which of them are still outstanding.
    const stampColumn =
      target === 'accepted' ? 'accepted_at' : target === 'ready' ? 'ready_at' : null;
    const byColumn =
      target === 'accepted' ? 'accepted_by' : target === 'ready' ? 'ready_by' : null;

    await connection.execute(
      stampColumn && byColumn
        ? `UPDATE orders
              SET status = ?, ${stampColumn} = NOW(), ${byColumn} = ?, updated_at = NOW()
            WHERE id = ?`
        : `UPDATE orders SET status = ?, updated_at = NOW() WHERE id = ?`,
      stampColumn && byColumn
        ? [resolvedStatus, sorterUserId, orderId]
        : [resolvedStatus, orderId]
    );

    // The items, and one audit row each. Written after the order so every row
    // carries the status the order actually ended at.
    for (const move of itemMoves) {
      await connection.execute(
        `UPDATE order_items SET item_status = ?, pending_quantity = ?, pending_reason = ?
          WHERE id = ?`,
        [move.to, move.pending, move.pending > 0 ? (pending?.reason || null) : null, move.id]
      );
      await recordItemHistory(connection, {
        orderId,
        orderItemId: move.id,
        orderStatus: resolvedStatus,
        previous: move.from,
        next: move.to,
        sorterUserId,
        // The QUANTITIES, in the note, because that is what actually moved:
        // "PROCESSING -> PARTIALLY_PENDING" on its own does not say how many.
        notes:
          `${move.name}: ${move.pending} of ${move.ordered} held pending, ` +
          `${deliveryQuantityOf(move.ordered, move.pending)} out for delivery` +
          (move.pending > 0 && pending?.reason ? ` (${pending.reason})` : ''),
      });
    }

    // The same history table the rest of the pipeline writes to, so tracking
    // keeps working unchanged. `order_item_id` is NULL on this row, which is
    // what marks it as the ORDER's own entry rather than an item's.
    await connection.execute(
      `INSERT INTO order_status_history (order_id, status, notes, changed_by)
       VALUES (?, ?, ?, ?)`,
      [
        orderId,
        resolvedStatus,
        heldPieces > 0
          ? `Marked ready by sorter — ${goingPieces} piece(s) out for delivery, ` +
            `${heldPieces} held pending`
          : `Marked ${target} by sorter`,
        sorterUserId,
      ]
    );

    await connection.commit();
    logger.info(
      `[SorterService] Order ${order.order_number} ${currentStage} -> ${resolvedStatus} ` +
        `by user ${sorterUserId}` +
        (heldPieces > 0 ? ` (${goingPieces} piece(s) out, ${heldPieces} held)` : '')
    );

    /*
     * THE SORTER'S ACCEPTANCE IS WHAT DISPATCHES A RIDER.
     *
     * This is the point the business asked for: an order that has been
     * confirmed by a human is real work, so a pickup job is created and
     * offered to the riders nearest the customer or establishment. Before
     * this moment riders have only had an advisory, which they cannot act on.
     *
     * `ready` does the same for the return leg, so a finished order is
     * collected for delivery without anyone chasing it.
     *
     * Run AFTER commit and deliberately not awaited into this function's
     * failure path. The Sorter's transition is already durable; a dispatch
     * that fails must leave the order accepted and be retried, never undo
     * the acceptance or report it as failed.
     */
    /*
     * WHICH SORTER STEP DISPATCHES WHAT.
     *
     *   accepted          -> PICKUP. The order is confirmed, so collecting
     *                        it from the customer is now real work.
     *
     *   out_for_delivery  -> DELIVERY. NOT `ready`: ready means the laundry
     *                        is finished, which is a shop-floor fact, and an
     *                        order can sit finished on a shelf for a while.
     *                        Dispatching then would send a rider to the
     *                        facility for goods nobody had decided to send
     *                        out. `out_for_delivery` is the decision to send
     *                        it, and that is the moment a rider is wanted.
     */
    if (target === 'accepted' || target === 'out_for_delivery') {
      const jobType = target === 'accepted' ? 'PICKUP' : 'DELIVERY';
      void (async () => {
        try {
          const job = await createJobForOrder(String(order.id), jobType);
          if (job) await dispatchJob(job.id);
        } catch (dispatchError) {
          logger.error(
            `[SorterService] ${jobType} dispatch failed for order ${order.order_number}: ` +
              `${dispatchError instanceof Error ? dispatchError.message : String(dispatchError)}`
          );
        }
      })();
    }

    return {
      id: String(order.id),
      order_number: order.order_number,
      status: resolvedStatus,
      stage: STAGE_OF[resolvedStatus] || target,
      pending_quantity: heldPieces,
      delivery_quantity: goingPieces,
      items: splitSummary,
    };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

/**
 * A pending quantity, or a 400 that names the item and the rule it broke.
 *
 * Whole pieces only, and never more than were collected. A garment is a
 * physical object, so `2.5` is refused rather than truncated; and holding
 * back seven of five pieces describes nothing that exists.
 *
 * Checked HERE, against the quantity read from the locked row -- never
 * against anything the request said the ordered quantity was.
 */
function parsePendingQuantity(
  value: unknown,
  orderedQuantity: number,
  itemName: string
): number {
  if (value === null || value === undefined || value === '') return 0;
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new AppError(`${itemName}: the pending quantity must be a number.`, 400);
  }
  if (!Number.isInteger(n)) {
    throw new AppError(`${itemName}: the pending quantity must be a whole number of pieces.`, 400);
  }
  if (n < 0) {
    throw new AppError(`${itemName}: the pending quantity cannot be negative.`, 400);
  }
  if (n > orderedQuantity) {
    throw new AppError(
      `${itemName}: pending quantity cannot be greater than ordered quantity ` +
        `(${n} of ${orderedQuantity}).`,
      400
    );
  }
  return n;
}

/* ===================================================================
 * ITEM-LEVEL AUDIT
 * =================================================================== */

/**
 * One audit row for one item's move, in `order_status_history` — the table
 * this application already uses for order history.
 *
 * NO SECOND AUDIT SYSTEM. The row carries the ORDER's status (the column is
 * NOT NULL and the tracking timeline reads it), plus the item, the status it
 * came from and the status it went to. `order_item_id` being non-NULL is what
 * distinguishes an item row from an order row, so the existing timeline —
 * which reads only status, notes and created_at — keeps working and simply
 * sees one more entry.
 */
async function recordItemHistory(
  connection: any,
  entry: {
    orderId: string;
    orderItemId: string;
    orderStatus: string;
    previous: string;
    next: string;
    sorterUserId: string;
    notes: string;
  }
): Promise<void> {
  await connection.execute(
    `INSERT INTO order_status_history
       (order_id, order_item_id, previous_item_status, new_item_status,
        status, notes, changed_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      entry.orderId, entry.orderItemId, entry.previous, entry.next,
      entry.orderStatus, entry.notes, entry.sorterUserId,
    ]
  );
}

/* ===================================================================
 * PENDING ITEMS, LATER
 * =================================================================== */

export interface ItemPendingResult {
  order_id: string;
  order_number: string;
  /** The order's status after re-deriving it from its items. */
  order_status: string;
  item: {
    id: string;
    item_name: string;
    ordered_quantity: number;
    pending_quantity: number;
    delivery_quantity: number;
    item_status: ItemStatus;
  };
  /** Across the whole order, after this change. */
  pending_quantity: number;
  delivery_quantity: number;
}

/**
 * Sets how many pieces of ONE line are being held, and re-derives the order.
 *
 * This is both halves of the later half of the workflow, and both are the
 * same operation with a different number:
 *
 *   0            release. The Sorter has finished the pieces that were held,
 *                so the whole line goes with the next dispatch. Once nothing
 *                anywhere on the order is held, the order becomes
 *                READY_FOR_DELIVERY again.
 *   1..ordered   hold that many. Something needs more time after all, or the
 *                first figure was wrong and is being corrected.
 *
 * IT REPLACES, IT DOES NOT ACCUMULATE. Sending 2 after 3 leaves 2 held, not
 * 5 -- the number is the state, not a delta.
 *
 * ATOMIC. The order and the line are locked, the line is written, the audit
 * row is written and the order's status is re-derived, all in one
 * transaction, so the order can never claim to be ready while a line of it
 * still holds pieces.
 *
 * NOTHING FINANCIAL MOVES. No price, quantity billed, total, invoice or
 * payment is read or written here. Holding a piece back costs nobody
 * anything, and that is the whole difference between PENDING and a defective
 * adjustment.
 *
 * SORTER ONLY: the route sits behind `authorize('SORTER')`.
 */
async function setItemPendingQuantity(
  orderId: string,
  orderItemId: string,
  pendingQuantity: unknown,
  sorterUserId: string,
  reason?: string | null
): Promise<ItemPendingResult> {
  const connection = await getClient();
  try {
    await connection.beginTransaction();

    // Order first, then the line: the same lock order as everywhere else, so
    // two Sorters working one order queue rather than deadlock.
    const [orderRows]: any = await connection.execute(
      `SELECT id, order_number, status FROM orders WHERE id = ? FOR UPDATE`,
      [orderId]
    );
    const order = orderRows[0];
    if (!order) throw new AppError('Order not found', 404);

    /*
     * ONLY WHILE THE ORDER IS STILL THE SORTER'S. Once dispatched or
     * cancelled its pieces are no longer here to be re-judged, and
     * re-deriving the status of a dispatched order could drag it backwards.
     */
    if (!['RECEIVED_AT_FACILITY', 'READY_FOR_DELIVERY', 'PARTIALLY_COMPLETED']
          .includes(String(order.status))) {
      throw new AppError(
        `This order is ${String(order.status).replace(/_/g, ' ')} and its items can no ` +
          'longer be changed from the Sorter workflow.',
        409
      );
    }

    const [itemRows]: any = await connection.execute(
      `SELECT id, service_name, quantity, original_quantity, pending_quantity, item_status
         FROM order_items WHERE id = ? AND order_id = ? FOR UPDATE`,
      [orderItemId, orderId]
    );
    const item = itemRows[0];
    if (!item) throw new AppError('That item is not part of this order.', 404);

    const ordered = Number(item.original_quantity ?? item.quantity);
    const held = parsePendingQuantity(pendingQuantity, ordered, item.service_name);
    const going = deliveryQuantityOf(ordered, held);
    const next = deriveItemStatus(ordered, held);

    const previousStatus = String(item.item_status);
    const previousHeld = Number(item.pending_quantity || 0);
    const changed = previousStatus !== next || previousHeld !== held;

    if (changed) {
      await connection.execute(
        `UPDATE order_items SET item_status = ?, pending_quantity = ?, pending_reason = ?
          WHERE id = ?`,
        [next, held, held > 0 ? (reason || null) : null, item.id]
      );
    }

    // Every line of the order as it now stands, for the derivation.
    const [allRows]: any = await connection.execute(
      `SELECT id, quantity, original_quantity, pending_quantity
         FROM order_items WHERE order_id = ?`,
      [orderId]
    );
    const after = allRows.map((r: any) => ({
      ordered: Number(r.original_quantity ?? r.quantity),
      pending: String(r.id) === String(item.id) ? held : Number(r.pending_quantity || 0),
    }));

    const orderStatus = deriveOrderStatus(after, String(order.status));
    if (orderStatus !== String(order.status)) {
      await connection.execute(
        `UPDATE orders SET status = ?, updated_at = NOW() WHERE id = ?`,
        [orderStatus, orderId]
      );
      await connection.execute(
        `INSERT INTO order_status_history (order_id, status, notes, changed_by)
         VALUES (?, ?, ?, ?)`,
        [
          orderId, orderStatus,
          `${item.service_name}: ${previousHeld} -> ${held} piece(s) pending; ` +
            'order re-derived from its items',
          sorterUserId,
        ]
      );
    }

    if (changed) {
      await recordItemHistory(connection, {
        orderId,
        orderItemId: String(item.id),
        orderStatus,
        previous: previousStatus,
        next,
        sorterUserId,
        notes:
          `${item.service_name}: ${held} of ${ordered} held pending, ` +
          `${going} out for delivery` +
          (held > 0 && reason ? ` (${reason})` : ''),
      });
    }

    await connection.commit();

    const totalHeld = after.reduce((sum: number, i: any) => sum + i.pending, 0);
    const totalGoing = after.reduce(
      (sum: number, i: any) => sum + deliveryQuantityOf(i.ordered, i.pending), 0
    );

    logger.info(
      `[SorterService] Order ${order.order_number} item ${item.id} ` +
        `(${item.service_name}): ${previousHeld} -> ${held} of ${ordered} held ` +
        `by user ${sorterUserId}; order ${order.status} -> ${orderStatus}`
    );

    return {
      order_id: String(orderId),
      order_number: order.order_number,
      order_status: orderStatus,
      item: {
        id: String(item.id),
        item_name: item.service_name,
        ordered_quantity: ordered,
        pending_quantity: held,
        delivery_quantity: going,
        item_status: next,
      },
      pending_quantity: totalHeld,
      delivery_quantity: totalGoing,
    };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

/**
 * The confirmation document for one order.
 *
 * Returns the stored reference when the order has one. When it does not, the
 * order detail comes back instead and the client renders it through the same
 * PDF template the Business app already uses — one generator, one layout, and
 * no PDF bytes in the database.
 */
async function getConfirmationPdf(
  orderId: string
): Promise<{ url: string | null; order: SorterOrderDetail }> {
  const order = await getOrderById(orderId);
  return { url: order.confirmation_pdf_url, order };
}

export { listOrders, getOrderById, updateStatus, setItemPendingQuantity,
         getConfirmationPdf, deriveOrderStatus, ALLOWED_TRANSITIONS };
