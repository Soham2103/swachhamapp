import { Router, Request, Response, NextFunction } from 'express';
import {
  createTicket,
  listTickets,
  getTicket,
  reply,
  setStatus,
  assign,
  assignableFor,
  categoriesForActor,
  windowForOrder,
  CATEGORIES_BY_ROLE,
  CATEGORY_LABELS,
  STATUS_LABELS,
  Actor,
  TicketRole,
} from '../services/ticket.service';
import { query } from '../config/database';
import { sendSuccess } from '../utils/response';
import { authenticate, AuthenticatedRequest } from '../middleware/auth';
import { AppError } from '../utils/appError';

/**
 * THE ONE TICKET ROUTER.
 *
 * Every role uses these same endpoints — there is no `/sorter/tickets`,
 * `/manager/tickets` or `/business/tickets`, because a second set of routes is
 * how two ticket systems start. What differs by role is what comes BACK, and
 * that is decided in the service by the actor, not by which URL was called.
 *
 * Authentication is required for all of it. There is no `authorize(...)` at
 * router level on purpose: every role legitimately reaches these routes, and
 * the finer question — which tickets, and what may be done to them — needs the
 * ticket in hand. The service answers it on every call.
 */
const router = Router();
router.use(authenticate);

/**
 * The caller, in the shape the service works in.
 *
 * A BUSINESS token's `id` is a `business_users` row; every other role's is a
 * `users` row. That is the split the ticket tables carry, so it is resolved
 * once here rather than in each handler.
 *
 * The NAME is read from the database rather than taken from the token: it goes
 * onto the ticket and every message as the record of who spoke, and a token
 * can be minted before a rename.
 */
async function actorFrom(req: Request): Promise<Actor> {
  const authReq = req as AuthenticatedRequest;
  const user = authReq.user;
  if (!user) throw new AppError('Unauthorized', 401);

  const role = String(user.role || '').toUpperCase();

  if (role === 'BUSINESS') {
    const rows = await query<any>(
      `SELECT bu.id, bu.business_id, bu.name,
              COALESCE(NULLIF(TRIM(b.establishment_name), ''), b.name) AS business_name
         FROM business_users bu
         LEFT JOIN businesses b ON b.id = bu.business_id
        WHERE bu.id = ?`,
      [user.id]
    );
    const row = rows.rows[0];
    if (!row) throw new AppError('Unauthorized', 401);
    return {
      role: 'BUSINESS',
      businessUserId: String(row.id),
      businessId: row.business_id ? String(row.business_id) : null,
      name: row.name || row.business_name || 'Business',
    };
  }

  if (!['SORTER', 'MANAGER', 'SUPER_ADMIN'].includes(role)) {
    throw new AppError('This role does not take part in the ticket system.', 403);
  }

  const rows = await query<any>(`SELECT id, name FROM users WHERE id = ?`, [user.id]);
  const row = rows.rows[0];
  if (!row) throw new AppError('Unauthorized', 401);

  return {
    role: role as TicketRole,
    userId: String(row.id),
    name: row.name || role,
  };
}

/**
 * GET /api/tickets/meta
 *
 * What this caller may raise, and the labels every screen renders. Served so
 * the app never carries its own copy of the role/category matrix — one source,
 * and a change here reaches every screen without a release.
 */
router.get('/meta', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const actor = await actorFrom(req);
    sendSuccess(res, {
      role: actor.role,
      categories: categoriesForActor(actor),
      categories_by_role: CATEGORIES_BY_ROLE,
      category_labels: CATEGORY_LABELS,
      status_labels: STATUS_LABELS,
      priorities: ['LOW', 'MEDIUM', 'HIGH', 'URGENT'],
      can_raise: actor.role !== 'SUPER_ADMIN',
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/tickets/order/:orderId/window
 *
 * How long is left to raise a Quality Issue, Missing Item or Rewash Request
 * against this order. The form reads it to grey out what has expired rather
 * than offering a category the server would refuse.
 */
router.get('/order/:orderId/window', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await actorFrom(req);
    sendSuccess(res, await windowForOrder(req.params.orderId));
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/tickets
 *   ?ticket_number=&status=&priority=&category=&business_id=&order_number=
 *   &date_from=&date_to=&limit=&offset=
 *
 * The tickets this caller may see. The scope is the permission — see
 * `listTickets` — so there is no parameter here that widens it.
 */
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const actor = await actorFrom(req);
    const q = req.query;
    const data = await listTickets(actor, {
      ticket_number: q.ticket_number ? String(q.ticket_number) : undefined,
      status: q.status ? String(q.status) : undefined,
      priority: q.priority ? String(q.priority) : undefined,
      category: q.category ? String(q.category) : undefined,
      business_id: q.business_id ? String(q.business_id) : undefined,
      order_number: q.order_number ? String(q.order_number) : undefined,
      date_from: q.date_from ? String(q.date_from) : undefined,
      date_to: q.date_to ? String(q.date_to) : undefined,
      limit: q.limit ? Number(q.limit) : undefined,
      offset: q.offset ? Number(q.offset) : undefined,
    });
    sendSuccess(res, data, `${data.total} ticket(s)`);
  } catch (error) {
    next(error);
  }
});

/** POST /api/tickets — raise one. Role and the 48-hour window decide. */
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const actor = await actorFrom(req);
    const ticket = await createTicket(actor, req.body || {});
    sendSuccess(res, ticket, `Ticket ${ticket.ticket_number} raised`);
  } catch (error) {
    next(error);
  }
});

/** GET /api/tickets/:id — one ticket, its conversation and its history. */
router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const actor = await actorFrom(req);
    sendSuccess(res, await getTicket(actor, req.params.id));
  } catch (error) {
    next(error);
  }
});

/** POST /api/tickets/:id/messages — reply. Creator and resolver both may. */
router.post('/:id/messages', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const actor = await actorFrom(req);
    const detail = await reply(actor, req.params.id, req.body?.message);
    sendSuccess(res, detail, 'Reply sent');
  } catch (error) {
    next(error);
  }
});

/**
 * PATCH /api/tickets/:id/status  { status, note? }
 *
 * Resolvers only. A creator calling this is refused — resolving your own
 * complaint is the one thing the permissions exist to prevent.
 */
router.patch('/:id/status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const actor = await actorFrom(req);
    const detail = await setStatus(actor, req.params.id, req.body?.status, req.body?.note);
    sendSuccess(res, detail, `Ticket ${detail.ticket_number} is now ${detail.status_label}`);
  } catch (error) {
    next(error);
  }
});

/** PATCH /api/tickets/:id/assign  { assigned_to_user_id | null } */
router.patch('/:id/assign', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const actor = await actorFrom(req);
    const detail = await assign(actor, req.params.id, req.body?.assigned_to_user_id);
    sendSuccess(res, detail, 'Assignment updated');
  } catch (error) {
    next(error);
  }
});

/** GET /api/tickets/:id/assignable — who this ticket may be handed to. */
router.get('/:id/assignable', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const actor = await actorFrom(req);
    sendSuccess(res, await assignableFor(actor, req.params.id));
  } catch (error) {
    next(error);
  }
});

export default router;
