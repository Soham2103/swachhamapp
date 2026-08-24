import { query } from '../config/database';
import { logger } from '../utils/logger';
import socketService from './socket.service';

/*
 * ===================================================================
 * WHY THIS FILE WAS REWRITTEN
 * ===================================================================
 *
 * Every statement here was written for PostgreSQL — `$1` placeholders and
 * `RETURNING *` — against a MySQL pool that only understands `?` and has no
 * RETURNING at all. Nothing in `query()` translates between the two, so every
 * function in this file threw the moment it was called.
 *
 * That was not dead code. `createOrder` calls `createNotification` AFTER its
 * transaction commits, so placing an order wrote the order, threw on the
 * notification, and returned a 500 to a customer whose order had in fact been
 * saved. `production.service` had the same problem on every status change.
 *
 * The rewrite is MySQL throughout: `?` placeholders, and an explicit SELECT
 * after an INSERT where the caller needs the stored row back.
 */

export interface Notification {
  id: string;
  user_id: string;
  order_id?: string;
  type: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  is_read: boolean;
  created_at: Date;
}

const NOTIFICATION_COLUMNS = `id, user_id, order_id, type, title, body, data, is_read, created_at`;

/**
 * Writes a notification and pushes it to the user's socket room.
 *
 * The socket emit is deliberately part of this function rather than something
 * each caller remembers: a notification that is stored but never delivered is
 * the failure mode that looks like everything working.
 */
async function createNotification(
  userId: string,
  orderId: string | null,
  type: string,
  title: string,
  body: string,
  data?: Record<string, unknown>
): Promise<Notification | null> {
  try {
    const inserted = await query(
      `INSERT INTO notifications (user_id, order_id, type, title, body, data, is_read)
       VALUES (?, ?, ?, ?, ?, ?, false)`,
      [userId, orderId, type, title, body, data ? JSON.stringify(data) : null]
    );

    const id = inserted.insertId;
    if (!id) {
      logger.warn(`[NotificationService] Insert for user ${userId} returned no id`);
      return null;
    }

    const result = await query<Notification>(
      `SELECT ${NOTIFICATION_COLUMNS} FROM notifications WHERE id = ?`,
      [id]
    );
    const notification = result.rows[0] || null;

    if (notification) {
      socketService.emitNotification(String(userId), notification);
    }

    logger.debug(`[NotificationService] Notification created for user ${userId}: ${type}`);
    return notification;
  } catch (error) {
    /*
     * A notification must never take down the thing it is reporting on.
     *
     * This is the specific bug that made order placement return 500 on a
     * successfully committed order: the caller runs after COMMIT, so throwing
     * here cannot undo the order, it can only misreport it. The failure is
     * logged loudly and swallowed.
     */
    logger.error(
      `[NotificationService] Failed to create ${type} notification for user ${userId}: ` +
        `${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

/**
 * The same write for several recipients, used by the rider fan-out.
 *
 * One failure does not stop the rest: a dispatch that reached four of five
 * riders is far better than one that reached none.
 */
async function createNotifications(
  recipients: Array<{
    userId: string;
    orderId: string | null;
    type: string;
    title: string;
    body: string;
    data?: Record<string, unknown>;
  }>
): Promise<number> {
  let delivered = 0;
  for (const r of recipients) {
    const created = await createNotification(
      r.userId,
      r.orderId,
      r.type,
      r.title,
      r.body,
      r.data
    );
    if (created) delivered += 1;
  }
  return delivered;
}

async function getUserNotifications(
  userId: string,
  page: number = 1,
  limit: number = 20
): Promise<{ notifications: Notification[]; total: number }> {
  const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const safePage = Math.max(Number(page) || 1, 1);
  const offset = (safePage - 1) * safeLimit;

  const countResult = await query<{ count: number }>(
    `SELECT COUNT(*) AS count FROM notifications WHERE user_id = ?`,
    [userId]
  );
  const total = Number(countResult.rows[0]?.count || 0);

  /*
   * LIMIT and OFFSET are inlined, not bound.
   *
   * mysql2's prepared-statement path sends them as strings, which MySQL
   * rejects with a syntax error. Both are forced through Number() and clamped
   * above, so nothing but an integer can reach the SQL.
   */
  const result = await query<Notification>(
    `SELECT ${NOTIFICATION_COLUMNS}
       FROM notifications
      WHERE user_id = ?
      ORDER BY created_at DESC
      LIMIT ${safeLimit} OFFSET ${offset}`,
    [userId]
  );

  return { notifications: result.rows, total };
}

async function markRead(userId: string, notificationId: string): Promise<Notification> {
  const updated = await query(
    `UPDATE notifications SET is_read = true WHERE id = ? AND user_id = ?`,
    [notificationId, userId]
  );

  if (!updated.rowCount) {
    throw new Error('Notification not found or access denied');
  }

  const result = await query<Notification>(
    `SELECT ${NOTIFICATION_COLUMNS} FROM notifications WHERE id = ?`,
    [notificationId]
  );
  return result.rows[0];
}

async function markAllRead(userId: string): Promise<{ updated: number }> {
  const result = await query(
    `UPDATE notifications SET is_read = true WHERE user_id = ? AND is_read = false`,
    [userId]
  );
  const updated = result.rowCount || 0;
  logger.debug(`[NotificationService] Marked ${updated} notifications as read for user ${userId}`);
  return { updated };
}

async function getUnreadCount(userId: string): Promise<{ count: number }> {
  const result = await query<{ count: number }>(
    `SELECT COUNT(*) AS count FROM notifications WHERE user_id = ? AND is_read = false`,
    [userId]
  );
  return { count: Number(result.rows[0]?.count || 0) };
}

export {
  createNotification,
  createNotifications,
  getUserNotifications,
  markRead,
  markAllRead,
  getUnreadCount,
};
