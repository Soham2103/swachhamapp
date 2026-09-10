import { getClient, query } from '../config/database';
import { AppError } from '../utils/appError';
import { logger } from '../utils/logger';
import { createNotification } from './notification.service';

/**
 * THE CENTRAL TICKET SYSTEM.
 *
 * One service behind every ticket in the application. A Sorter reporting a
 * quantity mismatch, a Manager reporting a technical fault and a hotel asking
 * for a rewash all travel this path and land in the same two tables — there is
 * no per-role ticket module anywhere, and adding one would be the thing this
 * exists to prevent.
 *
 * THREE RULES LIVE HERE, and nowhere else:
 *
 *   1. WHICH ROLE MAY RAISE WHAT   `CATEGORIES_BY_ROLE`
 *   2. THE 48-HOUR WINDOW          `assertWithinWindow`
 *   3. WHO MAY ANSWER WHAT         `assertCanResolve` / `assertCanView`
 *
 * They are enforced on the server for every request. The screens use the same
 * constants to decide what to offer, so a Sorter is not shown a category the
 * server would refuse — but the screen deciding is a convenience, and the
 * check here is the rule.
 */

/* ============================================================
 * CATEGORIES, AND WHO MAY RAISE THEM
 * ============================================================ */

export type TicketCategory =
  | 'QUANTITY_MISMATCHED'
  | 'DAMAGE_ITEM'
  | 'MATERIAL_REQUISITION'
  | 'TECHNICAL_ISSUE'
  | 'QUALITY_ISSUE'
  | 'MISSING_ITEM'
  | 'INVOICE_ISSUE'
  | 'REWASH_REQUEST';

export type TicketPriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
export type TicketStatus =
  | 'OPEN'
  | 'IN_PROGRESS'
  | 'WAITING_FOR_RESPONSE'
  | 'RESOLVED'
  | 'CLOSED';

/** The roles that can RAISE a ticket. Super Admin answers; it does not raise. */
export type CreatorRole = 'SORTER' | 'MANAGER' | 'BUSINESS';
/** Every role that can appear on a ticket, as creator or as responder. */
export type TicketRole = CreatorRole | 'SUPER_ADMIN';

/**
 * The whole matrix, in one place.
 *
 * A category not listed against a role cannot be raised by it — there is no
 * fallback and no "other". Material Requisition appears twice on purpose:
 * both the shop floor and the Manager ask for materials, and it is the same
 * category when either does.
 */
export const CATEGORIES_BY_ROLE: Record<CreatorRole, TicketCategory[]> = {
  SORTER: ['QUANTITY_MISMATCHED', 'DAMAGE_ITEM', 'MATERIAL_REQUISITION'],
  MANAGER: ['TECHNICAL_ISSUE', 'MATERIAL_REQUISITION'],
  BUSINESS: ['QUALITY_ISSUE', 'MISSING_ITEM', 'INVOICE_ISSUE', 'REWASH_REQUEST'],
};

export const CATEGORY_LABELS: Record<TicketCategory, string> = {
  QUANTITY_MISMATCHED: 'Quantity Mismatched',
  DAMAGE_ITEM: 'Damage Item',
  MATERIAL_REQUISITION: 'Material Requisition',
  TECHNICAL_ISSUE: 'Technical Issue',
  QUALITY_ISSUE: 'Quality Issue',
  MISSING_ITEM: 'Missing Item',
  INVOICE_ISSUE: 'Invoice Issue',
  REWASH_REQUEST: 'Rewash Request',
};

export const STATUS_LABELS: Record<TicketStatus, string> = {
  OPEN: 'Open',
  IN_PROGRESS: 'In Progress',
  WAITING_FOR_RESPONSE: 'Waiting for Response',
  RESOLVED: 'Resolved',
  CLOSED: 'Closed',
};

const PRIORITIES: TicketPriority[] = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];
const STATUSES: TicketStatus[] = [
  'OPEN', 'IN_PROGRESS', 'WAITING_FOR_RESPONSE', 'RESOLVED', 'CLOSED',
];

/**
 * THE 48-HOUR CATEGORIES.
 *
 * Three of the four a hotel can raise are about what arrived, so they are
 * answerable only while the delivery is recent enough to be checked. Invoice
 * Issue is deliberately absent: a billing question can be asked whenever the
 * bill is read.
 */
const WINDOWED_CATEGORIES: TicketCategory[] = [
  'QUALITY_ISSUE',
  'MISSING_ITEM',
  'REWASH_REQUEST',
];

const WINDOW_HOURS = 48;

/* ============================================================
 * WHO IS ASKING
 * ============================================================ */

/**
 * The caller, resolved from the token by the route.
 *
 * `businessUserId` is set for a hotel and `userId` for everyone else, which is
 * the same split the two creator columns carry — see the migration.
 */
export interface Actor {
  role: TicketRole;
  /** `users.id` — Sorter, Manager, Super Admin. */
  userId?: string | null;
  /** `business_users.id` — a hotel's login. */
  businessUserId?: string | null;
  name: string;
  /** The establishment, for a BUSINESS actor. */
  businessId?: string | null;
}

export interface TicketMessage {
  id: string;
  ticket_id: string;
  sender_role: TicketRole;
  sender_name: string;
  message: string;
  created_at: Date;
}

export interface TicketStatusChange {
  id: string;
  previous_status: TicketStatus | null;
  new_status: TicketStatus;
  changed_by_role: TicketRole;
  changed_by_name: string;
  note: string | null;
  created_at: Date;
}

export interface Ticket {
  id: string;
  ticket_number: string;
  category: TicketCategory;
  category_label: string;
  title: string;
  description: string;
  priority: TicketPriority;
  status: TicketStatus;
  status_label: string;
  created_by_role: CreatorRole;
  created_by_name: string;
  created_by_user_id: string | null;
  created_by_business_user_id: string | null;
  business_id: string | null;
  business_name: string | null;
  order_id: string | null;
  order_number: string | null;
  assigned_to_user_id: string | null;
  assigned_to_name: string | null;
  assigned_at: Date | null;
  resolved_at: Date | null;
  closed_at: Date | null;
  created_at: Date;
  updated_at: Date;
  message_count: number;
}

export interface TicketDetail extends Ticket {
  messages: TicketMessage[];
  history: TicketStatusChange[];
}

/* ============================================================
 * PERMISSIONS
 * ============================================================ */

/**
 * WHO MAY ANSWER A TICKET — view it in the queue, reply, assign, resolve, close.
 *
 *   raised by SORTER or MANAGER  ->  SUPER_ADMIN only
 *   raised by BUSINESS           ->  MANAGER and SUPER_ADMIN
 *
 * The creator is deliberately NOT here. A creator reads their own ticket and
 * replies to it (see `assertCanView` and `reply`), and can never resolve or
 * close it — which is the difference between taking part in a conversation and
 * deciding it is over.
 */
function resolversFor(createdByRole: CreatorRole): TicketRole[] {
  return createdByRole === 'BUSINESS' ? ['MANAGER', 'SUPER_ADMIN'] : ['SUPER_ADMIN'];
}

/** True when this actor raised this ticket. */
function isCreator(actor: Actor, ticket: Ticket): boolean {
  if (actor.role === 'BUSINESS') {
    return (
      !!actor.businessUserId &&
      String(ticket.created_by_business_user_id) === String(actor.businessUserId)
    );
  }
  return !!actor.userId && String(ticket.created_by_user_id) === String(actor.userId);
}

function canResolve(actor: Actor, ticket: Ticket): boolean {
  return resolversFor(ticket.created_by_role).includes(actor.role);
}

/** Read access: the creator, or anyone permitted to answer it. */
function assertCanView(actor: Actor, ticket: Ticket): void {
  if (isCreator(actor, ticket) || canResolve(actor, ticket)) return;
  // 404, not 403: a ticket someone may not see should not be confirmed to
  // exist by the error they get back.
  throw new AppError('Ticket not found', 404);
}

function assertCanResolve(actor: Actor, ticket: Ticket): void {
  assertCanView(actor, ticket);
  if (canResolve(actor, ticket)) return;
  throw new AppError(
    ticket.created_by_role === 'BUSINESS'
      ? 'Only a Manager or the Super Admin can resolve or close this ticket.'
      : 'Only the Super Admin can resolve or close this ticket.',
    403
  );
}

/* ============================================================
 * THE 48-HOUR WINDOW
 * ============================================================ */

/**
 * When the order was ACTUALLY delivered.
 *
 * `deliveries.delivered_at` is the recorded delivery moment and is preferred.
 * Where a delivery row was never written, the earliest status-history row that
 * put the order into DELIVERED or COMPLETED is used instead — that is the
 * moment the system recorded the goods as handed over.
 *
 * NULL when neither exists, which means the order has not been delivered yet.
 */
async function deliveredAtFor(orderId: string): Promise<Date | null> {
  const result = await query<{ delivered_at: Date | null }>(
    `SELECT LEAST(
              COALESCE(
                (SELECT MIN(d.delivered_at) FROM deliveries d
                  WHERE d.order_id = ? AND d.delivered_at IS NOT NULL),
                '9999-12-31 23:59:59'),
              COALESCE(
                (SELECT MIN(h.created_at) FROM order_status_history h
                  WHERE h.order_id = ? AND h.status IN ('DELIVERED','COMPLETED')),
                '9999-12-31 23:59:59')
            ) AS delivered_at`,
    [orderId, orderId]
  );
  const value = result.rows[0]?.delivered_at ?? null;
  if (!value) return null;
  const date = new Date(value);
  // The sentinel above means neither source had a date.
  return date.getUTCFullYear() >= 9999 ? null : date;
}

/**
 * Refuses a windowed category once the 48 hours are up.
 *
 * MEASURED FROM THE RECORDED DELIVERY, not from the order date and not from
 * now: the window exists so a complaint is made while the laundry can still be
 * looked at, and that clock starts when it arrives.
 *
 * An order that has NOT been delivered is not refused. Nothing has arrived to
 * complain about yet, so there is no deadline to have missed — the window
 * begins later, and a premature complaint is a matter for the person reading
 * it rather than a rule to be enforced here.
 *
 * Invoice Issue never reaches this function.
 */
async function assertWithinWindow(
  category: TicketCategory,
  orderId: string | null
): Promise<void> {
  if (!WINDOWED_CATEGORIES.includes(category)) return;
  if (!orderId) {
    throw new AppError(
      `A ${CATEGORY_LABELS[category]} ticket must name the order it is about.`,
      400
    );
  }

  const deliveredAt = await deliveredAtFor(orderId);
  if (!deliveredAt) return;

  const deadline = new Date(deliveredAt.getTime() + WINDOW_HOURS * 60 * 60 * 1000);
  if (Date.now() <= deadline.getTime()) return;

  throw new AppError(
    `${CATEGORY_LABELS[category]} can only be raised within ${WINDOW_HOURS} hours of ` +
      `delivery. This order was delivered on ${deliveredAt.toISOString().slice(0, 16).replace('T', ' ')} ` +
      `and the window closed on ${deadline.toISOString().slice(0, 16).replace('T', ' ')}.`,
    409
  );
}

/**
 * The window as the SCREEN needs it: what may still be raised against an order.
 *
 * The same clock the enforcement uses, exposed so a form can grey out a
 * category rather than offering it and failing. This reports; it never decides.
 */
export async function windowForOrder(orderId: string): Promise<{
  order_id: string;
  delivered_at: Date | null;
  deadline: Date | null;
  hours_remaining: number | null;
  expired: boolean;
  allowed_categories: TicketCategory[];
}> {
  const deliveredAt = await deliveredAtFor(orderId);
  const deadline = deliveredAt
    ? new Date(deliveredAt.getTime() + WINDOW_HOURS * 60 * 60 * 1000)
    : null;
  const expired = Boolean(deadline && Date.now() > deadline.getTime());

  return {
    order_id: String(orderId),
    delivered_at: deliveredAt,
    deadline,
    hours_remaining: deadline
      ? Math.max(0, Math.round(((deadline.getTime() - Date.now()) / 3600000) * 10) / 10)
      : null,
    expired,
    allowed_categories: expired
      ? CATEGORIES_BY_ROLE.BUSINESS.filter((c) => !WINDOWED_CATEGORIES.includes(c))
      : CATEGORIES_BY_ROLE.BUSINESS,
  };
}

/* ============================================================
 * READING
 * ============================================================ */

const SELECT_TICKET = `
  SELECT t.*, u.name AS assigned_to_name,
         (SELECT COUNT(*) FROM ticket_messages m WHERE m.ticket_id = t.id) AS message_count
    FROM tickets t
    LEFT JOIN users u ON u.id = t.assigned_to_user_id`;

function toTicket(row: any): Ticket {
  return {
    id: String(row.id),
    ticket_number: row.ticket_number,
    category: row.category,
    category_label: CATEGORY_LABELS[row.category as TicketCategory] || row.category,
    title: row.title,
    description: row.description,
    priority: row.priority,
    status: row.status,
    status_label: STATUS_LABELS[row.status as TicketStatus] || row.status,
    created_by_role: row.created_by_role,
    created_by_name: row.created_by_name,
    created_by_user_id: row.created_by_user_id === null ? null : String(row.created_by_user_id),
    created_by_business_user_id:
      row.created_by_business_user_id === null ? null : String(row.created_by_business_user_id),
    business_id: row.business_id === null ? null : String(row.business_id),
    business_name: row.business_name || null,
    order_id: row.order_id === null ? null : String(row.order_id),
    order_number: row.order_number || null,
    assigned_to_user_id:
      row.assigned_to_user_id === null ? null : String(row.assigned_to_user_id),
    assigned_to_name: row.assigned_to_name || null,
    assigned_at: row.assigned_at || null,
    resolved_at: row.resolved_at || null,
    closed_at: row.closed_at || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    message_count: Number(row.message_count || 0),
  };
}

export interface TicketFilters {
  ticket_number?: string;
  status?: string;
  priority?: string;
  category?: string;
  business_id?: string;
  order_number?: string;
  /** Inclusive, on the day the ticket was created. YYYY-MM-DD. */
  date_from?: string;
  date_to?: string;
  limit?: number;
  offset?: number;
}

/**
 * The tickets this actor may see, newest first.
 *
 * THE SCOPE IS THE PERMISSION, not a filter on top of one. A creator's query
 * is constrained to their own rows; a resolver's to the roles they answer for.
 * There is no parameter that widens either, so no caller can ask for tickets
 * it may not read.
 */
export async function listTickets(
  actor: Actor,
  filters: TicketFilters = {}
): Promise<{ tickets: Ticket[]; total: number }> {
  const where: string[] = [];
  const params: any[] = [];

  if (actor.role === 'SUPER_ADMIN') {
    // Everything: the Super Admin answers every category from every role.
  } else if (actor.role === 'MANAGER') {
    // What a Manager answers (hotel tickets) OR what they raised themselves.
    where.push(`(t.created_by_role = 'BUSINESS' OR t.created_by_user_id = ?)`);
    params.push(actor.userId);
  } else if (actor.role === 'BUSINESS') {
    where.push(`t.created_by_business_user_id = ?`);
    params.push(actor.businessUserId);
  } else {
    where.push(`t.created_by_user_id = ?`);
    params.push(actor.userId);
  }

  if (filters.ticket_number) {
    where.push(`t.ticket_number LIKE ?`);
    params.push(`%${String(filters.ticket_number).trim()}%`);
  }
  if (filters.status && STATUSES.includes(filters.status as TicketStatus)) {
    where.push(`t.status = ?`);
    params.push(filters.status);
  }
  if (filters.priority && PRIORITIES.includes(filters.priority as TicketPriority)) {
    where.push(`t.priority = ?`);
    params.push(filters.priority);
  }
  if (filters.category && CATEGORY_LABELS[filters.category as TicketCategory]) {
    where.push(`t.category = ?`);
    params.push(filters.category);
  }
  if (filters.business_id) {
    where.push(`t.business_id = ?`);
    params.push(filters.business_id);
  }
  if (filters.order_number) {
    where.push(`t.order_number LIKE ?`);
    params.push(`%${String(filters.order_number).trim()}%`);
  }
  if (filters.date_from) {
    where.push(`DATE(t.created_at) >= ?`);
    params.push(filters.date_from);
  }
  if (filters.date_to) {
    where.push(`DATE(t.created_at) <= ?`);
    params.push(filters.date_to);
  }

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.min(Math.max(Number(filters.limit) || 50, 1), 200);
  const offset = Math.max(Number(filters.offset) || 0, 0);

  const counted = await query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM tickets t ${clause}`,
    params
  );

  const rows = await query<any>(
    `${SELECT_TICKET} ${clause}
      ORDER BY t.created_at DESC, t.id DESC
      LIMIT ${limit} OFFSET ${offset}`,
    params
  );

  return {
    tickets: rows.rows.map(toTicket),
    total: Number(counted.rows[0]?.n || 0),
  };
}

async function loadTicket(ticketId: string): Promise<Ticket> {
  const rows = await query<any>(`${SELECT_TICKET} WHERE t.id = ?`, [ticketId]);
  const row = rows.rows[0];
  if (!row) throw new AppError('Ticket not found', 404);
  return toTicket(row);
}

/** One ticket with its whole conversation and status history. */
export async function getTicket(actor: Actor, ticketId: string): Promise<TicketDetail> {
  const ticket = await loadTicket(ticketId);
  assertCanView(actor, ticket);

  const messages = await query<any>(
    `SELECT id, ticket_id, sender_role, sender_name, message, created_at
       FROM ticket_messages WHERE ticket_id = ? ORDER BY id ASC`,
    [ticketId]
  );
  const history = await query<any>(
    `SELECT id, previous_status, new_status, changed_by_role, changed_by_name, note, created_at
       FROM ticket_status_history WHERE ticket_id = ? ORDER BY id ASC`,
    [ticketId]
  );

  return {
    ...ticket,
    messages: messages.rows.map((m: any) => ({
      id: String(m.id),
      ticket_id: String(m.ticket_id),
      sender_role: m.sender_role,
      sender_name: m.sender_name,
      message: m.message,
      created_at: m.created_at,
    })),
    history: history.rows.map((h: any) => ({
      id: String(h.id),
      previous_status: h.previous_status,
      new_status: h.new_status,
      changed_by_role: h.changed_by_role,
      changed_by_name: h.changed_by_name,
      note: h.note || null,
      created_at: h.created_at,
    })),
  };
}

/* ============================================================
 * NOTIFYING
 * ============================================================ */

/**
 * Tells the people on a ticket that something happened to it.
 *
 * WHO: the creator and everyone permitted to answer, minus whoever caused the
 * event — nobody is told about their own action.
 *
 * `notifications` keys on `users.id`, so a hotel creator cannot be reached
 * through it; those go to `business_messages`, which is the inbox that table
 * already serves. Both are best-effort: a ticket that was saved is not undone
 * because a notification failed, which is why this never throws.
 */
async function notify(
  ticket: Ticket,
  actor: Actor,
  title: string,
  body: string
): Promise<void> {
  try {
    const recipients = new Set<string>();

    // The creator, when they are a `users` row and not the one acting.
    if (
      ticket.created_by_user_id &&
      String(ticket.created_by_user_id) !== String(actor.userId || '')
    ) {
      recipients.add(String(ticket.created_by_user_id));
    }

    // The assigned resolver, when there is one.
    if (
      ticket.assigned_to_user_id &&
      String(ticket.assigned_to_user_id) !== String(actor.userId || '')
    ) {
      recipients.add(String(ticket.assigned_to_user_id));
    }

    // Everyone who may answer this ticket by role, so an unassigned ticket
    // still reaches the people responsible for it.
    const roles = resolversFor(ticket.created_by_role);
    if (roles.length) {
      const placeholders = roles.map(() => '?').join(',');
      const staff = await query<{ id: string }>(
        `SELECT id FROM users WHERE role IN (${placeholders}) AND is_active = true`,
        roles
      );
      for (const row of staff.rows) {
        if (String(row.id) !== String(actor.userId || '')) recipients.add(String(row.id));
      }
    }

    for (const userId of recipients) {
      await createNotification(userId, ticket.order_id, 'GENERAL', title, body, {
        ticket_id: ticket.id,
        ticket_number: ticket.ticket_number,
      });
    }

    // The hotel creator, through the inbox that reaches a business_users row.
    if (
      ticket.created_by_business_user_id &&
      String(ticket.created_by_business_user_id) !== String(actor.businessUserId || '')
    ) {
      await query(
        `INSERT INTO business_messages (business_user_id, order_id, type, body)
         VALUES (?, ?, 'TICKET_UPDATE', ?)`,
        [ticket.created_by_business_user_id, ticket.order_id, `${title} — ${body}`]
      );
    }
  } catch (error: any) {
    logger.error(`[Ticket] notification failed for ${ticket.ticket_number}: ${error.message}`);
  }
}

/* ============================================================
 * WRITING
 * ============================================================ */

export interface CreateTicketInput {
  category?: unknown;
  title?: unknown;
  description?: unknown;
  priority?: unknown;
  order_id?: unknown;
  business_id?: unknown;
}

function text(value: unknown, field: string, max: number, required = true): string {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!s) {
    if (required) throw new AppError(`${field} is required.`, 400);
    return '';
  }
  return s.slice(0, max);
}

/**
 * Raises a ticket.
 *
 * The category is checked against the caller's ROLE before anything else, so a
 * Sorter asking for a Rewash is refused by name rather than by a database
 * error, and the 48-hour window is checked before the row is written so a late
 * complaint never becomes a ticket that has to be withdrawn.
 *
 * The ticket number is derived from the row's own id inside the transaction:
 * unique without a second sequence, and never reused.
 */
export async function createTicket(actor: Actor, input: CreateTicketInput): Promise<Ticket> {
  if (actor.role === 'SUPER_ADMIN') {
    throw new AppError('The Super Admin answers tickets rather than raising them.', 403);
  }
  const role = actor.role as CreatorRole;

  const category = String(input.category || '') as TicketCategory;
  const allowed = CATEGORIES_BY_ROLE[role];
  if (!allowed || !allowed.includes(category)) {
    throw new AppError(
      `A ${role.toLowerCase()} cannot raise a ${CATEGORY_LABELS[category] || 'ticket'} ticket. ` +
        `Allowed: ${(allowed || []).map((c) => CATEGORY_LABELS[c]).join(', ')}.`,
      403
    );
  }

  const title = text(input.title, 'Title', 200);
  const description = text(input.description, 'Description', 5000);
  const priority = PRIORITIES.includes(String(input.priority) as TicketPriority)
    ? (String(input.priority) as TicketPriority)
    : 'MEDIUM';

  const orderId = input.order_id ? String(input.order_id) : null;

  // The window, before anything is written. See assertWithinWindow.
  await assertWithinWindow(category, orderId);

  /*
   * WHAT THE TICKET IS ABOUT, resolved from the order where there is one so
   * the establishment and order number on the ticket are the ones the database
   * holds rather than whatever the client sent.
   */
  let businessId: string | null =
    actor.role === 'BUSINESS' && actor.businessId ? String(actor.businessId) : null;
  let businessName: string | null = null;
  let orderNumber: string | null = null;

  if (orderId) {
    const order = await query<any>(
      `SELECT o.id, o.order_number, bu.business_id,
              COALESCE(NULLIF(TRIM(b.establishment_name), ''), b.name) AS business_name
         FROM orders o
         LEFT JOIN business_users bu ON bu.id = o.business_user_id
         LEFT JOIN businesses b ON b.id = bu.business_id
        WHERE o.id = ?`,
      [orderId]
    );
    const row = order.rows[0];
    if (!row) throw new AppError('That order does not exist.', 404);

    /*
     * A HOTEL MAY ONLY RAISE A TICKET AGAINST ITS OWN ORDER. Without this a
     * business could complain about another establishment's delivery, and the
     * ticket would carry that establishment's name.
     */
    if (
      actor.role === 'BUSINESS' &&
      String(row.business_id || '') !== String(actor.businessId || '')
    ) {
      throw new AppError('That order does not belong to your establishment.', 403);
    }

    orderNumber = row.order_number;
    if (row.business_id) {
      businessId = String(row.business_id);
      businessName = row.business_name || null;
    }
  } else if (businessId) {
    const biz = await query<any>(
      `SELECT COALESCE(NULLIF(TRIM(establishment_name), ''), name) AS business_name
         FROM businesses WHERE id = ?`,
      [businessId]
    );
    businessName = biz.rows[0]?.business_name || null;
  }

  /*
   * EXACTLY ONE CREATOR, checked before the row is written.
   *
   * The schema cannot hold this: a CHECK is not allowed over a column whose
   * foreign key is ON DELETE SET NULL, and that SET NULL is what lets a ticket
   * outlive the account that raised it. So the guarantee lives here, at the
   * only place that inserts a ticket.
   */
  const creatorUserId = role === 'BUSINESS' ? null : actor.userId ?? null;
  const creatorBusinessUserId = role === 'BUSINESS' ? actor.businessUserId ?? null : null;
  if (!creatorUserId && !creatorBusinessUserId) {
    throw new AppError('Could not identify the account raising this ticket.', 401);
  }

  const connection = await getClient();
  try {
    await connection.beginTransaction();

    const [inserted]: any = await connection.execute(
      `INSERT INTO tickets
         (ticket_number, category, title, description, priority, status,
          created_by_user_id, created_by_business_user_id, created_by_role, created_by_name,
          business_id, business_name, order_id, order_number)
       VALUES ('', ?, ?, ?, ?, 'OPEN', ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        category, title, description, priority,
        creatorUserId,
        creatorBusinessUserId,
        role, actor.name,
        businessId, businessName, orderId, orderNumber,
      ]
    );

    const id = String(inserted.insertId);
    const ticketNumber = `SWT-${String(id).padStart(6, '0')}`;
    await connection.execute(`UPDATE tickets SET ticket_number = ? WHERE id = ?`, [
      ticketNumber, id,
    ]);

    // The opening row of the history: from nothing, into OPEN.
    await connection.execute(
      `INSERT INTO ticket_status_history
         (ticket_id, previous_status, new_status, changed_by_user_id, changed_by_role,
          changed_by_name, note)
       VALUES (?, NULL, 'OPEN', ?, ?, ?, 'Ticket raised')`,
      [id, role === 'BUSINESS' ? null : actor.userId ?? null, role, actor.name]
    );

    await connection.commit();
    logger.info(`[Ticket] ${ticketNumber} raised by ${role} ${actor.name}`);

    const ticket = await loadTicket(id);
    await notify(
      ticket, actor,
      `New ticket ${ticket.ticket_number}`,
      `${ticket.category_label}: ${ticket.title}`
    );
    return ticket;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

/**
 * Adds a message to the conversation.
 *
 * BOTH SIDES MAY REPLY. The creator answers questions about their own ticket
 * and the resolver asks them — that is what the conversation is for. What a
 * creator cannot do is change the status, which is the next function.
 *
 * A CLOSED TICKET TAKES NO MORE MESSAGES. Reopening is a status change, made
 * by someone entitled to make it, so that the reopening is recorded rather
 * than implied by a stray reply.
 */
export async function reply(
  actor: Actor,
  ticketId: string,
  messageInput: unknown
): Promise<TicketDetail> {
  const ticket = await loadTicket(ticketId);
  assertCanView(actor, ticket);

  if (ticket.status === 'CLOSED') {
    throw new AppError(
      `${ticket.ticket_number} is closed. It must be reopened before it can take a reply.`,
      409
    );
  }

  const message = text(messageInput, 'Message', 5000);

  await query(
    `INSERT INTO ticket_messages
       (ticket_id, sender_user_id, sender_business_user_id, sender_role, sender_name, message)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      ticketId,
      actor.role === 'BUSINESS' ? null : actor.userId,
      actor.role === 'BUSINESS' ? actor.businessUserId : null,
      actor.role,
      actor.name,
      message,
    ]
  );

  /*
   * A RESOLVED TICKET THAT IS REPLIED TO IS NOT RESOLVED. Anything else leaves
   * a question sitting under a green tick. OPEN and IN_PROGRESS are left where
   * they are: a reply is not progress on its own.
   */
  if (ticket.status === 'RESOLVED') {
    await setStatusInternal(actor, ticket, 'IN_PROGRESS', 'Reopened by a new reply');
  }

  await query(`UPDATE tickets SET updated_at = NOW() WHERE id = ?`, [ticketId]);

  const fresh = await loadTicket(ticketId);
  await notify(
    fresh, actor,
    `Reply on ${fresh.ticket_number}`,
    `${actor.name} (${actor.role}): ${message.slice(0, 120)}`
  );
  return getTicket(actor, ticketId);
}

/** Writes the status move and its history row. Permission is the caller's job. */
async function setStatusInternal(
  actor: Actor,
  ticket: Ticket,
  next: TicketStatus,
  note: string | null
): Promise<void> {
  const stamps =
    next === 'RESOLVED'
      ? `, resolved_at = NOW(), closed_at = NULL`
      : next === 'CLOSED'
      ? `, closed_at = NOW()`
      : // Moving back out of RESOLVED/CLOSED clears both: a ticket that is
        // open again was not resolved at the time those stamps claim.
        `, resolved_at = NULL, closed_at = NULL`;

  await query(`UPDATE tickets SET status = ?${stamps}, updated_at = NOW() WHERE id = ?`, [
    next, ticket.id,
  ]);

  await query(
    `INSERT INTO ticket_status_history
       (ticket_id, previous_status, new_status, changed_by_user_id, changed_by_role,
        changed_by_name, note)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      ticket.id, ticket.status, next,
      actor.role === 'BUSINESS' ? null : actor.userId,
      actor.role, actor.name, note,
    ]
  );
}

/**
 * Moves a ticket to a new status.
 *
 * RESOLVERS ONLY. A creator cannot resolve or close their own ticket, however
 * satisfied they are — `assertCanResolve` refuses it — so "resolved" always
 * means somebody answerable said so.
 */
export async function setStatus(
  actor: Actor,
  ticketId: string,
  statusInput: unknown,
  noteInput?: unknown
): Promise<TicketDetail> {
  const ticket = await loadTicket(ticketId);
  assertCanResolve(actor, ticket);

  const next = String(statusInput || '') as TicketStatus;
  if (!STATUSES.includes(next)) {
    throw new AppError(`Unknown status. Use one of: ${STATUSES.join(', ')}.`, 400);
  }
  if (next === ticket.status) {
    throw new AppError(`${ticket.ticket_number} is already ${STATUS_LABELS[next]}.`, 409);
  }

  const note = text(noteInput, 'Note', 500, false) || null;
  await setStatusInternal(actor, ticket, next, note);

  const fresh = await loadTicket(ticketId);
  await notify(
    fresh, actor,
    `${fresh.ticket_number} is now ${STATUS_LABELS[next]}`,
    note || `${actor.name} set the ticket to ${STATUS_LABELS[next]}.`
  );
  return getTicket(actor, ticketId);
}

/**
 * Puts a ticket in a resolver's hands.
 *
 * The assignee must be someone entitled to answer THIS ticket — a Manager
 * cannot be handed a Sorter's ticket, because a Manager cannot resolve one.
 * Assigning an OPEN ticket moves it to In Progress, since someone now has it.
 */
export async function assign(
  actor: Actor,
  ticketId: string,
  assigneeIdInput: unknown
): Promise<TicketDetail> {
  const ticket = await loadTicket(ticketId);
  assertCanResolve(actor, ticket);

  const assigneeId = assigneeIdInput ? String(assigneeIdInput) : null;

  if (assigneeId) {
    const roles = resolversFor(ticket.created_by_role);
    const placeholders = roles.map(() => '?').join(',');
    const found = await query<any>(
      `SELECT id, name, role FROM users WHERE id = ? AND role IN (${placeholders})`,
      [assigneeId, ...roles]
    );
    if (!found.rows[0]) {
      throw new AppError(
        `A ticket raised by a ${ticket.created_by_role.toLowerCase()} can only be assigned to: ` +
          `${roles.join(' or ')}.`,
        400
      );
    }
  }

  await query(
    `UPDATE tickets SET assigned_to_user_id = ?, assigned_at = ?, updated_at = NOW()
      WHERE id = ?`,
    [assigneeId, assigneeId ? new Date() : null, ticketId]
  );

  if (assigneeId && ticket.status === 'OPEN') {
    await setStatusInternal(actor, ticket, 'IN_PROGRESS', 'Assigned');
  }

  const fresh = await loadTicket(ticketId);
  await notify(
    fresh, actor,
    `${fresh.ticket_number} assigned`,
    assigneeId
      ? `Assigned to ${fresh.assigned_to_name || 'a resolver'} by ${actor.name}.`
      : `Unassigned by ${actor.name}.`
  );
  return getTicket(actor, ticketId);
}

/** The resolvers a ticket may be assigned to — for the assignment picker. */
export async function assignableFor(
  actor: Actor,
  ticketId: string
): Promise<Array<{ id: string; name: string; role: string }>> {
  const ticket = await loadTicket(ticketId);
  assertCanResolve(actor, ticket);

  const roles = resolversFor(ticket.created_by_role);
  const placeholders = roles.map(() => '?').join(',');
  const rows = await query<any>(
    `SELECT id, name, role FROM users WHERE role IN (${placeholders}) AND is_active = true
      ORDER BY role, name`,
    roles
  );
  return rows.rows.map((r: any) => ({ id: String(r.id), name: r.name, role: r.role }));
}

/** What this actor may raise — drives the category picker on the form. */
export function categoriesForActor(actor: Actor): Array<{ value: TicketCategory; label: string }> {
  if (actor.role === 'SUPER_ADMIN') return [];
  return (CATEGORIES_BY_ROLE[actor.role as CreatorRole] || []).map((value) => ({
    value,
    label: CATEGORY_LABELS[value],
  }));
}
