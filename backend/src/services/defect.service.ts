import { query } from '../config/database';
import { AppError } from '../utils/appError';
import { logger } from '../utils/logger';
import { saveBase64Image, absolutePathForUrl } from '../utils/fileStorage';
import {
  sendDefectTemplate,
  uploadMedia,
  toWhatsAppNumber,
  isWhatsAppConfigured,
} from './whatsapp.service';
import { config } from '../config/env';

/**
 * Defective-piece reporting.
 *
 * A Sorter photographs a damaged garment; the photo is stored on disk, a row
 * records the defect against the order, and the customer is notified over
 * WhatsApp using the approved template.
 *
 * The photo is saved before WhatsApp is attempted, and the row is written
 * whatever Meta answers. A failed notification therefore never loses the
 * evidence — it leaves a FAILED row that can be retried.
 */

export interface DefectRecord {
  id: string;
  order_id: string;
  photo_url: string;
  description: string | null;
  reported_by: string | null;
  reported_at: Date;
  whatsapp_status: 'PENDING' | 'SENT' | 'FAILED';
  whatsapp_message_id: string | null;
  whatsapp_error: string | null;
  whatsapp_sent_at: Date | null;
  whatsapp_to: string | null;
  /**
   * The identical message sent to the Sorter who reported the defect.
   * null status means no attempt has been made for this row yet.
   */
  sorter_whatsapp_status: 'PENDING' | 'SENT' | 'FAILED' | null;
  sorter_whatsapp_message_id: string | null;
  sorter_whatsapp_error: string | null;
  sorter_whatsapp_sent_at: Date | null;
  sorter_whatsapp_to: string | null;
}

/** Customer identity for one order, resolved the same way the Sorter queue does. */
const ORDER_CONTACT_SELECT = `
  SELECT o.id, o.order_number, o.status,
         COALESCE(b.name, u.name, 'Customer') AS customer_name,
         COALESCE(bu.mobile_number, u.mobile_number) AS customer_contact
    FROM orders o
    LEFT JOIN business_users bu ON bu.id = o.business_user_id
    LEFT JOIN businesses b ON b.id = bu.business_id
    LEFT JOIN users u ON u.id = o.user_id
   WHERE o.id = ?`;

async function loadOrderContact(orderId: string) {
  const result = await query<any>(ORDER_CONTACT_SELECT, [orderId]);
  const row = result.rows[0];
  if (!row) {
    throw new AppError('Order not found', 404);
  }
  return row;
}

function toRecord(row: any): DefectRecord {
  return {
    id: String(row.id),
    order_id: String(row.order_id),
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
  };
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
 * Attempts the WhatsApp notification for a defect row and records the real
 * outcome against it.
 *
 * The identical template goes to two recipients: the customer, and the Sorter
 * who reported it. The photo is uploaded to Meta once and both messages
 * reference the same media id, so the image never crosses the wire twice.
 *
 * Each copy is tracked in its own columns. That separation matters: a Sorter
 * copy that bounces must never make an accepted customer message look failed,
 * and neither may read as delivered unless Meta actually accepted it.
 */
async function notifyForDefect(defectId: string, orderId: string): Promise<DefectRecord> {
  const defect = await getDefectById(defectId);
  const order = await loadOrderContact(orderId);

  const absolutePath = absolutePathForUrl(defect.photo_url);
  if (!absolutePath) {
    const error = 'The stored defect photo could not be read from disk.';
    await query(
      `UPDATE order_defects
          SET whatsapp_status = 'FAILED', whatsapp_error = ?,
              sorter_whatsapp_status = 'FAILED', sorter_whatsapp_error = ?
        WHERE id = ?`,
      [error, error, defectId]
    );
    return getDefectById(defectId);
  }

  const customerTo = toWhatsAppNumber(order.customer_contact);

  // The reporting Sorter's own number, or a configured shop-floor number when
  // the account has none on file.
  const sorter = await loadSorterContact(defect.reported_by);
  const sorterTo =
    toWhatsAppNumber(sorter?.mobile_number) || toWhatsAppNumber(config.WHATSAPP_SORTER_NUMBER);

  // Nothing to send to at all: record both as failed and stop before Meta.
  if (!customerTo && !sorterTo) {
    const error = 'No valid WhatsApp number for the customer or the sorter.';
    await query(
      `UPDATE order_defects
          SET whatsapp_status = 'FAILED', whatsapp_error = ?,
              sorter_whatsapp_status = 'FAILED', sorter_whatsapp_error = ?
        WHERE id = ?`,
      [error, error, defectId]
    );
    return getDefectById(defectId);
  }

  // Upload once, reuse for both messages. A failure here is fatal to both.
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

  /** Sends one copy and returns what to write for that recipient. */
  const deliver = async (to: string | null) => {
    if (!to) return { ok: false, messageId: null, error: 'No valid WhatsApp number.' };
    if (!mediaId) return { ok: false, messageId: null, error: uploadError };
    return sendDefectTemplate({
      to,
      customerName: order.customer_name,
      orderNumber: order.order_number,
      mediaId,
    });
  };

  // Customer copy — skipped only when Meta already accepted it, so a retry
  // aimed at the sorter can never message the customer a second time.
  if (defect.whatsapp_status !== 'SENT') {
    const result = await deliver(customerTo);
    await query(
      result.ok
        ? `UPDATE order_defects
              SET whatsapp_status = 'SENT', whatsapp_message_id = ?, whatsapp_error = NULL,
                  whatsapp_sent_at = NOW(), whatsapp_to = ?
            WHERE id = ?`
        : `UPDATE order_defects
              SET whatsapp_status = 'FAILED', whatsapp_error = ?, whatsapp_to = ?
            WHERE id = ?`,
      result.ok ? [result.messageId, customerTo, defectId] : [result.error, customerTo, defectId]
    );
  }

  // Sorter copy — the same message, tracked separately.
  if (defect.sorter_whatsapp_status !== 'SENT') {
    const result = await deliver(sorterTo);
    await query(
      result.ok
        ? `UPDATE order_defects
              SET sorter_whatsapp_status = 'SENT', sorter_whatsapp_message_id = ?,
                  sorter_whatsapp_error = NULL, sorter_whatsapp_sent_at = NOW(),
                  sorter_whatsapp_to = ?
            WHERE id = ?`
        : `UPDATE order_defects
              SET sorter_whatsapp_status = 'FAILED', sorter_whatsapp_error = ?,
                  sorter_whatsapp_to = ?
            WHERE id = ?`,
      result.ok ? [result.messageId, sorterTo, defectId] : [result.error, sorterTo, defectId]
    );
  }

  return getDefectById(defectId);
}

/** Kept under the old name so existing callers keep reading naturally. */
const notifyCustomer = notifyForDefect;

/**
 * Records a defect: stores the photo, writes the row, then notifies.
 *
 * The order must be one the Sorter can still act on; a cancelled or delivered
 * order is rejected rather than quietly accepting evidence against it.
 */
async function reportDefect(params: {
  orderId: string;
  sorterUserId: string;
  photoBase64: string;
  mimeType: string;
  description?: string | null;
  notify?: boolean;
}): Promise<DefectRecord> {
  const order = await loadOrderContact(params.orderId);
  if (['CANCELLED', 'DELIVERED'].includes(String(order.status))) {
    throw new AppError(`This order is ${order.status} and cannot take a new defect report.`, 409);
  }

  let stored;
  try {
    stored = await saveBase64Image('defects', params.photoBase64, params.mimeType);
  } catch (error: any) {
    throw new AppError(error?.message || 'Could not store the defect photo', 400);
  }

  await query(
    `INSERT INTO order_defects (order_id, photo_url, description, reported_by)
     VALUES (?, ?, ?, ?)`,
    [params.orderId, stored.url, params.description || null, params.sorterUserId]
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
 * explicitly, so a stray tap on Retry cannot message the customer twice.
 */
async function retryWhatsApp(
  defectId: string,
  options: { force?: boolean } = {}
): Promise<DefectRecord> {
  const defect = await getDefectById(defectId);
  // Only a retry with nothing left to do is refused. If one copy failed, the
  // retry proceeds and notifyForDefect re-sends just that one.
  const bothSent =
    defect.whatsapp_status === 'SENT' && defect.sorter_whatsapp_status === 'SENT';
  if (bothSent && !options.force) {
    throw new AppError(
      'This defect photo has already been sent to both the customer and the sorter.',
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
};
