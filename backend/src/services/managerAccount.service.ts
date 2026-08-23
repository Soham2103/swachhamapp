import bcrypt from 'bcrypt';
import { query } from '../config/database';
import { AppError } from '../utils/appError';
import { logger } from '../utils/logger';
import { validatePassword } from '../utils/password';
import { sendCredentialsEmail } from './email.service';
import { normaliseEmail, normaliseMobile } from './creationRequest.service';

/**
 * Manager accounts.
 *
 * A Manager is created by a SUPER ADMIN and by nobody else — there is no
 * self-registration path, no invite link, and no way for one Manager to
 * create another. The only entry point is the Super Admin router, which is
 * already guarded by `authorize('SUPER_ADMIN')`.
 *
 * A Manager is an ordinary `users` row with role MANAGER. That role has been
 * in the enum since migration 021 and `unifiedAuth` already lists it among
 * the password-signin roles, so an account created here can log in through
 * the existing flow with no auth changes at all.
 *
 * THE SUPER ADMIN TYPES THE PASSWORD. Nothing here generates one — a
 * request that omits it is a 400, not a random string nobody knows. The
 * value is validated against the app's existing policy, hashed, used once
 * to send the credentials email, and then dropped: it is never stored in
 * plaintext, never logged and never returned by the API.
 */

const SALT_ROUNDS = 10;

export interface ManagerRow {
  id: string;
  name: string | null;
  email: string | null;
  mobile_number: string;
  is_active: boolean;
  last_login_at: string | null;
  created_at: string;
  /** How many requests this manager has raised, by status. */
  pending: number;
  approved: number;
  rejected: number;
}

/** Every manager, with their request activity. */
export async function listManagers(): Promise<ManagerRow[]> {
  const result = await query<any>(
    `SELECT u.id, u.name, u.email, u.mobile_number, u.is_active, u.last_login_at, u.created_at,
            COALESCE(SUM(r.status = 'PENDING'), 0)  AS pending,
            COALESCE(SUM(r.status = 'APPROVED'), 0) AS approved,
            COALESCE(SUM(r.status = 'REJECTED'), 0) AS rejected
       FROM users u
       LEFT JOIN creation_requests r ON r.requested_by = u.id
      WHERE u.role = 'MANAGER'
      GROUP BY u.id
      ORDER BY u.created_at DESC`
  );
  return result.rows.map((row) => ({
    ...row,
    id: String(row.id),
    is_active: Boolean(row.is_active),
    pending: Number(row.pending),
    approved: Number(row.approved),
    rejected: Number(row.rejected),
  }));
}

export interface CreateManagerInput {
  name?: unknown;
  email?: unknown;
  mobile_number?: unknown;
  /** Typed by the Super Admin. Required — there is no fallback. */
  password?: unknown;
  confirm_password?: unknown;
}

/**
 * Creates a manager and emails the credentials.
 *
 * The username is the email, matching every other account this system issues.
 * The password is the one the SUPER ADMIN typed: validated, hashed, and sent
 * verbatim in the email so the two agree. Nothing is generated.
 */
export async function createManager(
  creatorId: string,
  input: CreateManagerInput
): Promise<{
  id: string;
  name: string;
  username: string;
  email: { sent: boolean; error?: string };
}> {
  const name = String(input.name ?? '').trim();
  if (!name) throw new AppError('Manager name is required.', 400);

  const email = normaliseEmail(input.email, 'Manager email');
  const mobile = normaliseMobile(input.mobile_number, 'Manager mobile number');

  const dupe = await query(`SELECT id FROM users WHERE email = ? OR mobile_number = ?`, [
    email,
    mobile,
  ]);
  if (dupe.rows[0]) {
    throw new AppError('That email or mobile number is already registered.', 409);
  }

  // Validated BEFORE the row is written, so a rejected password never
  // leaves a half-made account behind.
  const password = validatePassword(input.password, input.confirm_password);
  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

  const inserted = await query(
    `INSERT INTO users
       (name, email, mobile_number, password_hash, role, is_active, mobile_verified,
        approval_status, reviewed_at, reviewed_by)
     VALUES (?, ?, ?, ?, 'MANAGER', 1, 1, 'APPROVED', NOW(), ?)`,
    [name, email, mobile, passwordHash, creatorId]
  );
  const id = String(inserted.insertId);

  // The id and the role, never the password.
  logger.info(`[ManagerAccount] manager ${id} created by super admin ${creatorId}`);

  const mail = await sendCredentialsEmail({
    kind: 'MANAGER',
    to: email,
    accountName: name,
    username: email,
    password,
  });

  return { id, name, username: email, email: { sent: mail.sent, error: mail.error } };
}

/**
 * Enables or disables a manager.
 *
 * Disabling rather than deleting: a manager's past requests reference them
 * through a RESTRICT foreign key, and the record of who proposed what has to
 * survive the person leaving.
 */
export async function setManagerActive(
  id: string,
  isActive: boolean
): Promise<{ id: string; is_active: boolean }> {
  const found = await query(`SELECT id FROM users WHERE id = ? AND role = 'MANAGER'`, [id]);
  if (!found.rows[0]) throw new AppError('Manager not found.', 404);

  await query(`UPDATE users SET is_active = ?, updated_at = NOW() WHERE id = ?`, [isActive, id]);
  logger.info(`[ManagerAccount] manager ${id} ${isActive ? 'enabled' : 'disabled'}`);
  return { id: String(id), is_active: isActive };
}

/**
 * Sets a NEW password for a manager and emails it.
 *
 * There is no "show me the existing password" — it was never stored, only
 * hashed. This is the recovery path when the credentials email did not
 * arrive: the Super Admin chooses a fresh password and it is sent.
 */
export async function resetManagerPassword(
  id: string,
  input: { password?: unknown; confirm_password?: unknown }
): Promise<{ username: string; email: { sent: boolean; error?: string } }> {
  const found = await query<{ id: string; name: string | null; email: string | null }>(
    `SELECT id, name, email FROM users WHERE id = ? AND role = 'MANAGER'`,
    [id]
  );
  const manager = found.rows[0];
  if (!manager) throw new AppError('Manager not found.', 404);
  if (!manager.email) throw new AppError('That manager has no email address on file.', 400);

  const password = validatePassword(input.password, input.confirm_password, 'New password');
  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  await query(`UPDATE users SET password_hash = ?, updated_at = NOW() WHERE id = ?`, [
    passwordHash,
    id,
  ]);

  const mail = await sendCredentialsEmail({
    kind: 'MANAGER',
    to: manager.email,
    accountName: manager.name || 'Manager',
    username: manager.email,
    password,
  });

  logger.info(`[ManagerAccount] password reissued for manager ${id}`);
  return { username: manager.email, email: { sent: mail.sent, error: mail.error } };
}
