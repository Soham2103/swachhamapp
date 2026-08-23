import jwt, { JwtPayload, SignOptions } from 'jsonwebtoken';
import { config } from '../config/env';

export interface TokenPayload {
  id: string;
  email: string;
  role: string;
  /**
   * The mobile number this session was PROVEN on, by OTP.
   *
   * For a business it is not necessarily the account's own number: any of the
   * business's registered contacts may sign in, and each of them proves their
   * own. It is carried so an action taken in this session can record which
   * number the person was actually reachable on — an order stamps it, and the
   * order's documents print it.
   *
   * Optional: sessions minted before this existed carry none, and every
   * reader falls back to the account's number for them.
   */
  mobile?: string;
}

export interface DecodedToken extends JwtPayload, TokenPayload {}

function generateAccessToken(payload: TokenPayload): string {
  const options: SignOptions = {
    expiresIn: config.JWT_EXPIRES_IN as SignOptions['expiresIn'],
  };
  return jwt.sign(payload, config.JWT_SECRET, options);
}

function generateRefreshToken(payload: TokenPayload): string {
  const options: SignOptions = {
    expiresIn: config.JWT_REFRESH_EXPIRES_IN as SignOptions['expiresIn'],
  };
  return jwt.sign(payload, config.JWT_REFRESH_SECRET, options);
}

function verifyAccessToken(token: string): DecodedToken {
  try {
    const decoded = jwt.verify(token, config.JWT_SECRET) as DecodedToken;
    return decoded;
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      throw new Error('Access token has expired');
    }
    if (error instanceof jwt.JsonWebTokenError) {
      throw new Error('Invalid access token');
    }
    throw error;
  }
}

function verifyRefreshToken(token: string): DecodedToken {
  try {
    const decoded = jwt.verify(token, config.JWT_REFRESH_SECRET) as DecodedToken;
    return decoded;
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      throw new Error('Refresh token has expired');
    }
    if (error instanceof jwt.JsonWebTokenError) {
      throw new Error('Invalid refresh token');
    }
    throw error;
  }
}

/**
 * Pre-auth token for the two-step super admin sign-in.
 *
 * Step 1 (mobile OTP) hands back one of these; step 2 (username +
 * password) will not run without it. That is what makes the flow
 * genuinely two-step instead of two endpoints that can each be called
 * on their own.
 *
 * It is signed with a SEPARATE derived secret, not JWT_SECRET. If it
 * shared the access-token secret it would sail straight through the
 * `authenticate` middleware — a half-authenticated token would be a
 * full session. With its own secret, presenting it as a Bearer token
 * fails signature verification like any other garbage string.
 *
 * Short-lived by design, but long enough for a human: the window has to
 * survive leaving the app to look a password up, not just typing it. Five
 * minutes turned out to be a machine's idea of that, so it is fifteen.
 * The token still only ever unlocks a password attempt against one
 * specific account.
 */
const PRE_AUTH_SECRET = config.JWT_SECRET + '_preauth';
const PRE_AUTH_EXPIRES_IN = '15m';

export interface PreAuthPayload {
  /** The mobile number that actually passed OTP. */
  mobile: string;
  userId: string;
  /**
   * The BUSINESS the proven number belongs to, for a business sign-in.
   *
   * This is the whole of what an alternative contact's OTP earns them: not an
   * account, not a password, just "this number belongs to business 25". The
   * password step then refuses any email whose own business_id is not this
   * one, which is what stops a contact of one business signing in with
   * another business's credentials.
   *
   * Absent for staff sign-ins, which are bound to `userId` instead.
   */
  businessId?: string;
  purpose: 'SUPER_ADMIN_LOGIN';
}

function generatePreAuthToken(payload: PreAuthPayload): string {
  return jwt.sign(payload, PRE_AUTH_SECRET, { expiresIn: PRE_AUTH_EXPIRES_IN });
}

function verifyPreAuthToken(token: string): PreAuthPayload & JwtPayload {
  try {
    const decoded = jwt.verify(token, PRE_AUTH_SECRET) as PreAuthPayload & JwtPayload;
    if (decoded.purpose !== 'SUPER_ADMIN_LOGIN') {
      throw new Error('Invalid verification token');
    }
    return decoded;
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      throw new Error('Mobile verification expired. Please start again.');
    }
    throw new Error('Invalid verification token');
  }
}

export { generateAccessToken, generateRefreshToken, verifyAccessToken, verifyRefreshToken,
         generatePreAuthToken, verifyPreAuthToken };
