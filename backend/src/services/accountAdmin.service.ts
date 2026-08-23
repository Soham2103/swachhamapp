import bcrypt from 'bcrypt';
import { query, getClient } from '../config/database';
import { AppError } from '../utils/appError';
import { logger } from '../utils/logger';
import { validatePassword } from '../utils/password';
import { sendCredentialsEmail } from './email.service';
import { normaliseMobile } from './businessContact.service';
import {
  parseBillingCycle,
  parseOptionalBillingCycle,
} from './billingCycle.service';
import {
  listContacts,
  replaceAlternatives,
  validateContact,
  upsertHeadContact,
  HEAD_CONTACT_JOIN,
  HEAD_CONTACT_COLUMNS,
} from './businessContact.service';
import { config } from '../config/env';
import {
  normaliseGstin,
  verifyGstinForRegistration,
  isGstVerificationConfigured,
} from './gstVerification.service';
import { panFromGstin } from './creationRequest.service';
import {
  parseRegistrationType,
  gstForRegistrationType,
  RegistrationType,
} from './registrationType.service';

/**
 * Super Admin account management: businesses, managers, riders, sorters.
 *
 * ONE SERVICE FOR THE STAFF ROLES. A manager, a rider and a sorter are all
 * `users` rows differing only by `role`, so create/edit/enable/delete is one
 * implementation parameterised by role rather than three copies. A business
 * is genuinely different — it has its own table, its own contacts and its own
 * login account — so it gets its own functions here.
 *
 * EVERYTHING HERE IS SUPER ADMIN ONLY. The router that mounts it applies
 * `authorize('SUPER_ADMIN')`; nothing in this file is reachable by a Manager,
 * a Business user or anyone else.
 *
 * PASSWORDS ARE ALWAYS TYPED BY THE SUPER ADMIN. Nothing generates one.
 * Every password path runs through `validatePassword`, is hashed with the
 * existing bcrypt settings, and is emailed once — never stored in plaintext,
 * never logged, never returned.
 *
 * DELETE IS DISABLE WHERE HISTORY DEPENDS ON THE ROW. An account that has
 * placed orders or raised requests is deactivated rather than removed,
 * because those records point at it and an invoice must stay readable. The
 * service says which happened, so the UI does not have to guess.
 */

const SALT_ROUNDS = 10;

export type StaffRole = 'MANAGER' | 'RIDER' | 'SORTER';
export const STAFF_ROLES: StaffRole[] = ['MANAGER', 'RIDER', 'SORTER'];

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function requireText(value: unknown, label: string, max = 255): string {
  const out = text(value);
  if (!out) throw new AppError(`${label} is required.`, 400);
  if (out.length > max) throw new AppError(`${label} is too long.`, 400);
  return out;
}

function normaliseEmail(value: unknown, label = 'Email'): string {
  const email = text(value).toLowerCase();
  if (!EMAIL_PATTERN.test(email)) {
    throw new AppError(`${label} must be a valid email address.`, 400);
  }
  return email;
}

function parseFlag(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const t = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'active', 'enabled'].includes(t)) return true;
  if (['false', '0', 'no', 'inactive', 'disabled'].includes(t)) return false;
  throw new AppError('Status must be enabled or disabled.', 400);
}

function assertRole(value: unknown): StaffRole {
  const role = String(value ?? '').trim().toUpperCase();
  if (!STAFF_ROLES.includes(role as StaffRole)) {
    throw new AppError(`Role must be one of: ${STAFF_ROLES.join(', ')}.`, 400);
  }
  return role as StaffRole;
}

/* ===================================================================
 * STAFF ACCOUNTS  (manager / rider / sorter)
 * =================================================================== */

export interface StaffRow {
  id: string;
  role: StaffRole;
  name: string | null;
  email: string | null;
  mobile_number: string;
  is_active: boolean;
  approval_status: string | null;
  last_login_at: string | null;
  created_at: string;
  /** Requests raised (managers) — the reason a delete may be refused. */
  request_count: number;
  /** Orders touched (riders/sorters) — same. */
  order_count: number;
}

function toStaff(row: any): StaffRow {
  return {
    ...row,
    id: String(row.id),
    is_active: Boolean(row.is_active),
    request_count: Number(row.request_count || 0),
    order_count: Number(row.order_count || 0),
  };
}

/** Every account of one role, with what depends on it. */
export async function listStaff(roleInput: unknown): Promise<StaffRow[]> {
  const role = assertRole(roleInput);
  const result = await query<any>(
    `SELECT u.id, u.role, u.name, u.email, u.mobile_number, u.is_active,
            u.approval_status, u.last_login_at, u.created_at,
            (SELECT COUNT(*) FROM creation_requests r WHERE r.requested_by = u.id) AS request_count,
            (SELECT COUNT(*) FROM garment_scans g WHERE g.scanned_by = u.id) AS order_count
       FROM users u
      WHERE u.role = ?
      ORDER BY u.created_at DESC`,
    [role]
  );
  return result.rows.map(toStaff);
}

export async function getStaff(id: string): Promise<StaffRow> {
  const result = await query<any>(
    `SELECT u.id, u.role, u.name, u.email, u.mobile_number, u.is_active,
            u.approval_status, u.last_login_at, u.created_at,
            (SELECT COUNT(*) FROM creation_requests r WHERE r.requested_by = u.id) AS request_count,
            (SELECT COUNT(*) FROM garment_scans g WHERE g.scanned_by = u.id) AS order_count
       FROM users u WHERE u.id = ? AND u.role IN ('MANAGER','RIDER','SORTER')`,
    [id]
  );
  if (!result.rows[0]) throw new AppError('Account not found.', 404);
  return toStaff(result.rows[0]);
}

export interface StaffInput {
  name?: unknown;
  email?: unknown;
  mobile_number?: unknown;
  password?: unknown;
  confirm_password?: unknown;
  is_active?: unknown;
}

/**
 * Creates a staff account with the password the Super Admin typed, and emails
 * the credentials.
 *
 * The role is a parameter, not something the request chooses freely — the
 * route fixes it — so a "create rider" call cannot mint a manager.
 */
export async function createStaff(
  creatorId: string,
  roleInput: unknown,
  input: StaffInput
): Promise<{ id: string; name: string; username: string; email: { sent: boolean; error?: string } }> {
  const role = assertRole(roleInput);
  const name = requireText(input.name, 'Name');
  const email = normaliseEmail(input.email);
  const mobile = normaliseMobile(input.mobile_number, 'Mobile number');

  const dupe = await query(`SELECT id FROM users WHERE email = ? OR mobile_number = ?`, [
    email,
    mobile,
  ]);
  if (dupe.rows[0]) {
    throw new AppError('That email or mobile number is already registered.', 409);
  }

  // Validated before the row is written, so a rejected password leaves
  // nothing half-made behind.
  const password = validatePassword(input.password, input.confirm_password);
  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

  const inserted = await query(
    `INSERT INTO users
       (name, email, mobile_number, password_hash, role, is_active, mobile_verified,
        approval_status, reviewed_at, reviewed_by)
     VALUES (?, ?, ?, ?, ?, ?, 1, 'APPROVED', NOW(), ?)`,
    [name, email, mobile, passwordHash, role, parseFlag(input.is_active, true), creatorId]
  );
  const id = String(inserted.insertId);

  // The id and the role, never the password.
  logger.info(`[AccountAdmin] ${role} ${id} created by super admin ${creatorId}`);

  const mail = await sendCredentialsEmail({
    kind: role,
    to: email,
    accountName: name,
    username: email,
    password,
  });

  return { id, name, username: email, email: { sent: mail.sent, error: mail.error } };
}

/**
 * Edits a staff account.
 *
 * THE ROLE CANNOT BE CHANGED. Turning a rider into a manager would grant
 * permissions through an edit form, so it is refused outright: delete and
 * recreate instead. The password is not editable here either — that is
 * `setStaffPassword`, which also sends the email.
 */
export async function updateStaff(id: string, input: StaffInput & { role?: unknown }): Promise<StaffRow> {
  const current = await getStaff(id);

  if (input.role !== undefined && assertRole(input.role) !== current.role) {
    throw new AppError(
      'An account role cannot be changed. Delete the account and create it under the new role.',
      400
    );
  }

  const fields: string[] = [];
  const values: unknown[] = [];

  if (input.name !== undefined) {
    fields.push('name = ?');
    values.push(requireText(input.name, 'Name'));
  }
  if (input.email !== undefined) {
    const email = normaliseEmail(input.email);
    const clash = await query(`SELECT id FROM users WHERE email = ? AND id <> ?`, [email, id]);
    if (clash.rows[0]) throw new AppError('That email is already registered.', 409);
    fields.push('email = ?');
    values.push(email);
  }
  if (input.mobile_number !== undefined) {
    const mobile = normaliseMobile(input.mobile_number, 'Mobile number');
    const clash = await query(`SELECT id FROM users WHERE mobile_number = ? AND id <> ?`, [mobile, id]);
    if (clash.rows[0]) throw new AppError('That mobile number is already registered.', 409);
    fields.push('mobile_number = ?');
    values.push(mobile);
  }
  if (input.is_active !== undefined) {
    fields.push('is_active = ?');
    values.push(parseFlag(input.is_active, current.is_active));
  }

  if (fields.length === 0) return current;

  await query(`UPDATE users SET ${fields.join(', ')}, updated_at = NOW() WHERE id = ?`, [
    ...values,
    id,
  ]);
  logger.info(`[AccountAdmin] ${current.role} ${id} updated`);
  return getStaff(id);
}

/**
 * Enables or disables a staff account.
 *
 * A disabled account cannot sign in: `unifiedAuth` already refuses an
 * inactive user, so this one flag is the whole enforcement — and because the
 * token is checked against the row on every request, an existing session
 * stops working too.
 */
export async function setStaffActive(id: string, active: unknown): Promise<StaffRow> {
  const current = await getStaff(id);
  const value = parseFlag(active, !current.is_active);
  await query(`UPDATE users SET is_active = ?, updated_at = NOW() WHERE id = ?`, [value, id]);
  logger.info(`[AccountAdmin] ${current.role} ${id} ${value ? 'enabled' : 'disabled'}`);
  return getStaff(id);
}

/** Sets a new password and emails it. Never reveals the old one. */
export async function setStaffPassword(
  id: string,
  input: { password?: unknown; confirm_password?: unknown }
): Promise<{ username: string; email: { sent: boolean; error?: string } }> {
  const staff = await getStaff(id);
  if (!staff.email) throw new AppError('That account has no email address on file.', 400);

  const password = validatePassword(input.password, input.confirm_password, 'New password');
  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  await query(`UPDATE users SET password_hash = ?, updated_at = NOW() WHERE id = ?`, [
    passwordHash,
    id,
  ]);

  const mail = await sendCredentialsEmail({
    kind: staff.role,
    to: staff.email,
    accountName: staff.name || staff.role,
    username: staff.email,
    password,
  });

  logger.info(`[AccountAdmin] password set for ${staff.role} ${id}`);
  return { username: staff.email, email: { sent: mail.sent, error: mail.error } };
}

/**
 * Deletes a staff account, or disables it when history points at it.
 *
 * `creation_requests.requested_by` is ON DELETE RESTRICT precisely so the
 * record of who proposed what survives the person leaving. Rather than
 * failing with a foreign-key error, this detects the case and deactivates
 * instead, reporting which it did.
 */
export async function deleteStaff(id: string): Promise<{ id: string; deleted: boolean; reason?: string }> {
  const staff = await getStaff(id);

  if (staff.request_count > 0) {
    await query(`UPDATE users SET is_active = 0, updated_at = NOW() WHERE id = ?`, [id]);
    logger.info(`[AccountAdmin] ${staff.role} ${id} disabled instead of deleted (has requests)`);
    return {
      id,
      deleted: false,
      reason:
        'This account raised requests that must stay on record, so it has been disabled instead of deleted.',
    };
  }

  await query(`DELETE FROM users WHERE id = ?`, [id]);
  logger.info(`[AccountAdmin] ${staff.role} ${id} deleted`);
  return { id, deleted: true };
}

/* ===================================================================
 * BUSINESSES
 * =================================================================== */

export interface BusinessAdminRow {
  id: string;
  name: string;
  legal_name: string | null;
  establishment_name: string | null;
  address: string | null;
  establishment_address: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
  gst_number: string | null;
  pan_number: string | null;
  billing_cycle: string | null;
  status: string;
  /** The establishment CATEGORY (hotel, restaurant…). */
  business_type: string | null;
  /** B2B or B2C — the registration type. */
  registration_type: string;
  contact_person_name: string | null;
  designation: string | null;
  mobile_number: string | null;
  whatsapp_number: string | null;
  email_id: string | null;
  created_at: string;
  order_count: number;
  account_email: string | null;
}

/** Every business, with what depends on it. */
export async function listBusinesses(filters: { search?: unknown; status?: unknown } = {}) {
  const conditions: string[] = [];
  const values: unknown[] = [];

  const search = text(filters.search);
  if (search) {
    conditions.push('(b.name LIKE ? OR b.gst_number LIKE ? OR b.establishment_name LIKE ?)');
    values.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  const status = text(filters.status).toUpperCase();
  if (['PENDING', 'ACTIVE', 'INACTIVE', 'REJECTED'].includes(status)) {
    conditions.push('b.status = ?');
    values.push(status);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const result = await query<any>(
    `SELECT b.id, b.name, b.legal_name, b.establishment_name, b.address, b.establishment_address,
            b.city, b.state, b.pincode, b.gst_number, b.pan_number, b.billing_cycle, b.status,
            b.business_type, b.registration_type,
            ${HEAD_CONTACT_COLUMNS},
            b.created_at,
            (SELECT COUNT(*) FROM orders o
               JOIN business_users bu ON bu.id = o.business_user_id
              WHERE bu.business_id = b.id) AS order_count,
            (SELECT bu.email FROM business_users bu
              WHERE bu.business_id = b.id AND bu.password_hash IS NOT NULL AND bu.email IS NOT NULL
              ORDER BY FIELD(bu.contact_type,'PRIMARY','ALTERNATIVE'), bu.id LIMIT 1) AS account_email
       FROM businesses b
       ${HEAD_CONTACT_JOIN}
       ${where}
      ORDER BY b.created_at DESC`,
    values
  );
  return result.rows.map((row) => ({
    ...row,
    id: String(row.id),
    order_count: Number(row.order_count || 0),
  })) as BusinessAdminRow[];
}

/** One business, with its contacts. */
export async function getBusiness(id: string) {
  const rows = await listBusinesses();
  const business = rows.find((b) => b.id === String(id));
  if (!business) throw new AppError('Business not found.', 404);
  return { ...business, contacts: await listContacts(String(id)) };
}

/**
 * Edits a business master record: the full registration form, every field.
 *
 * THE GSTIN IS THE BUSINESS'S IDENTITY, and it may be changed -- but only
 * through verification. A new number is normalised, checked for a clash with
 * another business, and then VERIFIED AGAINST THE PROVIDER by the server. The
 * PAN is re-derived from characters 3-12 of the verified GSTIN.
 *
 * NOTHING ABOUT THE GST IS TAKEN FROM THE REQUEST. A `pan_number`,
 * `gst_verified` or `gst_status` in the body is ignored entirely: a client
 * cannot mark its own submission verified, and a PAN and the GSTIN it sits
 * inside can never be allowed to disagree.
 */
export async function updateBusiness(id: string, input: any) {
  const current = await getBusiness(id);

  const fields: string[] = [];
  const values: unknown[] = [];

  const set = (column: string, value: unknown) => {
    fields.push(`${column} = ?`);
    values.push(value);
  };

  /* ---- Registration type, which decides whether a GSTIN is wanted ---- */
  //
  // Absent means unchanged: an edit that only touches the address must not
  // have to restate what kind of registration this is.
  const registrationType: RegistrationType = parseRegistrationType(
    input.registration_type,
    (current.registration_type as RegistrationType) || 'B2B'
  );
  if (registrationType !== current.registration_type) {
    set('registration_type', registrationType);
  }

  /* ---- GSTIN, and the PAN it determines ---- */
  // Set when the provider told us which state the registration is in. That
  // value wins over a typed one below, because it decides CGST/SGST versus
  // IGST on every invoice this business is ever sent.
  let stateFromGst = false;

  // For a B2C record this is null whatever the request said, and for a B2B
  // one it is required -- with the business's EXISTING number standing in
  // when the form did not resend it, so an unrelated edit cannot fail for
  // want of a GSTIN that is already on file.
  const submittedGstin = gstForRegistrationType(
    registrationType,
    text(input.gstin ?? input.gst_number) || current.gst_number || ''
  );

  // Turning a B2B record into a B2C one clears the tax registration rather
  // than leaving a GSTIN attached to an account that is no longer registered
  // under it. The PAN stays: it identifies the entity, not the registration.
  if (registrationType === 'B2C' && current.gst_number) {
    set('gst_number', null);
    set('gst_verified', 0);
    set('gst_status', null);
    logger.info(`[AccountAdmin] business ${id} switched to B2C; GSTIN cleared`);
  }

  if (submittedGstin) {
    // Format and check digit first, so an obviously wrong number never
    // reaches the provider.
    const gstin = normaliseGstin(submittedGstin);

    if (gstin !== (current.gst_number || '')) {
      const clash = await query(`SELECT id FROM businesses WHERE gst_number = ? AND id <> ?`, [
        gstin,
        id,
      ]);
      if (clash.rows[0]) {
        throw new AppError('Another business is already registered with this GST number.', 409);
      }

      let verified: Awaited<ReturnType<typeof verifyGstinForRegistration>> | null = null;
      if (config.GST_VERIFICATION_REQUIRED) {
        if (!isGstVerificationConfigured()) {
          throw new AppError(
            'GST verification is not configured on the server. Please contact the administrator.',
            503
          );
        }
        // Throws 404 for an unknown GSTIN and 422 for one that is not Active.
        verified = await verifyGstinForRegistration(gstin);
      }

      set('gst_number', gstin);
      // Written from the server's own lookup, never from the request.
      set('gst_verified', verified ? 1 : 0);
      set('gst_status', verified?.status || null);
      // DERIVED, not submitted: characters 3-12 of the GSTIN.
      set('pan_number', panFromGstin(gstin));
      if (verified?.address.state) {
        set('state', verified.address.state);
        stateFromGst = true;
      }

      logger.info(`[AccountAdmin] business ${id} GSTIN changed and re-verified`);
    }
  }

  if (input.name !== undefined) set('name', requireText(input.name, 'Business name'));
  if (input.legal_name !== undefined) set('legal_name', text(input.legal_name) || null);
  if (input.establishment_name !== undefined) {
    set('establishment_name', text(input.establishment_name) || null);
  }
  if (input.address !== undefined) set('address', requireText(input.address, 'Legal address', 1000));
  if (input.establishment_address !== undefined) {
    set('establishment_address', text(input.establishment_address) || null);
  }
  if (input.city !== undefined) set('city', text(input.city) || null);
  // Skipped when the GST lookup above already supplied it: the registration's
  // own state is the authoritative one.
  if (input.state !== undefined && !stateFromGst) set('state', text(input.state) || null);
  if (input.pincode !== undefined) set('pincode', text(input.pincode) || null);
  if (input.billing_cycle !== undefined) {
    set('billing_cycle', parseBillingCycle(input.billing_cycle));
  }
  if (input.status !== undefined) {
    const status = text(input.status).toUpperCase();
    if (!['PENDING', 'ACTIVE', 'INACTIVE', 'REJECTED'].includes(status)) {
      throw new AppError('Status must be PENDING, ACTIVE, INACTIVE or REJECTED.', 400);
    }
    set('status', status);
  }

  // The business head. It is a `business_users` row and nothing else since
  // migration 031, so there is no second copy on the business row to keep in
  // step -- and therefore no way for the two to disagree about who to ring.
  let head: ReturnType<typeof validateContact> | null = null;
  if (input.business_head !== undefined) {
    head = validateContact(input.business_head, 'BUSINESS_HEAD');
  }

  if (fields.length > 0) {
    await query(`UPDATE businesses SET ${fields.join(', ')}, updated_at = NOW() WHERE id = ?`, [
      ...values,
      id,
    ]);
  }

  if (head) {
    await upsertHeadContact(String(id), head);
  }

  if (input.alternative_contacts !== undefined) {
    await replaceAlternatives(String(id), input.alternative_contacts);
  }

  logger.info(`[AccountAdmin] business ${id} updated`);
  return getBusiness(id);
}

/** ACTIVE / INACTIVE. A disabled business's users cannot place orders. */
export async function setBusinessActive(id: string, active: unknown) {
  const business = await getBusiness(id);
  const value = parseFlag(active, business.status !== 'ACTIVE');
  await query(`UPDATE businesses SET status = ?, updated_at = NOW() WHERE id = ?`, [
    value ? 'ACTIVE' : 'INACTIVE',
    id,
  ]);
  // Its login accounts follow the business: a disabled business should not
  // leave a working login behind. Contact-only rows are left alone -- they
  // carry no password, so `is_active` on them decides nothing, and clearing
  // it would only make the contact list look half-deleted.
  await query(
    `UPDATE business_users SET is_active = ?, updated_at = NOW()
      WHERE business_id = ? AND password_hash IS NOT NULL`,
    [value, id]
  );
  logger.info(`[AccountAdmin] business ${id} ${value ? 'enabled' : 'disabled'}`);
  return getBusiness(id);
}

/* ===================================================================
 * BUSINESS PASSWORD
 * =================================================================== */

/**
 * Sets a new password on a business's login account, and emails it.
 *
 * IT IS THE EXISTING AUTHENTICATION, not a second one. The password goes
 * through the same `validatePassword` policy every other account uses, is
 * hashed with the same bcrypt cost, and is written to the same
 * `business_users.password_hash` column that `unifiedAuth` compares against —
 * so the business signs in afterwards through exactly the path it did before,
 * with the new password.
 *
 * NOTHING IS REVEALED. The current password cannot be shown because only its
 * hash was ever stored; the new one is used twice — hashed for the column,
 * rendered into the email — and is gone when this function returns. The
 * response carries the username and whether the mail went out, and never a
 * password, a hash or an OTP.
 *
 * WHICH ROW. A business's login account is the row that HAS a password,
 * preferring the PRIMARY contact. A business whose head was recorded without
 * credentials has none yet, so the first password set here is what turns that
 * contact into an account — which is why `password_hash IS NOT NULL` is not
 * part of the lookup and the email is.
 */
export async function setBusinessPassword(
  id: string,
  input: { password?: unknown; confirm_password?: unknown }
): Promise<{ business_id: string; username: string; email: { sent: boolean; error?: string } }> {
  const business = await getBusiness(id);

  const account = await query<{ id: string; email: string | null; name: string | null }>(
    `SELECT id, email, name FROM business_users
      WHERE business_id = ? AND email IS NOT NULL AND TRIM(email) <> ''
      ORDER BY (password_hash IS NULL), FIELD(contact_type,'PRIMARY','ALTERNATIVE'), id
      LIMIT 1`,
    [id]
  );
  const row = account.rows[0];
  if (!row) {
    throw new AppError(
      'This business has no login account with an email address, so there is no password to set. Add a business head email first.',
      400
    );
  }

  // Validated BEFORE anything is written, so a rejected password leaves the
  // existing one working rather than half-replaced.
  const password = validatePassword(input.password, input.confirm_password, 'New password');
  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

  await query(
    `UPDATE business_users SET password_hash = ?, updated_at = NOW() WHERE id = ?`,
    [passwordHash, row.id]
  );

  // The business id and the account id. Never the password.
  logger.info(`[AccountAdmin] password set for business ${id} account ${row.id}`);

  const mail = await sendCredentialsEmail({
    kind: 'BUSINESS',
    to: row.email!,
    accountName: business.name,
    username: row.email!,
    password,
  });

  return {
    business_id: String(id),
    username: row.email!,
    email: { sent: mail.sent, error: mail.error },
  };
}

/**
 * Deletes a business, or disables it when orders point at it.
 *
 * `orders.business_user_id` is ON DELETE RESTRICT, so a business with any
 * order history cannot be removed without destroying invoices. That case is
 * detected and turned into a deactivation, which is what the operator
 * actually wants.
 */
export async function deleteBusiness(id: string): Promise<{ id: string; deleted: boolean; reason?: string }> {
  const business = await getBusiness(id);

  if (business.order_count > 0) {
    await setBusinessActive(id, false);
    return {
      id: String(id),
      deleted: false,
      reason:
        `This business has ${business.order_count} order(s) on record, which its invoices depend on. ` +
        'It has been disabled instead of deleted.',
    };
  }

  const connection = await getClient();
  try {
    await connection.beginTransaction();
    // business_users (accounts and contacts alike), business_price_list and
    // carts all cascade from businesses; the request that created it keeps
    // its row and simply loses the pointer.
    await connection.execute(`UPDATE creation_requests SET created_entity_id = NULL WHERE created_entity_id = ? AND request_type = 'BUSINESS'`, [id]);
    await connection.execute(`DELETE FROM businesses WHERE id = ?`, [id]);
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }

  logger.info(`[AccountAdmin] business ${id} deleted`);
  return { id: String(id), deleted: true };
}
