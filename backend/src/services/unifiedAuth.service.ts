import bcrypt from 'bcrypt';
import { query } from '../config/database';
import { AppError } from '../utils/appError';
import { logger } from '../utils/logger';
import {
  generateAccessToken,
  generateRefreshToken,
  generatePreAuthToken,
  verifyPreAuthToken,
} from '../utils/jwt';

/**
 * ===================================================================
 * ONE SIGN-IN FOR EVERYONE
 * ===================================================================
 *
 * Every account starts the same way: enter a mobile number, prove it
 * with an OTP. What happens next depends on what that number turns out
 * to be, and the SERVER decides that -- the client never announces which
 * kind of user it is.
 *
 *   no account      -> a CUSTOMER is created, straight to home
 *   one customer    -> straight to home
 *   one staff/biz   -> username + password step
 *   several accounts-> refused (see RESOLUTION below)
 *
 * Customers never see a password field; they do not need one, because
 * the OTP is the credential.
 */

/** Roles that must also prove a password. Everything else is a customer. */
const PASSWORD_ROLES = ['ADMIN', 'SUPER_ADMIN', 'MANAGER', 'SORTER', 'RIDER', 'BUSINESS'];

export type SignInMode = 'CUSTOMER_SESSION' | 'PASSWORD_REQUIRED' | 'AMBIGUOUS';

export interface ResolvedAccount {
  /** 'users' or 'business_users' -- they are separate id-spaces. */
  source: 'users' | 'business_users';
  id: string;
  role: string;
  name: string | null;
  /** The value to type as the username, for the password step. */
  username: string | null;
}

/**
 * Every account that answers to this mobile number, across BOTH id
 * spaces. Businesses live in business_users, not users, so a lookup
 * that only read `users` would be blind to every business account.
 */
async function findAccounts(mobile: string): Promise<ResolvedAccount[]> {
  const [users, businesses] = await Promise.all([
    query<{ id: string; role: string; name: string | null; email: string | null }>(
      `SELECT id, role, name, email FROM users WHERE mobile_number = ?`,
      [mobile]
    ),
    // A business answers on every number in business_mobiles, not just
    // the one stored on its account row, so both are searched. DISTINCT
    // because a number can legitimately be in both places for the same
    // account, and that is one account, not two.
    query<{ id: string; name: string | null; email: string; business_name: string | null }>(
      `SELECT DISTINCT bu.id, bu.name, bu.email, b.name AS business_name
         FROM business_users bu
         JOIN businesses b ON b.id = bu.business_id
         LEFT JOIN business_mobiles bm ON bm.business_id = b.id
        WHERE bu.mobile_number = ? OR bm.mobile_number = ?`,
      [mobile, mobile]
    ),
  ]);

  return [
    ...users.rows.map((u) => ({
      source: 'users' as const,
      id: String(u.id),
      role: u.role,
      name: u.name,
      username: u.email,
    })),
    ...businesses.rows.map((b) => ({
      source: 'business_users' as const,
      id: String(b.id),
      role: 'BUSINESS',
      name: b.business_name || b.name,
      username: b.email,
    })),
  ];
}

export interface SignInResult {
  mode: SignInMode;
  /** Present only for CUSTOMER_SESSION -- the caller is logged in. */
  user?: Record<string, unknown>;
  accessToken?: string;
  refreshToken?: string;
  /** Present only for PASSWORD_REQUIRED. */
  role?: string;
  name?: string | null;
  preAuthToken?: string;
  message?: string;
}

async function issueSession(row: {
  id: string; name: string | null; email: string | null; mobile: string; role: string;
}) {
  const payload = { id: String(row.id), email: row.email || '', role: row.role };
  return {
    user: {
      id: String(row.id),
      name: row.name,
      email: row.email,
      mobile: row.mobile,
      role: row.role,
    },
    accessToken: generateAccessToken(payload),
    refreshToken: generateRefreshToken(payload),
  };
}

/**
 * RESOLUTION -- what a proven mobile number entitles you to.
 *
 * The rule is that ambiguity always resolves DOWNWARDS. A number that
 * answers to more than one account never grants the privileged one,
 * because picking a winner among them would mean a shared or recycled
 * number could silently hand somebody an admin session. Escalation
 * requires a number that means exactly one thing; until the duplicates
 * are cleaned up, the privileged account stays out of reach.
 *
 * The number is only ever trusted AFTER the OTP has been verified by
 * the caller, so nothing here can be probed without the code.
 */
async function resolveAfterOtp(mobile: string): Promise<SignInResult> {
  const accounts = await findAccounts(mobile);

  // -- Nobody yet: this is a new customer. The OTP just proved the
  //    number, which is the whole of what a customer account needs.
  if (accounts.length === 0) {
    const inserted = await query(
      `INSERT INTO users (mobile_number, role, is_active, mobile_verified)
       VALUES (?, 'CUSTOMER', true, true)`,
      [mobile]
    );
    const id = String(inserted.insertId);
    await query(`INSERT IGNORE INTO carts (user_id) VALUES (?)`, [id]);
    logger.info(`[UnifiedAuth] New customer ${id} created from mobile sign-in`);

    return {
      mode: 'CUSTOMER_SESSION',
      ...(await issueSession({ id, name: null, email: null, mobile, role: 'CUSTOMER' })),
    };
  }

  // -- Several accounts answer to this number. Resolve downwards.
  if (accounts.length > 1) {
    const customer = accounts.find((a) => a.source === 'users' && a.role === 'CUSTOMER');
    if (customer) {
      const row = await query<{ id: string; name: string | null; email: string | null }>(
        `SELECT id, name, email FROM users WHERE id = ?`,
        [customer.id]
      );
      logger.warn(
        `[UnifiedAuth] Mobile ${mobile} matches ${accounts.length} accounts; signed in as customer only`
      );
      return {
        mode: 'CUSTOMER_SESSION',
        ...(await issueSession({
          id: customer.id,
          name: row.rows[0]?.name ?? null,
          email: row.rows[0]?.email ?? null,
          mobile,
          role: 'CUSTOMER',
        })),
      };
    }

    // No customer account to fall back to, and we will not invent a
    // customer session on a row that says something else.
    logger.warn(`[UnifiedAuth] Mobile ${mobile} matches ${accounts.length} accounts, none of them a customer`);
    return {
      mode: 'AMBIGUOUS',
      message:
        'This mobile number is linked to more than one account, so it cannot be used to sign in. Please contact support to have the duplicates removed.',
    };
  }

  // -- Exactly one account.
  const account = accounts[0];

  if (!PASSWORD_ROLES.includes(account.role)) {
    const row = await query<{ id: string; name: string | null; email: string | null; is_active: boolean }>(
      `SELECT id, name, email, is_active FROM users WHERE id = ?`,
      [account.id]
    );
    if (!row.rows[0]?.is_active) {
      throw new AppError('This account is inactive. Please contact support.', 403);
    }
    return {
      mode: 'CUSTOMER_SESSION',
      ...(await issueSession({
        id: account.id,
        name: row.rows[0].name,
        email: row.rows[0].email,
        mobile,
        role: account.role,
      })),
    };
  }

  // Staff or business: the number is proven, the password is not.
  return {
    mode: 'PASSWORD_REQUIRED',
    role: account.role,
    name: account.name,
    preAuthToken: generatePreAuthToken({
      mobile,
      userId: `${account.source}:${account.id}`,
      purpose: 'SUPER_ADMIN_LOGIN',
    }),
  };
}

/**
 * The password step, for the roles that need one.
 *
 * Three things must agree, not two: the pre-auth token is valid, the
 * username resolves to an account, and that account is the SAME one the
 * OTP was proven against. Without the last check, clearing the OTP on
 * your own number would let you attempt passwords against anyone else's
 * staff account.
 */
async function completeWithPassword(
  username: string,
  password: string,
  preAuthToken: string
): Promise<SignInResult> {
  const preAuth = (() => {
    try {
      return verifyPreAuthToken(preAuthToken);
    } catch (error) {
      throw new AppError((error as Error).message, 401);
    }
  })();

  const [source, expectedId] = String(preAuth.userId).split(':');
  const typed = String(username || '').trim().toLowerCase();

  if (source === 'business_users') {
    const result = await query<{
      id: string; name: string; email: string; password_hash: string;
      is_active: boolean; status: string; mobile: string | null;
    }>(
      `SELECT bu.id, bu.name, bu.email, bu.password_hash, bu.is_active,
              b.status, COALESCE(bu.mobile_number, b.mobile_number) AS mobile
         FROM business_users bu
         JOIN businesses b ON b.id = bu.business_id
        WHERE bu.email = ?`,
      [typed]
    );
    const account = result.rows[0];
    if (!account || !account.password_hash) {
      throw new AppError('Invalid username or password', 401);
    }
    if (String(account.id) !== String(expectedId)) {
      throw new AppError('This account does not match the verified mobile number', 401);
    }
    if (!(await bcrypt.compare(password, account.password_hash))) {
      throw new AppError('Invalid username or password', 401);
    }
    if (account.status === 'PENDING') {
      throw new AppError('Your business registration is awaiting approval.', 403);
    }
    if (!account.is_active || account.status !== 'ACTIVE') {
      throw new AppError('This business account is not active.', 403);
    }

    await query(`UPDATE business_users SET last_login_at = NOW() WHERE id = ?`, [account.id]);
    logger.info(`[UnifiedAuth] Business ${account.id} signed in`);
    return {
      mode: 'CUSTOMER_SESSION',
      ...(await issueSession({
        id: String(account.id),
        name: account.name,
        email: account.email,
        mobile: account.mobile || preAuth.mobile,
        role: 'BUSINESS',
      })),
    };
  }

  const result = await query<{
    id: string; name: string | null; email: string | null; password_hash: string;
    role: string; is_active: boolean; mobile_number: string;
  }>(
    `SELECT id, name, email, password_hash, role, is_active, mobile_number
       FROM users WHERE email = ?`,
    [typed]
  );
  const account = result.rows[0];
  if (!account || !account.password_hash) {
    throw new AppError('Invalid username or password', 401);
  }
  if (String(account.id) !== String(expectedId)) {
    throw new AppError('This account does not match the verified mobile number', 401);
  }
  if (!(await bcrypt.compare(password, account.password_hash))) {
    throw new AppError('Invalid username or password', 401);
  }
  if (!account.is_active) {
    throw new AppError('This account is inactive. Please contact support.', 403);
  }

  await query(`UPDATE users SET last_login_at = NOW() WHERE id = ?`, [account.id]);
  logger.info(`[UnifiedAuth] ${account.role} ${account.id} signed in`);
  return {
    mode: 'CUSTOMER_SESSION',
    ...(await issueSession({
      id: String(account.id),
      name: account.name,
      email: account.email,
      mobile: account.mobile_number,
      role: account.role,
    })),
  };
}

export { resolveAfterOtp, completeWithPassword, findAccounts, PASSWORD_ROLES };
