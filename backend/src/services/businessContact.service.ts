import { query } from '../config/database';
import { AppError } from '../utils/appError';
import { logger } from '../utils/logger';

/**
 * Business contacts — the people and numbers a business is reached through.
 *
 * THEY LIVE IN `business_users`, WHICH IS THE ONLY PLACE THEY LIVE.
 *
 * There used to be three: five columns on `businesses`, a row in
 * `business_contacts`, and the `business_users` account row. Migration 031
 * folded all of it into `business_users`, so a number is recorded exactly
 * once and the login lookup and the invoice can no longer disagree about it.
 *
 *   contact_type = 'PRIMARY'      the business head; also the login account
 *   contact_type = 'ALTERNATIVE'  a further contact, one to three of them
 *
 * WHAT MAKES A ROW AN ACCOUNT is `password_hash`, not `contact_type`. A
 * PRIMARY row without one is a person on file who cannot yet sign in; an
 * ALTERNATIVE never has one, because an alternative contact is somebody to
 * ring, not a second set of credentials.
 *
 * WHAT THE MOBILE NUMBER DOES. Every contact's number — primary and
 * alternative alike — identifies the business at sign-in. `unifiedAuth`
 * resolves it to that business's login account, so an alternative contact
 * reaches the same business dashboard as the head, and `login_enabled` is
 * the Super Admin's switch for whether a given number may do that at all.
 * The number is proven by OTP; the password step that follows is unchanged.
 *
 * THE API SHAPE IS UNCHANGED. `contact_type` is reported as BUSINESS_HEAD /
 * ALTERNATIVE exactly as before, so the app's existing screens and types
 * keep working; only the table underneath moved.
 */

/** What the API calls them. The column says PRIMARY; the wire says BUSINESS_HEAD. */
export type ContactType = 'BUSINESS_HEAD' | 'ALTERNATIVE';

/** What the column holds. */
export type ContactRole = 'PRIMARY' | 'ALTERNATIVE';

const typeFor = (role: string): ContactType =>
  role === 'ALTERNATIVE' ? 'ALTERNATIVE' : 'BUSINESS_HEAD';

/**
 * Alternative contacts: none to three.
 *
 * OPTIONAL. A business is complete with only its primary contact -- that one
 * is the login account, and it is the only contact registration insists on.
 * An alternative contact is an extra person authorised to reach the same
 * account, so requiring one would be requiring a second person to exist.
 *
 * Three is the maximum, and it is enforced in the service rather than by the
 * form, so a client that posts a fourth is refused either way.
 */
export const MIN_ALTERNATIVE_CONTACTS = 0;
export const MAX_ALTERNATIVE_CONTACTS = 3;

const MOBILE_PATTERN = /^[6-9]\d{9}$/;

/**
 * Strips punctuation and a COUNTRY CODE OR TRUNK PREFIX, and nothing else.
 *
 * THE LENGTH CHECKS ARE THE POINT. `91` is stripped only from a twelve-digit
 * number and `0` only from an eleven-digit one, because in a ten-digit number
 * those digits are part of the number itself. Stripping them unconditionally
 * turns the perfectly ordinary `9123456789` into `23456789`, and then that
 * contact cannot be registered, cannot be found, and cannot sign in -- while
 * every number starting 6-8 works, so the fault looks like bad data rather
 * than a bug. `+91` is a country code wherever it appears, since the `+` says
 * so outright.
 *
 * This is the same rule `auth.service.normalizeMobile` applies on the OTP
 * path; the two have to agree, or a number would be stored under one spelling
 * and looked up under another.
 */
function stripToNationalNumber(value: unknown): string {
  const cleaned = String(value ?? '').trim().replace(/[\s\-()]/g, '');
  if (cleaned.startsWith('+91')) return cleaned.slice(3);
  if (cleaned.startsWith('91') && cleaned.length === 12) return cleaned.slice(2);
  if (cleaned.startsWith('0') && cleaned.length === 11) return cleaned.slice(1);
  return cleaned;
}

/** Strips +91 / 0 / spaces / dashes, then checks the ten digits. */
export function normaliseMobile(value: unknown, label = 'Mobile number'): string {
  const digits = stripToNationalNumber(value);
  if (!MOBILE_PATTERN.test(digits)) {
    throw new AppError(`${label} must be a valid 10-digit Indian mobile number.`, 400);
  }
  return digits;
}

/**
 * The same normalisation, but `null` instead of an error.
 *
 * For the one caller that must not fail on a bad value: stamping
 * `orders.placed_by_mobile`. That number is taken from the SESSION, not from
 * the request, and a session with a missing or malformed claim is a session
 * minted before the claim existed -- not a bad order. Refusing the order over
 * it would break placing orders for everyone holding an older token, so the
 * order is placed and the column stays NULL, which is the honest record of
 * "this was never captured".
 *
 * Ten digits or nothing: half a phone number on a document is worse than no
 * phone number at all.
 */
export function normaliseMobileOrNull(value: unknown): string | null {
  const digits = stripToNationalNumber(value);
  return MOBILE_PATTERN.test(digits) ? digits : null;
}

/* ===================================================================
 * THE ONE DEFINITION OF "THE BUSINESS HEAD"
 *
 * Both fragments below exist so that every service asking "who is this
 * business's contact person" asks it the same way. Before 031 that answer
 * came from columns on `businesses`; now it comes from the PRIMARY row, and
 * having one spelling of it is what stops the old drift coming back.
 * =================================================================== */

/**
 * The id of a business's head row: PRIMARY first, lowest id as the
 * tie-break. Takes ONE bound parameter — the business id.
 */
export const HEAD_CONTACT_ID_SQL = `
  (SELECT x.id FROM business_users x
    WHERE x.business_id = ?
    ORDER BY FIELD(x.contact_type,'PRIMARY','ALTERNATIVE'), x.id
    LIMIT 1)`;

/**
 * Joins the head row onto a query that already has `businesses b` in scope,
 * exposing it as `hbu`. Correlated on b.id, so it binds no parameter.
 */
export const HEAD_CONTACT_JOIN = `
  LEFT JOIN business_users hbu
         ON hbu.id = (SELECT x.id FROM business_users x
                       WHERE x.business_id = b.id
                       ORDER BY FIELD(x.contact_type,'PRIMARY','ALTERNATIVE'), x.id
                       LIMIT 1)`;

/**
 * The columns `businesses` used to carry inline, under the names the API has
 * always reported them by. Used with HEAD_CONTACT_JOIN.
 */
export const HEAD_CONTACT_COLUMNS = `
  hbu.name            AS contact_person_name,
  hbu.designation     AS designation,
  hbu.mobile_number   AS mobile_number,
  hbu.whatsapp_number AS whatsapp_number,
  hbu.email           AS email_id`;

/**
 * The account a sign-in on this business resolves to: a row that HAS a
 * password. Takes ONE bound parameter — the business id.
 */
export const LOGIN_ACCOUNT_ID_SQL = `
  (SELECT x.id FROM business_users x
    WHERE x.business_id = ?
      AND x.password_hash IS NOT NULL
      AND x.is_active = true
    ORDER BY FIELD(x.contact_type,'PRIMARY','ALTERNATIVE'), x.id
    LIMIT 1)`;

export interface BusinessContactRow {
  id: string;
  business_id: string;
  contact_type: ContactType;
  name: string;
  designation: string | null;
  mobile: string | null;
  /** Head only. Alternatives never carry one. */
  whatsapp: string | null;
  /** Head only — it is the login username. Always null for alternatives. */
  email: string | null;
  login_enabled: boolean;
  /** True when this row carries credentials, i.e. it can actually sign in. */
  has_login: boolean;
  created_at: string;
}

const SELECT_CONTACT = `
  SELECT id, business_id, contact_type, name, designation,
         mobile_number AS mobile, whatsapp_number AS whatsapp, email,
         login_enabled, (password_hash IS NOT NULL) AS has_login, created_at
    FROM business_users`;

/**
 * A SQL truth value as a real boolean.
 *
 * `Boolean()` alone is WRONG here. The pool converts a TINYINT(1) COLUMN to a
 * boolean, but `(password_hash IS NOT NULL)` is a computed expression, and
 * with `bigNumberStrings` on it arrives as the STRING '0' or '1' -- and
 * `Boolean('0')` is true. Reading it that way would mark every contact as a
 * login account, which is exactly the sort of thing that then refuses to
 * delete a contact for a reason that is not real.
 */
function truthy(value: unknown): boolean {
  if (typeof value === 'string') return value !== '' && value !== '0';
  return Boolean(value);
}

function toRow(row: any): BusinessContactRow {
  return {
    ...row,
    id: String(row.id),
    business_id: String(row.business_id),
    contact_type: typeFor(row.contact_type),
    login_enabled: truthy(row.login_enabled),
    has_login: truthy(row.has_login),
  };
}

/** Every contact on one business, head first. */
export async function listContacts(businessId: string): Promise<BusinessContactRow[]> {
  const result = await query<any>(
    `${SELECT_CONTACT}
      WHERE business_id = ?
      ORDER BY FIELD(contact_type,'PRIMARY','ALTERNATIVE'), id ASC`,
    [businessId]
  );
  return result.rows.map(toRow);
}

/* ===================================================================
 * LOGIN ROUTING
 * =================================================================== */

export interface LoginRoute {
  /** True when this number maps to exactly one business that may be reached. */
  routed: boolean;
  business?: {
    id: string;
    name: string;
    /** The email the person must sign in with — the business head's. */
    login_email: string | null;
  };
  /** The contact that matched, for the "signing in as…" line. */
  contact?: { name: string; designation: string | null };
  /** Shown to the user when `routed` is false. */
  message?: string;
}

/**
 * Turns a mobile number into "show this business's login page".
 *
 * PRIMARY AND ALTERNATIVE ARE TREATED IDENTICALLY here, which is the point:
 * whichever of a business's numbers is typed, the same business comes back.
 *
 * Deliberately returns a 200-shaped answer rather than throwing for the
 * not-found and not-permitted cases: both are legitimate outcomes of a
 * lookup, and the caller renders the message.
 *
 * NO CREDENTIAL IS RETURNED. The response carries the business name and the
 * email to sign in WITH — never a token, never a password, never a hash.
 */
export async function resolveLoginRoute(mobileInput: unknown): Promise<LoginRoute> {
  const mobile = normaliseMobile(mobileInput);

  const result = await query<any>(
    `SELECT c.id, c.name, c.designation, c.login_enabled, c.contact_type,
            b.id AS business_id, b.name AS business_name, b.status AS business_status,
            (SELECT a.email FROM business_users a
              WHERE a.business_id = b.id AND a.is_active = true
                AND a.password_hash IS NOT NULL AND a.email IS NOT NULL
              ORDER BY FIELD(a.contact_type,'PRIMARY','ALTERNATIVE'), a.id
              LIMIT 1) AS login_email
       FROM business_users c
       JOIN businesses b ON b.id = c.business_id
      WHERE c.mobile_number = ?
      ORDER BY FIELD(c.contact_type,'PRIMARY','ALTERNATIVE'), c.id ASC`,
    [mobile]
  );

  const matches = result.rows;
  if (matches.length === 0) {
    return {
      routed: false,
      message: 'That mobile number is not registered against any business.',
    };
  }

  // The Super Admin's switch, checked before anything else about the match is
  // used. When every match is disabled the caller is told so plainly.
  const permitted = matches.filter((row: any) => Boolean(row.login_enabled));
  if (permitted.length === 0) {
    return {
      routed: false,
      message:
        'This contact is not authorized for business login. Please contact the administrator.',
    };
  }

  const match = permitted[0];

  // A closed or unapproved business is not somewhere to send anyone.
  if (match.business_status !== 'ACTIVE') {
    return {
      routed: false,
      message: 'That business account is not active. Please contact the administrator.',
    };
  }
  if (!match.login_email) {
    return {
      routed: false,
      message: 'That business has no active login account yet. Please contact the administrator.',
    };
  }

  logger.info(`[BusinessContact] login routed to business ${match.business_id}`);

  return {
    routed: true,
    business: {
      id: String(match.business_id),
      name: match.business_name,
      login_email: match.login_email,
    },
    contact: { name: match.name, designation: match.designation },
  };
}

/* ===================================================================
 * SUPER ADMIN MANAGEMENT
 * =================================================================== */

export interface ContactInput {
  name?: unknown;
  designation?: unknown;
  mobile?: unknown;
  /** Head only. Ignored for an alternative. */
  whatsapp?: unknown;
  /** Head only. Ignored for an alternative. */
  email?: unknown;
  login_enabled?: unknown;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function requireText(value: unknown, label: string, max = 255): string {
  const out = String(value ?? '').trim();
  if (!out) throw new AppError(`${label} is required.`, 400);
  if (out.length > max) throw new AppError(`${label} is too long.`, 400);
  return out;
}

function parseFlag(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const text = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'enabled'].includes(text)) return true;
  if (['false', '0', 'no', 'disabled'].includes(text)) return false;
  throw new AppError('Login access must be enabled or disabled.', 400);
}

/**
 * Validates one contact.
 *
 * AN ALTERNATIVE IS A PHONE NUMBER AND A DESIGNATION. The number is the only
 * required part, because the number is what does the work: it is what
 * identifies the business at sign-in. The name is kept -- it is useful to know
 * who is being rung -- but it is not insisted on, and a contact given without
 * one is recorded rather than refused.
 *
 * Email and WhatsApp are forced to null for an alternative rather than merely
 * ignored, so a client that sends them cannot get them stored. An alternative
 * contact has no email because they have no account: the only email that
 * authenticates is the primary contact's.
 *
 * THE PRIMARY contact is the opposite: its email IS the login username, so it
 * is required and validated as one.
 */
export function validateContact(input: ContactInput, contactType: ContactType) {
  const designation = String(input.designation ?? '').trim() || null;

  if (contactType === 'ALTERNATIVE') {
    const name = String(input.name ?? '').trim() || 'Alternative contact';
    return {
      name,
      designation,
      mobile: normaliseMobile(input.mobile, `${name}'s mobile number`),
      whatsapp: null as string | null,
      email: null as string | null,
      login_enabled: parseFlag(input.login_enabled, true),
    };
  }

  const name = requireText(input.name, 'Contact name');
  const mobile = normaliseMobile(input.mobile, `${name}'s mobile number`);
  const email = String(input.email ?? '').trim().toLowerCase();
  if (!EMAIL_PATTERN.test(email)) {
    throw new AppError('Business head email must be a valid email address.', 400);
  }
  const whatsappRaw = String(input.whatsapp ?? '').trim();
  return {
    name,
    designation,
    mobile,
    // Not defaulted from the mobile: they are frequently different numbers.
    whatsapp: whatsappRaw ? normaliseMobile(whatsappRaw, 'WhatsApp number') : null,
    email,
    login_enabled: parseFlag(input.login_enabled, true),
  };
}

/**
 * The 0..3 rule for alternatives, in one place.
 *
 * An empty list is legitimate and means "this business has no alternative
 * contacts" -- it is not an omission to be rejected. Blank rows are dropped
 * before counting, so a form that renders three empty slots and sends them
 * all does not turn into three refusals.
 */
export function validateAlternatives(input: unknown): ReturnType<typeof validateContact>[] {
  const list = (Array.isArray(input) ? input : []).filter((c: any) => {
    if (!c || typeof c !== 'object') return false;
    return Boolean(String(c.mobile ?? '').trim() || String(c.name ?? '').trim());
  });
  if (list.length > MAX_ALTERNATIVE_CONTACTS) {
    throw new AppError(
      `You can add at most ${MAX_ALTERNATIVE_CONTACTS} alternative contacts.`,
      400
    );
  }
  const contacts = list.map((c) => validateContact(c as ContactInput, 'ALTERNATIVE'));

  // Two contacts on one business sharing a number would make the sign-in
  // lookup ambiguous about which person is calling, so it is refused here.
  const seen = new Set<string>();
  for (const contact of contacts) {
    if (seen.has(contact.mobile)) {
      throw new AppError(`${contact.mobile} is listed as an alternative contact twice.`, 400);
    }
    seen.add(contact.mobile);
  }
  return contacts;
}

/**
 * A number may identify exactly one business.
 *
 * Checked before every write, because the whole of the alternative-contact
 * sign-in rests on it: if one number were recorded against two businesses,
 * proving it by OTP could not say which dashboard the person belongs in.
 * A number already on THIS business (`excludeId` aside) is a duplicate too.
 */
async function assertMobileFree(
  businessId: string,
  mobile: string,
  excludeId?: string
): Promise<void> {
  const clash = await query<{ id: string; business_id: string; name: string }>(
    `SELECT id, business_id, name FROM business_users
      WHERE mobile_number = ? AND (? IS NULL OR id <> ?)`,
    [mobile, excludeId ?? null, excludeId ?? null]
  );
  const row = clash.rows[0];
  if (!row) return;

  throw new AppError(
    String(row.business_id) === String(businessId)
      ? `${mobile} is already a contact on this business.`
      : 'That mobile number is already registered against another business.',
    409
  );
}

/**
 * Replaces a business's alternative contacts wholesale.
 *
 * The head row is left alone — it is edited through the business record,
 * because its email is the login username and changing it is a different
 * operation from editing a phone list.
 *
 * ONLY ALTERNATIVE ROWS ARE DELETED, and only rows that carry no password:
 * an account row can never be removed by editing a contact list, because
 * orders point at it.
 */
export async function replaceAlternatives(
  businessId: string,
  input: unknown
): Promise<BusinessContactRow[]> {
  const contacts = validateAlternatives(input);

  for (const contact of contacts) {
    const clash = await query<{ id: string; business_id: string }>(
      `SELECT id, business_id FROM business_users
        WHERE mobile_number = ? AND business_id <> ?`,
      [contact.mobile, businessId]
    );
    if (clash.rows[0]) {
      throw new AppError(
        'That mobile number is already registered against another business.',
        409
      );
    }
  }

  await query(
    `DELETE FROM business_users
      WHERE business_id = ? AND contact_type = 'ALTERNATIVE' AND password_hash IS NULL`,
    [businessId]
  );
  for (const c of contacts) {
    await query(
      `INSERT INTO business_users
         (business_id, contact_type, name, designation, email, mobile_number,
          whatsapp_number, password_hash, is_active, login_enabled)
       VALUES (?, 'ALTERNATIVE', ?, ?, NULL, ?, NULL, NULL, TRUE, ?)`,
      [businessId, c.name, c.designation, c.mobile, c.login_enabled]
    );
  }

  logger.info(`[BusinessContact] ${contacts.length} alternative contact(s) set on business ${businessId}`);
  return listContacts(businessId);
}

/** One contact on one business, or a 404 that says which. */
async function getContact(businessId: string, contactId: string): Promise<BusinessContactRow> {
  const result = await query<any>(`${SELECT_CONTACT} WHERE id = ? AND business_id = ?`, [
    contactId,
    businessId,
  ]);
  if (!result.rows[0]) throw new AppError('Contact not found for this business.', 404);
  return toRow(result.rows[0]);
}

/** How many alternative contacts this business currently holds. */
async function countAlternatives(businessId: string): Promise<number> {
  const result = await query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM business_users
      WHERE business_id = ? AND contact_type = 'ALTERNATIVE'`,
    [businessId]
  );
  return Number(result.rows[0]?.n || 0);
}

/**
 * Adds ONE alternative contact.
 *
 * The maximum is enforced here, in the backend, so a client that never
 * renders the "+ Add Alternative Contact" button and posts anyway is still
 * refused. Name, designation and mobile only -- `validateContact` writes the
 * email and WhatsApp columns as NULL for an alternative.
 */
export async function addAlternative(
  businessId: string,
  input: ContactInput
): Promise<BusinessContactRow> {
  const existing = await countAlternatives(businessId);
  if (existing >= MAX_ALTERNATIVE_CONTACTS) {
    throw new AppError(
      `This business already has ${MAX_ALTERNATIVE_CONTACTS} alternative contacts. Remove one before adding another.`,
      409
    );
  }

  const contact = validateContact(input, 'ALTERNATIVE');
  await assertMobileFree(businessId, contact.mobile);

  const inserted = await query(
    `INSERT INTO business_users
       (business_id, contact_type, name, designation, email, mobile_number,
        whatsapp_number, password_hash, is_active, login_enabled)
     VALUES (?, 'ALTERNATIVE', ?, ?, NULL, ?, NULL, NULL, TRUE, ?)`,
    [businessId, contact.name, contact.designation, contact.mobile, contact.login_enabled]
  );

  logger.info(`[BusinessContact] alternative contact added to business ${businessId}`);
  return getContact(businessId, String(inserted.insertId));
}

/**
 * Edits one contact in place.
 *
 * THE CONTACT TYPE IS NOT EDITABLE. Promoting an alternative to the business
 * head through an edit form would move the login username, so it is refused:
 * the head is edited through the business record, where its email is handled
 * as the credential it is.
 *
 * The password is never touched here. Changing a business's password is
 * `setBusinessPassword` on the account service, and nothing on this path can
 * read, set or clear a hash.
 */
export async function updateContact(
  businessId: string,
  contactId: string,
  input: ContactInput
): Promise<BusinessContactRow> {
  const current = await getContact(businessId, contactId);
  const contact = validateContact(
    // The head keeps whatever email it already has unless a new one is sent,
    // because the head's email IS the login username.
    current.contact_type === 'BUSINESS_HEAD'
      ? { ...input, email: input.email ?? current.email }
      : input,
    current.contact_type
  );

  await assertMobileFree(businessId, contact.mobile, contactId);

  await query(
    `UPDATE business_users
        SET name = ?, designation = ?, mobile_number = ?, whatsapp_number = ?, email = ?,
            login_enabled = ?, updated_at = NOW()
      WHERE id = ? AND business_id = ?`,
    [
      contact.name,
      contact.designation,
      contact.mobile,
      contact.whatsapp,
      contact.email,
      contact.login_enabled,
      contactId,
      businessId,
    ]
  );

  logger.info(`[BusinessContact] contact ${contactId} updated on business ${businessId}`);
  return getContact(businessId, contactId);
}

/**
 * Deletes ONE alternative contact.
 *
 * TWO THINGS ARE REFUSED, both in the backend:
 *
 *   the business head          it is not an alternative contact. It is the
 *                              login account, and removing it would leave the
 *                              business with no way in at all.
 *   a row with a password      same reason, for a business that has more than
 *                              one login account: orders point at it, and a
 *                              contact list is not where an account gets
 *                              deleted.
 *
 * The LAST alternative may go. Alternative contacts are optional, so a
 * business holding one is allowed to hold none.
 */
export async function deleteAlternative(
  businessId: string,
  contactId: string
): Promise<{ id: string; deleted: true }> {
  const contact = await getContact(businessId, contactId);

  if (contact.contact_type !== 'ALTERNATIVE') {
    throw new AppError(
      'The business head cannot be deleted. Edit the business record to change who it is.',
      400
    );
  }
  if (contact.has_login) {
    throw new AppError(
      'That contact is also a login account for this business, so it cannot be removed here.',
      409
    );
  }

  await query(`DELETE FROM business_users WHERE id = ? AND business_id = ?`, [
    contactId,
    businessId,
  ]);
  logger.info(`[BusinessContact] alternative contact ${contactId} deleted from business ${businessId}`);
  return { id: String(contactId), deleted: true };
}

/** The Super Admin's per-contact login switch. */
export async function setContactLoginEnabled(
  businessId: string,
  contactId: string,
  enabled: unknown
): Promise<BusinessContactRow> {
  const found = await query<any>(
    `SELECT id FROM business_users WHERE id = ? AND business_id = ?`,
    [contactId, businessId]
  );
  if (!found.rows[0]) throw new AppError('Contact not found for this business.', 404);

  const value = parseFlag(enabled, true);
  await query(
    `UPDATE business_users SET login_enabled = ?, updated_at = NOW()
      WHERE id = ? AND business_id = ?`,
    [value, contactId, businessId]
  );

  logger.info(
    `[BusinessContact] contact ${contactId} login ${value ? 'enabled' : 'disabled'}`
  );
  return getContact(businessId, contactId);
}

/**
 * Writes the business head onto the PRIMARY row, creating it if the business
 * has none yet.
 *
 * This is what the Super Admin's business edit and the approval path both
 * call, so "who is the head" is set in exactly one way. The password is
 * untouched: a row that had credentials keeps them, and a row created here
 * has none until one is set.
 */
export async function upsertHeadContact(
  businessId: string,
  head: ReturnType<typeof validateContact>
): Promise<void> {
  const existing = await query<{ id: string }>(
    `SELECT id FROM business_users
      WHERE business_id = ? AND contact_type = 'PRIMARY'
      ORDER BY id LIMIT 1`,
    [businessId]
  );

  const clash = await query<{ id: string }>(
    `SELECT id FROM business_users WHERE email = ? AND business_id <> ?`,
    [head.email, businessId]
  );
  if (clash.rows[0]) {
    throw new AppError('That email is already registered to another business account.', 409);
  }

  if (existing.rows[0]) {
    await assertMobileFree(businessId, head.mobile!, String(existing.rows[0].id));
    await query(
      `UPDATE business_users
          SET name = ?, designation = ?, mobile_number = ?, whatsapp_number = ?,
              email = ?, updated_at = NOW()
        WHERE id = ?`,
      [head.name, head.designation, head.mobile, head.whatsapp, head.email, existing.rows[0].id]
    );
    return;
  }

  await assertMobileFree(businessId, head.mobile!);
  await query(
    `INSERT INTO business_users
       (business_id, contact_type, name, designation, email, mobile_number,
        whatsapp_number, password_hash, is_active, login_enabled)
     VALUES (?, 'PRIMARY', ?, ?, ?, ?, ?, NULL, TRUE, TRUE)`,
    [businessId, head.name, head.designation, head.email, head.mobile, head.whatsapp]
  );
  logger.info(`[BusinessContact] head contact created for business ${businessId}`);
}
