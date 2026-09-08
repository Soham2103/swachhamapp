import { getClient, query } from '../config/database';
import { config } from '../config/env';
import { AppError } from '../utils/appError';
import { logger } from '../utils/logger';
import {
  planBatches,
  OptimizerItem,
  OptimizerMachine,
  OptimizerResult,
  WashingGroup,
} from './batchOptimizer.service';

/* ===================================================================
 * SORTER BATCH PROCESSING
 * ===================================================================
 *
 * The database side of batch processing. Every read and every write lives
 * here; the algorithm itself is `batchOptimizer.service.ts`, which is pure and
 * knows nothing about SQL.
 *
 *   sorter.routes  ->  sorterBatch.service  ->  batchOptimizer.service
 *                              |
 *                           database
 *
 * WHAT THIS MODULE DOES NOT TOUCH
 *
 * It never writes `orders.status`, `order_items.item_status`,
 * `order_items.quantity`, any price, any invoice, or any acceptance/delivery
 * garment scan. Batching happens entirely INSIDE the existing
 * RECEIVED_AT_FACILITY stage: an order is approved by the Sorter exactly as it
 * always was, it may then be batched, and it is marked ready exactly as it
 * always was. Removing every line of this feature would leave the existing
 * workflow behaving identically.
 *
 * WHY APPROVAL IS THE GATE
 *
 * The Sorter's approval is the existing transition ORDER_PLACED ->
 * RECEIVED_AT_FACILITY, audited by `orders.accepted_at` / `accepted_by` since
 * migration 017. That IS the approval record, so no second approval flag was
 * invented: `status = 'RECEIVED_AT_FACILITY' AND accepted_at IS NOT NULL` is
 * the eligibility rule, and `accepted_at` is also the priority clock.
 */

/* ===================================================================
 * ELIGIBILITY
 * =================================================================== */

/**
 * The one status an order can be batched from.
 *
 * Everything the requirement excludes falls out of this single condition:
 * ORDER_PLACED is not yet approved, CANCELLED and DELIVERED and COMPLETED are
 * past it, and READY_FOR_DELIVERY / PARTIALLY_COMPLETED have already finished
 * the Sorter's pass. Only an order the Sorter has approved and not yet
 * finished can be washed.
 */
const BATCHABLE_ORDER_STATUS = 'RECEIVED_AT_FACILITY';

/**
 * Batch statuses that still hold their order lines.
 *
 * A CANCELLED batch releases its lines back to the eligible pool; every other
 * status keeps them, so a line can never appear in two live batches.
 */
const LIVE_BATCH_STATUSES = ['CONFIRMED', 'IN_MACHINE', 'WASHING', 'COMPLETED'] as const;

/** Machines that may receive a new load. Only this one. */
const ASSIGNABLE_MACHINE_STATUS = 'AVAILABLE';

/**
 * "Every piece of this line that is not already in a live batch."
 *
 * The sentinel a caller's id-only request carries until the line is locked and
 * the real remaining count is known. Negative so it can never collide with a
 * genuine piece count.
 */
const WHOLE_LINE = -1;

/**
 * The optimisation window, in order LINES.
 *
 * Bounded on purpose: the eligible query is a `LIMIT`ed read of approved,
 * unbatched lines ordered by approval time, so the historical orders table is
 * never walked no matter how large it grows.
 */
const WINDOW = (() => {
  const raw = Number(process.env.BATCH_OPTIMIZATION_WINDOW);
  if (!Number.isFinite(raw) || raw <= 0) return 30;
  return Math.min(Math.floor(raw), 100);
})();

/* ===================================================================
 * SHAPES
 * =================================================================== */

export interface MachineRecord {
  id: string;
  code: string;
  name: string;
  capacity_kg: number;
  status: 'AVAILABLE' | 'IN_USE' | 'MAINTENANCE' | 'OFFLINE' | 'COMPLETED';
}

export type BatchStatus =
  | 'PROPOSED'
  | 'CONFIRMED'
  | 'IN_MACHINE'
  | 'WASHING'
  | 'COMPLETED'
  | 'CANCELLED';

export interface EligibleLine {
  order_item_id: string;
  order_id: string;
  order_number: string;
  item_name: string;
  washing_group: WashingGroup;
  quantity: number;
  weight_kg: number;
  approved_at: Date;
  /** Minutes since the Sorter approved the order. The waiting time. */
  waiting_minutes: number;
}

export interface BatchEligibility {
  /** Distinct approved orders with at least one unbatched line. */
  approved_orders_ready: number;
  /** Unbatched lines across those orders — what the optimiser works on. */
  eligible_items: number;
  total_weight_kg: number;
  machines: MachineRecord[];
  available_machines: number;
  optimization_window: number;
  lines: EligibleLine[];
}

/* ===================================================================
 * READS
 * =================================================================== */

/** The three machines and their current status. */
async function listMachines(): Promise<MachineRecord[]> {
  const result = await query<any>(
    `SELECT id, code, name, capacity_kg, status
       FROM machines
      ORDER BY capacity_kg DESC, id ASC`
  );
  return result.rows.map(toMachine);
}

function toMachine(row: any): MachineRecord {
  return {
    id: String(row.id),
    code: row.code,
    name: row.name,
    capacity_kg: Number(row.capacity_kg),
    status: row.status,
  };
}

/**
 * HOW MANY PIECES OF A LINE MAY BE WASHED IN A BATCH.
 *
 * ============================================================
 * THE RULE
 * ============================================================
 *
 * Soaking cloth and colour cloth do not go into a batch, and their weight is
 * not part of any batch or machine total. What is left is WHITE, NON-SOAKED
 * cloth, and that is all this expression returns:
 *
 *     white_cloth_count - white_socked
 *
 * ============================================================
 * WHY COLOUR IS NOT SUBTRACTED SEPARATELY
 * ============================================================
 *
 * Because it is already gone. The Sorter's four figures are not four piles:
 * `white_socked` and `color_socked` are counted OUT OF the white and colour
 * cloth respectively — the counting screen states the rule as
 *
 *     (White - White Socked) + (Color - Color Socked) + White Socked + Color Socked
 *
 * so White Cloth + Color Cloth is the whole line. Excluding "colour and
 * soaking" therefore means keeping only the white that was not soaked, and
 * subtracting `color_cloth_count` or `color_socked` here as well would remove
 * pieces that this expression never included in the first place.
 *
 * ============================================================
 * AN UNCOUNTED LINE IS UNCHANGED
 * ============================================================
 *
 * NULL means "not counted" — a different fact from 0, and the schema keeps
 * them apart deliberately. A line the Sorter never counted has nothing known
 * to be colour or soaking, so it batches on its full ordered quantity exactly
 * as it did before this rule existed. Only a line that HAS been counted is
 * reduced.
 *
 * LEAST caps the result at the ordered quantity: the counts are taken by hand
 * and are not enforced against the order, so a miscount cannot conjure pieces
 * that were never ordered. GREATEST floors it at zero for the same reason in
 * the other direction.
 *
 * Written once and used by BOTH the eligibility read and the batch-creation
 * read, so the preview and what is actually built can never disagree.
 */
const BATCHABLE_QUANTITY_SQL = `
  CASE
    WHEN pi.white_cloth_count IS NULL
     AND pi.color_cloth_count IS NULL
     AND pi.white_socked IS NULL
     AND pi.color_socked IS NULL
    THEN COALESCE(oi.original_quantity, oi.quantity)
    ELSE LEAST(
      COALESCE(oi.original_quantity, oi.quantity),
      GREATEST(
        COALESCE(pi.white_cloth_count, 0)
          -- Defective white pieces are not washed either. Subtracted from the
          -- same side as the socked pieces, and for the same reason: the
          -- count is what was COUNTED, not what is still going in a drum.
          -- The read in sorter.service.listPendingItemsForOrder nets the
          -- same figure for display, so screen and batch agree.
          - COALESCE(oi.white_defective_quantity, 0)
          - COALESCE(pi.white_socked, 0),
        0
      )
    )
  END`;

/**
 * The eligible lines, and only them.
 *
 * ENFORCED IN SQL, not in the app. The four conditions the requirement lists
 * are the four conditions of this WHERE clause:
 *
 *   sorter_approved       o.status = 'RECEIVED_AT_FACILITY' AND accepted_at
 *                         IS NOT NULL — the existing approval audit.
 *   not_cancelled         CANCELLED is not that status.
 *   not_completed         nor is DELIVERED / COMPLETED / READY_FOR_DELIVERY.
 *   not_already_batched   NOT EXISTS a live batch_order_items row.
 *
 * Ordered by approval time and LIMITed, so the read is the window and not the
 * table. `washing_group` is resolved from the catalogue item, with the item's
 * own name as the fallback for a line whose catalogue row was since deleted
 * (order_items.service_id is ON DELETE SET NULL).
 */
async function fetchEligibleLines(limit: number): Promise<EligibleLine[]> {
  const result = await query<any>(
    `SELECT oi.id AS order_item_id,
            oi.order_id,
            o.order_number,
            oi.service_name AS item_name,
            COALESCE(oi.original_quantity, oi.quantity) AS ordered_quantity,
            -- What may actually be washed: white, non-soaked cloth only.
            -- See BATCHABLE_QUANTITY_SQL.
            ${BATCHABLE_QUANTITY_SQL} AS batchable_quantity,
            -- PIECES ALREADY IN A LIVE BATCH. Since a line is splittable this
            -- is no longer all-or-nothing: 57 of 60 towels may be washing
            -- while the last 3 are still waiting for a drum.
            COALESCE((
              SELECT SUM(boi.quantity) FROM batch_order_items boi
               WHERE boi.active_order_item_id = oi.id
            ), 0) AS batched_quantity,
            -- The order's OWN weight snapshot, which is what every other
            -- screen shows. The fallback recomputes the same
            -- quantity x standard_weight for rows written before the column
            -- existed; no second weight rule is introduced anywhere.
            COALESCE(
              oi.total_weight_kg,
              ROUND(COALESCE(oi.weight_kg, 0) * COALESCE(oi.original_quantity, oi.quantity), 3),
              0
            ) AS ordered_weight_kg,
            COALESCE(
              s.washing_group,
              IF(LOWER(oi.service_name) LIKE '%towel%', 'TOWEL', 'GENERAL')
            ) AS washing_group,
            o.accepted_at,
            TIMESTAMPDIFF(MINUTE, o.accepted_at, UTC_TIMESTAMP()) AS waiting_minutes
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       LEFT JOIN services s ON s.id = oi.service_id
       -- The Sorter's cloth counts for this line, if it was counted at all.
       -- LEFT so an uncounted line still appears; the CASE above is what
       -- decides that it batches in full.
       LEFT JOIN pending_item pi ON pi.order_item_id = oi.id
      WHERE o.status = ?
        AND o.accepted_at IS NOT NULL
        -- Compared against the BATCHABLE quantity, not the ordered one, so a
        -- line whose washable pieces are all in a drum drops out — and a line
        -- that is entirely colour or soaking never appears at all.
        AND ${BATCHABLE_QUANTITY_SQL} > COALESCE((
              SELECT SUM(boi.quantity) FROM batch_order_items boi
               WHERE boi.active_order_item_id = oi.id
            ), 0)
      ORDER BY o.accepted_at ASC, o.id ASC, oi.id ASC
      LIMIT ${Math.max(1, Math.floor(limit))}`,
    [BATCHABLE_ORDER_STATUS]
  );

  return result.rows.map((row) => {
    const ordered = Number(row.ordered_quantity || 0);
    const batched = Number(row.batched_quantity || 0);
    /*
     * REMAINING IS MEASURED AGAINST THE BATCHABLE PIECES, NOT THE ORDERED
     * ONES. Colour and soaking cloth is not washed here, so it is not work
     * still to do — counting it as remaining would keep offering the
     * optimiser pieces that will never go in a drum.
     */
    const batchable = Number(row.batchable_quantity || 0);
    const remaining = Math.max(0, batchable - batched);
    const orderedKg = Number(row.ordered_weight_kg || 0);
    /*
     * The remaining pieces' weight, at the line's own PER-PIECE weight.
     *
     * Divided by the ORDERED quantity on purpose: that is the quantity the
     * line's stored weight was measured over, so `orderedKg / ordered` is the
     * true weight of one piece. Dividing by the batchable count instead would
     * spread the whole line's weight — colour and soaking included — across
     * only the white pieces, which is exactly the weight this change exists
     * to leave out.
     */
    const remainingKg =
      ordered > 0 ? Math.round((orderedKg / ordered) * remaining * 1000) / 1000 : 0;

    return {
      order_item_id: String(row.order_item_id),
      order_id: String(row.order_id),
      order_number: row.order_number,
      item_name: row.item_name,
      washing_group: (row.washing_group === 'TOWEL' ? 'TOWEL' : 'GENERAL') as WashingGroup,
      quantity: remaining,
      weight_kg: remainingKg,
      approved_at: row.accepted_at,
      waiting_minutes: Math.max(0, Number(row.waiting_minutes || 0)),
    };
  });
}

/**
 * What the Sorter sees BEFORE pressing START BATCH: how much approved laundry
 * is waiting and which machines are free.
 *
 * A read, and nothing more. Opening the screen does not optimise anything —
 * the optimiser runs only when START BATCH is pressed.
 */
async function getBatchEligibility(): Promise<BatchEligibility> {
  const [lines, machines] = await Promise.all([fetchEligibleLines(WINDOW), listMachines()]);

  const orders = new Set(lines.map((line) => line.order_id));
  const totalWeight = lines.reduce((sum, line) => sum + line.weight_kg, 0);

  return {
    approved_orders_ready: orders.size,
    eligible_items: lines.length,
    total_weight_kg: Math.round(totalWeight * 1000) / 1000,
    machines,
    available_machines: machines.filter((m) => m.status === ASSIGNABLE_MACHINE_STATUS).length,
    optimization_window: WINDOW,
    lines,
  };
}

/* ===================================================================
 * START BATCH  ->  a PROPOSAL
 * =================================================================== */

export interface ProposalBatchView {
  machine_id: string;
  machine_code: string;
  machine_name: string;
  capacity_kg: number;
  washing_group: WashingGroup;
  total_weight_kg: number;
  remaining_capacity_kg: number;
  utilization_percentage: number;
  items: Array<{
    order_item_id: string;
    order_id: string;
    order_number: string;
    item_name: string;
    quantity: number;
    weight_kg: number;
    washing_group: WashingGroup;
    approved_at: Date;
  }>;
}

export interface BatchProposal {
  /**
   * Identifies THIS calculation. Sent back with CONFIRM BATCH so the log can
   * tie a confirmation to the proposal it came from. It is not a token and it
   * grants nothing: confirmation re-validates every line and every machine
   * from the database regardless of what this says.
   */
  proposal_id: string;
  generated_at: Date;
  batches: ProposalBatchView[];
  unplaced: Array<{
    order_item_id: string;
    order_id: string;
    order_number: string;
    item_name: string;
    quantity: number;
    weight_kg: number;
    washing_group: WashingGroup;
    reason: string;
  }>;
  total_weight_kg: number;
  overall_utilization_percentage: number;
  machines_used: number;
  approved_orders_ready: number;
  eligible_items: number;
  machines: MachineRecord[];
  stats: OptimizerResult['stats'];
}

/**
 * START BATCH.
 *
 * Runs the optimiser once and returns what it proposes. NOTHING IS WRITTEN:
 * no batch row, no machine reservation, no order or item status. The Sorter
 * can press REGENERATE as often as they like — each press is another
 * calculation over the laundry that is eligible at that moment, and none of
 * them leaves anything behind.
 *
 * REGENERATE is this same function. It re-reads the eligible lines and the
 * machine statuses first, so a machine that went into maintenance, or an
 * order another Sorter batched in the meantime, is reflected in the new
 * proposal.
 */
async function optimizeBatches(): Promise<BatchProposal> {
  const [lines, machines] = await Promise.all([fetchEligibleLines(WINDOW), listMachines()]);

  const availableMachines: OptimizerMachine[] = machines
    .filter((m) => m.status === ASSIGNABLE_MACHINE_STATUS)
    .map((m) => ({ id: m.id, code: m.code, name: m.name, capacityKg: m.capacity_kg }));

  // A line with no recorded weight cannot be planned against a capacity, and
  // guessing one would be worse than saying so. Reported rather than dropped.
  const weightless = lines.filter((line) => line.weight_kg <= 0);
  const weighed = lines.filter((line) => line.weight_kg > 0);

  const optimizerItems: OptimizerItem[] = weighed.map((line) => ({
    orderItemId: line.order_item_id,
    orderId: line.order_id,
    orderNumber: line.order_number,
    itemName: line.item_name,
    washingGroup: line.washing_group,
    quantity: line.quantity,
    weightKg: line.weight_kg,
    approvedAt: new Date(line.approved_at),
  }));

  const result = planBatches(optimizerItems, availableMachines, { windowSize: WINDOW });

  const byId = new Map(lines.map((line) => [line.order_item_id, line]));

  const batches: ProposalBatchView[] = result.batches.map((batch) => ({
    machine_id: batch.machineId,
    machine_code: batch.machineCode,
    machine_name: batch.machineName,
    capacity_kg: batch.capacityKg,
    washing_group: batch.washingGroup,
    total_weight_kg: batch.totalWeightKg,
    remaining_capacity_kg: batch.remainingCapacityKg,
    utilization_percentage: batch.utilizationPercentage,
    // `quantity` / `weight_kg` are what THIS drum takes, which for a split
    // line is less than the line. `ordered_quantity` keeps the whole line
    // visible so the screen can show "13 of 50".
    items: batch.items.map((item) => ({
      order_item_id: item.orderItemId,
      order_id: item.orderId,
      order_number: item.orderNumber,
      item_name: item.itemName,
      quantity: item.takenQuantity,
      weight_kg: item.takenWeightKg,
      is_partial: item.isPartial,
      ordered_quantity: item.quantity,
      washing_group: item.washingGroup,
      approved_at: byId.get(item.orderItemId)!.approved_at,
    })),
  }));

  const unplaced = [
    ...result.unplaced.map((entry) => ({
      order_item_id: entry.item.orderItemId,
      order_id: entry.item.orderId,
      order_number: entry.item.orderNumber,
      item_name: entry.item.itemName,
      quantity: entry.item.quantity,
      weight_kg: entry.item.weightKg,
      washing_group: entry.item.washingGroup,
      reason: entry.reason,
    })),
    ...weightless.map((line) => ({
      order_item_id: line.order_item_id,
      order_id: line.order_id,
      order_number: line.order_number,
      item_name: line.item_name,
      quantity: line.quantity,
      weight_kg: line.weight_kg,
      washing_group: line.washing_group,
      reason: 'No standard weight is recorded for this item, so it cannot be planned against a machine capacity.',
    })),
  ];

  return {
    proposal_id: `P-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    generated_at: new Date(),
    batches,
    unplaced,
    total_weight_kg: result.totalWeightKg,
    overall_utilization_percentage: result.overallUtilizationPercentage,
    machines_used: result.machinesUsed,
    approved_orders_ready: new Set(lines.map((line) => line.order_id)).size,
    eligible_items: lines.length,
    machines,
    stats: result.stats,
  };
}

/* ===================================================================
 * CONFIRM BATCH
 * =================================================================== */

/** One line's contribution to one batch, in PIECES. */
export interface ConfirmBatchLine {
  orderItemId: string;
  /** Pieces of this line to put in this drum. Never more than are left. */
  quantity: number;
}

export interface ConfirmBatchInput {
  machineId: string;
  /**
   * The preferred form: how many pieces of each line go in this drum, which is
   * what makes a split expressible.
   */
  lines?: ConfirmBatchLine[];
  /**
   * The whole-line form, kept so a caller that does not split does not have to
   * spell out quantities. Each id means "every piece of this line that is not
   * already in a live batch".
   */
  orderItemIds?: string[];
}

export interface BatchRecord {
  id: string;
  batch_number: string;
  machine_id: string;
  machine_code: string;
  machine_name: string;
  capacity_kg: number;
  washing_group: WashingGroup;
  total_weight_kg: number;
  item_count: number;
  status: BatchStatus;
  utilization_percentage: number;
  created_by: string | null;
  confirmed_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  items?: Array<{
    id: string;
    order_id: string;
    order_number: string;
    order_item_id: string;
    item_name: string;
    /** Pieces of the line in THIS batch. Less than `ordered_quantity` when split. */
    quantity: number;
    /** Weight of exactly those pieces. */
    weight_kg: number;
    /** True when the line is spread across more than one drum. */
    is_partial: boolean;
    /** Pieces on the whole line, so a tag can read "13 of 50". */
    ordered_quantity: number;
    /** For PRINT TAG. The business's own display name, same fallback the rest of the app uses. */
    establishment_name: string;
  }>;
}

/** `B-YYYYMMDD-0001`, in the business day, taken inside the transaction. */
async function nextBatchNumber(connection: any): Promise<string> {
  const [dateRows]: any = await connection.execute(
    `SELECT DATE_FORMAT(CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', ?), '%Y%m%d') AS ymd`,
    [config.BUSINESS_TZ_OFFSET]
  );
  const ymd = String(dateRows[0].ymd);
  const prefix = `B-${ymd}-`;

  // Read under the same lock as the INSERT that follows, so two confirmations
  // in the same millisecond cannot both take the same number. The UNIQUE key
  // on batch_number is the backstop if they somehow do.
  const [rows]: any = await connection.execute(
    `SELECT COALESCE(MAX(CAST(SUBSTRING(batch_number, ?) AS UNSIGNED)), 0) AS last
       FROM laundry_batches
      WHERE batch_number LIKE ?
        FOR UPDATE`,
    [prefix.length + 1, `${prefix}%`]
  );
  return `${prefix}${String(Number(rows[0].last) + 1).padStart(4, '0')}`;
}

/**
 * CONFIRM BATCH — the only call that makes anything permanent.
 *
 * EVERYTHING IS RE-VALIDATED FROM THE DATABASE. The request names machines
 * and order lines; it does not get to state their weight, their washing
 * group, their order's status or whether they are already batched. All of
 * that is re-read here, inside the transaction, under row locks. A proposal
 * generated five minutes ago against laundry another Sorter has since taken
 * is refused, with a message saying which line moved, rather than quietly
 * writing a batch that contradicts the database.
 *
 * LOCK ORDER is machines, then orders/order lines, then the batch rows —
 * always the same, and always by ascending id, so two Sorters confirming
 * overlapping proposals queue behind each other instead of deadlocking.
 *
 * The whole thing is one transaction: either every batch in the confirmation
 * exists with all of its lines and its machine reserved, or none of it does.
 */
async function confirmBatches(
  input: ConfirmBatchInput[],
  sorterUserId: string
): Promise<{ batches: BatchRecord[]; total_weight_kg: number }> {
  if (!Array.isArray(input) || input.length === 0) {
    throw new AppError('No batches were sent to confirm.', 400);
  }

  /*
   * Shape validation before anything is locked.
   *
   * A line MAY now appear in more than one batch of the same confirmation —
   * that is what splitting one line across two drums looks like on the wire.
   * What is checked instead, once the rows are locked, is that the pieces
   * asked for do not exceed the pieces the line actually has left.
   *
   * `quantity: 0` is not a request, it is noise, and it is refused rather than
   * silently written as an empty line.
   */
  const machineIds: string[] = [];
  const allItemIds: string[] = [];
  /** Per batch, in input order: the lines and the pieces asked of each. */
  const requested: Array<Map<string, number>> = [];

  for (const batch of input) {
    const machineId = String(batch?.machineId ?? '');
    if (!/^\d+$/.test(machineId)) {
      throw new AppError('Each batch must name a machine.', 400);
    }
    if (machineIds.includes(machineId)) {
      throw new AppError('A machine can only take one batch at a time.', 400);
    }
    machineIds.push(machineId);

    const perLine = new Map<string, number>();

    // The explicit form wins; the id-only form means "everything left".
    // `null` is the marker for "everything left", resolved after the lock.
    const explicit = Array.isArray(batch?.lines) ? batch.lines : null;
    if (explicit) {
      for (const line of explicit) {
        const id = String(line?.orderItemId ?? '');
        if (!/^\d+$/.test(id)) throw new AppError('Invalid order item reference.', 400);
        const pieces = Number(line?.quantity);
        if (!Number.isFinite(pieces) || !Number.isInteger(pieces) || pieces <= 0) {
          throw new AppError('Each batched line must name a whole number of pieces.', 400);
        }
        perLine.set(id, (perLine.get(id) || 0) + pieces);
        if (!allItemIds.includes(id)) allItemIds.push(id);
      }
    } else {
      for (const raw of Array.isArray(batch?.orderItemIds) ? batch.orderItemIds : []) {
        const id = String(raw);
        if (!/^\d+$/.test(id)) throw new AppError('Invalid order item reference.', 400);
        // WHOLE_LINE, resolved to the pieces remaining once the row is locked.
        perLine.set(id, WHOLE_LINE);
        if (!allItemIds.includes(id)) allItemIds.push(id);
      }
    }

    if (perLine.size === 0) {
      throw new AppError('A batch cannot be empty.', 400);
    }
    requested.push(perLine);
  }

  const connection = await getClient();
  try {
    await connection.beginTransaction();

    /* ---- 1. Machines, locked and re-checked ---- */
    const [machineRows]: any = await connection.execute(
      `SELECT id, code, name, capacity_kg, status
         FROM machines
        WHERE id IN (${machineIds.map(() => '?').join(', ')})
        ORDER BY id ASC
          FOR UPDATE`,
      machineIds
    );
    const machines = new Map<string, any>(machineRows.map((row: any) => [String(row.id), row]));
    for (const machineId of machineIds) {
      const machine = machines.get(machineId);
      if (!machine) throw new AppError(`Machine ${machineId} does not exist.`, 404);
      if (machine.status !== ASSIGNABLE_MACHINE_STATUS) {
        throw new AppError(
          `${machine.name} is now ${String(machine.status).replace(/_/g, ' ').toLowerCase()} ` +
            'and can no longer take this batch. Regenerate the distribution.',
          409
        );
      }
    }

    /* ---- 2. Order lines and their orders, locked and re-checked ---- */
    const [lineRows]: any = await connection.execute(
      `SELECT oi.id AS order_item_id,
              oi.order_id,
              o.order_number,
              o.status AS order_status,
              o.accepted_at,
              oi.service_name AS item_name,
              COALESCE(oi.original_quantity, oi.quantity) AS quantity,
              COALESCE(
                oi.total_weight_kg,
                ROUND(COALESCE(oi.weight_kg, 0) * COALESCE(oi.original_quantity, oi.quantity), 3),
                0
              ) AS weight_kg,
              COALESCE(
                s.washing_group,
                IF(LOWER(oi.service_name) LIKE '%towel%', 'TOWEL', 'GENERAL')
              ) AS washing_group,
              -- The same rule the eligibility read uses, on the LOCKED row.
              -- Re-derived here rather than trusted from the request, so a
              -- stale distribution cannot commit colour or soaking pieces.
              ${BATCHABLE_QUANTITY_SQL} AS batchable_quantity
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
         LEFT JOIN services s ON s.id = oi.service_id
         LEFT JOIN pending_item pi ON pi.order_item_id = oi.id
        WHERE oi.id IN (${allItemIds.map(() => '?').join(', ')})
        ORDER BY oi.id ASC
          FOR UPDATE`,
      allItemIds
    );
    const lines = new Map<string, any>(lineRows.map((row: any) => [String(row.order_item_id), row]));

    // For PRINT TAG. Read only — not part of the FOR UPDATE lock above, so it
    // does not widen what this transaction locks.
    const orderIds: string[] = Array.from(new Set(lineRows.map((row: any) => String(row.order_id))));
    const [establishmentRows]: any = await connection.execute(
      `SELECT o.id AS order_id,
              COALESCE(NULLIF(TRIM(b.establishment_name), ''), b.name) AS establishment_name
         FROM orders o
         JOIN business_users bu ON bu.id = o.business_user_id
         JOIN businesses b ON b.id = bu.business_id
        WHERE o.id IN (${orderIds.map(() => '?').join(', ')})`,
      orderIds
    );
    const establishmentByOrderId = new Map<string, string>(
      establishmentRows.map((row: any) => [String(row.order_id), row.establishment_name || ''])
    );

    for (const id of allItemIds) {
      const line = lines.get(id);
      if (!line) throw new AppError(`Order item ${id} no longer exists.`, 404);

      // THE APPROVAL CHECK, again, on the locked row. This is the rule the
      // requirement says must not live in the frontend, and it is the same
      // rule the eligibility query uses.
      if (String(line.order_status) !== BATCHABLE_ORDER_STATUS || !line.accepted_at) {
        throw new AppError(
          `Order ${line.order_number} is ${String(line.order_status).replace(/_/g, ' ')} ` +
            'and is no longer eligible for batching. Regenerate the distribution.',
          409
        );
      }
      if (Number(line.weight_kg) <= 0) {
        throw new AppError(
          `${line.item_name} on order ${line.order_number} has no recorded weight and cannot be batched.`,
          409
        );
      }
    }

    /* ---- 3. Enough PIECES left, counted on the locked rows ---- */
    /*
     * Under 036 this asked "is this line already batched?" and refused if so.
     * A line is splittable now, so the question is a count: how many pieces of
     * it are already in a live drum, and are there enough left for what is
     * being asked? Over-committing a line is the one thing that must not get
     * through — it would put more pieces in drums than the customer handed
     * over — so it is checked here on locked rows, and again by the unique key
     * on batch_garments.active_garment_id when the pieces are claimed.
     */
    const [takenRows]: any = await connection.execute(
      `SELECT boi.active_order_item_id AS order_item_id,
              SUM(boi.quantity) AS pieces
         FROM batch_order_items boi
        WHERE boi.active_order_item_id IN (${allItemIds.map(() => '?').join(', ')})
        GROUP BY boi.active_order_item_id
          FOR UPDATE`,
      allItemIds
    );
    const alreadyBatched = new Map<string, number>(
      takenRows.map((row: any) => [String(row.order_item_id), Number(row.pieces || 0)])
    );

    /**
     * Pieces of each line still free to batch, before this confirmation.
     *
     * COUNTED AGAINST THE BATCHABLE PIECES, not the ordered ones. This is the
     * gate that decides what actually goes into a drum, so it is where the
     * colour-and-soaking exclusion has to hold: a distribution generated
     * before the line was counted, or computed by any other caller, still
     * cannot commit a piece this rule excludes.
     */
    const piecesLeft = new Map<string, number>();
    for (const id of allItemIds) {
      const line = lines.get(id);
      const batchable = Number(line.batchable_quantity || 0);
      piecesLeft.set(id, Math.max(0, batchable - (alreadyBatched.get(id) || 0)));
    }

    // Resolve "everything left" now that the real figure is known, then check
    // the TOTAL asked across every batch in this one confirmation.
    const askedPerLine = new Map<string, number>();
    for (const perLine of requested) {
      for (const [id, pieces] of perLine) {
        const resolved = pieces === WHOLE_LINE ? piecesLeft.get(id) || 0 : pieces;
        perLine.set(id, resolved);
        askedPerLine.set(id, (askedPerLine.get(id) || 0) + resolved);
      }
    }

    for (const id of allItemIds) {
      const line = lines.get(id);
      const left = piecesLeft.get(id) || 0;
      const asked = askedPerLine.get(id) || 0;

      if (left === 0) {
        throw new AppError(
          `Every piece of ${line.item_name} on order ${line.order_number} is already in a batch. ` +
            'Regenerate the distribution.',
          409
        );
      }
      if (asked > left) {
        throw new AppError(
          `${line.item_name} on order ${line.order_number}: ${asked} piece(s) requested but only ` +
            `${left} are left to batch. Regenerate the distribution.`,
          409
        );
      }
    }

    // A resolved request of 0 means the line had nothing left; drop it rather
    // than writing an empty batch line.
    for (const perLine of requested) {
      for (const [id, pieces] of [...perLine]) if (pieces <= 0) perLine.delete(id);
    }
    if (requested.some((perLine) => perLine.size === 0)) {
      throw new AppError('A batch cannot be empty. Regenerate the distribution.', 409);
    }

    /* ---- 4. Capacity and washing-group rules, on the DATABASE's numbers ---- */
    const created: BatchRecord[] = [];
    let grandTotal = 0;

    for (let batchIndex = 0; batchIndex < input.length; batchIndex += 1) {
      const batch = input[batchIndex];
      const perLine = requested[batchIndex];
      const machine = machines.get(String(batch.machineId));
      const capacity = Number(machine.capacity_kg);

      /**
       * What this drum takes from each line, with the weight of exactly those
       * pieces. The weight is the LINE's own per-piece weight — never a figure
       * the request sent — so a split cannot assert a lighter load than it is.
       */
      const takes = [...perLine.entries()].map(([id, pieces]) => {
        const line = lines.get(id);
        const ordered = Math.max(1, Number(line.quantity || 0));
        const perPieceKg = Number(line.weight_kg) / ordered;
        return {
          line,
          pieces,
          weightKg: Math.round(pieces * perPieceKg * 1000) / 1000,
          isPartial: pieces < ordered,
        };
      });

      const groups = new Set<string>(takes.map((t) => String(t.line.washing_group)));
      if (groups.size > 1) {
        // TOWEL ISOLATION, enforced at the point of writing and not only at
        // the point of planning. A crafted request that mixes a towel with a
        // bedsheet is refused here even though the optimiser would never
        // have proposed it.
        throw new AppError(
          'A batch cannot mix washing groups — towels wash only with other towels.',
          400
        );
      }
      const washingGroup = String(takes[0].line.washing_group) as WashingGroup;

      const totalWeight =
        Math.round(takes.reduce((sum, t) => sum + t.weightKg, 0) * 1000) / 1000;
      if (totalWeight > capacity) {
        throw new AppError(
          `${machine.name} holds ${capacity} kg and this batch weighs ${totalWeight} kg.`,
          400
        );
      }

      const batchNumber = await nextBatchNumber(connection);

      const [insert]: any = await connection.execute(
        `INSERT INTO laundry_batches
           (batch_number, machine_id, washing_group, capacity_kg, total_weight_kg,
            item_count, status, created_by, confirmed_at)
         VALUES (?, ?, ?, ?, ?, ?, 'CONFIRMED', ?, NOW())`,
        [
          batchNumber,
          machine.id,
          washingGroup,
          capacity,
          totalWeight,
          takes.length,
          sorterUserId,
        ]
      );
      const batchId = String(insert.insertId);

      for (const take of takes) {
        const item = take.line;
        await connection.execute(
          `INSERT INTO batch_order_items
             (batch_id, order_id, order_item_id, active_order_item_id, quantity, weight_kg)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            batchId,
            item.order_id,
            item.order_item_id,
            // Mirrors order_item_id while the batch is live. No longer unique:
            // a split line has one live row per drum it is in. What IS unique
            // is the piece, claimed just below.
            item.order_item_id,
            take.pieces,
            take.weightKg,
          ]
        );

        /*
         * CLAIM THE INDIVIDUAL PIECES.
         *
         * This is what makes a split real to the barcode scanner: it is these
         * rows, not the line, that answer "is this garment in this batch?".
         * The pieces taken are the lowest-numbered ones not already claimed by
         * a live batch, locked here so two Sorters splitting the same line at
         * the same instant cannot both take the same towel — and if they race
         * past this lock, uk_bg_active_garment refuses the second write.
         */
        const [freeGarments]: any = await connection.execute(
          `SELECT g.id, g.order_id
             FROM order_garments g
            WHERE g.order_item_id = ?
              AND NOT EXISTS (
                    SELECT 1 FROM batch_garments bg WHERE bg.active_garment_id = g.id)
            ORDER BY g.piece_no ASC, g.id ASC
            LIMIT ${Math.floor(take.pieces)}
              FOR UPDATE`,
          [item.order_item_id]
        );

        if (freeGarments.length < take.pieces) {
          throw new AppError(
            `${item.item_name} on order ${item.order_number} has ${freeGarments.length} ` +
              `unbatched piece(s) but ${take.pieces} were requested. Regenerate the distribution.`,
            409
          );
        }

        for (const garment of freeGarments) {
          await connection.execute(
            `INSERT INTO batch_garments
               (batch_id, garment_id, order_id, order_item_id, active_garment_id)
             VALUES (?, ?, ?, ?, ?)`,
            [batchId, garment.id, garment.order_id, item.order_item_id, garment.id]
          );
        }
      }

      // The machine is now spoken for. Re-read as AVAILABLE by the next
      // optimisation only once it is released.
      await connection.execute(
        `UPDATE machines SET status = 'IN_USE', updated_at = NOW() WHERE id = ?`,
        [machine.id]
      );

      /*
       * AUDIT ON THE ORDER, WITHOUT MOVING THE ORDER.
       *
       * One history row per order in the batch, written with the order's OWN
       * CURRENT STATUS. The order does not change status by being batched —
       * it is still at the facility, which is what RECEIVED_AT_FACILITY says —
       * so the row records what happened and moves nothing. The existing
       * tracking timeline reads status, notes and created_at and simply sees
       * one more entry.
       */
      const seen = new Set<string>();
      for (const { line: item } of takes) {
        const orderId = String(item.order_id);
        if (seen.has(orderId)) continue;
        seen.add(orderId);
        await connection.execute(
          `INSERT INTO order_status_history (order_id, status, notes, changed_by)
           VALUES (?, ?, ?, ?)`,
          [
            orderId,
            item.order_status,
            `Added to wash batch ${batchNumber} on ${machine.name} ` +
              `(${washingGroup === 'TOWEL' ? 'towel' : 'general'} load, ` +
              `${totalWeight}/${capacity} kg)`,
            sorterUserId,
          ]
        );
      }

      grandTotal += totalWeight;
      created.push({
        id: batchId,
        batch_number: batchNumber,
        machine_id: String(machine.id),
        machine_code: machine.code,
        machine_name: machine.name,
        capacity_kg: capacity,
        washing_group: washingGroup,
        total_weight_kg: totalWeight,
        item_count: takes.length,
        status: 'CONFIRMED',
        utilization_percentage: Math.round((totalWeight / capacity) * 10000) / 100,
        created_by: String(sorterUserId),
        confirmed_at: new Date(),
        completed_at: null,
        created_at: new Date(),
        // The pieces THIS drum holds, not the whole line. A split line
        // reports 13 here and 37 on its other batch.
        items: takes.map(({ line: item, pieces, weightKg, isPartial }) => ({
          id: String(item.order_item_id),
          order_id: String(item.order_id),
          order_number: item.order_number,
          order_item_id: String(item.order_item_id),
          item_name: item.item_name,
          quantity: pieces,
          weight_kg: weightKg,
          is_partial: isPartial,
          ordered_quantity: Number(item.quantity),
          establishment_name: establishmentByOrderId.get(String(item.order_id)) || '',
        })),
      });
    }

    await connection.commit();

    logger.info(
      `[BatchOptimizer] CONFIRM by user ${sorterUserId}: ${created.length} batch(es), ` +
        `${Math.round(grandTotal * 1000) / 1000} kg — ` +
        created.map((b) => `${b.batch_number} ${b.utilization_percentage}%`).join(', ')
    );

    return { batches: created, total_weight_kg: Math.round(grandTotal * 1000) / 1000 };
  } catch (error: any) {
    await connection.rollback();
    // The unique key on active_order_item_id fired: another Sorter's
    // confirmation committed first. Same situation as the check above, and
    // the same answer — regenerate.
    if (error?.code === 'ER_DUP_ENTRY') {
      throw new AppError(
        'Another sorter batched one of these items a moment ago. Regenerate the distribution.',
        409
      );
    }
    throw error;
  } finally {
    connection.release();
  }
}

/* ===================================================================
 * BATCH READS
 * =================================================================== */

const BATCH_SELECT = `
  SELECT b.id, b.batch_number, b.machine_id, b.washing_group, b.capacity_kg,
         b.total_weight_kg, b.item_count, b.status, b.created_by,
         b.confirmed_at, b.completed_at, b.created_at,
         m.code AS machine_code, m.name AS machine_name
    FROM laundry_batches b
    JOIN machines m ON m.id = b.machine_id`;

function toBatch(row: any): BatchRecord {
  const capacity = Number(row.capacity_kg);
  const total = Number(row.total_weight_kg);
  return {
    id: String(row.id),
    batch_number: row.batch_number,
    machine_id: String(row.machine_id),
    machine_code: row.machine_code,
    machine_name: row.machine_name,
    capacity_kg: capacity,
    washing_group: row.washing_group,
    total_weight_kg: total,
    item_count: Number(row.item_count),
    status: row.status,
    utilization_percentage: capacity > 0 ? Math.round((total / capacity) * 10000) / 100 : 0,
    created_by: row.created_by === null ? null : String(row.created_by),
    confirmed_at: row.confirmed_at,
    completed_at: row.completed_at,
    created_at: row.created_at,
  };
}

/**
 * The batches, newest first. `status` narrows the list; the default is the
 * live ones, which is what the shop floor is working on.
 */
async function listBatches(status?: string, limit = 50): Promise<BatchRecord[]> {
  const statuses = status
    ? [status.toUpperCase()]
    : (LIVE_BATCH_STATUSES.filter((s) => s !== 'COMPLETED') as unknown as string[]);
  const capped = Math.min(Math.max(limit, 1), 200);

  const result = await query<any>(
    `${BATCH_SELECT}
      WHERE b.status IN (${statuses.map(() => '?').join(', ')})
      ORDER BY b.id DESC
      LIMIT ${capped}`,
    statuses
  );
  return result.rows.map(toBatch);
}

/** One batch, with the order lines in it. */
async function getBatchById(batchId: string): Promise<BatchRecord> {
  const result = await query<any>(`${BATCH_SELECT} WHERE b.id = ?`, [batchId]);
  const row = result.rows[0];
  if (!row) throw new AppError('Batch not found', 404);

  const items = await query<any>(
    `SELECT boi.id, boi.order_id, boi.order_item_id, boi.quantity, boi.weight_kg,
            o.order_number, oi.service_name AS item_name,
            COALESCE(oi.original_quantity, oi.quantity) AS ordered_quantity,
            COALESCE(NULLIF(TRIM(b.establishment_name), ''), b.name) AS establishment_name
       FROM batch_order_items boi
       JOIN orders o ON o.id = boi.order_id
       JOIN order_items oi ON oi.id = boi.order_item_id
       JOIN business_users bu ON bu.id = o.business_user_id
       JOIN businesses b ON b.id = bu.business_id
      WHERE boi.batch_id = ?
      ORDER BY boi.id ASC`,
    [batchId]
  );

  return {
    ...toBatch(row),
    items: items.rows.map((item) => {
      const inBatch = Number(item.quantity);
      const ordered = Number(item.ordered_quantity || inBatch);
      return {
        id: String(item.id),
        order_id: String(item.order_id),
        order_number: item.order_number,
        order_item_id: String(item.order_item_id),
        item_name: item.item_name,
        quantity: inBatch,
        weight_kg: Number(item.weight_kg),
        is_partial: inBatch < ordered,
        ordered_quantity: ordered,
        establishment_name: item.establishment_name || '',
      };
    }),
  };
}

/* ===================================================================
 * BATCH STATUS
 * =================================================================== */

/**
 * The batch lifecycle after confirmation.
 *
 * CANCELLED is reachable from anything unfinished, and it is the only way a
 * line returns to the eligible pool.
 */
const BATCH_TRANSITIONS: Record<BatchStatus, BatchStatus[]> = {
  PROPOSED: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['IN_MACHINE', 'CANCELLED'],
  IN_MACHINE: ['WASHING', 'CANCELLED'],
  WASHING: ['COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
};

/**
 * Moves a batch, and the machine with it.
 *
 * COMPLETED and CANCELLED both free the machine, because in both cases the
 * drum is no longer holding that load. CANCELLED additionally releases the
 * order lines by clearing `active_order_item_id`, which is what lets them
 * appear in the next optimisation — the history row stays, so what was
 * cancelled is still on the record.
 */
async function updateBatchStatus(
  batchId: string,
  targetStatus: string,
  sorterUserId: string
): Promise<BatchRecord> {
  const target = String(targetStatus || '').toUpperCase() as BatchStatus;
  if (!(target in BATCH_TRANSITIONS)) {
    throw new AppError(
      `Unknown batch status. Allowed: ${Object.keys(BATCH_TRANSITIONS).join(', ')}`,
      400
    );
  }

  const connection = await getClient();
  try {
    await connection.beginTransaction();

    const [rows]: any = await connection.execute(
      `SELECT id, batch_number, machine_id, status FROM laundry_batches WHERE id = ? FOR UPDATE`,
      [batchId]
    );
    const batch = rows[0];
    if (!batch) throw new AppError('Batch not found', 404);

    const current = String(batch.status) as BatchStatus;
    if (!BATCH_TRANSITIONS[current].includes(target)) {
      throw new AppError(
        `Cannot move a batch from ${current} to ${target}.` +
          (BATCH_TRANSITIONS[current].length
            ? ` Allowed next: ${BATCH_TRANSITIONS[current].join(', ')}.`
            : ' This batch is finished.'),
        409
      );
    }

    await connection.execute(
      `UPDATE laundry_batches
          SET status = ?, completed_at = IF(? = 'COMPLETED', NOW(), completed_at), updated_at = NOW()
        WHERE id = ?`,
      [target, target, batchId]
    );

    if (target === 'COMPLETED' || target === 'CANCELLED') {
      // Free the drum. Only if it is still holding THIS batch — a machine
      // someone put into maintenance meanwhile is left as it is.
      await connection.execute(
        `UPDATE machines SET status = 'AVAILABLE', updated_at = NOW()
          WHERE id = ? AND status = 'IN_USE'`,
        [batch.machine_id]
      );
    }

    if (target === 'CANCELLED') {
      // Release the lines back to the eligible pool. The rows stay, so the
      // batch's contents remain auditable.
      await connection.execute(
        `UPDATE batch_order_items SET active_order_item_id = NULL WHERE batch_id = ?`,
        [batchId]
      );
      // And the PIECES with them. Without this the garments of a cancelled
      // batch would stay claimed by uk_bg_active_garment and could never be
      // batched again — the per-piece equivalent of the line release above.
      await connection.execute(
        `UPDATE batch_garments SET active_garment_id = NULL WHERE batch_id = ?`,
        [batchId]
      );
    }

    await connection.commit();
    logger.info(
      `[BatchOptimizer] Batch ${batch.batch_number} ${current} -> ${target} by user ${sorterUserId}`
    );

    return await getBatchById(batchId);
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

/** Sets a machine's status directly, for maintenance and the like. */
async function updateMachineStatus(
  machineId: string,
  status: string,
  sorterUserId: string
): Promise<MachineRecord> {
  const target = String(status || '').toUpperCase();
  const allowed = ['AVAILABLE', 'IN_USE', 'MAINTENANCE', 'OFFLINE', 'COMPLETED'];
  if (!allowed.includes(target)) {
    throw new AppError(`Unknown machine status. Allowed: ${allowed.join(', ')}`, 400);
  }

  const connection = await getClient();
  try {
    await connection.beginTransaction();

    const [rows]: any = await connection.execute(
      `SELECT id, name, status FROM machines WHERE id = ? FOR UPDATE`,
      [machineId]
    );
    const machine = rows[0];
    if (!machine) throw new AppError('Machine not found', 404);

    // A drum with a live load in it cannot be declared free by hand: the
    // batch has to be completed or cancelled, which frees it properly.
    if (target === 'AVAILABLE') {
      const [live]: any = await connection.execute(
        `SELECT batch_number FROM laundry_batches
          WHERE machine_id = ? AND status IN ('CONFIRMED','IN_MACHINE','WASHING')
          LIMIT 1`,
        [machineId]
      );
      if (live.length > 0) {
        throw new AppError(
          `${machine.name} still holds batch ${live[0].batch_number}. ` +
            'Complete or cancel that batch to free the machine.',
          409
        );
      }
    }

    await connection.execute(
      `UPDATE machines SET status = ?, updated_at = NOW() WHERE id = ?`,
      [target, machineId]
    );
    await connection.commit();

    logger.info(
      `[BatchOptimizer] Machine ${machine.name} ${machine.status} -> ${target} by user ${sorterUserId}`
    );

    const refreshed = await query<any>(
      `SELECT id, code, name, capacity_kg, status FROM machines WHERE id = ?`,
      [machineId]
    );
    return toMachine(refreshed.rows[0]);
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

/* ===================================================================
 * BATCH BARCODE SCANNING
 * ===================================================================
 *
 * The existing scanner is NOT modified. `garment.service.ts` still owns
 * ACCEPTANCE and DELIVERY, still counts them the same way and still refuses
 * the same things; nothing below reads or writes an ACCEPTANCE or DELIVERY
 * row.
 *
 * What is added is a THIRD stage in the SAME `garment_scans` table — one
 * scanning system, not two. The (garment_id, stage) unique key that makes a
 * garment count once per stage does the same job for BATCH, and the batch's
 * own `batch_order_items` rows are what "belongs to this batch" means.
 */

export interface BatchScanStatus {
  batch_id: string;
  batch_number: string;
  status: BatchStatus;
  expected_count: number;
  scanned_count: number;
  remaining_count: number;
  quantity_matched: boolean;
  garments: Array<{
    id: string;
    barcode: string;
    item_name: string;
    order_id: string;
    order_number: string;
    scanned_at: Date | null;
  }>;
}

async function getBatchScanStatus(batchId: string): Promise<BatchScanStatus> {
  const batchResult = await query<any>(
    `SELECT id, batch_number, status FROM laundry_batches WHERE id = ?`,
    [batchId]
  );
  const batch = batchResult.rows[0];
  if (!batch) throw new AppError('Batch not found', 404);

  /*
   * Expected is the PIECES the batch was built from, and since a line can be
   * split those pieces are named individually in `batch_garments` rather than
   * inferred from the line. Joining through the LINE, as this did under 036,
   * would make both halves of a split line report the whole line and neither
   * would ever reach QUANTITY MATCH.
   *
   * Counted from `batch_order_items.quantity` still, so a batch whose garment
   * rows were never written reads as a mismatch instead of silently passing —
   * the same principle the acceptance scan uses.
   */
  const expectedResult = await query<{ expected: number }>(
    `SELECT COALESCE(SUM(quantity), 0) AS expected FROM batch_order_items WHERE batch_id = ?`,
    [batchId]
  );
  const expected = Number(expectedResult.rows[0]?.expected || 0);

  const garmentsResult = await query<any>(
    `SELECT g.id, g.barcode, g.item_name, g.order_id, o.order_number,
            (SELECT s.scanned_at FROM garment_scans s
              WHERE s.garment_id = g.id AND s.stage = 'BATCH') AS scanned_at
       FROM batch_garments bg
       JOIN order_garments g ON g.id = bg.garment_id
       JOIN orders o ON o.id = g.order_id
      WHERE bg.batch_id = ?
      ORDER BY g.id ASC`,
    [batchId]
  );

  const garments = garmentsResult.rows.map((row) => ({
    id: String(row.id),
    barcode: row.barcode,
    item_name: row.item_name,
    order_id: String(row.order_id),
    order_number: row.order_number,
    scanned_at: row.scanned_at,
  }));

  const scanned = garments.filter((g) => g.scanned_at).length;

  return {
    batch_id: String(batch.id),
    batch_number: batch.batch_number,
    status: batch.status,
    expected_count: expected,
    scanned_count: scanned,
    remaining_count: Math.max(expected - scanned, 0),
    quantity_matched: expected > 0 && scanned === expected,
    garments,
  };
}

export interface BatchScanResult {
  success: true;
  barcode: string;
  garment: { id: string; item_name: string; order_number: string };
  batch_id: string;
  batch_number: string;
  scannedCount: number;
  expectedCount: number;
  remainingCount: number;
  quantityMatched: boolean;
  message: string;
}

/**
 * One barcode, against one batch.
 *
 * The three answers the requirement names, and each is a distinct error so
 * the scanner can show the right one:
 *
 *   ACCEPTED        the garment's line is in this batch and it had not been
 *                   scanned for the batch stage yet.
 *   WRONG BATCH     the barcode is real, but its line is not in this batch —
 *                   and if it is in a different live batch, the message says
 *                   which. A garment from another batch is never accepted.
 *   ALREADY SCANNED this garment has already been counted for this batch.
 *
 * Counting is a COUNT over the scan table, never an increment the client
 * sends, so a repeated read of the same label cannot inflate it.
 */
async function scanBatchGarment(
  batchId: string,
  barcodeInput: string,
  sorterUserId: string
): Promise<BatchScanResult> {
  const barcode = String(barcodeInput || '').trim();
  if (!barcode) throw new AppError('No barcode was read. Please try again.', 400);

  const connection = await getClient();
  try {
    await connection.beginTransaction();

    const [batchRows]: any = await connection.execute(
      `SELECT id, batch_number, status FROM laundry_batches WHERE id = ? FOR UPDATE`,
      [batchId]
    );
    const batch = batchRows[0];
    if (!batch) throw new AppError('Batch not found', 404);
    if (!['CONFIRMED', 'IN_MACHINE', 'WASHING'].includes(String(batch.status))) {
      throw new AppError(
        `Batch ${batch.batch_number} is ${String(batch.status).toLowerCase()} and is no longer being loaded.`,
        409
      );
    }

    // Global lookup, which is what separates "belongs to another batch" from
    // "not a registered barcode at all".
    const [garmentRows]: any = await connection.execute(
      `SELECT id, order_id, order_item_id, item_name FROM order_garments WHERE barcode = ? FOR UPDATE`,
      [barcode]
    );
    const garment = garmentRows[0];
    if (!garment) throw new AppError('Barcode not registered.', 404);

    /*
     * MEMBERSHIP IS PER PIECE, not per line.
     *
     * Under 036 this asked whether the garment's LINE was in this batch, which
     * was equivalent while a line could only be in one drum. With splitting it
     * is not: 13 of 50 towels being here says nothing about THIS towel. So the
     * question is asked of the piece itself.
     */
    const [belongs]: any = await connection.execute(
      `SELECT id FROM batch_garments WHERE batch_id = ? AND garment_id = ?`,
      [batchId, garment.id]
    );
    if (belongs.length === 0) {
      // Name the batch it does belong to when there is one — on a shop floor
      // that is the difference between a useful message and a shrug.
      const [other]: any = await connection.execute(
        `SELECT b.batch_number
           FROM batch_garments bg
           JOIN laundry_batches b ON b.id = bg.batch_id
          WHERE bg.active_garment_id = ?
          LIMIT 1`,
        [garment.id]
      );
      throw new AppError(
        other.length > 0
          ? `WRONG BATCH — this garment belongs to batch ${other[0].batch_number}.`
          : 'WRONG BATCH — this garment is not part of this batch.',
        409
      );
    }

    const [existing]: any = await connection.execute(
      `SELECT id FROM garment_scans WHERE garment_id = ? AND stage = 'BATCH'`,
      [garment.id]
    );
    if (existing.length > 0) {
      throw new AppError('ALREADY SCANNED — this garment has been counted for this batch.', 409);
    }

    await connection.execute(
      `INSERT INTO garment_scans (order_id, garment_id, barcode, stage, scanned_by)
       VALUES (?, ?, ?, 'BATCH', ?)`,
      [garment.order_id, garment.id, barcode, sorterUserId]
    );

    const [countRows]: any = await connection.execute(
      `SELECT COUNT(*) AS n
         FROM garment_scans s
         JOIN order_garments g ON g.id = s.garment_id
         JOIN batch_order_items boi ON boi.order_item_id = g.order_item_id
        WHERE boi.batch_id = ? AND s.stage = 'BATCH'`,
      [batchId]
    );
    const [expectedRows]: any = await connection.execute(
      `SELECT COALESCE(SUM(quantity), 0) AS expected FROM batch_order_items WHERE batch_id = ?`,
      [batchId]
    );
    const [orderRows]: any = await connection.execute(
      `SELECT order_number FROM orders WHERE id = ?`,
      [garment.order_id]
    );

    await connection.commit();

    const scannedCount = Number(countRows[0].n);
    const expectedCount = Number(expectedRows[0].expected);
    const remainingCount = Math.max(expectedCount - scannedCount, 0);
    const quantityMatched = expectedCount > 0 && scannedCount === expectedCount;

    return {
      success: true,
      barcode,
      garment: {
        id: String(garment.id),
        item_name: garment.item_name,
        order_number: orderRows[0]?.order_number || '',
      },
      batch_id: String(batch.id),
      batch_number: batch.batch_number,
      scannedCount,
      expectedCount,
      remainingCount,
      quantityMatched,
      message: quantityMatched
        ? 'QUANTITY MATCH'
        : `ACCEPTED — ${garment.item_name}. ${remainingCount} remaining.`,
    };
  } catch (error: any) {
    await connection.rollback();
    if (error?.code === 'ER_DUP_ENTRY') {
      throw new AppError('ALREADY SCANNED — this garment has been counted for this batch.', 409);
    }
    throw error;
  } finally {
    connection.release();
  }
}

export {
  getBatchEligibility,
  optimizeBatches,
  confirmBatches,
  listBatches,
  listMachines,
  getBatchById,
  updateBatchStatus,
  updateMachineStatus,
  getBatchScanStatus,
  scanBatchGarment,
  WINDOW as OPTIMIZATION_WINDOW,
};
