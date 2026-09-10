import { query } from '../config/database';
import { AppError } from '../utils/appError';
import { logger } from '../utils/logger';
import { saveBase64Image, absolutePathForUrl } from '../utils/fileStorage';
import {
  sendDefectTemplate,
  sendDefectDetailTemplate,
  sendImageWithCaption,
  uploadMedia,
  toWhatsAppNumber,
  isWhatsAppConfigured,
} from './whatsapp.service';
import { config } from '../config/env';

/**
 * Defective-piece reporting.
 *
 * A Sorter photographs a damaged garment; the photo is stored on disk, a row
 * records the defect against the order — and, when the report came from Mark
 * as Defective, against the ORDER LINE — and the people who need to know are
 * notified over WhatsApp.
 *
 * The photo is saved before WhatsApp is attempted, and the row is written
 * whatever Meta answers. A failed notification therefore never loses the
 * evidence — it leaves a FAILED row that can be retried.
 */

/** The four people a defect report is sent to, and their column prefixes. */
export type DefectRecipientRole = 'customer' | 'sorter' | 'manager' | 'super_admin';

/**
 * The delivery state of one copy.
 *
 * `null` means there is NO SUCH RECIPIENT for this order — no manager
 * accepted it, or no Super Admin has a number on file. That is not a failure,
 * and it is deliberately distinguished from FAILED: a deployment with no
 * manager account must not make every defect report read as undelivered. The
 * matching `_error` column carries the reason either way.
 */
export type DefectWhatsAppStatus = 'PENDING' | 'SENT' | 'FAILED';

export interface DefectRecord {
  id: string;
  order_id: string;
  /** The line this defect is about, or null when it is about the order. */
  order_item_id: string | null;
  /** Pieces reported defective with this photo; null when none was given. */
  defective_quantity: number | null;
  /**
   * How that total divides between the two colours, as typed into Mark
   * Defective.
   *
   * NULL is "not split", not zero: reports taken before these were recorded
   * carry no division, and `defective_quantity` remains the figure that is
   * populated on every row.
   */
  white_defective_quantity: number | null;
  color_defective_quantity: number | null;
  photo_url: string;
  description: string | null;
  reported_by: string | null;
  reported_at: Date;
  whatsapp_status: DefectWhatsAppStatus;
  whatsapp_message_id: string | null;
  whatsapp_error: string | null;
  whatsapp_sent_at: Date | null;
  whatsapp_to: string | null;
  /**
   * The identical message sent to the Sorter who reported the defect.
   * null status means no attempt has been made for this row yet.
   */
  sorter_whatsapp_status: DefectWhatsAppStatus | null;
  sorter_whatsapp_message_id: string | null;
  sorter_whatsapp_error: string | null;
  sorter_whatsapp_sent_at: Date | null;
  sorter_whatsapp_to: string | null;
  /** The Manager copy. null status = no manager to send to; see above. */
  manager_whatsapp_status: DefectWhatsAppStatus | null;
  manager_whatsapp_message_id: string | null;
  manager_whatsapp_error: string | null;
  manager_whatsapp_sent_at: Date | null;
  manager_whatsapp_to: string | null;
  /** The Super Admin copy. null status = no Super Admin to send to. */
  super_admin_whatsapp_status: DefectWhatsAppStatus | null;
  super_admin_whatsapp_message_id: string | null;
  super_admin_whatsapp_error: string | null;
  super_admin_whatsapp_sent_at: Date | null;
  super_admin_whatsapp_to: string | null;
}

/**
 * The column prefix each recipient's delivery state lives under.
 *
 * The customer's columns are unprefixed because they were the first and only
 * ones; renaming them would rewrite every existing reader for no gain.
 */
const COLUMNS: Record<DefectRecipientRole, {
  status: string;
  messageId: string;
  error: string;
  sentAt: string;
  to: string;
}> = {
  customer: {
    status: 'whatsapp_status',
    messageId: 'whatsapp_message_id',
    error: 'whatsapp_error',
    sentAt: 'whatsapp_sent_at',
    to: 'whatsapp_to',
  },
  sorter: {
    status: 'sorter_whatsapp_status',
    messageId: 'sorter_whatsapp_message_id',
    error: 'sorter_whatsapp_error',
    sentAt: 'sorter_whatsapp_sent_at',
    to: 'sorter_whatsapp_to',
  },
  manager: {
    status: 'manager_whatsapp_status',
    messageId: 'manager_whatsapp_message_id',
    error: 'manager_whatsapp_error',
    sentAt: 'manager_whatsapp_sent_at',
    to: 'manager_whatsapp_to',
  },
  super_admin: {
    status: 'super_admin_whatsapp_status',
    messageId: 'super_admin_whatsapp_message_id',
    error: 'super_admin_whatsapp_error',
    sentAt: 'super_admin_whatsapp_sent_at',
    to: 'super_admin_whatsapp_to',
  },
};

/** The order in which copies are sent and reported. */
/**
 * WHO A DEFECT REPORT GOES TO: the two people it concerns.
 *
 *   customer  the customer or establishment whose piece was damaged — they
 *             are the ones who have to be told, and the only ones who can
 *             dispute it.
 *   sorter    the sorting desk, which is where the report was raised and
 *             where the piece physically is.
 *
 * THE MANAGER AND SUPER ADMIN COPIES WERE REMOVED DELIBERATELY. A defect is
 * an operational fact between the desk that found it and the customer who
 * owns the garment; copying every report to management turned a working
 * notification into a broadcast, and a WhatsApp message costs money per send.
 *
 * Their columns on `order_defects` are LEFT IN PLACE and simply stay NULL.
 * Dropping them would rewrite history for every report already sent, and
 * restoring a copy later is then a one-line change here rather than a
 * migration.
 */
const ROLES: DefectRecipientRole[] = ['customer', 'sorter'];

/** How each role reads in a message or an error. */
export const ROLE_LABEL: Record<DefectRecipientRole, string> = {
  customer: 'Customer',
  manager: 'Manager',
  super_admin: 'Super Admin',
  sorter: 'Sorter',
};

/**
 * Customer identity for one order, resolved the same way the Sorter queue
 * does, plus what the notification has to name.
 *
 * `customer_contact` is UNCHANGED — the same COALESCE it has always been, so
 * the customer copy still goes exactly where it went before. Everything added
 * here is read for the message text, not for addressing it.
 */
const ORDER_CONTACT_SELECT = `
  SELECT o.id, o.order_number, o.status, o.created_at, o.manager_approved_by,
         COALESCE(b.name, u.name, 'Customer') AS customer_name,
         NULLIF(TRIM(b.establishment_name), '') AS establishment_name,
         -- The business's WHATSAPP number wins over its mobile: a business
         -- that recorded both gave the first one for exactly this. NULLIF
         -- keeps a blank column from beating a real mobile. A customer order
         -- has no business_users row and falls through to the user's mobile,
         -- exactly as before.
         COALESCE(NULLIF(TRIM(bu.whatsapp_number), ''), bu.mobile_number, u.mobile_number)
           AS customer_contact,
         DATE_FORMAT(CONVERT_TZ(o.created_at, '+00:00', ?), '%d %b %Y') AS order_date,
         (SELECT st.name FROM services st WHERE st.id = o.service_id) AS order_service_name
    FROM orders o
    LEFT JOIN business_users bu ON bu.id = o.business_user_id
    LEFT JOIN businesses b ON b.id = bu.business_id
    LEFT JOIN users u ON u.id = o.user_id
   WHERE o.id = ?`;

async function loadOrderContact(orderId: string) {
  const result = await query<any>(ORDER_CONTACT_SELECT, [config.BUSINESS_TZ_OFFSET, orderId]);
  const row = result.rows[0];
  if (!row) {
    throw new AppError('Order not found', 404);
  }
  return row;
}

function toNumberOrNull(value: any): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toRecord(row: any): DefectRecord {
  return {
    id: String(row.id),
    order_id: String(row.order_id),
    order_item_id: row.order_item_id === null || row.order_item_id === undefined
      ? null
      : String(row.order_item_id),
    defective_quantity: toNumberOrNull(row.defective_quantity),
    white_defective_quantity: toNumberOrNull(row.white_defective_quantity),
    color_defective_quantity: toNumberOrNull(row.color_defective_quantity),
    photo_url: row.photo_url,
    description: row.description || null,
    reported_by: row.reported_by === null ? null : String(row.reported_by),
    reported_at: row.reported_at,
    whatsapp_status: row.whatsapp_status,
    whatsapp_message_id: row.whatsapp_message_id || null,
    whatsapp_error: row.whatsapp_error || null,
    whatsapp_sent_at: row.whatsapp_sent_at || null,
    whatsapp_to: row.whatsapp_to || null,
    sorter_whatsapp_status: row.sorter_whatsapp_status || null,
    sorter_whatsapp_message_id: row.sorter_whatsapp_message_id || null,
    sorter_whatsapp_error: row.sorter_whatsapp_error || null,
    sorter_whatsapp_sent_at: row.sorter_whatsapp_sent_at || null,
    sorter_whatsapp_to: row.sorter_whatsapp_to || null,
    manager_whatsapp_status: row.manager_whatsapp_status || null,
    manager_whatsapp_message_id: row.manager_whatsapp_message_id || null,
    manager_whatsapp_error: row.manager_whatsapp_error || null,
    manager_whatsapp_sent_at: row.manager_whatsapp_sent_at || null,
    manager_whatsapp_to: row.manager_whatsapp_to || null,
    super_admin_whatsapp_status: row.super_admin_whatsapp_status || null,
    super_admin_whatsapp_message_id: row.super_admin_whatsapp_message_id || null,
    super_admin_whatsapp_error: row.super_admin_whatsapp_error || null,
    super_admin_whatsapp_sent_at: row.super_admin_whatsapp_sent_at || null,
    super_admin_whatsapp_to: row.super_admin_whatsapp_to || null,
  };
}

/** The status of one copy, read off a record without a switch at every call. */
export function statusOf(
  defect: DefectRecord,
  role: DefectRecipientRole
): DefectWhatsAppStatus | null {
  return (defect as any)[COLUMNS[role].status] ?? null;
}

/** The error recorded against one copy, if any. */
export function errorOf(defect: DefectRecord, role: DefectRecipientRole): string | null {
  return (defect as any)[COLUMNS[role].error] ?? null;
}

async function getDefectById(defectId: string): Promise<DefectRecord> {
  const result = await query<any>(`SELECT * FROM order_defects WHERE id = ?`, [defectId]);
  const row = result.rows[0];
  if (!row) {
    throw new AppError('Defect report not found', 404);
  }
  return toRecord(row);
}

/** Every defect on an order, newest first. */
async function listDefectsForOrder(orderId: string): Promise<DefectRecord[]> {
  const result = await query<any>(
    `SELECT * FROM order_defects WHERE order_id = ? ORDER BY reported_at DESC, id DESC`,
    [orderId]
  );
  return result.rows.map(toRecord);
}

/** The Sorter who reported a defect, for the copy that goes to their phone. */
async function loadSorterContact(sorterUserId: string | null) {
  if (!sorterUserId) return null;
  const result = await query<any>(
    `SELECT id, name, mobile_number FROM users WHERE id = ? LIMIT 1`,
    [sorterUserId]
  );
  return result.rows[0] || null;
}

/**
 * The Manager for this order.
 *
 * FIRST the manager who actually accepted the booking — `manager_approved_by`
 * is the one person who took this order on, so they are the one who needs to
 * hear that a piece in it is damaged. Orders placed before manager approval
 * existed carry no such id, and for those any active Manager account is the
 * right answer, because the role is the recipient rather than the individual.
 *
 * No number is written into this file: both branches read `users`.
 */
async function loadManagerContact(managerUserId: string | null) {
  if (managerUserId) {
    const owned = await query<any>(
      `SELECT id, name, mobile_number FROM users
        WHERE id = ? AND role = 'MANAGER' LIMIT 1`,
      [managerUserId]
    );
    if (owned.rows[0]?.mobile_number) return owned.rows[0];
  }
  const any = await query<any>(
    `SELECT id, name, mobile_number FROM users
      WHERE role = 'MANAGER' AND is_active = 1 AND mobile_number IS NOT NULL
      ORDER BY id ASC LIMIT 1`
  );
  return any.rows[0] || null;
}

/**
 * The Super Admin to tell.
 *
 * Read from the existing accounts, oldest first so a deployment always
 * resolves the same one rather than whichever was created last.
 */
async function loadSuperAdminContact() {
  const result = await query<any>(
    `SELECT id, name, mobile_number FROM users
      WHERE role = 'SUPER_ADMIN' AND is_active = 1 AND mobile_number IS NOT NULL
      ORDER BY id ASC LIMIT 1`
  );
  return result.rows[0] || null;
}

/**
 * WHAT THE DEFECT IS ABOUT, in the words the message uses.
 *
 * Every figure comes from the order's OWN records — the line when the report
 * names one, the order's lines summed when it does not. Nothing is recomputed
 * here and no quantity rule is duplicated: `original_quantity` is the pieces
 * the order was placed for and `defective_quantity` is what the adjustment
 * recorded, exactly as every other reader of `order_items` understands them.
 */
interface DefectDetails {
  orderNumber: string;
  customerName: string;
  establishmentName: string | null;
  orderDate: string;
  itemName: string;
  serviceType: string;
  /** Pieces the order was placed for, on this line or across the order. */
  totalQuantity: number;
  /** Pieces found damaged. */
  defectiveQuantity: number;
  /**
   * How that total divides by colour, as the Sorter typed it.
   *
   * NULL is "not split", not zero — a report filed before the split existed,
   * or one filed against the whole order. The template prints a dash for it
   * rather than a 0 that would read as "none of these were white".
   */
  whiteDefectiveQuantity: number | null;
  colorDefectiveQuantity: number | null;
  reason: string | null;
  reportedBy: string | null;
  /** When the report was filed, in business time. */
  reportedAt: string;
}

async function loadDefectDetails(defect: DefectRecord, order: any): Promise<DefectDetails> {
  let itemName = 'All items';
  let serviceType = order.order_service_name || '—';
  let totalQuantity = 0;
  let defectiveQuantity = 0;

  if (defect.order_item_id) {
    /*
     * ONE LINE, and its service resolved from the most specific answer down:
     *
     *   1. the LINE's own `laundry_service_id`, which is what a booking that
     *      mixes services per item records;
     *   2. the ORDER's service, for an order placed at one service throughout;
     *   3. the item's single supported service, when it has exactly one.
     *
     * Never a guess beyond that: an item offered for several services with
     * nothing recorded has no answer, and the message says so rather than
     * naming one of them.
     */
    const line = await query<any>(
      `SELECT oi.id, oi.service_name AS item_name,
              COALESCE(oi.original_quantity, oi.quantity) AS original_quantity,
              COALESCE(oi.defective_quantity, 0) AS defective_quantity,
              COALESCE(
                (SELECT st.name FROM services st
                  WHERE st.id = oi.laundry_service_id AND st.kind = 'SERVICE_TYPE'),
                (SELECT st.name FROM services st WHERE st.id = o.service_id),
                (SELECT MIN(st.name)
                   FROM item_service_types m
                   JOIN services st ON st.id = m.service_id
                  WHERE m.item_id = oi.service_id
                    AND st.kind = 'SERVICE_TYPE' AND st.is_active = true
                 HAVING COUNT(*) = 1)
              ) AS service_name
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
        WHERE oi.id = ? AND oi.order_id = ?
        LIMIT 1`,
      [defect.order_item_id, defect.order_id]
    );
    const row = line.rows[0];
    if (row) {
      itemName = row.item_name;
      serviceType = row.service_name || serviceType;
      totalQuantity = Number(row.original_quantity || 0);
      defectiveQuantity = Number(row.defective_quantity || 0);
    }
  }

  if (!defect.order_item_id || totalQuantity === 0) {
    // THE WHOLE ORDER — what a report filed against no particular line is
    // about, and the only sound answer for rows written before lines were
    // recorded. Never zero when the order has pieces on it.
    const totals = await query<any>(
      `SELECT COUNT(*) AS lines,
              COALESCE(SUM(COALESCE(original_quantity, quantity)), 0) AS total_quantity,
              COALESCE(SUM(COALESCE(defective_quantity, 0)), 0) AS total_defective,
              MIN(service_name) AS first_item
         FROM order_items WHERE order_id = ?`,
      [defect.order_id]
    );
    const row = totals.rows[0];
    if (row) {
      if (!defect.order_item_id) {
        const lines = Number(row.lines || 0);
        itemName = lines === 1 ? row.first_item : `${lines} item(s) on this order`;
      }
      if (totalQuantity === 0) totalQuantity = Number(row.total_quantity || 0);
      if (defectiveQuantity === 0) defectiveQuantity = Number(row.total_defective || 0);
    }
  }

  /*
   * The count the Sorter reported WITH THIS PHOTO wins over the live line
   * figure: the line can be corrected afterwards, and a message has to
   * describe the report it was sent for. It is still capped at the pieces on
   * the line, so a stale figure can never read as more than were ordered.
   */
  if (defect.defective_quantity !== null && defect.defective_quantity > 0) {
    defectiveQuantity = totalQuantity > 0
      ? Math.min(defect.defective_quantity, totalQuantity)
      : defect.defective_quantity;
  }

  const sorter = await loadSorterContact(defect.reported_by);

  /*
   * WHEN THE REPORT WAS FILED, off the DATABASE clock.
   *
   * `reported_at` is stored in UTC and converted through the same
   * `BUSINESS_TZ_OFFSET` the order date above already uses. Formatting it in
   * Node with `new Date()` instead would introduce a second clock that can
   * disagree with the one the row was stamped with — the reason
   * `utils/istTime.ts` exists at all.
   */
  const stamp = defect.id
    ? await query<any>(
        `SELECT DATE_FORMAT(CONVERT_TZ(reported_at, '+00:00', ?), '%d %b %Y, %h:%i %p')
                  AS reported_at
           FROM order_defects WHERE id = ?`,
        [config.BUSINESS_TZ_OFFSET, defect.id]
      )
    : // The PREVIEW passes a report that has not been filed, so there is no
      // row and no id to read one by. "Now" is what a report filed at this
      // moment would carry, which is what the preview is answering.
      await query<any>(
        `SELECT DATE_FORMAT(CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', ?), '%d %b %Y, %h:%i %p')
                  AS reported_at`,
        [config.BUSINESS_TZ_OFFSET]
      );

  return {
    orderNumber: order.order_number,
    customerName: order.customer_name,
    establishmentName: order.establishment_name || null,
    orderDate: order.order_date || '—',
    itemName,
    serviceType: serviceType || '—',
    totalQuantity,
    defectiveQuantity,
    // Straight off the row: the division the Sorter typed with this photo,
    // not a figure re-derived from the line, which can be edited afterwards.
    whiteDefectiveQuantity: defect.white_defective_quantity,
    colorDefectiveQuantity: defect.color_defective_quantity,
    reason: defect.description || null,
    reportedBy: sorter?.name || null,
    reportedAt: stamp.rows[0]?.reported_at || '—',
  };
}

/**
 * The message body, as one block of text.
 *
 * EVERYTHING THE FORM CAPTURED IS HERE, and both quantities are named
 * separately so "10 ordered, 2 damaged" can never be read as one figure.
 * Lines with nothing behind them are dropped rather than printed as a dash,
 * so a customer order does not carry an empty "Business:" line.
 */
function buildDefectMessage(details: DefectDetails): string {
  const lines: Array<string | null> = [
    'Defective Piece Report',
    '',
    `Order ID: #${details.orderNumber}`,
    `Order Date: ${details.orderDate}`,
    `Customer: ${details.customerName}`,
    details.establishmentName ? `Business: ${details.establishmentName}` : null,
    `Item: ${details.itemName}`,
    `Service Type: ${details.serviceType}`,
    `Total Quantity: ${details.totalQuantity}`,
    `Defective Quantity: ${details.defectiveQuantity}`,
    // Only when the Sorter actually recorded a division. A report without one
    // prints neither line rather than two zeroes.
    details.whiteDefectiveQuantity !== null
      ? `White Quantity: ${details.whiteDefectiveQuantity}`
      : null,
    details.colorDefectiveQuantity !== null
      ? `Colour Quantity: ${details.colorDefectiveQuantity}`
      : null,
    details.reason ? `Reason: ${details.reason}` : null,
    details.reportedBy ? `Reported by: ${details.reportedBy}` : null,
    `Reported at: ${details.reportedAt}`,
  ];
  return lines.filter((line) => line !== null).join('\n');
}

/**
 * The body parameters for WHATSAPP_DEFECT_DETAIL_TEMPLATE.
 *
 * THE ORDER IS THE CONTRACT and is documented in .env.example so an approved
 * template can be built to match. Meta rejects an empty text parameter, so
 * every slot falls back to a dash rather than being left blank.
 */
/**
 * The body parameters for `defective_piece_report`.
 *
 * THE ORDER IS THE CONTRACT — it is the approved template's {{1}}..{{10}} and
 * nothing may be reordered here without the template being re-approved to
 * match. It is documented in .env.example beside the variable that names it.
 *
 *   {{1}}  Order ID           {{6}}  Colour quantity
 *   {{2}}  Customer           {{7}}  Total defective pieces
 *   {{3}}  Cloth type         {{8}}  Remarks
 *   {{4}}  Defective category {{9}}  Reported by
 *   {{5}}  White quantity     {{10}} Date & time
 *
 * {{4}} IS THE SERVICE THE LINE WAS BOOKED FOR — Dry Clean, Wash & Fold — and
 * it is the one slot with no field of its own behind it: the app records no
 * defect category anywhere, and inventing a form field for one would be a UI
 * change this work was not asked to make. The service is used because it is
 * real data that recipients ALREADY see (the captioned-photo path prints
 * "Service Type:"), so mapping it here keeps the information rather than
 * dropping it. Change this one line if the category should read differently.
 *
 * Meta rejects an EMPTY text parameter, so every slot falls back to a dash or
 * a word rather than being left blank — a rejected message would take the
 * photo with it.
 */
function reportTemplateParams(details: DefectDetails): string[] {
  // A split that was never recorded prints as a dash: 0 would assert that
  // none of the damaged pieces were of that colour, which is a different and
  // possibly untrue statement.
  const white =
    details.whiteDefectiveQuantity === null ? '—' : String(details.whiteDefectiveQuantity);
  const colour =
    details.colorDefectiveQuantity === null ? '—' : String(details.colorDefectiveQuantity);

  return [
    `#${details.orderNumber}`,
    details.customerName || '—',
    details.itemName || '—',
    details.serviceType || '—',
    white,
    colour,
    String(details.defectiveQuantity),
    details.reason || 'Not specified',
    details.reportedBy || 'Sorter',
    details.reportedAt || '—',
  ];
}

function detailTemplateParams(details: DefectDetails): string[] {
  return [
    details.customerName || '—',
    details.orderNumber,
    details.orderDate || '—',
    details.establishmentName || '—',
    details.itemName || '—',
    details.serviceType || '—',
    String(details.totalQuantity),
    String(details.defectiveQuantity),
    details.reason || 'Not specified',
    details.reportedBy || 'Sorter',
  ];
}

/** What one attempt produced, before it is written to the row. */
interface Attempt {
  ok: boolean;
  messageId: string | null;
  error: string | null;
  /**
   * WHICH of the delivery paths produced this outcome, for the log line.
   *
   * Recorded rather than inferred: the send falls back through several paths,
   * and "it went out" is not actionable when what matters is whether the
   * approved template was used or a fallback quietly covered for it.
   */
  via?: string;
}

/** Writes one copy's outcome, addressing whichever columns that role owns. */
async function recordAttempt(
  defectId: string,
  role: DefectRecipientRole,
  to: string | null,
  attempt: Attempt
): Promise<void> {
  const c = COLUMNS[role];
  if (attempt.ok) {
    await query(
      `UPDATE order_defects
          SET ${c.status} = 'SENT', ${c.messageId} = ?, ${c.error} = NULL,
              ${c.sentAt} = NOW(), ${c.to} = ?
        WHERE id = ?`,
      [attempt.messageId, to, defectId]
    );
    return;
  }
  await query(
    `UPDATE order_defects
        SET ${c.status} = 'FAILED', ${c.error} = ?, ${c.to} = ?
      WHERE id = ?`,
    [attempt.error ? String(attempt.error).slice(0, 500) : null, to, defectId]
  );
}

/**
 * Records that a role has NO recipient on this order.
 *
 * Status stays NULL — see the note on DefectWhatsAppStatus. The reason is
 * written to the error column so support can see why nothing was sent,
 * without the row claiming a send was attempted and refused.
 */
async function recordNoRecipient(
  defectId: string,
  role: DefectRecipientRole,
  reason: string
): Promise<void> {
  const c = COLUMNS[role];
  await query(
    `UPDATE order_defects SET ${c.status} = NULL, ${c.error} = ?, ${c.to} = NULL WHERE id = ?`,
    [reason.slice(0, 500), defectId]
  );
}

/**
 * Attempts the WhatsApp notification for a defect row and records the real
 * outcome against it.
 *
 * FOUR RECIPIENTS, ONE MESSAGE EACH: the customer, the Manager who took the
 * order on, the Super Admin, and the Sorter who reported it. The photo is
 * uploaded to Meta ONCE and every message references the same media id, so
 * the image never crosses the wire more than once.
 *
 * NOBODY IS MESSAGED TWICE. Two roles that resolve to the SAME phone number —
 * a sorter who is also the manager on a small site — are sent one message and
 * both rows record its outcome. A copy Meta has already accepted is skipped
 * entirely, which is what makes a retry safe.
 *
 * Each copy is tracked in its own columns. That separation matters: a Manager
 * copy that bounces must never make an accepted customer message look failed,
 * and no copy may read as delivered unless Meta actually accepted it.
 */
async function notifyForDefect(defectId: string, orderId: string): Promise<DefectRecord> {
  const defect = await getDefectById(defectId);
  const order = await loadOrderContact(orderId);

  const absolutePath = absolutePathForUrl(defect.photo_url);
  if (!absolutePath) {
    const error = 'The stored defect photo could not be read from disk.';
    for (const role of ROLES) {
      await recordAttempt(defectId, role, null, { ok: false, messageId: null, error });
    }
    return getDefectById(defectId);
  }

  // ---- Who each copy goes to ----
  const sorter = await loadSorterContact(defect.reported_by);
  const manager = await loadManagerContact(
    order.manager_approved_by === null || order.manager_approved_by === undefined
      ? null
      : String(order.manager_approved_by)
  );
  const superAdmin = await loadSuperAdminContact();

  const numbers: Record<DefectRecipientRole, string | null> = {
    customer: toWhatsAppNumber(order.customer_contact),
    /*
     * THE CONFIGURED SORTING-DESK NUMBER FIRST, the reporting Sorter's own
     * only when none is configured.
     *
     * This is the one ordering that changed with the report template: the
     * desk number in WHATSAPP_SORTER_NUMBER is a fixed line that should see
     * every defect report, whereas the reporting Sorter's personal number
     * varies with whoever happened to be on shift. Neither is written into
     * this file — the number lives only in the environment.
     *
     * When both resolve to the same number, the per-number guard below sends
     * one message, not two.
     */
    sorter:
      toWhatsAppNumber(config.WHATSAPP_SORTER_NUMBER) || toWhatsAppNumber(sorter?.mobile_number),
    manager:
      toWhatsAppNumber(manager?.mobile_number) || toWhatsAppNumber(config.WHATSAPP_MANAGER_NUMBER),
    super_admin:
      toWhatsAppNumber(superAdmin?.mobile_number) ||
      toWhatsAppNumber(config.WHATSAPP_SUPER_ADMIN_NUMBER),
  };

  // Nothing to send to at all: record it and stop before Meta.
  if (ROLES.every((role) => !numbers[role])) {
    const error = 'No valid WhatsApp number for any recipient of this order.';
    for (const role of ROLES) {
      await recordAttempt(defectId, role, null, { ok: false, messageId: null, error });
    }
    return getDefectById(defectId);
  }

  // ---- What every copy says ----
  const details = await loadDefectDetails(defect, order);
  const caption = buildDefectMessage(details);
  const detailTemplate = String(config.WHATSAPP_DEFECT_DETAIL_TEMPLATE || '').trim();
  const reportTemplate = String(config.WHATSAPP_DEFECT_REPORT_TEMPLATE || '').trim();

  // Upload once, reuse for every message. A failure here is fatal to all.
  let mediaId: string | null = null;
  let uploadError: string | null = null;
  if (!isWhatsAppConfigured()) {
    uploadError =
      'WhatsApp is not configured on the server (WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_ACCESS_TOKEN).';
  } else {
    try {
      mediaId = await uploadMedia(absolutePath, 'image/jpeg');
    } catch (error: any) {
      uploadError = String(error?.message || 'Photo upload to WhatsApp failed').slice(0, 500);
      logger.warn(`[Defect] media upload failed for order ${order.order_number}: ${uploadError}`);
    }
  }

  /**
   * Sends ONE copy: the photo and every detail, in a single message.
   *
   * FOUR PATHS, in the order of how much they carry, and only ever ONE
   * message per recipient — a path is tried solely because the one before it
   * was NOT delivered:
   *
   *   1. `defective_piece_report`: photo as the IMAGE header, every field the
   *      Sorter entered in the body, deliverable at any time because it is an
   *      approved UTILITY template. This is the one that should be used.
   *   2. An approved detail template, when one is separately configured. Kept
   *      so a deployment that had WHATSAPP_DEFECT_DETAIL_TEMPLATE working
   *      does not lose it.
   *   3. A captioned photo. Same content, no template needed, but Meta only
   *      delivers free-form messages inside the 24-hour service window.
   *   4. The approved defect template the account already has. Photo, name
   *      and order number — less detail, but it always reaches its
   *      recipient, which is why it is the floor and not the ceiling.
   *
   * The photo travels WITH the details in every one of them. There is no path
   * on which the image and the text arrive as two messages.
   */
  const deliver = async (to: string): Promise<Attempt> => {
    if (!mediaId) return { ok: false, messageId: null, error: uploadError };

    if (reportTemplate) {
      const result = await sendDefectDetailTemplate({
        to,
        templateName: reportTemplate,
        mediaId,
        bodyParams: reportTemplateParams(details),
        orderNumber: details.orderNumber,
      });
      if (result.ok) return { ...result, via: `template ${reportTemplate}` };
      // Worth a line of its own: a template rejection is a Meta-side
      // configuration problem, and the fallbacks below can mask it by
      // succeeding.
      logger.warn(
        `[Defect] template "${reportTemplate}" refused for order ${details.orderNumber} → ${to}: ${result.error}`
      );
    }

    if (detailTemplate) {
      const result = await sendDefectDetailTemplate({
        to,
        templateName: detailTemplate,
        mediaId,
        bodyParams: detailTemplateParams(details),
        orderNumber: details.orderNumber,
      });
      if (result.ok) return { ...result, via: `template ${detailTemplate}` };
    }

    const captioned = await sendImageWithCaption({
      to,
      mediaId,
      caption,
      orderNumber: details.orderNumber,
    });
    if (captioned.ok) return { ...captioned, via: 'captioned photo' };

    const templated = await sendDefectTemplate({
      to,
      customerName: details.customerName,
      orderNumber: details.orderNumber,
      mediaId,
    });
    if (templated.ok) return { ...templated, via: `template ${config.WHATSAPP_DEFECT_TEMPLATE}` };

    // Say why the message with the detail in it was refused, not just why the
    // fallback was: the first reason is the one worth acting on.
    return {
      ok: false,
      messageId: null,
      error: `${captioned.error || 'not sent'} (fallback template: ${templated.error || 'not sent'})`,
    };
  };

  /*
   * ONE SEND PER NUMBER. Keyed by the number rather than the role, so two
   * roles sharing a phone produce one message and two identical rows.
   */
  const sentTo = new Map<string, Attempt>();

  for (const role of ROLES) {
    // Already accepted by Meta: never sent again. This is the duplicate
    // guard that makes Retry safe for the copies that did fail.
    if (statusOf(defect, role) === 'SENT') continue;

    const to = numbers[role];
    if (!to) {
      if (role === 'customer' || role === 'sorter') {
        // Unchanged from before: these two have always recorded a missing
        // number as a failed copy, and the endpoint's status code reads them.
        await recordAttempt(defectId, role, null, {
          ok: false,
          messageId: null,
          error: 'No valid WhatsApp number.',
        });
      } else {
        await recordNoRecipient(
          defectId,
          role,
          `No ${ROLE_LABEL[role]} with a mobile number is available for this order.`
        );
      }
      continue;
    }

    const already = sentTo.get(to);
    const attempt = already ?? (await deliver(to));
    if (!already) sentTo.set(to, attempt);
    await recordAttempt(defectId, role, to, attempt);

    /*
     * ONE LINE PER COPY: who it went to, which order, how it was delivered
     * and what Meta said. The timestamp is the logger's own.
     *
     * The number is logged because a report nobody received is investigated
     * by asking which number was tried; it is an ordinary business contact,
     * not a credential, and no token or message body is written here.
     */
    const reused = already ? ' (reused, same number)' : '';
    if (attempt.ok) {
      logger.info(
        `[Defect] order ${details.orderNumber} → ${ROLE_LABEL[role]} ${to}: sent via ` +
          `${attempt.via || 'unknown path'}, message ${attempt.messageId}${reused}`
      );
    } else {
      logger.error(
        `[Defect] order ${details.orderNumber} → ${ROLE_LABEL[role]} ${to}: NOT sent` +
          `${reused} — ${attempt.error || 'no reason reported'}`
      );
    }
  }

  return getDefectById(defectId);
}

/** Kept under the old name so existing callers keep reading naturally. */
const notifyCustomer = notifyForDefect;

/**
 * WHAT WOULD BE SENT, AND TO WHOM — without sending anything.
 *
 * Nothing is written, no media is uploaded and Meta is never called. It runs
 * the same recipient resolution and the same message builder the real send
 * uses, so what it returns is what would actually go out; a second
 * implementation that drifted from the first would be worse than no preview
 * at all.
 *
 * This is what makes "the quantity is right" and "the manager is the right
 * manager" checkable on a live order without messaging anybody.
 */
export async function previewDefectNotification(params: {
  orderId: string;
  orderItemId?: string | null;
  defectiveQuantity?: number | null;
  /** The colour split, when the caller is previewing one. */
  whiteDefectiveQuantity?: number | null;
  colorDefectiveQuantity?: number | null;
  reason?: string | null;
  sorterUserId?: string | null;
}): Promise<{
  details: DefectDetails;
  message: string;
  /** The template the send would use first, or null when none is configured. */
  templateName: string | null;
  templateParams: string[];
  recipients: Array<{ role: DefectRecipientRole; label: string; to: string | null }>;
}> {
  const order = await loadOrderContact(params.orderId);

  // A defect that has not been filed yet, described exactly as a filed one
  // would be — the same shape `loadDefectDetails` reads.
  const asIfFiled = {
    order_id: params.orderId,
    order_item_id: params.orderItemId ? String(params.orderItemId) : null,
    defective_quantity: params.defectiveQuantity ?? null,
    // Explicitly null rather than absent: `undefined` here would reach the
    // template parameters as the string "undefined" instead of a dash.
    white_defective_quantity: params.whiteDefectiveQuantity ?? null,
    color_defective_quantity: params.colorDefectiveQuantity ?? null,
    description: params.reason ?? null,
    reported_by: params.sorterUserId ? String(params.sorterUserId) : null,
  } as DefectRecord;

  const details = await loadDefectDetails(asIfFiled, order);
  const sorter = await loadSorterContact(asIfFiled.reported_by);
  const manager = await loadManagerContact(
    order.manager_approved_by === null || order.manager_approved_by === undefined
      ? null
      : String(order.manager_approved_by)
  );
  const superAdmin = await loadSuperAdminContact();

  const numbers: Record<DefectRecipientRole, string | null> = {
    customer: toWhatsAppNumber(order.customer_contact),
    // The SAME precedence the real send uses. A preview that resolved
    // recipients differently would be the drift this function exists to
    // avoid.
    sorter:
      toWhatsAppNumber(config.WHATSAPP_SORTER_NUMBER) || toWhatsAppNumber(sorter?.mobile_number),
    manager:
      toWhatsAppNumber(manager?.mobile_number) || toWhatsAppNumber(config.WHATSAPP_MANAGER_NUMBER),
    super_admin:
      toWhatsAppNumber(superAdmin?.mobile_number) ||
      toWhatsAppNumber(config.WHATSAPP_SUPER_ADMIN_NUMBER),
  };

  // Whichever template the send would actually reach for first, so the
  // parameters shown are the parameters Meta would receive.
  const reportTemplate = String(config.WHATSAPP_DEFECT_REPORT_TEMPLATE || '').trim();

  return {
    details,
    message: buildDefectMessage(details),
    templateName: reportTemplate || String(config.WHATSAPP_DEFECT_DETAIL_TEMPLATE || '').trim() || null,
    templateParams: reportTemplate ? reportTemplateParams(details) : detailTemplateParams(details),
    recipients: ROLES.map((role) => ({ role, label: ROLE_LABEL[role], to: numbers[role] })),
  };
}

/**
 * Records a defect: stores the photo, writes the row, then notifies.
 *
 * The order must be one the Sorter can still act on; a cancelled or delivered
 * order is rejected rather than quietly accepting evidence against it.
 */
/**
 * One colour's figure as the column takes it.
 *
 * Anything that is not a whole, non-negative number becomes NULL — "not
 * split" — rather than reaching the row as a guess. The column is UNSIGNED, so
 * a negative would be refused by the database anyway; this makes it a stored
 * absence instead of an error, which is the right outcome for a field the
 * report does not require.
 */
function splitQuantity(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

async function reportDefect(params: {
  orderId: string;
  sorterUserId: string;
  photoBase64: string;
  mimeType: string;
  description?: string | null;
  /** The line this is about, when it was reported from Mark as Defective. */
  orderItemId?: string | null;
  /** Pieces reported defective with this photo. */
  defectiveQuantity?: number | null;
  /**
   * The same pieces, split by colour, as typed into Mark Defective.
   *
   * Optional: a report that carries no split stores NULL for both and behaves
   * exactly as every report did before these columns existed.
   */
  whiteDefectiveQuantity?: number | null;
  colorDefectiveQuantity?: number | null;
  notify?: boolean;
}): Promise<DefectRecord> {
  const order = await loadOrderContact(params.orderId);
  if (['CANCELLED', 'DELIVERED'].includes(String(order.status))) {
    throw new AppError(`This order is ${order.status} and cannot take a new defect report.`, 409);
  }

  /*
   * A line id is honoured only when it really belongs to this order. Anything
   * else is stored as null and the report is about the order as a whole —
   * never against someone else's line.
   */
  let orderItemId: string | null = null;
  if (params.orderItemId) {
    const line = await query<any>(
      `SELECT id FROM order_items WHERE id = ? AND order_id = ? LIMIT 1`,
      [params.orderItemId, params.orderId]
    );
    orderItemId = line.rows[0] ? String(line.rows[0].id) : null;
  }

  const defectiveQuantity =
    params.defectiveQuantity !== null &&
    params.defectiveQuantity !== undefined &&
    Number.isInteger(params.defectiveQuantity) &&
    params.defectiveQuantity > 0
      ? params.defectiveQuantity
      : null;

  let stored;
  try {
    stored = await saveBase64Image('defects', params.photoBase64, params.mimeType);
  } catch (error: any) {
    throw new AppError(error?.message || 'Could not store the defect photo', 400);
  }

  await query(
    `INSERT INTO order_defects
       (order_id, order_item_id, defective_quantity,
        white_defective_quantity, color_defective_quantity,
        photo_url, description, reported_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      params.orderId,
      // The line is the one already validated against this order above, so
      // the split is stored against the correct item or against none at all.
      orderItemId,
      defectiveQuantity,
      // Stored beside the total, never instead of it. A report with no split
      // writes NULL for both, which is what every existing report holds.
      splitQuantity(params.whiteDefectiveQuantity),
      splitQuantity(params.colorDefectiveQuantity),
      stored.url,
      params.description || null,
      params.sorterUserId,
    ]
  );

  // The row is identified by its stored photo_url, which is randomised per
  // upload — safer than relying on the driver's insertId shape.
  const inserted = await query<any>(
    `SELECT id FROM order_defects WHERE photo_url = ? ORDER BY id DESC LIMIT 1`,
    [stored.url]
  );
  const defectId = inserted.rows[0] ? String(inserted.rows[0].id) : null;
  if (!defectId) {
    throw new AppError('Defect report could not be saved', 500);
  }

  logger.info(
    `[Defect] order ${order.order_number}: photo stored (${stored.bytes} bytes) by user ${params.sorterUserId}`
  );

  if (params.notify === false) {
    return getDefectById(defectId);
  }
  return notifyCustomer(defectId, params.orderId);
}

/**
 * Re-sends the WhatsApp notification for an existing defect.
 *
 * A message Meta already accepted is not sent again unless the caller says so
 * explicitly, so a stray tap on Retry cannot message anyone twice.
 */
async function retryWhatsApp(
  defectId: string,
  options: { force?: boolean } = {}
): Promise<DefectRecord> {
  const defect = await getDefectById(defectId);
  // Only a retry with nothing left to do is refused. If one copy failed, the
  // retry proceeds and notifyForDefect re-sends just that one.
  const nothingLeft = ROLES.every((role) => {
    const status = statusOf(defect, role);
    // NULL means there is no such recipient — nothing to retry for them.
    return status === 'SENT' || status === null;
  });
  if (nothingLeft && !options.force) {
    throw new AppError(
      'This defect photo has already been sent to every recipient it can reach.',
      409
    );
  }
  return notifyForDefect(defectId, defect.order_id);
}

export {
  reportDefect,
  retryWhatsApp,
  notifyForDefect,
  listDefectsForOrder,
  getDefectById,
  notifyCustomer,
  isWhatsAppConfigured,
  ROLES as DEFECT_RECIPIENT_ROLES,
};
