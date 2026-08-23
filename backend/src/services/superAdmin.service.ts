import { query } from '../config/database';
import { AppError } from '../utils/appError';
import { logger } from '../utils/logger';
import { getCompleteness, Completeness } from './businessCompleteness';
import {
  buildBusinessProfileUpdate,
  applyContactUpdate,
  UpdateBusinessProfileInput,
} from './businessProfile.service';
import { HEAD_CONTACT_JOIN, HEAD_CONTACT_COLUMNS } from './businessContact.service';

/**
 * B2B vs B2C is not a column — it is which owner column an order
 * carries. A business order is stamped with business_user_id, a
 * customer order with user_id. Everything below derives the split
 * from that one fact rather than from a flag that could drift.
 */
const CHANNEL_CASE = `CASE WHEN o.business_user_id IS NOT NULL THEN 'B2B' ELSE 'B2C' END`;

/** Cancelled orders are excluded from revenue but counted separately. */
const REVENUE_PREDICATE = `o.status <> 'CANCELLED'`;

function parseDateRange(from?: string, to?: string): { from: string; to: string } {
  const isDate = (v?: string) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
  const today = new Date();
  const defaultTo = today.toISOString().slice(0, 10);
  const defaultFrom = new Date(today.getTime() - 29 * 86400000).toISOString().slice(0, 10);

  const start = isDate(from) ? from! : defaultFrom;
  const end = isDate(to) ? to! : defaultTo;
  if (start > end) {
    throw new AppError('`from` must not be after `to`', 400);
  }
  return { from: start, to: end };
}

export interface SalesSummary {
  from: string;
  to: string;
  channels: Array<{
    channel: 'B2B' | 'B2C';
    orders: number;
    revenue: number;
    average_order_value: number;
  }>;
  totals: { orders: number; revenue: number; cancelled_orders: number };
}

/** Headline numbers for the dashboard tiles, split by channel. */
async function getSalesSummary(from?: string, to?: string): Promise<SalesSummary> {
  const range = parseDateRange(from, to);

  const result = await query<{
    channel: 'B2B' | 'B2C';
    orders: string;
    revenue: string;
  }>(
    `SELECT ${CHANNEL_CASE} AS channel,
            COUNT(*) AS orders,
            COALESCE(SUM(o.total), 0) AS revenue
       FROM orders o
      WHERE ${REVENUE_PREDICATE}
        AND DATE(o.created_at) BETWEEN ? AND ?
      GROUP BY channel`,
    [range.from, range.to]
  );

  const [cancelled] = (
    await query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM orders o
        WHERE o.status = 'CANCELLED' AND DATE(o.created_at) BETWEEN ? AND ?`,
      [range.from, range.to]
    )
  ).rows;

  // Both channels are always present, so a chart never has to cope with
  // a missing series just because one side had no orders that period.
  const channels = (['B2B', 'B2C'] as const).map((channel) => {
    const row = result.rows.find((r) => r.channel === channel);
    const orders = Number(row?.orders || 0);
    const revenue = Number(row?.revenue || 0);
    return {
      channel,
      orders,
      revenue,
      average_order_value: orders > 0 ? Number((revenue / orders).toFixed(2)) : 0,
    };
  });

  return {
    ...range,
    channels,
    totals: {
      orders: channels.reduce((sum, c) => sum + c.orders, 0),
      revenue: Number(channels.reduce((sum, c) => sum + c.revenue, 0).toFixed(2)),
      cancelled_orders: Number(cancelled?.n || 0),
    },
  };
}

export interface SalesPoint {
  period: string;
  b2b_revenue: number;
  b2c_revenue: number;
  b2b_orders: number;
  b2c_orders: number;
}

const GRANULARITIES: Record<string, string> = {
  day: '%Y-%m-%d',
  month: '%Y-%m',
};

/**
 * Time series for the dashboard chart. Every period in the range is
 * returned, including empty ones — a chart with gaps silently misleads,
 * so zero-filling happens here rather than in each client.
 */
async function getSalesTimeseries(
  from?: string,
  to?: string,
  granularity: string = 'day'
): Promise<{ from: string; to: string; granularity: string; points: SalesPoint[] }> {
  const range = parseDateRange(from, to);
  const format = GRANULARITIES[granularity];
  if (!format) {
    throw new AppError(`granularity must be one of: ${Object.keys(GRANULARITIES).join(', ')}`, 400);
  }

  const result = await query<{
    period: string;
    channel: 'B2B' | 'B2C';
    revenue: string;
    orders: string;
  }>(
    `SELECT DATE_FORMAT(o.created_at, ?) AS period,
            ${CHANNEL_CASE} AS channel,
            COALESCE(SUM(o.total), 0) AS revenue,
            COUNT(*) AS orders
       FROM orders o
      WHERE ${REVENUE_PREDICATE}
        AND DATE(o.created_at) BETWEEN ? AND ?
      GROUP BY period, channel
      ORDER BY period ASC`,
    [format, range.from, range.to]
  );

  const byPeriod = new Map<string, SalesPoint>();
  const blank = (period: string): SalesPoint => ({
    period,
    b2b_revenue: 0,
    b2c_revenue: 0,
    b2b_orders: 0,
    b2c_orders: 0,
  });

  // Seed every period in the range so gaps show as zero, not as absent.
  const cursor = new Date(range.from + 'T00:00:00Z');
  const end = new Date(range.to + 'T00:00:00Z');
  while (cursor <= end) {
    const iso = cursor.toISOString();
    const key = granularity === 'month' ? iso.slice(0, 7) : iso.slice(0, 10);
    if (!byPeriod.has(key)) byPeriod.set(key, blank(key));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  for (const row of result.rows) {
    const point = byPeriod.get(row.period) || blank(row.period);
    if (row.channel === 'B2B') {
      point.b2b_revenue = Number(row.revenue);
      point.b2b_orders = Number(row.orders);
    } else {
      point.b2c_revenue = Number(row.revenue);
      point.b2c_orders = Number(row.orders);
    }
    byPeriod.set(row.period, point);
  }

  return {
    ...range,
    granularity,
    points: [...byPeriod.values()].sort((a, b) => a.period.localeCompare(b.period)),
  };
}


/* ===================================================================
 * APPROVAL QUEUE
 * =================================================================== */

const BUSINESS_STATUSES = ['PENDING', 'ACTIVE', 'INACTIVE', 'REJECTED'];
const RIDER_STATUSES = ['PENDING', 'APPROVED', 'REJECTED'];

export interface PendingBusiness {
  id: string;
  name: string;
  business_type: string;
  registration_type: string;
  contact_person_name: string | null;
  mobile_number: string | null;
  email: string | null;
  city: string | null;
  gst_number: string | null;
  status: string;
  created_at: Date;
}

/** Businesses awaiting (or already given) a decision, newest first. */
async function listBusinessApprovals(status: string = 'PENDING'): Promise<PendingBusiness[]> {
  if (!BUSINESS_STATUSES.includes(status)) {
    throw new AppError(`status must be one of: ${BUSINESS_STATUSES.join(', ')}`, 400);
  }
  const result = await query<PendingBusiness>(
    `SELECT b.id, b.name, b.business_type, b.registration_type,
            hbu.name AS contact_person_name, hbu.mobile_number,
            COALESCE(hbu.email, b.email) AS email,
            b.city, b.gst_number, b.status, b.created_at
       FROM businesses b
       ${HEAD_CONTACT_JOIN}
      WHERE b.status = ?
      ORDER BY b.created_at DESC
      LIMIT 200`,
    [status]
  );
  return result.rows;
}

export interface PendingRider {
  id: string;
  name: string | null;
  email: string | null;
  mobile_number: string;
  approval_status: string | null;
  is_active: boolean;
  created_at: Date;
}

async function listRiderApprovals(status: string = 'PENDING'): Promise<PendingRider[]> {
  if (!RIDER_STATUSES.includes(status)) {
    throw new AppError(`status must be one of: ${RIDER_STATUSES.join(', ')}`, 400);
  }
  const result = await query<PendingRider>(
    `SELECT id, name, email, mobile_number, approval_status, is_active, created_at
       FROM users
      WHERE role = 'RIDER' AND approval_status = ?
      ORDER BY created_at DESC
      LIMIT 200`,
    [status]
  );
  return result.rows;
}

function decisionFor(action: string): 'APPROVE' | 'REJECT' {
  const normalized = String(action || '').toUpperCase();
  if (normalized !== 'APPROVE' && normalized !== 'REJECT') {
    throw new AppError("action must be 'approve' or 'reject'", 400);
  }
  return normalized;
}

/**
 * Approving flips the business live; rejecting records the decision
 * without deleting anything, so a rejected applicant can still be
 * looked up and the reason is preserved.
 *
 * The already-in-that-state check makes a double-tap on Approve a 409
 * rather than a silent re-stamp of the reviewer and timestamp.
 */
async function decideBusiness(
  reviewerId: string,
  businessId: string,
  action: string,
  note?: string
): Promise<{ id: string; status: string }> {
  const decision = decisionFor(action);
  const nextStatus = decision === 'APPROVE' ? 'ACTIVE' : 'REJECTED';

  const existing = await query<{ id: string; status: string }>(
    `SELECT id, status FROM businesses WHERE id = ?`,
    [businessId]
  );
  if (existing.rows.length === 0) {
    throw new AppError('Business not found', 404);
  }
  if (existing.rows[0].status === nextStatus) {
    throw new AppError(`Business is already ${nextStatus}`, 409);
  }

  await query(
    `UPDATE businesses
        SET status = ?, reviewed_by = ?, approval_note = ?, updated_at = NOW()
      WHERE id = ?`,
    [nextStatus, reviewerId, note ? String(note).slice(0, 300) : null, businessId]
  );

  logger.info(`[SuperAdmin] Business ${businessId} ${nextStatus} by ${reviewerId}`);
  return { id: String(businessId), status: nextStatus };
}

/**
 * A rider may only work once approved, so is_active tracks the decision
 * rather than being set independently — one switch, not two that can
 * disagree with each other.
 */
async function decideRider(
  reviewerId: string,
  riderId: string,
  action: string,
  note?: string
): Promise<{ id: string; approval_status: string }> {
  const decision = decisionFor(action);
  const nextStatus = decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';

  const existing = await query<{ id: string; approval_status: string | null }>(
    `SELECT id, approval_status FROM users WHERE id = ? AND role = 'RIDER'`,
    [riderId]
  );
  if (existing.rows.length === 0) {
    throw new AppError('Rider not found', 404);
  }
  if (existing.rows[0].approval_status === nextStatus) {
    throw new AppError(`Rider is already ${nextStatus}`, 409);
  }

  await query(
    `UPDATE users
        SET approval_status = ?, is_active = ?, reviewed_at = NOW(), reviewed_by = ?,
            approval_note = ?, updated_at = NOW()
      WHERE id = ? AND role = 'RIDER'`,
    [nextStatus, decision === 'APPROVE', reviewerId, note ? String(note).slice(0, 300) : null, riderId]
  );

  logger.info(`[SuperAdmin] Rider ${riderId} ${nextStatus} by ${reviewerId}`);
  return { id: String(riderId), approval_status: nextStatus };
}

/* ===================================================================
 * DIRECT ENTRY CREATION -- REMOVED
 *
 * `createBusiness` and `createRider` used to live here, behind
 * POST /api/super-admin/businesses and POST /api/super-admin/riders.
 *
 * A Super Admin no longer creates either. Both now come into existence the
 * one way: a MANAGER raises a creation request and the Super Admin approves
 * it, which is `creationRequest.service` and is untouched. That leaves one
 * path into `businesses` and one into `users`, both of which re-verify the
 * GSTIN and set the credentials at approval time -- so removing these did
 * not remove a capability, it removed the second, unreviewed copy of one.
 *
 * Everything else about a business and a rider is unchanged: listing,
 * viewing, editing, approving, disabling, deleting, rider login, rider
 * assignment and every rider API still work exactly as they did.
 * =================================================================== */

export {
  getSalesSummary,
  getSalesTimeseries,
  listBusinessApprovals,
  listRiderApprovals,
  decideBusiness,
  decideRider,
};

/* ===================================================================
 * COMPANY / ESTABLISHMENT DETAILS  (super admin view of any business)
 * =================================================================== */

/**
 * Onboarding is done by the super admin, and details get missed while
 * it happens. These three functions are what the Company /
 * Establishment Details screen uses to find those gaps and close them.
 */

export interface BusinessDetail {
  business_id: string;
  business_name: string;
  /** The establishment CATEGORY, from businesses.business_type. */
  customer_type: string | null;
  /** B2B or B2C. */
  registration_type: string;
  other_type_specify: string | null;
  establishment_address: string | null;
  gst_number: string | null;
  pan_number: string | null;
  website: string | null;
  contact_person_name: string | null;
  designation: string | null;
  mobile_number: string | null;
  whatsapp_number: string | null;
  email_id: string | null;
  alternate_contact_person: string | null;
  alternate_mobile_no: string | null;
  status: string;
  created_at: Date;
  updated_at: Date;
}

/** Same shape the business sees for itself, for any business id. */
async function getBusinessDetail(
  businessId: string
): Promise<BusinessDetail & Completeness> {
  const result = await query<BusinessDetail>(
    `SELECT b.id AS business_id,
            COALESCE(NULLIF(TRIM(b.establishment_name), ''), b.name) AS business_name,
            b.business_type AS customer_type,
            b.registration_type,
            b.other_type_specify,
            COALESCE(b.establishment_address, b.address) AS establishment_address,
            b.gst_number, b.pan_number, b.website,
            ${HEAD_CONTACT_COLUMNS},
            (SELECT a.name FROM business_users a
              WHERE a.business_id = b.id AND a.contact_type = 'ALTERNATIVE'
              ORDER BY a.id LIMIT 1) AS alternate_contact_person,
            (SELECT a.mobile_number FROM business_users a
              WHERE a.business_id = b.id AND a.contact_type = 'ALTERNATIVE'
              ORDER BY a.id LIMIT 1) AS alternate_mobile_no,
            b.status, b.created_at, b.updated_at
       FROM businesses b
       ${HEAD_CONTACT_JOIN}
      WHERE b.id = ?`,
    [businessId]
  );
  const detail = result.rows[0];
  if (!detail) {
    throw new AppError('Business not found', 404);
  }
  return { ...detail, ...(await getCompleteness(businessId)) };
}

export interface BusinessCompletenessRow {
  business_id: string;
  business_name: string;
  status: string;
  /** Shown on the account card, and the number an invoice is billed under. */
  gst_number: string | null;
  is_complete: boolean;
  missing_fields: Completeness['missing_fields'];
}

/**
 * Every business with its completeness, so the super admin can see at a
 * glance who cannot order and why. `onlyIncomplete` narrows it to the
 * ones actually needing attention.
 */
async function listBusinessCompleteness(
  onlyIncomplete = false
): Promise<BusinessCompletenessRow[]> {
  const idsResult = await query<{ id: string; name: string; status: string; gst_number: string | null }>(
    `SELECT id, COALESCE(NULLIF(TRIM(establishment_name), ''), name) AS name, status, gst_number
       FROM businesses ORDER BY created_at DESC LIMIT 500`
  );

  const rows: BusinessCompletenessRow[] = [];
  for (const business of idsResult.rows) {
    const completeness = await getCompleteness(String(business.id));
    if (onlyIncomplete && completeness.is_complete) continue;
    rows.push({
      business_id: String(business.id),
      business_name: business.name,
      status: business.status,
      gst_number: business.gst_number || null,
      ...completeness,
    });
  }
  return rows;
}

/**
 * Fills in a business's establishment details on its behalf.
 *
 * Validation is deliberately the SAME code the business's own profile
 * update runs, so a record the super admin saves can never be shaped
 * differently from one the business saves itself.
 *
 * Unlike the self-service path the establishment name IS editable here
 * — a name typed wrong during onboarding is exactly the kind of thing
 * this screen exists to correct.
 */
async function updateBusinessDetail(
  businessId: string,
  input: UpdateBusinessProfileInput & { establishmentName?: string }
): Promise<BusinessDetail & Completeness> {
  const exists = await query(`SELECT id FROM businesses WHERE id = ?`, [businessId]);
  if (exists.rows.length === 0) {
    throw new AppError('Business not found', 404);
  }

  const plan = buildBusinessProfileUpdate(input, { allowNameChange: true });

  if (plan.fields.length > 0) {
    await query(`UPDATE businesses SET ${plan.fields.join(', ')}, updated_at = NOW() WHERE id = ?`, [
      ...plan.values,
      businessId,
    ]);
  }

  // The contact half goes to the business's PRIMARY row -- the same row the
  // business edits itself, and the one the order summary and PDF read.
  const head = await query<{ id: string }>(
    `SELECT id FROM business_users WHERE business_id = ?
      ORDER BY FIELD(contact_type,'PRIMARY','ALTERNATIVE'), id LIMIT 1`,
    [businessId]
  );
  await applyContactUpdate(businessId, head.rows[0] ? String(head.rows[0].id) : null, plan);

  logger.info(`[SuperAdmin] Establishment details updated for business ${businessId}`);
  return getBusinessDetail(businessId);
}

export { getBusinessDetail, listBusinessCompleteness, updateBusinessDetail };
