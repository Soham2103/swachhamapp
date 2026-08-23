import bcrypt from 'bcrypt';
import { query, getClient } from '../config/database';
import { AppError } from '../utils/appError';
import { logger } from '../utils/logger';
import { config } from '../config/env';
import { validatePassword } from '../utils/password';
import { sendCredentialsEmail } from './email.service';
import { normaliseGstin, verifyGstinForRegistration } from './gstVerification.service';
import {
  parseRegistrationType,
  gstForRegistrationType,
  RegistrationType,
} from './registrationType.service';
import { parseBillingCycle, BillingCycle as Cycle } from './billingCycle.service';

/**
 * Creation requests: the Manager proposes, the Super Admin disposes.
 *
 * A Manager can submit a business, a rider or a sorter. NONE of them exist as
 * an account until a Super Admin approves — that is the whole point of the
 * table. Submitting stores a payload; approving is what runs the creation,
 * generates the credentials and sends the email.
 *
 * ONE IMPLEMENTATION FOR THREE KINDS. Submit, list, approve and reject are
 * identical across the three; only `buildEntity` differs. Three parallel
 * services would be three copies of the authorisation and the state machine.
 *
 * SECURITY, in one place:
 *   - Only a SUPER_ADMIN reaches approve/reject. Enforced by the router's
 *     `authorize`, and again here: `approve` takes the reviewer's id and the
 *     route that supplies it is Super Admin only.
 *   - A Manager reads only its OWN requests; every manager-facing query is
 *     filtered by `requested_by`.
 *   - The GSTIN is re-verified AT APPROVAL against the provider. A payload
 *     edited to say `gst_verified: true` changes nothing, because that field
 *     is never read.
 *   - PAN is DERIVED from the GSTIN on the server. A pan_number in the
 *     payload is ignored.
 *   - THE PASSWORD IS TYPED BY THE SUPER ADMIN AT APPROVAL. It is not in
 *     the request, not in the payload, and not generated anywhere: a
 *     Manager never handles one, and an approval that omits it is a 400.
 *     It is hashed immediately, used once for the email, and dropped —
 *     never stored in plaintext, never logged, never returned.
 */

const SALT_ROUNDS = 10;

export type RequestType = 'BUSINESS' | 'RIDER' | 'SORTER';
export type RequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

export const REQUEST_TYPES: RequestType[] = ['BUSINESS', 'RIDER', 'SORTER'];

// Re-exported from the billing service so there is ONE list of cycles in the
// codebase; adding FORTNIGHTLY there added it here with no second edit.
export { BILLING_CYCLES } from './billingCycle.service';
export type { BillingCycle } from './billingCycle.service';

/**
 * Alternative contacts: none to three. Optional, because the PRIMARY contact
 * is the account and is the only one registration requires.
 */
const MAX_ALTERNATIVE_CONTACTS = 3;

/* ===================================================================
 * VALIDATION HELPERS
 * =================================================================== */

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
/** Indian mobile: ten digits starting 6-9, with the usual prefixes tolerated. */
const MOBILE_PATTERN = /^[6-9]\d{9}$/;

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function requireText(value: unknown, label: string, max = 255): string {
  const out = text(value);
  if (!out) throw new AppError(`${label} is required.`, 400);
  if (out.length > max) throw new AppError(`${label} is too long.`, 400);
  return out;
}

/** Strips +91 / 0 / spaces / dashes, then checks the ten digits. */
export function normaliseMobile(value: unknown, label = 'Mobile number'): string {
  const digits = text(value).replace(/[\s\-()]/g, '').replace(/^\+?91/, '').replace(/^0/, '');
  if (!MOBILE_PATTERN.test(digits)) {
    throw new AppError(`${label} must be a valid 10-digit Indian mobile number.`, 400);
  }
  return digits;
}

function optionalMobile(value: unknown, label: string): string | null {
  return text(value) ? normaliseMobile(value, label) : null;
}

export function normaliseEmail(value: unknown, label = 'Email'): string {
  const email = text(value).toLowerCase();
  if (!EMAIL_PATTERN.test(email)) {
    throw new AppError(`${label} must be a valid email address.`, 400);
  }
  return email;
}

/**
 * The PAN inside a GSTIN.
 *
 * A GSTIN is 2 state digits + 10-character PAN + 3 suffix characters, so the
 * PAN is characters 3..12 — `substring(2, 12)` zero-based. Derived on the
 * server from an already-validated GSTIN; a PAN sent by a client is ignored
 * entirely, so it can never disagree with the registration.
 */
export function panFromGstin(gstin: string): string {
  return normaliseGstin(gstin).substring(2, 12);
}

/* ===================================================================
 * PAYLOAD SHAPES
 * =================================================================== */

/**
 * One contact on a business.
 *
 * `mobile` and `email` are required for every contact — the head's email is
 * the account username and the alternatives are the people to ring when the
 * head cannot be reached, so a contact without either is not a contact.
 * `whatsapp` is genuinely optional and is NOT defaulted to `mobile`: they are
 * frequently different numbers.
 */
export interface ContactInput {
  name: string;
  designation: string | null;
  mobile: string;
  /** Head only; null for an alternative. */
  whatsapp: string | null;
  /** Head only — it becomes the login username. Null for an alternative. */
  email: string | null;
}

export interface BusinessRequestPayload {
  /** B2B or B2C. Decides whether a GSTIN is required at all. */
  registration_type: RegistrationType;
  /** Null for a B2C registration, which does not carry one. */
  gstin: string | null;
  /** Server-derived from the GSTIN, so null when there is none. */
  pan_number: string | null;
  /** Maps to businesses.name — the canonical business name. */
  legal_name: string;
  /** Maps to businesses.address. */
  legal_address: string;
  /** The trading name, when it differs from the legal one. */
  establishment_name: string | null;
  /** Where it actually operates, when that differs from the legal address. */
  establishment_address: string | null;
  billing_cycle: Cycle;
  city: string | null;
  state: string | null;
  pincode: string | null;
  business_head: ContactInput;
  alternative_contacts: ContactInput[];
}

export interface StaffRequestPayload {
  name: string;
  email: string;
  mobile_number: string;
}

/**
 * Validates the Business form.
 *
 * The GSTIN is format- and checksum-checked here so a typo is caught at
 * submission; the PROVIDER call happens at approval, where it decides whether
 * the business is created.
 */
function validateBusinessPayload(input: any): BusinessRequestPayload {
  /*
   * REGISTRATION TYPE FIRST, because it decides what else is required.
   *
   * B2B  a GSTIN must be present, and it is format- and checksum-checked
   *      here so a typo is caught at submission. The PROVIDER call happens
   *      at approval, where it decides whether the business is created.
   *
   * B2C  no GSTIN is collected. `gstForRegistrationType` returns null for a
   *      B2C submission whatever the body contained, so a client that fills
   *      the disabled field anyway cannot store a GST number against an
   *      account that is not registered for one.
   *
   * Anything that is neither B2B nor B2C is rejected outright: the check
   * lives in the service, so it applies to an API call exactly as it does to
   * the form.
   */
  const registrationType = parseRegistrationType(input?.registration_type);
  const submittedGstin = gstForRegistrationType(
    registrationType,
    input?.gstin ?? input?.gst_number
  );
  const gstin = submittedGstin ? normaliseGstin(submittedGstin) : null;

  const head = input?.business_head ?? {};
  const businessHead: ContactInput = {
    name: requireText(head.name, 'Business head name'),
    designation: text(head.designation) || null,
    mobile: normaliseMobile(head.mobile, 'Business head mobile number'),
    // Not assumed to equal the mobile: they are frequently different numbers.
    whatsapp: optionalMobile(head.whatsapp, 'WhatsApp number'),
    email: normaliseEmail(head.email, 'Business head email'),
  };

  /*
   * Optional, and blank slots are dropped rather than rejected: a form that
   * renders three empty rows and posts them all should register a business
   * with no alternative contacts, not fail three times.
   */
  const rawAlternatives = (Array.isArray(input?.alternative_contacts)
    ? input.alternative_contacts
    : []
  ).filter((c: any) => c && typeof c === 'object' &&
    (text(c.mobile) !== '' || text(c.name) !== ''));

  if (rawAlternatives.length > MAX_ALTERNATIVE_CONTACTS) {
    throw new AppError(
      `You can add at most ${MAX_ALTERNATIVE_CONTACTS} alternative contacts.`,
      400
    );
  }

  /*
   * An alternative contact is a MOBILE NUMBER and a DESIGNATION, with a name
   * when one is given. Nothing else.
   *
   * NO EMAIL AND NO PASSWORD, ever. An alternative contact does not get an
   * account: they sign in by proving this number and then entering the PRIMARY
   * contact's email and password. Email and WhatsApp are written as null
   * rather than merely left out, so a client that sends them cannot get them
   * stored and cannot manufacture a second set of credentials.
   */
  const alternatives: ContactInput[] = rawAlternatives.map((c: any, i: number) => ({
    // Optional. The number is what matters -- it is what identifies the
    // business at sign-in -- so a contact given without a name is recorded
    // under a placeholder rather than refused.
    name: text(c?.name) || `Alternative contact ${i + 1}`,
    designation: text(c?.designation) || null,
    mobile: normaliseMobile(c?.mobile, `Alternative contact ${i + 1} mobile number`),
    whatsapp: null,
    email: null,
  }));

  return {
    registration_type: registrationType,
    gstin,
    pan_number: gstin ? panFromGstin(gstin) : null,
    legal_name: requireText(input?.legal_name ?? input?.name, 'Legal name'),
    legal_address: requireText(input?.legal_address ?? input?.address, 'Legal address', 1000),
    // Optional. When the form's "same as legal" box is ticked the client
    // sends the legal value; when it is blank the business simply trades
    // under its legal name and address, and these stay null.
    establishment_name: text(input?.establishment_name) || null,
    establishment_address: text(input?.establishment_address) || null,
    billing_cycle: parseBillingCycle(input?.billing_cycle),
    city: text(input?.city) || null,
    state: text(input?.state) || null,
    pincode: text(input?.pincode) || null,
    business_head: businessHead,
    alternative_contacts: alternatives,
  };
}

/** Riders and sorters are both `users` rows, so they share a shape. */
function validateStaffPayload(input: any, label: string): StaffRequestPayload {
  return {
    name: requireText(input?.name, `${label} name`),
    // The email is the username, so it is required for both.
    email: normaliseEmail(input?.email, `${label} email`),
    mobile_number: normaliseMobile(input?.mobile_number ?? input?.mobile, `${label} mobile number`),
  };
}

/* ===================================================================
 * SUBMIT  (manager)
 * =================================================================== */

export interface CreationRequestRow {
  id: string;
  request_type: RequestType;
  status: RequestStatus;
  requested_by: string;
  requested_by_name: string | null;
  subject_name: string;
  subject_email: string | null;
  payload: any;
  rejection_reason: string | null;
  reviewed_by: string | null;
  approved_at: string | null;
  created_entity_id: string | null;
  email_status: 'NOT_SENT' | 'SENT' | 'FAILED';
  email_error: string | null;
  created_at: string;
  updated_at: string;
}

/** mysql2 returns a JSON column already parsed; a string is tolerated anyway. */
function toRow(row: any): CreationRequestRow {
  return {
    ...row,
    id: String(row.id),
    requested_by: String(row.requested_by),
    reviewed_by: row.reviewed_by === null ? null : String(row.reviewed_by),
    created_entity_id: row.created_entity_id === null ? null : String(row.created_entity_id),
    payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
  };
}

/**
 * Submits a request. Always lands in PENDING — a Manager has no way to
 * create anything approved, because no code path here writes another status.
 */
export async function submitRequest(
  managerId: string,
  requestType: unknown,
  input: any
): Promise<CreationRequestRow> {
  const type = String(requestType ?? '').trim().toUpperCase() as RequestType;
  if (!REQUEST_TYPES.includes(type)) {
    throw new AppError(`Request type must be one of: ${REQUEST_TYPES.join(', ')}.`, 400);
  }

  let payload: BusinessRequestPayload | StaffRequestPayload;
  let subjectName: string;
  let subjectEmail: string | null;

  if (type === 'BUSINESS') {
    const business = validateBusinessPayload(input);
    payload = business;
    subjectName = business.legal_name;
    subjectEmail = business.business_head.email;
    await assertBusinessNotTaken(business);
  } else {
    const staff = validateStaffPayload(input, type === 'RIDER' ? 'Rider' : 'Sorter');
    payload = staff;
    subjectName = staff.name;
    subjectEmail = staff.email;
    await assertStaffNotTaken(staff);
  }

  const inserted = await query(
    `INSERT INTO creation_requests
       (request_type, status, requested_by, payload, subject_name, subject_email)
     VALUES (?, 'PENDING', ?, CAST(? AS JSON), ?, ?)`,
    [type, managerId, JSON.stringify(payload), subjectName, subjectEmail]
  );

  logger.info(`[CreationRequest] ${type} request ${inserted.insertId} submitted by manager ${managerId}`);
  return getRequestById(inserted.insertId!);
}

/**
 * Duplicate checks at SUBMIT time, so a Manager finds out immediately rather
 * than a Super Admin discovering it at approval. Re-run at approval too,
 * because the world can change in between.
 */
async function assertBusinessNotTaken(
  payload: BusinessRequestPayload,
  excludeRequestId?: string
): Promise<void> {
  // Only a B2B submission has a GSTIN to collide with; a B2C one is not
  // "duplicate" for having no number, and NULL = NULL would never match
  // anyway.
  if (payload.gstin) {
    const gst = await query(`SELECT id FROM businesses WHERE gst_number = ?`, [payload.gstin]);
    if (gst.rows[0]) {
      throw new AppError('A business with that GST number already exists.', 409);
    }
  }
  const email = await query(`SELECT id FROM business_users WHERE email = ?`, [
    payload.business_head.email,
  ]);
  if (email.rows[0]) {
    throw new AppError('That business head email is already registered.', 409);
  }

  /*
   * EVERY CONTACT NUMBER MUST BE FREE.
   *
   * A number identifies a business at sign-in, so one recorded against two
   * businesses would make a proven OTP ambiguous about which dashboard the
   * person belongs in. Checked across all of `business_users` -- primary and
   * alternative alike -- because any of them can be the number that is typed.
   */
  const numbers = [
    payload.business_head.mobile,
    ...payload.alternative_contacts.map((c) => c.mobile),
  ];
  const seen = new Set<string>();
  for (const number of numbers) {
    if (seen.has(number)) {
      throw new AppError(`${number} is listed as a contact number twice.`, 400);
    }
    seen.add(number);
  }
  /*
   * The placeholders are expanded one per number rather than `IN (?)` with
   * an array. The pool runs PREPARED statements, and a prepared `IN (?)`
   * binds the whole array as ONE value -- which matches nothing, silently,
   * so the check would always pass and this guard would not exist.
   */
  const taken = await query<{ mobile_number: string }>(
    `SELECT mobile_number FROM business_users
      WHERE mobile_number IN (${numbers.map(() => '?').join(', ')})`,
    numbers
  );
  if (taken.rows[0]) {
    throw new AppError(
      `${taken.rows[0].mobile_number} is already registered against another business.`,
      409
    );
  }
  // The request being approved is itself PENDING with this GSTIN, so it has
  // to be excluded or every approval would collide with itself.
  if (payload.gstin) {
    const pending = await query(
      `SELECT id FROM creation_requests
        WHERE request_type = 'BUSINESS' AND status = 'PENDING'
          AND JSON_UNQUOTE(JSON_EXTRACT(payload, '$.gstin')) = ?
          AND (? IS NULL OR id <> ?)`,
      [payload.gstin, excludeRequestId ?? null, excludeRequestId ?? null]
    );
    if (pending.rows[0]) {
      throw new AppError('A request for that GST number is already awaiting approval.', 409);
    }
  }
}

async function assertStaffNotTaken(
  payload: StaffRequestPayload,
  excludeRequestId?: string
): Promise<void> {
  const dupe = await query(`SELECT id FROM users WHERE email = ? OR mobile_number = ?`, [
    payload.email,
    payload.mobile_number,
  ]);
  if (dupe.rows[0]) {
    throw new AppError('That email or mobile number is already registered.', 409);
  }
  // Excluding the request under approval: it is itself a PENDING row with
  // this email, and without this every approval would refuse itself.
  const pending = await query(
    `SELECT id FROM creation_requests
      WHERE status = 'PENDING' AND subject_email = ? AND request_type IN ('RIDER','SORTER')
        AND (? IS NULL OR id <> ?)`,
    [payload.email, excludeRequestId ?? null, excludeRequestId ?? null]
  );
  if (pending.rows[0]) {
    throw new AppError('A request for that email is already awaiting approval.', 409);
  }
}

/* ===================================================================
 * READ
 * =================================================================== */

const SELECT_REQUEST = `
  SELECT r.id, r.request_type, r.status, r.requested_by, u.name AS requested_by_name,
         r.subject_name, r.subject_email, r.payload, r.rejection_reason, r.reviewed_by,
         r.approved_at, r.created_entity_id, r.email_status, r.email_error,
         r.created_at, r.updated_at
    FROM creation_requests r
    LEFT JOIN users u ON u.id = r.requested_by`;

export async function getRequestById(id: string): Promise<CreationRequestRow> {
  const result = await query<any>(`${SELECT_REQUEST} WHERE r.id = ?`, [id]);
  if (!result.rows[0]) throw new AppError('Request not found.', 404);
  return toRow(result.rows[0]);
}

/**
 * One request, scoped to its owner.
 *
 * The manager id is part of the WHERE clause, not checked after the fact, so
 * another manager's request is a 404 rather than a 403 — it does not confirm
 * that the id exists.
 */
export async function getOwnRequest(managerId: string, id: string): Promise<CreationRequestRow> {
  const result = await query<any>(`${SELECT_REQUEST} WHERE r.id = ? AND r.requested_by = ?`, [
    id,
    managerId,
  ]);
  if (!result.rows[0]) throw new AppError('Request not found.', 404);
  return toRow(result.rows[0]);
}

/** A manager's own requests. Always filtered by `requested_by`. */
export async function listOwnRequests(
  managerId: string,
  filters: { type?: unknown; status?: unknown } = {}
): Promise<CreationRequestRow[]> {
  const conditions = ['r.requested_by = ?'];
  const values: unknown[] = [managerId];

  const type = String(filters.type ?? '').trim().toUpperCase();
  if (type && REQUEST_TYPES.includes(type as RequestType)) {
    conditions.push('r.request_type = ?');
    values.push(type);
  }
  const status = String(filters.status ?? '').trim().toUpperCase();
  if (status && ['PENDING', 'APPROVED', 'REJECTED'].includes(status)) {
    conditions.push('r.status = ?');
    values.push(status);
  }

  const result = await query<any>(
    `${SELECT_REQUEST} WHERE ${conditions.join(' AND ')} ORDER BY r.created_at DESC LIMIT 200`,
    values
  );
  return result.rows.map(toRow);
}

/** Every request, for the Super Admin queues. Not filtered by owner. */
export async function listAllRequests(
  filters: { type?: unknown; status?: unknown } = {}
): Promise<CreationRequestRow[]> {
  const conditions: string[] = [];
  const values: unknown[] = [];

  const type = String(filters.type ?? '').trim().toUpperCase();
  if (type && REQUEST_TYPES.includes(type as RequestType)) {
    conditions.push('r.request_type = ?');
    values.push(type);
  }
  const status = String(filters.status ?? '').trim().toUpperCase();
  if (status && ['PENDING', 'APPROVED', 'REJECTED'].includes(status)) {
    conditions.push('r.status = ?');
    values.push(status);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const result = await query<any>(
    `${SELECT_REQUEST} ${where} ORDER BY FIELD(r.status,'PENDING','REJECTED','APPROVED'), r.created_at DESC LIMIT 300`,
    values
  );
  return result.rows.map(toRow);
}

/* ===================================================================
 * REJECT  (super admin)
 * =================================================================== */

export async function rejectRequest(
  reviewerId: string,
  id: string,
  reason: unknown
): Promise<CreationRequestRow> {
  const request = await getRequestById(id);
  if (request.status !== 'PENDING') {
    throw new AppError(`This request has already been ${request.status.toLowerCase()}.`, 409);
  }

  await query(
    `UPDATE creation_requests
        SET status = 'REJECTED', reviewed_by = ?, rejection_reason = ?, updated_at = NOW()
      WHERE id = ? AND status = 'PENDING'`,
    [reviewerId, text(reason).slice(0, 500) || null, id]
  );

  logger.info(`[CreationRequest] ${request.request_type} request ${id} rejected by ${reviewerId}`);
  return getRequestById(id);
}

/* ===================================================================
 * APPROVE  (super admin)
 * =================================================================== */

export interface ApprovalResult {
  request: CreationRequestRow;
  created: { id: string; name: string; username: string };
  email: { sent: boolean; error?: string };
}

/**
 * Approves a request: creates the entity, generates credentials, emails them.
 *
 * THE PASSWORD COMES FROM THE SUPER ADMIN, in the request body, and is
 * validated before any row is written. Nothing is generated and nothing is
 * defaulted.
 *
 * TRANSACTIONAL. Every row the approval writes — the business, its contacts,
 * the account, the request's own status — is one transaction. Either the
 * whole account exists or none of it does; a half-created business is never
 * left behind.
 *
 * THE EMAIL IS SENT AFTER THE COMMIT, deliberately. Mail delivery can take
 * seconds and can fail, and neither should hold a database transaction open
 * or roll back an account that was correctly created. A failure is recorded
 * on the request (`email_status = 'FAILED'`) and the Super Admin can resend,
 * which mints a NEW password — the original is gone by then, because it was
 * never stored.
 */
export async function approveRequest(
  reviewerId: string,
  id: string,
  input: { password?: unknown; confirm_password?: unknown }
): Promise<ApprovalResult> {
  const request = await getRequestById(id);
  if (request.status !== 'PENDING') {
    throw new AppError(`This request has already been ${request.status.toLowerCase()}.`, 409);
  }

  // The Super Admin's own password, checked against the app's existing
  // policy BEFORE anything is created — a rejected password must not leave
  // a half-made account behind. Used twice, hashed for storage and rendered
  // into the email, then discarded when this function returns.
  const password = validatePassword(input.password, input.confirm_password);
  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

  const created =
    request.request_type === 'BUSINESS'
      ? await approveBusiness(request, reviewerId, passwordHash)
      : await approveStaff(request, reviewerId, passwordHash);

  // Post-commit. The account exists from here on regardless of what the mail
  // server does.
  const email = await sendCredentialsEmail({
    kind: request.request_type,
    to: created.username,
    accountName: created.name,
    username: created.username,
    password,
  });

  await query(
    `UPDATE creation_requests
        SET email_status = ?, email_error = ?, email_sent_at = ?, updated_at = NOW()
      WHERE id = ?`,
    [email.sent ? 'SENT' : 'FAILED', email.sent ? null : (email.error || '').slice(0, 500) || null,
     email.sent ? new Date() : null, id]
  );

  if (!email.sent) {
    // The reason, never the credentials.
    logger.warn(`[CreationRequest] request ${id} approved but the credentials email failed`);
  }

  return { request: await getRequestById(id), created, email: { sent: email.sent, error: email.error } };
}

/** Creates the business, its contacts and its account, in one transaction. */
async function approveBusiness(
  request: CreationRequestRow,
  reviewerId: string,
  passwordHash: string
): Promise<{ id: string; name: string; username: string }> {
  const payload = request.payload as BusinessRequestPayload;

  // Re-validated from the stored payload rather than trusted: a row edited in
  // the database still has to pass everything a submission would.
  const validated = validateBusinessPayload(payload);

  // Re-checked now, because the world moved on since submission. This
  // request is excluded from the "already pending" test — it is the one
  // being decided.
  await assertBusinessNotTaken(validated, request.id);

  /*
   * THE GSTIN IS VERIFIED HERE, against the provider, at approval time.
   *
   * Not read from the payload, not taken from a `gst_verified` flag, not
   * inherited from the submission. This is what makes it impossible for a
   * Manager to create a business with an unverified GSTIN, whatever the
   * request body said.
   */
  let gstStatus: string | null = null;
  let gstVerified = false;
  let legalNameFromGst: string | null = null;

  // A B2C registration has no GSTIN, so there is nothing to verify and the
  // provider is not called at all. For a B2B one the number is already known
  // to be present -- `validateBusinessPayload` refuses the submission
  // otherwise -- so this is the check that decides the account.
  if (validated.gstin && config.GST_VERIFICATION_REQUIRED) {
    const details = await verifyGstinForRegistration(validated.gstin);
    gstVerified = details.active;
    gstStatus = details.status;
    legalNameFromGst = details.legalName;
  }

  // The registered legal name wins when the provider supplied one: the name
  // on file should be the name on the registration.
  const name = legalNameFromGst || validated.legal_name;

  const connection = await getClient();
  try {
    await connection.beginTransaction();

    const [businessInsert]: any = await connection.execute(
      `INSERT INTO businesses
         (name, legal_name, establishment_name, business_type, registration_type, status,
          address, establishment_address, city, state, pincode,
          gst_number, gst_verified, gst_status, pan_number, billing_cycle,
          created_by_admin_id, reviewed_by)
       VALUES (?, ?, ?, 'HOTEL', ?, 'ACTIVE', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        // Legal Name -> businesses.name, the canonical field. `legal_name` is
        // set to the same value because the column already existed.
        name,
        name,
        // The trading name. Falls back to the legal name so the column is
        // never empty for a business that trades under its own name.
        validated.establishment_name || name,
        // B2B or B2C, as submitted and re-validated above. It is what makes
        // the GSTIN below required or absent, and it travels with the record
        // into the profile, the API and the PDF.
        validated.registration_type,
        // Legal Address -> businesses.address, the existing address column.
        validated.legal_address,
        // Where it operates. Falls back to the legal address for the same
        // reason.
        validated.establishment_address || validated.legal_address,
        validated.city,
        validated.state,
        validated.pincode,
        // Null for a B2C registration, by construction rather than by
        // omission: `gstForRegistrationType` discarded anything sent.
        validated.gstin,
        gstVerified,
        gstStatus,
        // Derived from the GSTIN on the server, never from the form, and
        // null when there is no GSTIN to derive it from.
        validated.pan_number,
        validated.billing_cycle,
        request.requested_by,
        reviewerId,
      ]
    );
    const businessId = String(businessInsert.insertId);

    /*
     * THE CONTACTS, AND THE ACCOUNT, IN ONE TABLE.
     *
     * Since migration 031 a business's people all live in `business_users`.
     * The head is the PRIMARY row and it is ALSO the login account -- it
     * carries the password hash, so there is no separate account row that
     * could disagree with it about the head's name, number or email.
     *
     * Each alternative is a further row with NO password: a person to ring,
     * and a number that identifies this business at sign-in, but not a
     * second set of credentials.
     */
    await connection.execute(
      `INSERT INTO business_users
         (business_id, contact_type, name, designation, email, mobile_number,
          whatsapp_number, password_hash, is_active, login_enabled)
       VALUES (?, 'PRIMARY', ?, ?, ?, ?, ?, ?, 1, TRUE)`,
      [
        businessId,
        validated.business_head.name,
        validated.business_head.designation,
        validated.business_head.email,
        validated.business_head.mobile,
        validated.business_head.whatsapp,
        passwordHash,
      ]
    );

    for (const contact of validated.alternative_contacts) {
      await connection.execute(
        `INSERT INTO business_users
           (business_id, contact_type, name, designation, email, mobile_number,
            whatsapp_number, password_hash, is_active, login_enabled)
         VALUES (?, 'ALTERNATIVE', ?, ?, NULL, ?, NULL, NULL, 1, TRUE)`,
        [businessId, contact.name, contact.designation, contact.mobile]
      );
    }

    await connection.execute(
      `UPDATE creation_requests
          SET status = 'APPROVED', reviewed_by = ?, approved_at = NOW(),
              created_entity_id = ?, updated_at = NOW()
        WHERE id = ? AND status = 'PENDING'`,
      [reviewerId, businessId, request.id]
    );

    await connection.commit();
    logger.info(`[CreationRequest] business ${businessId} created from request ${request.id}`);

    // Required by validateBusinessPayload for the head, which is the only
    // contact whose email is ever read.
    return { id: businessId, name, username: validated.business_head.email! };
  } catch (error) {
    await connection.rollback();
    logger.error(`[CreationRequest] business approval ${request.id} rolled back: ${(error as Error).message}`);
    throw error;
  } finally {
    connection.release();
  }
}

/** Creates a rider or sorter `users` row. Same table every other staff account uses. */
async function approveStaff(
  request: CreationRequestRow,
  reviewerId: string,
  passwordHash: string
): Promise<{ id: string; name: string; username: string }> {
  const payload = request.payload as StaffRequestPayload;
  const validated = validateStaffPayload(payload, request.request_type === 'RIDER' ? 'Rider' : 'Sorter');
  await assertStaffNotTaken(validated, request.id);

  const role = request.request_type; // 'RIDER' | 'SORTER'

  const connection = await getClient();
  try {
    await connection.beginTransaction();

    const [insert]: any = await connection.execute(
      `INSERT INTO users
         (name, email, mobile_number, password_hash, role, is_active, mobile_verified,
          approval_status, reviewed_at, reviewed_by)
       VALUES (?, ?, ?, ?, ?, 1, 1, 'APPROVED', NOW(), ?)`,
      [validated.name, validated.email, validated.mobile_number, passwordHash, role, reviewerId]
    );
    const userId = String(insert.insertId);

    await connection.execute(
      `UPDATE creation_requests
          SET status = 'APPROVED', reviewed_by = ?, approved_at = NOW(),
              created_entity_id = ?, updated_at = NOW()
        WHERE id = ? AND status = 'PENDING'`,
      [reviewerId, userId, request.id]
    );

    await connection.commit();
    logger.info(`[CreationRequest] ${role} ${userId} created from request ${request.id}`);

    return { id: userId, name: validated.name, username: validated.email };
  } catch (error) {
    await connection.rollback();
    logger.error(`[CreationRequest] ${role} approval ${request.id} rolled back: ${(error as Error).message}`);
    throw error;
  } finally {
    connection.release();
  }
}

/* ===================================================================
 * RESEND CREDENTIALS  (super admin)
 * =================================================================== */

/**
 * Sets a NEW password on an approved account and emails the credentials.
 *
 * This is the recovery path from a failed credentials email. The original
 * password cannot be re-sent because it was never stored — only its hash was
 * — so the Super Admin types a fresh one and that is what goes out. A reset,
 * not a retrieval, which is what makes "never store plaintext" workable.
 */
export async function resendCredentials(
  reviewerId: string,
  id: string,
  input: { password?: unknown; confirm_password?: unknown }
): Promise<{ email: { sent: boolean; error?: string }; username: string }> {
  const request = await getRequestById(id);
  if (request.status !== 'APPROVED' || !request.created_entity_id) {
    throw new AppError('Credentials can only be resent for an approved request.', 400);
  }

  const password = validatePassword(input.password, input.confirm_password, 'New password');
  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

  let username: string;
  let accountName: string;

  if (request.request_type === 'BUSINESS') {
    // The LOGIN account, not merely the first row: a business now holds its
    // alternative contacts in this table too, and they carry no credentials.
    const account = await query<{ id: string; email: string; name: string }>(
      `SELECT id, email, name FROM business_users
        WHERE business_id = ? AND email IS NOT NULL AND TRIM(email) <> ''
        ORDER BY (password_hash IS NULL), FIELD(contact_type,'PRIMARY','ALTERNATIVE'), id
        LIMIT 1`,
      [request.created_entity_id]
    );
    if (!account.rows[0]) throw new AppError('The business account no longer exists.', 404);
    username = account.rows[0].email;
    accountName = request.subject_name;
    await query(`UPDATE business_users SET password_hash = ?, updated_at = NOW() WHERE id = ?`, [
      passwordHash,
      account.rows[0].id,
    ]);
  } else {
    const account = await query<{ id: string; email: string | null; name: string | null }>(
      `SELECT id, email, name FROM users WHERE id = ?`,
      [request.created_entity_id]
    );
    if (!account.rows[0] || !account.rows[0].email) {
      throw new AppError('The account no longer exists or has no email.', 404);
    }
    username = account.rows[0].email!;
    accountName = account.rows[0].name || request.subject_name;
    await query(`UPDATE users SET password_hash = ?, updated_at = NOW() WHERE id = ?`, [
      passwordHash,
      account.rows[0].id,
    ]);
  }

  const email = await sendCredentialsEmail({
    kind: request.request_type,
    to: username,
    accountName,
    username,
    password,
  });

  await query(
    `UPDATE creation_requests
        SET email_status = ?, email_error = ?, email_sent_at = ?, updated_at = NOW()
      WHERE id = ?`,
    [email.sent ? 'SENT' : 'FAILED', email.sent ? null : (email.error || '').slice(0, 500) || null,
     email.sent ? new Date() : null, id]
  );

  logger.info(`[CreationRequest] credentials reissued for request ${id} by ${reviewerId}`);
  return { email: { sent: email.sent, error: email.error }, username };
}

/** Counts for the dashboards. */
export async function requestCounts(managerId?: string): Promise<Record<string, number>> {
  const where = managerId ? 'WHERE requested_by = ?' : '';
  const values = managerId ? [managerId] : [];
  const result = await query<{ status: string; request_type: string; n: number }>(
    `SELECT status, request_type, COUNT(*) AS n FROM creation_requests ${where}
      GROUP BY status, request_type`,
    values
  );
  const counts: Record<string, number> = {
    PENDING: 0, APPROVED: 0, REJECTED: 0,
    BUSINESS: 0, RIDER: 0, SORTER: 0,
  };
  for (const row of result.rows) {
    counts[row.status] = (counts[row.status] || 0) + Number(row.n);
    counts[row.request_type] = (counts[row.request_type] || 0) + Number(row.n);
  }
  return counts;
}
