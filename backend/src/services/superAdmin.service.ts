import bcrypt from 'bcrypt';
import { query } from '../config/database';
import { AppError } from '../utils/appError';
import { logger } from '../utils/logger';
import { getCompleteness, Completeness } from './businessCompleteness';
import {
  buildBusinessProfileUpdate,
  UpdateBusinessProfileInput,
} from './businessProfile.service';

const SALT_ROUNDS = 10;

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
    `SELECT b.id, b.name, b.business_type, b.contact_person_name, b.mobile_number,
            COALESCE(b.email, MIN(bu.email)) AS email, b.city, b.gst_number, b.status, b.created_at
       FROM businesses b
       LEFT JOIN business_users bu ON bu.business_id = b.id
      WHERE b.status = ?
      GROUP BY b.id
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
        SET status = ?, reviewed_at = NOW(), reviewed_by = ?, approval_note = ?, updated_at = NOW()
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
 * DIRECT ENTRY CREATION
 * =================================================================== */

function requireField(value: unknown, label: string): string {
  const text = String(value ?? '').trim();
  if (!text) throw new AppError(`${label} is required`, 400);
  return text;
}

const MOBILE_PATTERN = /^[6-9]\d{9}$/;

/** Same normalisation the auth service applies, so one number cannot
 *  enter the system in two shapes. */
function requireMobile(value: unknown): string {
  const mobile = String(value ?? '')
    .replace(/[\s-]/g, '')
    .replace(/^(\+91|91|0)/, '');
  if (!MOBILE_PATTERN.test(mobile)) {
    throw new AppError('Mobile must be a valid 10-digit Indian mobile number', 400);
  }
  return mobile;
}

export interface CreateBusinessInput {
  name: string;
  business_type?: string;
  contact_person_name?: string;
  mobile_number: string;
  email?: string;
  address: string;
  city: string;
  state?: string;
  pincode?: string;
  gst_number?: string;
  pan_number?: string;
}

/**
 * A business entered directly by the super admin is ACTIVE at once —
 * it was created by the approver, so routing it into their own
 * approval queue would be theatre.
 */
async function createBusiness(
  creatorId: string,
  input: CreateBusinessInput
): Promise<{ id: string; name: string; status: string }> {
  const name = requireField(input.name, 'Business name');
  const address = requireField(input.address, 'Address');
  const city = requireField(input.city, 'City');
  const mobile = requireMobile(input.mobile_number);

  if (input.gst_number) {
    const dupe = await query(`SELECT id FROM businesses WHERE gst_number = ?`, [input.gst_number]);
    if (dupe.rows.length > 0) throw new AppError('GST number already registered', 409);
  }

  const inserted = await query(
    `INSERT INTO businesses
       (name, business_type, contact_person_name, mobile_number, email, address, city, state,
        pincode, gst_number, pan_number, status, created_by_admin_id, reviewed_at, reviewed_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, NOW(), ?)`,
    [
      name,
      input.business_type || 'OTHER',
      input.contact_person_name || null,
      mobile,
      input.email ? String(input.email).toLowerCase() : null,
      address,
      city,
      input.state || null,
      input.pincode || null,
      input.gst_number || null,
      input.pan_number || null,
      creatorId,
      creatorId,
    ]
  );

  logger.info(`[SuperAdmin] Business ${inserted.insertId} created by ${creatorId}`);
  return { id: String(inserted.insertId), name, status: 'ACTIVE' };
}

export interface CreateRiderInput {
  name: string;
  mobile_number: string;
  email?: string;
  password: string;
}

/**
 * Riders are ordinary `users` rows, so they inherit the same mobile
 * uniqueness, bcrypt hashing and OTP machinery as every other account
 * instead of needing a parallel identity system.
 */
async function createRider(
  creatorId: string,
  input: CreateRiderInput
): Promise<{ id: string; name: string; mobile_number: string; approval_status: string }> {
  const name = requireField(input.name, 'Rider name');
  const mobile = requireMobile(input.mobile_number);
  const password = String(input.password ?? '');
  if (password.length < 8) {
    throw new AppError('Password must be at least 8 characters long', 400);
  }

  const dupe = await query(`SELECT id FROM users WHERE mobile_number = ?`, [mobile]);
  if (dupe.rows.length > 0) {
    throw new AppError('That mobile number is already registered', 409);
  }
  if (input.email) {
    const emailDupe = await query(`SELECT id FROM users WHERE email = ?`, [
      String(input.email).toLowerCase(),
    ]);
    if (emailDupe.rows.length > 0) throw new AppError('That email is already registered', 409);
  }

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  const inserted = await query(
    `INSERT INTO users
       (name, email, mobile_number, password_hash, role, is_active, mobile_verified,
        approval_status, reviewed_at, reviewed_by)
     VALUES (?, ?, ?, ?, 'RIDER', true, true, 'APPROVED', NOW(), ?)`,
    [name, input.email ? String(input.email).toLowerCase() : null, mobile, passwordHash, creatorId]
  );

  logger.info(`[SuperAdmin] Rider ${inserted.insertId} created by ${creatorId}`);
  return {
    id: String(inserted.insertId),
    name,
    mobile_number: mobile,
    approval_status: 'APPROVED',
  };
}

export {
  getSalesSummary,
  getSalesTimeseries,
  listBusinessApprovals,
  listRiderApprovals,
  decideBusiness,
  decideRider,
  createBusiness,
  createRider,
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
  customer_type: string | null;
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
            b.business_type AS customer_type, b.other_type_specify,
            COALESCE(b.establishment_address, b.address) AS establishment_address,
            b.gst_number, b.pan_number, b.website,
            b.contact_person_name, b.designation,
            COALESCE(b.mobile_number, MIN(bu.mobile_number)) AS mobile_number,
            b.whatsapp_number,
            COALESCE(b.email_id, b.email, MIN(bu.email)) AS email_id,
            b.alternate_contact_person, b.alternate_mobile_no,
            b.status, b.created_at, b.updated_at
       FROM businesses b
       LEFT JOIN business_users bu ON bu.business_id = b.id
      WHERE b.id = ?
      GROUP BY b.id`,
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
  const idsResult = await query<{ id: string; name: string; status: string }>(
    `SELECT id, COALESCE(NULLIF(TRIM(establishment_name), ''), name) AS name, status
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

  const { fields, values } = buildBusinessProfileUpdate(input, { allowNameChange: true });

  if (fields.length > 0) {
    fields.push('updated_at = NOW()');
    await query(`UPDATE businesses SET ${fields.join(', ')} WHERE id = ?`, [...values, businessId]);
  }

  // The authenticated account row carries the mobile number that the
  // order summary and PDF read, so it has to move with the profile.
  if (input.mobileNumber !== undefined) {
    await query(
      `UPDATE business_users SET mobile_number = ?, updated_at = NOW() WHERE business_id = ?`,
      [String(input.mobileNumber).trim(), businessId]
    );
  }

  logger.info(`[SuperAdmin] Establishment details updated for business ${businessId}`);
  return getBusinessDetail(businessId);
}

export { getBusinessDetail, listBusinessCompleteness, updateBusinessDetail };
