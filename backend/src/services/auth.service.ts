import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { query } from '../config/database';
import {
  generateAccessToken,
  generateRefreshToken,
  generatePreAuthToken,
  verifyPreAuthToken,
} from '../utils/jwt';
import { logger } from '../utils/logger';
import { smsService } from './sms.service';
import { AppError } from '../utils/appError';

const SALT_ROUNDS = 10;
const OTP_EXPIRY_MINUTES = 5;
const RESEND_COOLDOWN_SECONDS = 60;
const MAX_VERIFICATION_ATTEMPTS = 5;

export interface UserProfile {
  id: string;
  name: string;
  email: string;
  mobile: string;
  role: string;
  profile_image?: string;
  is_active: boolean;
  mobile_verified?: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface AuthResult {
  user: UserProfile;
  accessToken: string;
  refreshToken: string;
}

function normalizeMobile(mobile: string): string {
  let normalized = mobile.replace(/\s+/g, '').replace(/-/g, '');
  if (normalized.startsWith('+91')) {
    normalized = normalized.substring(3);
  } else if (normalized.startsWith('91') && normalized.length === 12) {
    normalized = normalized.substring(2);
  } else if (normalized.startsWith('0') && normalized.length === 11) {
    normalized = normalized.substring(1);
  }
  return normalized;
}

/**
 * Device identifiers are only ever compared, never read back, so the table
 * stores a hash rather than the raw value.
 */
function hashDeviceId(deviceId: string): string {
  return crypto.createHash('sha256').update(deviceId.trim()).digest('hex');
}

function generateNumericOtp(length = 6): string {
  const min = Math.pow(10, length - 1);
  const max = Math.pow(10, length) - 1;
  return crypto.randomInt(min, max + 1).toString();
}

async function sendOtpInternal(mobile: string, purpose: 'REGISTRATION' | 'PASSWORD_RESET' | 'LOGIN_VERIFICATION', deviceId?: string): Promise<void> {
  const normalizedMobile = normalizeMobile(mobile);
  
  const recentOtpResult = await query<{ created_at: Date }>(
    `SELECT created_at FROM otp_verifications WHERE mobile_number = ? AND purpose = ? AND is_verified = false ORDER BY created_at DESC LIMIT 1`,
    [normalizedMobile, purpose]
  );
  
  if (recentOtpResult.rows.length > 0) {
    const secondsSinceLastOtp = (Date.now() - recentOtpResult.rows[0].created_at.getTime()) / 1000;
    if (secondsSinceLastOtp < RESEND_COOLDOWN_SECONDS) {
      throw new AppError(`Please wait ${Math.ceil(RESEND_COOLDOWN_SECONDS - secondsSinceLastOtp)} seconds before requesting a new OTP`, 429);
    }
  }

  const otp = generateNumericOtp(6);
  const otpHash = await bcrypt.hash(otp, SALT_ROUNDS);
  const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60000);

  await query(
    `UPDATE otp_verifications SET is_verified = true WHERE mobile_number = ? AND purpose = ? AND is_verified = false`,
    [normalizedMobile, purpose]
  );

  await query(
    `INSERT INTO otp_verifications (mobile_number, otp_hash, expires_at, purpose, device_id_hash) VALUES (?, ?, ?, ?, ?)`,
    [normalizedMobile, otpHash, expiresAt, purpose, deviceId ? hashDeviceId(deviceId) : null]
  );

  await smsService.sendOtpSms(normalizedMobile, otp);
}

async function verifyOtpInternal(mobile: string, otp: string, purpose: 'REGISTRATION' | 'PASSWORD_RESET' | 'LOGIN_VERIFICATION', deviceId?: string): Promise<void> {
  const normalizedMobile = normalizeMobile(mobile);

  const otpResult = await query<{ id: string; otp_hash: string; expires_at: Date; attempts: number; device_id_hash: string | null }>(
    `SELECT id, otp_hash, expires_at, attempts, device_id_hash FROM otp_verifications 
     WHERE mobile_number = ? AND purpose = ? AND is_verified = false 
     ORDER BY created_at DESC LIMIT 1`,
    [normalizedMobile, purpose]
  );

  const otpRecord = otpResult.rows[0];
  if (!otpRecord) {
    throw new AppError('No pending OTP verification found for this mobile number', 400);
  }

  if (otpRecord.attempts >= MAX_VERIFICATION_ATTEMPTS) {
    await query(`UPDATE otp_verifications SET is_verified = true WHERE id = ?`, [otpRecord.id]);
    throw new AppError('Maximum verification attempts exceeded. Please request a new OTP.', 429);
  }

  await query(`UPDATE otp_verifications SET attempts = attempts + 1 WHERE id = ?`, [otpRecord.id]);

  if (new Date() > otpRecord.expires_at) {
    throw new AppError('OTP has expired. Please request a new OTP.', 400);
  }

  // Device binding. Checked before the code itself is compared, so a request
  // from the wrong handset never learns whether the code it holds is correct.
  //
  // Rows written before this column existed carry a NULL hash and are left
  // alone; only OTPs issued to a known device are enforced.
  if (otpRecord.device_id_hash) {
    if (!deviceId || hashDeviceId(deviceId) !== otpRecord.device_id_hash) {
      logger.warn(`[OTP] device mismatch on verify for ${normalizedMobile} (${purpose})`);
      throw new AppError(
        'This OTP was sent to a different device. Please request a new OTP on this device.',
        403
      );
    }
  }

  const isValid = await bcrypt.compare(otp, otpRecord.otp_hash);
  if (!isValid) {
    throw new AppError('Invalid OTP', 400);
  }

  await query(`UPDATE otp_verifications SET is_verified = true, verified_at = NOW() WHERE id = ?`, [otpRecord.id]);
}


// --- New Flows ---

export async function register(
  name: string,
  email: string,
  mobile: string,
  password: string
): Promise<void> {
  logger.debug(`[AuthService] Registering user: ${email}`);
  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  const normalizedMobile = normalizeMobile(mobile);

  await query(
    `INSERT INTO users (name, email, mobile_number, password_hash, role, is_active, mobile_verified)
     VALUES (?, ?, ?, ?, 'CUSTOMER', true, true)`,
    [name, email.toLowerCase(), normalizedMobile, passwordHash]
  );
  
  logger.info(`[AuthService] User registered: ${email}`);
}

export async function customerLogin(email: string, password: string): Promise<AuthResult> {
  logger.debug(`[AuthService] Customer login attempt for: ${email}`);
  const userResult = await query<UserProfile & { password_hash: string }>(
    `SELECT id, name, email, mobile_number as mobile, role, profile_image, is_active, mobile_verified, password_hash, created_at, updated_at
     FROM users WHERE email = ? AND role = 'CUSTOMER'`,
    [email.toLowerCase()]
  );
  const user = userResult.rows[0];
  
  if (!user || !user.password_hash) {
    throw new AppError('Invalid email or password', 401);
  }
  if (!user.is_active) {
    throw new AppError('Account is inactive', 403);
  }
  if (!user.mobile_verified) {
    throw new AppError('Mobile number not verified', 403);
  }

  const passwordMatch = await bcrypt.compare(password, user.password_hash);
  if (!passwordMatch) {
    throw new AppError('Invalid email or password', 401);
  }

  await query(`UPDATE users SET last_login_at = NOW() WHERE id = ?`, [user.id]);
  const tokenPayload = { id: user.id.toString(), email: user.email, role: user.role };
  const accessToken = generateAccessToken(tokenPayload);
  const refreshToken = generateRefreshToken(tokenPayload);

  const { password_hash, ...userWithoutPassword } = user;
  return { user: userWithoutPassword as UserProfile, accessToken, refreshToken };
}

export async function businessLogin(email: string, password: string): Promise<AuthResult> {
  logger.debug(`[AuthService] Business login attempt for: ${email}`);
  const userResult = await query<UserProfile & { password_hash: string; business_id: string }>(
    `SELECT bu.id, bu.name, bu.email, bu.password_hash, bu.is_active, bu.created_at, bu.updated_at,
            COALESCE(bu.mobile_number, b.mobile_number) AS mobile,
            b.status as business_status
     FROM business_users bu
     JOIN businesses b ON bu.business_id = b.id
     WHERE bu.email = ?`,
    [email.toLowerCase()]
  );
  const user = userResult.rows[0];
  
  if (!user || !user.password_hash) {
    throw new AppError('Invalid email or password', 401);
  }
  const businessStatus = (user as any).business_status;
  // A pending applicant is not the same thing as a disabled account, and
  // saying so saves a support call.
  if (businessStatus === 'PENDING') {
    throw new AppError('Your business registration is awaiting approval. You will be notified once it is reviewed.', 403);
  }
  if (businessStatus === 'REJECTED') {
    throw new AppError('Your business registration was not approved. Please contact support.', 403);
  }
  if (!user.is_active || businessStatus !== 'ACTIVE') {
    throw new AppError('Account or business is inactive', 403);
  }

  const passwordMatch = await bcrypt.compare(password, user.password_hash);
  if (!passwordMatch) {
    throw new AppError('Invalid email or password', 401);
  }

  await query(`UPDATE business_users SET last_login_at = NOW() WHERE id = ?`, [user.id]);
  const tokenPayload = { id: user.id.toString(), email: user.email, role: 'BUSINESS' };
  const accessToken = generateAccessToken(tokenPayload);
  const refreshToken = generateRefreshToken(tokenPayload);

  const { password_hash, ...userWithoutPassword } = user;
  userWithoutPassword.role = 'BUSINESS';
  // Mobile comes from the registered Business account record, never the device.
  userWithoutPassword.mobile = user.mobile || '';

  return { user: userWithoutPassword as UserProfile, accessToken, refreshToken };
}

/**
 * Sorter login.
 *
 * Staff sign in with a username rather than an email address; the existing
 * `users` table has no separate username column, so the username IS the value
 * stored in `users.email` for that account. Everything else — bcrypt, the JWT
 * helpers, the role claim — is the same machinery the customer login uses, so
 * there is no second authentication system to keep in step.
 *
 * The role is pinned in the query: an account that is not a SORTER can never
 * obtain a sorter token through this endpoint.
 */
export async function sorterLogin(username: string, password: string): Promise<AuthResult> {
  logger.debug('[AuthService] Sorter login attempt');

  const userResult = await query<UserProfile & { password_hash: string }>(
    `SELECT id, name, email, mobile_number as mobile, role, profile_image,
            is_active, password_hash, created_at, updated_at
       FROM users WHERE email = ? AND role = 'SORTER'`,
    [String(username || '').trim().toLowerCase()]
  );
  const user = userResult.rows[0];

  // One message for both branches, so the response cannot be used to find out
  // which usernames exist.
  if (!user || !user.password_hash) {
    throw new AppError('Invalid username or password', 401);
  }
  if (!user.is_active) {
    throw new AppError('Account is inactive', 403);
  }

  const passwordMatch = await bcrypt.compare(password, user.password_hash);
  if (!passwordMatch) {
    throw new AppError('Invalid username or password', 401);
  }

  await query(`UPDATE users SET last_login_at = NOW() WHERE id = ?`, [user.id]);

  const tokenPayload = { id: user.id.toString(), email: user.email, role: 'SORTER' };
  const accessToken = generateAccessToken(tokenPayload);
  const refreshToken = generateRefreshToken(tokenPayload);

  // The hash never leaves this function.
  const { password_hash, ...userWithoutPassword } = user;
  return { user: userWithoutPassword as UserProfile, accessToken, refreshToken };
}

/**
 * Admin sign-in.
 *
 * `users` holds CUSTOMER, ADMIN and SUPER_ADMIN rows in the same table, and
 * customerLogin deliberately filters `role = 'CUSTOMER'` — so without this an
 * admin row can authenticate nowhere. Both admin tiers sign in here; the token
 * carries whichever role the row actually has, and the route guards decide what
 * that role may reach. The filter is applied in SQL rather than checked after
 * the fetch, so a customer can never obtain an admin token from this endpoint.
 *
 * Unlike customerLogin there is no mobile_verified gate: admins are created
 * directly against the database and never pass through the mobile OTP flow.
 */
export async function adminLogin(email: string, password: string): Promise<AuthResult> {
  logger.debug(`[AuthService] Admin login attempt for: ${email}`);
  const userResult = await query<UserProfile & { password_hash: string }>(
    `SELECT id, name, email, mobile_number as mobile, role, profile_image, is_active,
            mobile_verified, password_hash, created_at, updated_at
     FROM users WHERE email = ? AND role IN ('ADMIN', 'SUPER_ADMIN')`,
    [email.toLowerCase()]
  );
  const user = userResult.rows[0];

  // Same opaque message for "no such admin" and "wrong password", so this
  // endpoint cannot be used to enumerate which emails are admins.
  if (!user || !user.password_hash) {
    throw new AppError('Invalid email or password', 401);
  }
  if (!user.is_active) {
    throw new AppError('Account is inactive', 403);
  }

  const passwordMatch = await bcrypt.compare(password, user.password_hash);
  if (!passwordMatch) {
    throw new AppError('Invalid email or password', 401);
  }

  await query(`UPDATE users SET last_login_at = NOW() WHERE id = ?`, [user.id]);
  const tokenPayload = { id: user.id.toString(), email: user.email, role: user.role };
  const accessToken = generateAccessToken(tokenPayload);
  const refreshToken = generateRefreshToken(tokenPayload);

  const { password_hash, ...userWithoutPassword } = user;
  return { user: userWithoutPassword as UserProfile, accessToken, refreshToken };
}

/**
 * ===================================================================
 * SUPER ADMIN SIGN-IN — step 1 of 2: mobile OTP
 * ===================================================================
 *
 * Sending the OTP says nothing about whether the number belongs to a
 * super admin. Refusing to send for an unknown number would turn this
 * endpoint into an oracle for "which mobile numbers are super admins",
 * so an OTP goes out either way and the role is only revealed after
 * the code is actually proven.
 */
export async function superAdminSendOtp(mobile: string): Promise<void> {
  await sendOtpInternal(normalizeMobile(mobile), 'LOGIN_VERIFICATION');
}

export interface SuperAdminOtpResult {
  /** Whether step 2 (username + password) applies to this number. */
  isSuperAdmin: boolean;
  /** Only issued for a super admin; required by superAdminLogin. */
  preAuthToken: string | null;
  name: string | null;
}

/**
 * Step 1 verification. The OTP is checked first and the role is read
 * only afterwards, so the answer cannot be obtained without the code.
 *
 * A super admin gets a short-lived pre-auth token; anyone else gets a
 * truthful `isSuperAdmin: false` and no token, and the client sends
 * them down the ordinary sign-in path.
 */
export async function superAdminVerifyOtp(
  mobile: string,
  otp: string
): Promise<SuperAdminOtpResult> {
  const normalizedMobile = normalizeMobile(mobile);
  await verifyOtpInternal(normalizedMobile, otp, 'LOGIN_VERIFICATION');

  const result = await query<{ id: string; name: string; role: string; is_active: boolean }>(
    `SELECT id, name, role, is_active FROM users WHERE mobile_number = ?`,
    [normalizedMobile]
  );
  const user = result.rows[0];

  if (!user || user.role !== 'SUPER_ADMIN') {
    return { isSuperAdmin: false, preAuthToken: null, name: null };
  }
  if (!user.is_active) {
    throw new AppError('Account is inactive', 403);
  }

  logger.info(`[AuthService] Super admin OTP verified for user ${user.id}`);
  return {
    isSuperAdmin: true,
    preAuthToken: generatePreAuthToken({
      mobile: normalizedMobile,
      userId: String(user.id),
      purpose: 'SUPER_ADMIN_LOGIN',
    }),
    name: user.name,
  };
}

/**
 * ===================================================================
 * SUPER ADMIN SIGN-IN — step 2 of 2: username + password
 * ===================================================================
 *
 * The username is the value stored in `users.email`, matching how
 * sorterLogin already treats staff usernames — one convention for
 * staff accounts rather than two.
 *
 * Three things must line up, not two: the pre-auth token has to be
 * valid, the username has to resolve to a SUPER_ADMIN, and that row
 * has to be the SAME id the OTP was proven against. Without the last
 * check, passing step 1 on your own number would let you attempt
 * passwords against somebody else's admin account.
 */
export async function superAdminLogin(
  username: string,
  password: string,
  preAuthToken: string
): Promise<AuthResult> {
  const preAuth = (() => {
    try {
      return verifyPreAuthToken(preAuthToken);
    } catch (error) {
      throw new AppError((error as Error).message, 401);
    }
  })();

  const userResult = await query<UserProfile & { password_hash: string }>(
    `SELECT id, name, email, mobile_number as mobile, role, profile_image, is_active,
            mobile_verified, password_hash, created_at, updated_at
     FROM users WHERE email = ? AND role = 'SUPER_ADMIN'`,
    [String(username || '').trim().toLowerCase()]
  );
  const user = userResult.rows[0];

  if (!user || !user.password_hash) {
    throw new AppError('Invalid username or password', 401);
  }
  if (String(user.id) !== String(preAuth.userId)) {
    throw new AppError('This account does not match the verified mobile number', 401);
  }
  if (!user.is_active) {
    throw new AppError('Account is inactive', 403);
  }

  const passwordMatch = await bcrypt.compare(password, user.password_hash);
  if (!passwordMatch) {
    throw new AppError('Invalid username or password', 401);
  }

  await query(`UPDATE users SET last_login_at = NOW() WHERE id = ?`, [user.id]);
  const tokenPayload = { id: user.id.toString(), email: user.email, role: user.role };
  const accessToken = generateAccessToken(tokenPayload);
  const refreshToken = generateRefreshToken(tokenPayload);

  logger.info(`[AuthService] Super admin logged in: ${user.id}`);
  const { password_hash, ...userWithoutPassword } = user;
  return { user: userWithoutPassword as UserProfile, accessToken, refreshToken };
}

export async function verifyMobileOtp(mobile: string, otp: string): Promise<AuthResult> {
  const normalizedMobile = normalizeMobile(mobile);
  await verifyOtpInternal(normalizedMobile, otp, 'REGISTRATION');
  
  await query(`UPDATE users SET mobile_verified = true WHERE mobile_number = ?`, [normalizedMobile]);
  
  const userResult = await query<UserProfile>(
    `SELECT id, name, email, mobile_number as mobile, role, profile_image, is_active, mobile_verified, created_at, updated_at
     FROM users WHERE mobile_number = ?`,
    [normalizedMobile]
  );
  const user = userResult.rows[0];
  
  await query(`INSERT IGNORE INTO carts (user_id) VALUES (?)`, [user.id]);
  
  const tokenPayload = { id: user.id.toString(), email: user.email, role: user.role };
  const accessToken = generateAccessToken(tokenPayload);
  const refreshToken = generateRefreshToken(tokenPayload);

  return { user, accessToken, refreshToken };
}

export async function sendRegistrationOtp(mobile: string): Promise<void> {
  await sendOtpInternal(normalizeMobile(mobile), 'REGISTRATION');
}

export async function sendPasswordResetOtp(email: string): Promise<void> {
  const userResult = await query<{ id: string; mobile_number: string }>(
    `SELECT id, mobile_number FROM users WHERE email = ? AND role = 'CUSTOMER'`,
    [email.toLowerCase()]
  );
  if (userResult.rows.length === 0) {
    // For security, don't indicate if the user exists or not, but here we can throw or just return
    throw new AppError('No customer account found with this email address', 404);
  }
  const normalizedMobile = normalizeMobile(userResult.rows[0].mobile_number);
  await sendOtpInternal(normalizedMobile, 'PASSWORD_RESET');
}

export async function verifyPasswordResetOtp(mobile: string, otp: string): Promise<void> {
  await verifyOtpInternal(normalizeMobile(mobile), otp, 'PASSWORD_RESET');
}

export async function resetPassword(mobile: string, otp: string, newPassword: string): Promise<void> {
  const normalizedMobile = normalizeMobile(mobile);
  // Verify OTP again just in case (or ensure it was recently verified)
  // To be perfectly secure, we should mark the OTP as used when resetting password.
  // Using verifyOtpInternal will fail if it's already verified. We need a way to check if it WAS verified.
  
  const otpResult = await query<{ id: string; is_verified: boolean; verified_at: Date }>(
    `SELECT id, is_verified, verified_at FROM otp_verifications 
     WHERE mobile_number = ? AND purpose = 'PASSWORD_RESET' 
     ORDER BY created_at DESC LIMIT 1`,
    [normalizedMobile]
  );
  const otpRecord = otpResult.rows[0];
  
  if (!otpRecord || !otpRecord.is_verified) {
    // If not verified yet, verify it now
    await verifyOtpInternal(normalizedMobile, otp, 'PASSWORD_RESET');
  } else {
    // If already verified, ensure it was verified recently (within last 15 mins)
    const minutesSinceVerify = (Date.now() - otpRecord.verified_at.getTime()) / 60000;
    if (minutesSinceVerify > 15) {
      throw new AppError('Password reset session expired. Please request a new OTP.', 400);
    }
  }

  const newPasswordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
  await query(
    `UPDATE users SET password_hash = ?, updated_at = NOW() WHERE mobile_number = ? AND role = 'CUSTOMER'`,
    [newPasswordHash, normalizedMobile]
  );
  
  // Invalidate the OTP so it can't be used again
  if (otpRecord) {
     await query(`UPDATE otp_verifications SET expires_at = NOW() WHERE id = ?`, [otpRecord.id]);
  }
}

// --- Old Flows / Profile Management ---

/**
 * `users` and `business_users` are separate id spaces, so the same numeric id
 * can exist in both tables. The role carried by the access token decides which
 * table to read — resolving by id alone returns whichever table is checked
 * first and can hand back a completely different account.
 */
export async function getMe(userId: string, role?: string): Promise<UserProfile> {
  const businessLookup = () =>
    query<UserProfile>(
      `SELECT bu.id, bu.name, bu.email,
              COALESCE(bu.mobile_number, b.mobile_number, '') AS mobile,
              'BUSINESS' as role, bu.is_active, bu.created_at, bu.updated_at
       FROM business_users bu
       JOIN businesses b ON b.id = bu.business_id
       WHERE bu.id = ? AND bu.is_active = true`,
      [userId]
    );

  const customerLookup = () =>
    query<UserProfile>(
      `SELECT id, name, email, mobile_number as mobile, role, profile_image, is_active, mobile_verified, created_at, updated_at
       FROM users
       WHERE id = ? AND is_active = true`,
      [userId]
    );

  const isBusiness = String(role || '').toUpperCase() === 'BUSINESS';
  let user = (isBusiness ? await businessLookup() : await customerLookup()).rows[0];

  // Fall back to the other table only when the caller gave no role.
  if (!user && !role) {
    user = (await businessLookup()).rows[0];
  }

  if (!user) {
    throw new AppError('User not found', 404);
  }
  return user;
}

export interface UpdateProfileData {
  name?: string;
  mobile?: string;
  profile_image?: string;
}

export async function updateProfile(
  userId: string,
  data: UpdateProfileData
): Promise<UserProfile> {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (data.name !== undefined) {
    fields.push(`name = ?`);
    values.push(data.name);
  }
  if (data.mobile !== undefined) {
    fields.push(`mobile_number = ?`);
    values.push(normalizeMobile(data.mobile));
  }
  if (data.profile_image !== undefined) {
    fields.push(`profile_image = ?`);
    values.push(data.profile_image);
  }

  if (fields.length === 0) {
    return getMe(userId, 'CUSTOMER');
  }

  fields.push(`updated_at = NOW()`);
  values.push(userId);

  await query(
    `UPDATE users SET ${fields.join(', ')} WHERE id = ? AND is_active = true`,
    values
  );

  return getMe(userId, 'CUSTOMER');
}

export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string
): Promise<void> {
  let result = await query<{ password_hash: string }>(
    `SELECT password_hash FROM users WHERE id = ? AND is_active = true`,
    [userId]
  );
  let isBusiness = false;
  
  if (result.rows.length === 0) {
    result = await query<{ password_hash: string }>(
      `SELECT password_hash FROM business_users WHERE id = ? AND is_active = true`,
      [userId]
    );
    isBusiness = true;
  }

  const user = result.rows[0];
  if (!user || !user.password_hash) {
    throw new AppError('User not found or password not set', 404);
  }

  const passwordMatch = await bcrypt.compare(currentPassword, user.password_hash);
  if (!passwordMatch) {
    throw new AppError('Current password is incorrect', 401);
  }

  const newPasswordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);

  if (isBusiness) {
    await query(`UPDATE business_users SET password_hash = ?, updated_at = NOW() WHERE id = ?`, [newPasswordHash, userId]);
  } else {
    await query(`UPDATE users SET password_hash = ?, updated_at = NOW() WHERE id = ?`, [newPasswordHash, userId]);
  }
}

export async function sendEntryOtp(mobile: string, deviceId?: string): Promise<void> {
  await sendOtpInternal(normalizeMobile(mobile), 'LOGIN_VERIFICATION', deviceId);
}

/**
 * Verifies an entry OTP and hands back the NORMALISED number.
 *
 * The unified sign-in needs the same normalisation the OTP was stored
 * under, otherwise the account lookup that follows could miss a number
 * that was typed as +91XXXXXXXXXX.
 *
 * `deviceId` is forwarded so an OTP issued to one handset still cannot be
 * completed on another: the unified sign-in is bound to a device exactly
 * like the older entry-OTP path.
 */
export async function verifyEntryOtpOnly(
  mobile: string,
  otp: string,
  deviceId?: string
): Promise<string> {
  const normalized = normalizeMobile(mobile);
  await verifyOtpInternal(normalized, otp, 'LOGIN_VERIFICATION', deviceId);
  return normalized;
}

export async function verifyEntryOtp(mobile: string, otp: string, deviceId?: string): Promise<void> {
  await verifyOtpInternal(normalizeMobile(mobile), otp, 'LOGIN_VERIFICATION', deviceId);
}

export async function resendEntryOtp(mobile: string, deviceId?: string): Promise<void> {
  await sendOtpInternal(normalizeMobile(mobile), 'LOGIN_VERIFICATION', deviceId);
}

export async function businessRegister(data: {
  customerType: string;
  otherTypeSpecify?: string;
  establishmentName: string;
  establishmentAddress: string;
  gstNumber?: string;
  panNumber?: string;
  website?: string;
  contactPersonName: string;
  designation?: string;
  mobileNumber: string;
  whatsappNumber?: string;
  emailId: string;
  alternateContactPerson?: string;
  alternateMobileNo?: string;
  password: string;
}): Promise<AuthResult> {
  logger.debug(`[AuthService] Registering business: ${data.emailId}`);

  // Check email in business_users
  const userCheck = await query(`SELECT id FROM business_users WHERE email = ?`, [data.emailId.toLowerCase()]);
  if (userCheck.rows.length > 0) {
    throw new AppError('Email already registered for a business', 409);
  }

  // Check GST
  if (data.gstNumber) {
    const gstCheck = await query(`SELECT id FROM businesses WHERE gst_number = ?`, [data.gstNumber]);
    if (gstCheck.rows.length > 0) {
      throw new AppError('GST number already registered', 409);
    }
  }

  // Check PAN
  if (data.panNumber) {
    const panCheck = await query(`SELECT id FROM businesses WHERE pan_number = ?`, [data.panNumber]);
    if (panCheck.rows.length > 0) {
      throw new AppError('PAN number already registered', 409);
    }
  }

  const passwordHash = await bcrypt.hash(data.password, SALT_ROUNDS);

  // Insert business
  const businessInsert = await query(
    `INSERT INTO businesses (
      name, business_type, other_type_specify, address, gst_number, pan_number, website,
      contact_person_name, designation, mobile_number, whatsapp_number,
      alternate_contact_person, alternate_mobile_no, status
     -- Signups now wait for a super admin decision instead of going
     -- live on submit; the approval queue is what makes them ACTIVE.
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING')`,
    [
      data.establishmentName, data.customerType, data.otherTypeSpecify || null, data.establishmentAddress,
      data.gstNumber || null, data.panNumber || null, data.website || null,
      data.contactPersonName, data.designation || null, data.mobileNumber,
      data.whatsappNumber || null, data.alternateContactPerson || null, data.alternateMobileNo || null
    ]
  );

  const businessId = businessInsert.insertId;

  // Insert business user. The registration mobile number is stored on the
  // account row too, so the authenticated Business record carries it and the
  // number never has to be asked for again.
  const userInsert = await query(
    `INSERT INTO business_users (business_id, name, email, mobile_number, password_hash, is_active)
     VALUES (?, ?, ?, ?, ?, true)`,
    [businessId, data.contactPersonName, data.emailId.toLowerCase(), data.mobileNumber, passwordHash]
  );

  const userId = userInsert.insertId;

  // Fetch the created business user profile
  const userResult = await query<UserProfile & { password_hash: string; business_id: string }>(
    `SELECT bu.id, bu.name, bu.email, bu.password_hash, bu.is_active, bu.created_at, bu.updated_at, b.status as business_status
     FROM business_users bu
     JOIN businesses b ON bu.business_id = b.id
     WHERE bu.id = ?`,
    [userId]
  );

  const user = userResult.rows[0];
  const { password_hash, ...userWithoutPassword } = user;
  userWithoutPassword.role = 'BUSINESS';
  userWithoutPassword.mobile = data.mobileNumber;

  const tokenPayload = { id: user.id.toString(), email: user.email, role: 'BUSINESS' };
  const accessToken = generateAccessToken(tokenPayload);
  const refreshToken = generateRefreshToken(tokenPayload);

  return { user: userWithoutPassword as UserProfile, accessToken, refreshToken };
}
