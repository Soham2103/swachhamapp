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
import { sendEntryOtp, verifyEntryOtpOnly } from './auth.service';
import { normaliseMobile } from './businessContact.service';

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
  /** Set for a BUSINESS account: the business the number belongs to. */
  businessId?: string;
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
    // A business answers on EVERY number recorded against it -- the business
    // head's and each alternative contact's alike. Since migration 031 they
    // are all rows in `business_users`, so this is one lookup on one table
    // rather than a union of two lists that could disagree.
    //
    // The row the number matches is the CONTACT; the row returned is that
    // business's LOGIN ACCOUNT -- the one carrying a password. That is what
    // makes an alternative contact's number reach the same business
    // dashboard as the head's: both resolve to the same account, and so to
    // the same business_id, rather than the alternative being a second
    // identity.
    //
    // `login_enabled` is checked on the MATCHED row, which is what makes the
    // Super Admin's switch a real restriction rather than a hidden button:
    // the number stops resolving to the business, so it cannot reach the
    // business login at all.
    //
    // `is_active` is deliberately NOT filtered here. A disabled account must
    // still be FOUND, so the password step can answer "this business account
    // is not active"; dropping it from the results instead would make the
    // number look unknown and quietly create a customer account on it.
    //
    // DISTINCT because several of a business's contacts can match at once
    // and they all resolve to the one account.
    query<{
      id: string; name: string | null; email: string;
      business_id: string; business_name: string | null;
    }>(
      `SELECT DISTINCT a.id, a.name, a.email, b.id AS business_id, b.name AS business_name
         FROM business_users c
         JOIN businesses b ON b.id = c.business_id
         JOIN business_users a
           ON a.id = (SELECT x.id FROM business_users x
                       WHERE x.business_id = c.business_id
                         AND x.password_hash IS NOT NULL
                       ORDER BY FIELD(x.contact_type,'PRIMARY','ALTERNATIVE'), x.id
                       LIMIT 1)
        WHERE c.mobile_number = ? AND c.login_enabled = true`,
      [mobile]
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
      // Carried through to the pre-auth token: the password step checks the
      // typed email against THIS, not against the account id, so any of the
      // business's own login accounts is acceptable and no other business's is.
      businessId: String(b.business_id),
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
  /**
   * Present when the proven number turned out to be a BUSINESS contact.
   *
   * It names the business the caller is about to sign in to and the email to
   * sign in WITH -- the primary contact's, which is on that business's own
   * paperwork. Never a password and never a token.
   */
  business?: { id: string; name: string; login_email: string };
  /** Which contact matched, for the "signing in as…" line. */
  contact?: { name: string; designation: string | null; is_primary: boolean };
  message?: string;
}

async function issueSession(row: {
  id: string; name: string | null; email: string | null; mobile: string; role: string;
}) {
  // `mobile` is the number this session was PROVEN on, which for a business
  // is whichever contact signed in -- not necessarily the account's own.
  const payload = {
    id: String(row.id),
    email: row.email || '',
    role: row.role,
    mobile: row.mobile || undefined,
  };
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
  /*
   * IS THIS NUMBER A BUSINESS CONTACT? ASKED FIRST, AND ASKED OF THE DATA.
   *
   * Nobody is asked whether they are a business. A number registered against a
   * business -- as its primary contact or as one of its alternative contacts
   * -- resolves to that business's login, and this is decided here, from the
   * contact rows, after the OTP has proven the number.
   *
   * WHY IT COMES BEFORE THE DOWNWARD RULE BELOW. That rule exists to stop a
   * shared or recycled number silently granting a PRIVILEGED account, and it
   * still does: everything it guards is in the `users` table. Resolving to a
   * business grants nothing on its own -- the caller still has to produce the
   * business's own email and password, and the password step refuses any email
   * belonging to a different business. So a business contact who also happens
   * to hold a customer account is sent to the business they are registered
   * against, which is what they asked for by typing that number.
   */
  const businessTarget = await findBusinessForSignIn(mobile);
  if (businessTarget) {
    return {
      mode: 'PASSWORD_REQUIRED',
      role: 'BUSINESS',
      name: businessTarget.business.name,
      business: businessTarget.business,
      contact: businessTarget.contact,
      preAuthToken: generatePreAuthToken({
        mobile,
        // No account is named: this token authorises a password attempt
        // against ANY login account of this business, and no other business.
        userId: `business:${businessTarget.business.id}`,
        businessId: businessTarget.business.id,
        purpose: 'SUPER_ADMIN_LOGIN',
      }),
    };
  }

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
      // Present only for a business, and it is what the password step
      // enforces. See completeWithPassword.
      businessId: account.businessId,
      purpose: 'SUPER_ADMIN_LOGIN',
    }),
  };
}

/* ===================================================================
 * BUSINESS SIGN-IN  --  the alternative contact's route in
 * ===================================================================
 *
 * A business is reached by ANY of its contacts: the primary one, whose email
 * and password are the credentials, and up to three alternative contacts, who
 * have neither. What an alternative contact has is a REGISTERED PHONE NUMBER,
 * and what proving it earns them is one thing only -- the business it belongs
 * to. They then sign in with the PRIMARY account's email and password, and
 * land on the same dashboard the primary user sees.
 *
 * NO ACCOUNT IS CREATED FOR THEM, ever. There is no second password, no second
 * business_id and no second session shape; the token minted at the end is the
 * ordinary business session, issued to the primary account.
 *
 * WHY THIS IS SEPARATE FROM THE UNIFIED SIGN-IN. Two behaviours differ, and
 * both matter here:
 *
 *   an unrecognised number      the unified flow makes it a CUSTOMER, because
 *                               that is the right answer to "sign in". Asked
 *                               "sign in to my business", the right answer is
 *                               that the number is not a business contact.
 *
 *   a number that is ALSO a
 *   customer                    the unified flow resolves DOWNWARDS and signs
 *                               them in as that customer -- so a contact who
 *                               also orders as a private customer could never
 *                               reach the business at all. Here the caller has
 *                               said which they want, so there is nothing to
 *                               resolve.
 *
 * The OTP mechanism itself is the EXISTING one -- same table, same purpose,
 * same hashing, same expiry, same device binding, same resend cooldown. There
 * is no second OTP system.
 */

export interface BusinessSignInTarget {
  business: { id: string; name: string; login_email: string };
  /** Which contact matched, for the "signing in as…" line. Never a credential. */
  contact: { name: string; designation: string | null; is_primary: boolean };
}

/**
 * The business a contact number belongs to, or a 404.
 *
 * Deliberately says only that the number is not a business contact. It does
 * not confirm or deny that the number exists as any other kind of account,
 * because that is not this endpoint's business to disclose.
 */
async function findBusinessByContactMobile(mobileInput: unknown): Promise<BusinessSignInTarget> {
  const mobile = normaliseMobile(mobileInput);

  const result = await query<{
    contact_name: string; designation: string | null; contact_type: string;
    login_enabled: boolean; business_id: string; business_name: string;
    business_status: string; login_email: string | null;
  }>(
    `SELECT c.name AS contact_name, c.designation, c.contact_type, c.login_enabled,
            b.id AS business_id, b.name AS business_name, b.status AS business_status,
            (SELECT a.email FROM business_users a
              WHERE a.business_id = b.id AND a.is_active = true
                AND a.password_hash IS NOT NULL AND a.email IS NOT NULL
              ORDER BY FIELD(a.contact_type,'PRIMARY','ALTERNATIVE'), a.id
              LIMIT 1) AS login_email
       FROM business_users c
       JOIN businesses b ON b.id = c.business_id
      WHERE c.mobile_number = ?
      ORDER BY FIELD(c.contact_type,'PRIMARY','ALTERNATIVE'), c.id
      LIMIT 1`,
    [mobile]
  );

  const match = result.rows[0];
  if (!match) {
    throw new AppError(
      'That mobile number is not registered as a contact for any business account.',
      404
    );
  }
  if (!match.login_enabled) {
    throw new AppError(
      'This contact is not authorized for business login. Please contact the administrator.',
      403
    );
  }
  if (match.business_status !== 'ACTIVE') {
    throw new AppError(
      'That business account is not active. Please contact the administrator.',
      403
    );
  }
  if (!match.login_email) {
    throw new AppError(
      'That business has no active login account yet. Please contact the administrator.',
      403
    );
  }

  return {
    business: {
      id: String(match.business_id),
      name: match.business_name,
      login_email: match.login_email,
    },
    contact: {
      name: match.contact_name,
      designation: match.designation,
      is_primary: match.contact_type === 'PRIMARY',
    },
  };
}

/**
 * The business a number belongs to, or `null` when it belongs to none.
 *
 * The SOFT form of `findBusinessByContactMobile`, for the unified sign-in,
 * where "this is not a business contact" is the ordinary answer and not an
 * error: most people typing a number into that screen are customers.
 *
 * A contact whose sign-in the Super Admin has switched off, a business that is
 * not ACTIVE, and a business with no login account all come back as `null`
 * too -- none of them is a business this number can reach, so the caller falls
 * through to the customer path rather than being stopped with a message about
 * a business they may know nothing about.
 */
async function findBusinessForSignIn(mobile: string): Promise<BusinessSignInTarget | null> {
  try {
    return await findBusinessByContactMobile(mobile);
  } catch {
    return null;
  }
}

/**
 * Step 1: the number is checked, then the OTP goes out.
 *
 * Checked FIRST, on purpose. An unregistered number gets an error and no
 * message is sent, which is both what the flow asks for and what stops this
 * endpoint being used to send SMS to arbitrary numbers.
 *
 * The OTP is never in the return value. Nothing here can be used to learn it.
 */
async function sendBusinessSignInOtp(
  mobileInput: unknown,
  deviceId?: string
): Promise<{ business_name: string }> {
  const target = await findBusinessByContactMobile(mobileInput);
  const mobile = normaliseMobile(mobileInput);

  // The existing OTP service: same table, same purpose, same expiry and
  // resend cooldown as every other OTP the app sends.
  await sendEntryOtp(mobile, deviceId);

  logger.info(`[UnifiedAuth] business sign-in OTP sent for business ${target.business.id}`);
  return { business_name: target.business.name };
}

/**
 * Step 2: the OTP is verified and the business is identified.
 *
 * NO SESSION IS CREATED HERE. What comes back is a pre-auth token carrying the
 * business id and nothing else -- it is signed with a separate secret, so it
 * is not a bearer token and cannot open any authenticated route. The password
 * step is still required, and it is what checks the credentials.
 *
 * The business is resolved AFTER the OTP passes, so an unverified caller
 * learns nothing about which business a number belongs to.
 */
async function verifyBusinessSignInOtp(
  mobileInput: unknown,
  otp: string,
  deviceId?: string
): Promise<BusinessSignInTarget & { preAuthToken: string }> {
  const mobile = normaliseMobile(mobileInput);

  // Throws on a wrong, expired, already-used or wrong-device OTP. The
  // existing implementation also marks the row verified, so the same code
  // cannot be presented twice.
  await verifyEntryOtpOnly(mobile, otp, deviceId);

  const target = await findBusinessByContactMobile(mobile);

  logger.info(
    `[UnifiedAuth] business sign-in OTP verified for business ${target.business.id}`
  );

  return {
    ...target,
    preAuthToken: generatePreAuthToken({
      mobile,
      // No account is named: this token authorises a password attempt against
      // ANY login account of this business, and against no other business.
      userId: `business:${target.business.id}`,
      businessId: target.business.id,
      purpose: 'SUPER_ADMIN_LOGIN',
    }),
  };
}

/**
 * The password step, for the roles that need one.
 *
 * Three things must agree, not two: the pre-auth token is valid, the username
 * resolves to an account, and that account is the one the OTP was proven
 * against. Without the last check, clearing the OTP on your own number would
 * let you attempt passwords against anyone else's account.
 *
 * WHAT "THE ONE" MEANS DIFFERS BY KIND, and the difference is the point:
 *
 *   staff       the SAME ACCOUNT. A rider's proven number unlocks a password
 *               attempt against that rider's row and nothing else.
 *
 *   business    the SAME BUSINESS. A proven number belongs to a business, not
 *               to an account -- an alternative contact has no account of
 *               their own -- so what is checked is that the typed email's
 *               `business_id` equals the one the OTP resolved to. That is the
 *               rule that stops a contact of business A signing in with
 *               business B's email and password, and it is checked BEFORE the
 *               password is compared, so a wrong-business attempt cannot even
 *               be used to test a password.
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

  if (source === 'business_users' || source === 'business') {
    const result = await query<{
      id: string; name: string; email: string; password_hash: string | null;
      is_active: boolean; status: string; mobile: string | null; business_id: string;
    }>(
      `SELECT bu.id, bu.name, bu.email, bu.password_hash, bu.is_active,
              bu.business_id, b.status, bu.mobile_number AS mobile
         FROM business_users bu
         JOIN businesses b ON b.id = bu.business_id
        WHERE bu.email = ?`,
      [typed]
    );
    const account = result.rows[0];

    // No such email, or an email belonging to a CONTACT rather than an
    // account -- an alternative contact has no password, and there is no
    // password that would let one through.
    if (!account || !account.password_hash) {
      throw new AppError('Invalid username or password', 401);
    }

    /*
     * THE RULE. The email must belong to the business the OTP proved.
     *
     * Checked before bcrypt, so an attempt against the wrong business is
     * refused without revealing whether the password was right.
     *
     * `businessId` is what a business pre-auth token carries. A token minted
     * before this existed carries only the account id, so that is honoured as
     * a fallback -- it is the same check, one account narrower.
     */
    if (preAuth.businessId) {
      if (String(account.business_id) !== String(preAuth.businessId)) {
        logger.warn(
          `[UnifiedAuth] refused: ${typed} is business ${account.business_id}, ` +
          `but the verified number belongs to business ${preAuth.businessId}`
        );
        throw new AppError(
          'That email does not belong to the business this mobile number is registered to.',
          403
        );
      }
    } else if (String(account.id) !== String(expectedId)) {
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
        /*
         * THE NUMBER THAT WAS PROVEN WINS, not the account's own.
         *
         * An alternative contact signs in AS the primary account -- that is
         * the whole design -- so `account.mobile` is the primary contact's
         * number whoever is at the keyboard. `preAuth.mobile` is the number
         * this person actually passed an OTP on, and it is what an order
         * placed in this session is stamped with.
         */
        mobile: preAuth.mobile || account.mobile || '',
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

export {
  resolveAfterOtp,
  completeWithPassword,
  findAccounts,
  findBusinessByContactMobile,
  findBusinessForSignIn,
  sendBusinessSignInOtp,
  verifyBusinessSignInOtp,
  PASSWORD_ROLES,
};
