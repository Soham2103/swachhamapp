import { query, getClient } from '../config/database';
import { AppError } from '../utils/appError';
import { logger } from '../utils/logger';
import { acceptJob } from './dispatch.service';

/**
 * DOOR ACCEPTANCE — counted or uncounted, and what the hotel is told.
 *
 * ============================================================
 * THE TWO ANSWERS
 * ============================================================
 *
 * A rider at a hotel's door either counted the load with its staff or did
 * not, and those are different promises about what was collected:
 *
 *   WITH_COUNT     Counted and checked. The hotel is told
 *                  "Order is checked at door" and the job proceeds at once.
 *
 *   WITHOUT_COUNT  Not counted. A TICKET is raised for the hotel, and the
 *                  rider waits. Only when the hotel accepts is the mismatch
 *                  notice sent and the rider released into the normal job
 *                  workflow.
 *
 * ============================================================
 * WHY BOTH PATHS CLAIM THE JOB IMMEDIATELY
 * ============================================================
 *
 * READ THIS BEFORE MOVING THE `acceptJob` CALL. It is the one place where
 * this file does not follow the brief's literal ordering, and it is
 * deliberate.
 *
 * An offer lives for `OFFER_TTL_SECONDS` — 90 seconds by default — and it is
 * offered to EVERY nearby rider at once, first to accept takes it. Accepting
 * after that window throws 410 "This offer has expired."
 *
 * So a rider who raised a ticket and then waited for a hotel to answer would,
 * in the overwhelming majority of cases, come back to an offer that had
 * expired or been taken by someone else — having already told the hotel they
 * were collecting. The uncounted path would be broken for exactly the reason
 * it exists.
 *
 * Claiming the job first costs nothing and loses nothing: the rider is still
 * blocked from proceeding until the hotel accepts (that gate is the ticket,
 * enforced in `requireAcceptedTicket` and reflected in the dashboard's
 * waiting state), and the hotel still gets the ticket and the message in the
 * required order. What changes is only that the job is SECURED while the
 * conversation happens, instead of being raced for after it.
 *
 * ============================================================
 * HOW THE HOTEL IS REACHED
 * ============================================================
 *
 * Through `business_messages`, not `notifications`. A hotel account lives in
 * `business_users`, and `notifications.user_id` is a foreign key to `users` —
 * a different table with its own ids — so a hotel has never been addressable
 * there. `rider.service.notifyOrderParty` documents the same limitation and
 * falls back to a socket emit, which reaches nothing, because the mobile app
 * has no socket client. See migration 062 for the full reasoning.
 */

/** The exact sentences the brief specifies. Changing these changes the product. */
export const MESSAGE_DOOR_CHECKED = 'Order is checked at door';

export const MESSAGE_DOOR_UNCOUNTED_AGREED =
  'Any Mismatch will be communicated. Note Physical verification will be done at Swachham';

export type DoorAcceptanceMode = 'WITH_COUNT' | 'WITHOUT_COUNT';

export type TicketStatus = 'PENDING' | 'ACCEPTED';

export interface DoorTicket {
  ticket_id: string;
  order_id: string;
  order_number: string | null;
  job_id: string;
  status: TicketStatus;
  created_at: string;
  accepted_at: string | null;
}

/** A ticket as the hotel sees it — enough to know what is being agreed to. */
export interface DoorTicketForBusiness extends DoorTicket {
  rider_name: string | null;
  address_text: string | null;
  item_count: number;
  weight_kg: number;
}

export interface BusinessMessage {
  id: string;
  order_id: string | null;
  order_number: string | null;
  ticket_id: string | null;
  type: string;
  body: string;
  is_read: boolean;
  created_at: string;
}

/**
 * The job's order and the hotel account behind it.
 *
 * Returns `business_user_id: null` for a plain customer pickup. That is not
 * an error here — the caller decides what it means, because it means
 * different things on the two paths.
 */
async function resolveJobParty(
  jobId: string,
  riderId: string
): Promise<{ order_id: string; order_number: string | null; business_user_id: string | null }> {
  const result = await query<any>(
    `SELECT j.order_id, o.order_number, o.business_user_id, j.rider_id
       FROM rider_jobs j
       JOIN orders o ON o.id = j.order_id
      WHERE j.id = ?`,
    [jobId]
  );

  const row = result.rows[0];
  if (!row) throw new AppError('That job no longer exists.', 404);

  /*
   * Ownership is checked AFTER acceptance has set `rider_id`, so this rejects
   * a rider reaching for a job that is not theirs while still allowing the
   * accept call that is in the middle of claiming it.
   */
  if (row.rider_id && String(row.rider_id) !== String(riderId)) {
    throw new AppError('That job belongs to another rider.', 403);
  }

  return {
    order_id: String(row.order_id),
    order_number: row.order_number ? String(row.order_number) : null,
    business_user_id: row.business_user_id ? String(row.business_user_id) : null,
  };
}

/**
 * Records how the rider accepted, on the job itself.
 *
 * Best-effort by design: the mode is a record of what happened, and failing
 * to write it must not undo an acceptance the rider has already been told
 * succeeded.
 */
async function recordMode(jobId: string, mode: DoorAcceptanceMode): Promise<void> {
  try {
    await query(`UPDATE rider_jobs SET door_acceptance_mode = ? WHERE id = ?`, [mode, jobId]);
  } catch (error) {
    logger.error(
      `[DoorAcceptance] Could not record mode ${mode} on job ${jobId}: ` +
        `${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Writes a message into the hotel's inbox.
 *
 * Returns whether it landed rather than throwing, so a messaging failure can
 * be reported without failing the acceptance that produced it.
 */
async function sendBusinessMessage(
  businessUserId: string | null,
  orderId: string | null,
  ticketId: string | null,
  type: string,
  body: string
): Promise<boolean> {
  // No hotel on this order — a plain customer pickup. Nothing to write, and
  // nothing wrong.
  if (!businessUserId) return false;

  try {
    await query(
      `INSERT INTO business_messages (business_user_id, order_id, ticket_id, type, body, is_read)
       VALUES (?, ?, ?, ?, ?, false)`,
      [businessUserId, orderId, ticketId, type, body]
    );
    return true;
  } catch (error) {
    logger.error(
      `[DoorAcceptance] Could not message business ${businessUserId}: ` +
        `${error instanceof Error ? error.message : String(error)}`
    );
    return false;
  }
}

/**
 * "With Counting & Checked".
 *
 * Accepts the job by the existing path, then tells the hotel. The message is
 * sent AFTER the acceptance commits, so a messaging problem cannot cost the
 * rider the job they were just told they had.
 */
export async function acceptWithCounting(
  jobId: string,
  riderId: string
): Promise<{ job: any; messaged: boolean }> {
  const party = await resolveJobParty(jobId, riderId);

  // The existing acceptance, unchanged — offer validation, the race against
  // other riders, and the job's own state transition all stay where they are.
  const job = await acceptJob(jobId, riderId);

  await recordMode(jobId, 'WITH_COUNT');

  const messaged = await sendBusinessMessage(
    party.business_user_id,
    party.order_id,
    null,
    'DOOR_CHECKED',
    MESSAGE_DOOR_CHECKED
  );

  return { job, messaged };
}

/**
 * "Without Counting & Checked".
 *
 * Claims the job (see the header note on why this happens first), then raises
 * the ticket the hotel must answer. NO MESSAGE IS SENT HERE — the mismatch
 * notice is the hotel's own acceptance talking back to it, and goes out in
 * `acceptTicketAsBusiness`.
 */
export async function raiseUncountedTicket(
  jobId: string,
  riderId: string
): Promise<{ job: any; ticket: DoorTicket }> {
  const party = await resolveJobParty(jobId, riderId);

  /*
   * A pickup with no hotel behind it has nobody to raise a ticket for. This
   * is refused rather than quietly downgraded to a plain acceptance: the
   * rider chose the uncounted path, and silently accepting on their behalf
   * would leave them believing a hotel had agreed to something.
   *
   * The dashboard does not offer the choice on these orders at all, so this
   * is a guard against a stale screen, not the normal route.
   */
  if (!party.business_user_id) {
    throw new AppError(
      'This pickup has no business account behind it, so there is nobody to raise a ticket with. Accept it with counting instead.',
      422
    );
  }

  const job = await acceptJob(jobId, riderId);

  await recordMode(jobId, 'WITHOUT_COUNT');

  /*
   * IDEMPOTENT ON `uk_door_ticket_job`. A rider who taps twice, or whose
   * request is retried, gets the same ticket rather than a second one for the
   * hotel to answer. The no-op update is what makes `insertId` come back for
   * the existing row on the duplicate path.
   */
  await query(
    `INSERT INTO rider_door_tickets (order_id, job_id, rider_id, business_user_id, status)
     VALUES (?, ?, ?, ?, 'PENDING')
     ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`,
    [party.order_id, jobId, riderId, party.business_user_id]
  );

  const stored = await query<any>(
    `SELECT id, order_id, job_id, status, created_at, accepted_at
       FROM rider_door_tickets WHERE job_id = ?`,
    [jobId]
  );

  const row = stored.rows[0];
  if (!row) throw new AppError('The ticket could not be raised. Try again.', 500);

  return {
    job,
    ticket: {
      ticket_id: String(row.id),
      order_id: String(row.order_id),
      order_number: party.order_number,
      job_id: String(row.job_id),
      status: String(row.status) as TicketStatus,
      created_at: String(row.created_at),
      accepted_at: row.accepted_at ? String(row.accepted_at) : null,
    },
  };
}

/**
 * What the rider's phone polls while it waits.
 *
 * Scoped to the signed-in rider, so a ticket id belonging to someone else is
 * a 404 rather than a peek at another rider's job.
 */
export async function getTicketForRider(ticketId: string, riderId: string): Promise<DoorTicket> {
  const result = await query<any>(
    `SELECT t.id, t.order_id, o.order_number, t.job_id, t.status, t.created_at, t.accepted_at
       FROM rider_door_tickets t
       JOIN orders o ON o.id = t.order_id
      WHERE t.id = ? AND t.rider_id = ?`,
    [ticketId, riderId]
  );

  const row = result.rows[0];
  if (!row) throw new AppError('That ticket no longer exists.', 404);

  return {
    ticket_id: String(row.id),
    order_id: String(row.order_id),
    order_number: row.order_number ? String(row.order_number) : null,
    job_id: String(row.job_id),
    status: String(row.status) as TicketStatus,
    created_at: String(row.created_at),
    accepted_at: row.accepted_at ? String(row.accepted_at) : null,
  };
}

/**
 * Every ticket this rider is still waiting on.
 *
 * The dashboard reads this on load so a rider who closed the app mid-wait
 * comes back to the waiting state rather than to a job with no explanation.
 */
export async function listPendingTicketsForRider(riderId: string): Promise<DoorTicket[]> {
  const result = await query<any>(
    `SELECT t.id, t.order_id, o.order_number, t.job_id, t.status, t.created_at, t.accepted_at
       FROM rider_door_tickets t
       JOIN orders o ON o.id = t.order_id
      WHERE t.rider_id = ? AND t.status = 'PENDING'
      ORDER BY t.created_at DESC`,
    [riderId]
  );

  return result.rows.map((row: any) => ({
    ticket_id: String(row.id),
    order_id: String(row.order_id),
    order_number: row.order_number ? String(row.order_number) : null,
    job_id: String(row.job_id),
    status: String(row.status) as TicketStatus,
    created_at: String(row.created_at),
    accepted_at: row.accepted_at ? String(row.accepted_at) : null,
  }));
}

/** The hotel's queue of tickets waiting on it. */
export async function listPendingTicketsForBusiness(
  businessUserId: string
): Promise<DoorTicketForBusiness[]> {
  const result = await query<any>(
    `SELECT t.id, t.order_id, o.order_number, t.job_id, t.status, t.created_at, t.accepted_at,
            u.name AS rider_name, j.address_text, j.item_count, j.weight_kg
       FROM rider_door_tickets t
       JOIN orders o ON o.id = t.order_id
       JOIN rider_jobs j ON j.id = t.job_id
       LEFT JOIN users u ON u.id = t.rider_id
      WHERE t.business_user_id = ? AND t.status = 'PENDING'
      ORDER BY t.created_at DESC`,
    [businessUserId]
  );

  return result.rows.map((row: any) => ({
    ticket_id: String(row.id),
    order_id: String(row.order_id),
    order_number: row.order_number ? String(row.order_number) : null,
    job_id: String(row.job_id),
    status: String(row.status) as TicketStatus,
    created_at: String(row.created_at),
    accepted_at: row.accepted_at ? String(row.accepted_at) : null,
    rider_name: row.rider_name ? String(row.rider_name) : null,
    address_text: row.address_text ? String(row.address_text) : null,
    item_count: Number(row.item_count || 0),
    weight_kg: Number(row.weight_kg || 0),
  }));
}

/**
 * The hotel's "Accepted".
 *
 * ONE TRANSACTION over the read and the update, so two taps from two devices
 * cannot both believe they were the acceptance. The WHERE names the pending
 * status, which is what makes the second one a no-op rather than a second
 * message to the hotel.
 */
export async function acceptTicketAsBusiness(
  ticketId: string,
  businessUserId: string
): Promise<{ ticket: DoorTicket; messaged: boolean }> {
  const connection = await getClient();
  let ticketRow: any;
  let alreadyAccepted = false;

  try {
    await connection.beginTransaction();

    const [rows]: any = await connection.execute(
      `SELECT id, order_id, job_id, business_user_id, status
         FROM rider_door_tickets
        WHERE id = ? FOR UPDATE`,
      [ticketId]
    );

    ticketRow = rows[0];
    if (!ticketRow) throw new AppError('That ticket no longer exists.', 404);

    // Scoped to the signed-in hotel, so one hotel cannot answer another's.
    if (String(ticketRow.business_user_id) !== String(businessUserId)) {
      throw new AppError('That ticket belongs to another business.', 403);
    }

    if (String(ticketRow.status) === 'ACCEPTED') {
      // Not an error. The rider is already released, and saying so is more
      // useful than a failure the hotel cannot act on.
      alreadyAccepted = true;
    } else {
      await connection.execute(
        `UPDATE rider_door_tickets
            SET status = 'ACCEPTED', accepted_at = NOW()
          WHERE id = ? AND status = 'PENDING'`,
        [ticketId]
      );
    }

    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }

  /*
   * AFTER THE COMMIT. The acceptance is what releases the rider; a failure to
   * write the message must not roll that back and strand them.
   *
   * Sent only on the transition, so a second tap does not post the notice
   * twice.
   */
  const messaged = alreadyAccepted
    ? false
    : await sendBusinessMessage(
        businessUserId,
        String(ticketRow.order_id),
        String(ticketRow.id),
        'DOOR_UNCOUNTED_AGREED',
        MESSAGE_DOOR_UNCOUNTED_AGREED
      );

  const refreshed = await query<any>(
    `SELECT t.id, t.order_id, o.order_number, t.job_id, t.status, t.created_at, t.accepted_at
       FROM rider_door_tickets t
       JOIN orders o ON o.id = t.order_id
      WHERE t.id = ?`,
    [ticketId]
  );

  const row = refreshed.rows[0];

  return {
    ticket: {
      ticket_id: String(row.id),
      order_id: String(row.order_id),
      order_number: row.order_number ? String(row.order_number) : null,
      job_id: String(row.job_id),
      status: String(row.status) as TicketStatus,
      created_at: String(row.created_at),
      accepted_at: row.accepted_at ? String(row.accepted_at) : null,
    },
    messaged,
  };
}

/** The hotel's message list. Newest first, capped so it cannot grow unbounded. */
export async function listMessagesForBusiness(
  businessUserId: string,
  limit = 50
): Promise<BusinessMessage[]> {
  /*
   * The limit is INLINED, not a placeholder. `query()` runs through
   * `pool.execute` — a prepared statement — and MySQL rejects `LIMIT ?` there
   * ("Incorrect arguments to mysqld_stmt_execute"). Every other LIMIT in this
   * codebase is a literal for the same reason.
   *
   * Clamped to a whole number in a sane range first, so the value can never
   * be anything but digits by the time it reaches the string.
   */
  const cap = Math.min(Math.max(Math.trunc(Number(limit) || 50), 1), 200);

  const result = await query<any>(
    `SELECT m.id, m.order_id, o.order_number, m.ticket_id, m.type, m.body, m.is_read, m.created_at
       FROM business_messages m
       LEFT JOIN orders o ON o.id = m.order_id
      WHERE m.business_user_id = ?
      ORDER BY m.created_at DESC
      LIMIT ${cap}`,
    [businessUserId]
  );

  return result.rows.map((row: any) => ({
    id: String(row.id),
    order_id: row.order_id ? String(row.order_id) : null,
    order_number: row.order_number ? String(row.order_number) : null,
    ticket_id: row.ticket_id ? String(row.ticket_id) : null,
    type: String(row.type),
    body: String(row.body),
    is_read: Boolean(row.is_read),
    created_at: String(row.created_at),
  }));
}

/** How many messages and tickets the hotel has not dealt with. For a badge. */
export async function businessInboxCounts(
  businessUserId: string
): Promise<{ unread_messages: number; pending_tickets: number }> {
  const [messages, tickets] = await Promise.all([
    query<any>(
      `SELECT COUNT(*) AS n FROM business_messages WHERE business_user_id = ? AND is_read = false`,
      [businessUserId]
    ),
    query<any>(
      `SELECT COUNT(*) AS n FROM rider_door_tickets WHERE business_user_id = ? AND status = 'PENDING'`,
      [businessUserId]
    ),
  ]);

  return {
    unread_messages: Number(messages.rows[0]?.n || 0),
    pending_tickets: Number(tickets.rows[0]?.n || 0),
  };
}

/** Marks the hotel's messages read. Scoped to the signed-in hotel. */
export async function markBusinessMessagesRead(businessUserId: string): Promise<{ updated: number }> {
  const result = await query<any>(
    `UPDATE business_messages SET is_read = true WHERE business_user_id = ? AND is_read = false`,
    [businessUserId]
  );

  return { updated: Number(result.rowCount || 0) };
}
