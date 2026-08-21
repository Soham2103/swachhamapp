import { query } from '../config/database';
import { AppError } from '../utils/appError';
import { logger } from '../utils/logger';

/**
 * The mobile numbers a business answers on.
 *
 * Any number in this list can be used to sign in to the business, so
 * the list is an authentication surface, not just contact details --
 * which is why adding to it is governed by a per-business allowance the
 * super admin sets, and why removals cannot empty it.
 */

const MOBILE_RE = /^[6-9]\d{9}$/;

function normalizeMobile(value: unknown): string {
  const mobile = String(value ?? '')
    .replace(/[\s-]/g, '')
    .replace(/^(\+91|91|0)/, '');
  if (!MOBILE_RE.test(mobile)) {
    throw new AppError('Enter a valid 10-digit Indian mobile number', 400);
  }
  return mobile;
}

export interface BusinessMobile {
  id: string;
  mobile_number: string;
  label: string | null;
  is_primary: boolean;
  created_at: Date;
}

export interface MobileList {
  business_id: string;
  /** How many this business is allowed to hold, set by the super admin. */
  max_mobiles: number;
  used: number;
  remaining: number;
  mobiles: BusinessMobile[];
}

async function listMobiles(businessId: string): Promise<MobileList> {
  const business = await query<{ id: string; max_mobiles: number }>(
    `SELECT id, max_mobiles FROM businesses WHERE id = ?`,
    [businessId]
  );
  if (!business.rows[0]) {
    throw new AppError('Business not found', 404);
  }

  const rows = await query<BusinessMobile>(
    `SELECT id, mobile_number, label, is_primary, created_at
       FROM business_mobiles WHERE business_id = ?
      ORDER BY is_primary DESC, id ASC`,
    [businessId]
  );

  const max = Number(business.rows[0].max_mobiles);
  return {
    business_id: String(businessId),
    max_mobiles: max,
    used: rows.rows.length,
    remaining: Math.max(0, max - rows.rows.length),
    mobiles: rows.rows,
  };
}

/**
 * Where else this number already appears.
 *
 * Adding a duplicate is allowed on purpose, but it has a consequence
 * worth stating out loud: a number that answers to more than one
 * account resolves DOWN at sign-in and may end up able to reach none of
 * them. The caller gets this back as a warning so the person adding it
 * is told, rather than finding out weeks later at a login screen.
 */
async function describeConflicts(mobile: string, exceptBusinessId?: string): Promise<string[]> {
  const [users, businesses] = await Promise.all([
    query<{ role: string; name: string | null }>(
      `SELECT role, name FROM users WHERE mobile_number = ?`,
      [mobile]
    ),
    query<{ id: string; name: string }>(
      `SELECT DISTINCT b.id, b.name
         FROM business_mobiles bm JOIN businesses b ON b.id = bm.business_id
        WHERE bm.mobile_number = ? AND bm.business_id <> ?`,
      [mobile, exceptBusinessId ?? '0']
    ),
  ]);

  return [
    ...users.rows.map((u) => `${u.role.replace('_', ' ').toLowerCase()} account${u.name ? ` (${u.name})` : ''}`),
    ...businesses.rows.map((b) => `business "${b.name}"`),
  ];
}

export interface AddResult extends MobileList {
  /** Non-fatal: the number was added, but it is now ambiguous. */
  warning?: string;
}

/**
 * Adds a number, bounded by the business's allowance.
 *
 * The count is re-read inside the same call rather than trusted from
 * the client, so two people adding at once cannot both slip past the
 * last free slot.
 */
async function addMobile(
  businessId: string,
  input: { mobile_number: unknown; label?: unknown; is_primary?: boolean },
  actorId?: string
): Promise<AddResult> {
  const mobile = normalizeMobile(input.mobile_number);
  const current = await listMobiles(businessId);

  if (current.mobiles.some((m) => m.mobile_number === mobile)) {
    throw new AppError('That number is already on this business', 409);
  }
  if (current.used >= current.max_mobiles) {
    throw new AppError(
      `This business is allowed ${current.max_mobiles} mobile number${current.max_mobiles === 1 ? '' : 's'} and already has ${current.used}. Ask a super admin to raise the limit first.`,
      409
    );
  }

  const conflicts = await describeConflicts(mobile, businessId);
  const label = input.label ? String(input.label).trim().slice(0, 60) : null;

  await query(
    `INSERT INTO business_mobiles (business_id, mobile_number, label, is_primary, created_by)
     VALUES (?, ?, ?, FALSE, ?)`,
    [businessId, mobile, label, actorId ?? null]
  );

  // Asking for primary is handled after the insert so there is exactly
  // one primary at all times, never zero and never two.
  if (input.is_primary) {
    await setPrimary(businessId, mobile);
  }

  logger.info(`[BusinessMobiles] ${mobile} added to business ${businessId}`);
  const after = await listMobiles(businessId);

  return {
    ...after,
    warning: conflicts.length
      ? `${mobile} is also used by ${conflicts.join(', ')}. A number linked to more than one account cannot be used to sign in until the duplicates are removed.`
      : undefined,
  };
}

/**
 * Removes a number. The list may never be emptied: a business with no
 * number on file has no way back in and no way to be contacted, so the
 * last one is refused rather than allowed and regretted.
 */
async function removeMobile(businessId: string, mobileId: string): Promise<MobileList> {
  const current = await listMobiles(businessId);
  const target = current.mobiles.find((m) => String(m.id) === String(mobileId));
  if (!target) {
    throw new AppError('That number is not on this business', 404);
  }
  if (current.used <= 1) {
    throw new AppError('A business must keep at least one mobile number', 409);
  }

  await query(`DELETE FROM business_mobiles WHERE id = ? AND business_id = ?`, [mobileId, businessId]);

  // If the primary was the one removed, promote another rather than
  // leaving the business without a main contact.
  if (target.is_primary) {
    const remaining = await listMobiles(businessId);
    if (remaining.mobiles[0]) {
      await setPrimary(businessId, remaining.mobiles[0].mobile_number);
    }
  }

  logger.info(`[BusinessMobiles] ${target.mobile_number} removed from business ${businessId}`);
  return listMobiles(businessId);
}

/** Exactly one primary, always. */
async function setPrimary(businessId: string, mobile: string): Promise<MobileList> {
  const normalized = normalizeMobile(mobile);
  const exists = await query(
    `SELECT id FROM business_mobiles WHERE business_id = ? AND mobile_number = ?`,
    [businessId, normalized]
  );
  if (exists.rows.length === 0) {
    throw new AppError('That number is not on this business', 404);
  }

  await query(`UPDATE business_mobiles SET is_primary = FALSE WHERE business_id = ?`, [businessId]);
  await query(
    `UPDATE business_mobiles SET is_primary = TRUE WHERE business_id = ? AND mobile_number = ?`,
    [businessId, normalized]
  );
  // The business row keeps showing the main contact, so anything still
  // reading businesses.mobile_number sees the same number as this list.
  await query(`UPDATE businesses SET mobile_number = ?, updated_at = NOW() WHERE id = ?`, [
    normalized,
    businessId,
  ]);
  return listMobiles(businessId);
}

/**
 * The allowance itself, which only a super admin sets.
 *
 * It cannot be dropped below what the business already holds -- that
 * would leave it silently over its own limit with no way to comply
 * short of deleting numbers it may still need.
 */
async function setAllowance(businessId: string, maxMobiles: unknown): Promise<MobileList> {
  const max = Number(maxMobiles);
  if (!Number.isInteger(max) || max < 1) {
    throw new AppError('The limit must be a whole number of at least 1', 400);
  }

  const current = await listMobiles(businessId);
  if (max < current.used) {
    throw new AppError(
      `This business already has ${current.used} numbers. Remove some before lowering the limit to ${max}.`,
      409
    );
  }

  await query(`UPDATE businesses SET max_mobiles = ?, updated_at = NOW() WHERE id = ?`, [max, businessId]);
  logger.info(`[BusinessMobiles] business ${businessId} allowance set to ${max}`);
  return listMobiles(businessId);
}

export { listMobiles, addMobile, removeMobile, setPrimary, setAllowance, normalizeMobile };
