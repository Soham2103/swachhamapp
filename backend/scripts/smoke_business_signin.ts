/**
 * End-to-end test for the Business sign-in flow.
 *
 *   phone -> OTP -> business identified -> primary email + password -> session
 *
 * It drives the REAL endpoints against the REAL database, and it reads the
 * REAL OTP out of the dev SMS provider's log rather than reaching into the
 * table — so the code that is verified is the code that was sent, and the
 * whole path including delivery is exercised.
 *
 * IT CREATES ITS OWN DATA. Two throwaway businesses, A and B, each with a
 * primary account and three alternative contacts, because the security rule
 * worth testing — a contact of A cannot sign in with B's credentials — needs
 * two of them. Both are removed at the end, and no existing business, account
 * or contact is touched or read into the assertions.
 *
 *   npx ts-node scripts/smoke_business_signin.ts [baseUrl] [serverLogPath]
 */
import bcrypt from 'bcrypt';
import fs from 'fs';
import dotenv from 'dotenv';
import { query } from '../src/config/database';
import { generateAccessToken } from '../src/utils/jwt';

dotenv.config();

const BASE = process.argv[2] || 'http://localhost:5099';
const SERVER_LOG = process.argv[3] || '';

const DEVICE = 'smoke-signin-device';
const PRIMARY_PASSWORD = 'SmokeSignIn1234';

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function api(
  path: string,
  body: unknown,
  method = 'POST'
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* an HTML 404 — the status is what matters */
  }
  return { status: res.status, json };
}

/**
 * The OTP that was actually sent to this number, from the dev SMS log.
 *
 * Deliberately NOT read from `otp_verifications`: only the bcrypt hash is
 * stored there, which is the point. Taking it from the delivery log means the
 * test verifies the code the user would have received.
 */
function readOtpFromLog(mobile: string): string | null {
  if (!SERVER_LOG || !fs.existsSync(SERVER_LOG)) return null;
  const log = fs.readFileSync(SERVER_LOG, 'utf-8');
  const re = new RegExp(`OTP generated for development: (\\d{6}) \\(for mobile: ${mobile}\\)`, 'g');
  let last: string | null = null;
  let m;
  while ((m = re.exec(log)) !== null) last = m[1];
  return last;
}

/**
 * Waits for a NEW code to appear for this number.
 *
 * The server's stdout is a FILE here, and Node buffers writes to a file, so
 * the log line can lag the response it belongs to. `previous` is whatever was
 * already there, so this waits for a genuinely new code rather than racing
 * and re-reading the one from a moment ago.
 */
async function waitForOtp(mobile: string, previous: string | null): Promise<string> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const found = readOtpFromLog(mobile);
    if (found && found !== previous) return found;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`No new OTP appeared in the server log for ${mobile}.`);
}

/** The whole OTP step for one number, returning the pre-auth token. */
async function otpJourney(mobile: string): Promise<{ status: number; json: any }> {
  const before = readOtpFromLog(mobile);
  const sent = await api('/api/auth/business/send-otp', { mobile, deviceId: DEVICE });
  if (sent.status !== 200) return sent;

  const otp = await waitForOtp(mobile, before);
  return api('/api/auth/business/verify-otp', { mobile, otp, deviceId: DEVICE });
}

/* ===================================================================
 * THROWAWAY FIXTURES
 * =================================================================== */

interface Fixture {
  businessId: string;
  name: string;
  email: string;
  primaryMobile: string;
  alternatives: string[];
}

async function createBusiness(
  label: string,
  primaryMobile: string,
  alternatives: string[]
): Promise<Fixture> {
  const email = `smoke.${label.toLowerCase()}@example-smoke-test.com`;
  const name = `Smoke Test ${label}`;

  const inserted = await query(
    `INSERT INTO businesses (name, legal_name, establishment_name, business_type,
       registration_type, status, address, establishment_address, city, state, pincode)
     VALUES (?, ?, ?, 'HOTEL', 'B2C', 'ACTIVE', ?, ?, 'Pune', 'Maharashtra', '411001')`,
    [name, name, name, '1 Smoke Road', '1 Smoke Road']
  );
  const businessId = String(inserted.insertId);

  const hash = await bcrypt.hash(PRIMARY_PASSWORD, 10);
  await query(
    `INSERT INTO business_users
       (business_id, contact_type, name, designation, email, mobile_number,
        whatsapp_number, password_hash, is_active, login_enabled)
     VALUES (?, 'PRIMARY', ?, 'Owner', ?, ?, NULL, ?, 1, TRUE)`,
    [businessId, `${label} Primary`, email, primaryMobile, hash]
  );

  for (let i = 0; i < alternatives.length; i += 1) {
    await query(
      `INSERT INTO business_users
         (business_id, contact_type, name, designation, email, mobile_number,
          whatsapp_number, password_hash, is_active, login_enabled)
       VALUES (?, 'ALTERNATIVE', ?, ?, NULL, ?, NULL, NULL, 1, TRUE)`,
      [businessId, `${label} Alt ${i + 1}`, ['Manager', 'Supervisor', 'Accountant'][i], alternatives[i]]
    );
  }

  return { businessId, name, email, primaryMobile, alternatives };
}

async function destroyBusiness(fixture: Fixture) {
  await query(`DELETE FROM business_users WHERE business_id = ?`, [fixture.businessId]);
  await query(`DELETE FROM businesses WHERE id = ?`, [fixture.businessId]);
  // Expanded placeholders: a prepared `IN (?)` binds an array as one value
  // and deletes nothing.
  const numbers = [fixture.primaryMobile, ...fixture.alternatives];
  await query(
    `DELETE FROM otp_verifications
      WHERE mobile_number IN (${numbers.map(() => '?').join(', ')})`,
    numbers
  );
}

async function main() {
  if (!SERVER_LOG) {
    console.log('\nNo server log path given; the OTP cannot be read. Pass it as argument 2.\n');
    process.exit(1);
  }

  // Numbers are fixed and obviously synthetic, and are cleaned up at the end.
  const A = await createBusiness('Alpha', '9000000201', ['9000000211', '9000000212', '9000000213']);
  const B = await createBusiness('Bravo', '9000000202', ['9000000221']);

  console.log(`\nBusiness A: ${A.name} (#${A.businessId}, ${A.email})`);
  console.log(`Business B: ${B.name} (#${B.businessId}, ${B.email})\n`);

  try {
    /* ================================================================
     * 1. THE PRIMARY CONTACT
     * ================================================================ */
    console.log('PRIMARY CONTACT');

    const primaryOtp = await otpJourney(A.primaryMobile);
    check('the primary number is accepted for business sign-in', primaryOtp.status === 200,
      `status ${primaryOtp.status}`);
    check('the response identifies the business', primaryOtp.json?.data?.business?.id === A.businessId,
      primaryOtp.json?.data?.business?.name);
    check('the response marks it as the primary contact',
      primaryOtp.json?.data?.contact?.is_primary === true);
    check('no session is issued by the OTP step',
      !primaryOtp.json?.data?.accessToken && !primaryOtp.json?.data?.refreshToken);
    check('the OTP is never in the response',
      !/\b\d{6}\b/.test(JSON.stringify(primaryOtp.json?.data ?? {})));

    const primaryLogin = await api('/api/auth/signin/password', {
      username: A.email, password: PRIMARY_PASSWORD, preAuthToken: primaryOtp.json.data.preAuthToken,
    });
    check('primary email + password signs in', primaryLogin.status === 200,
      `status ${primaryLogin.status}: ${primaryLogin.json?.message}`);
    check('the session is a BUSINESS session',
      primaryLogin.json?.data?.user?.role === 'BUSINESS');

    const primaryAccount = await query<{ business_id: string }>(
      `SELECT business_id FROM business_users WHERE id = ?`,
      [primaryLogin.json?.data?.user?.id]
    );
    check('the session belongs to business A',
      String(primaryAccount.rows[0]?.business_id) === A.businessId,
      `${primaryAccount.rows[0]?.business_id} vs ${A.businessId}`);
    check('no password is echoed back',
      !JSON.stringify(primaryLogin.json ?? {}).includes(PRIMARY_PASSWORD));
    check('no hash is echoed back', !JSON.stringify(primaryLogin.json ?? {}).includes('$2'));

    /* ================================================================
     * 2. EACH ALTERNATIVE CONTACT
     * ================================================================ */
    for (let i = 0; i < A.alternatives.length; i += 1) {
      const mobile = A.alternatives[i];
      console.log(`\nALTERNATIVE CONTACT ${i + 1}  (${mobile})`);

      const verified = await otpJourney(mobile);
      check('the registered number receives and verifies an OTP', verified.status === 200,
        `status ${verified.status}: ${verified.json?.message}`);
      check('the OTP step resolves to business A',
        verified.json?.data?.business?.id === A.businessId,
        verified.json?.data?.business?.name);
      check('it is reported as an alternative, not the primary',
        verified.json?.data?.contact?.is_primary === false);
      check('the primary email is offered to sign in with',
        verified.json?.data?.business?.login_email === A.email);
      check('no session and no password come back',
        !verified.json?.data?.accessToken &&
        !JSON.stringify(verified.json?.data ?? {}).includes('$2'));

      const preAuthToken = verified.json.data.preAuthToken;

      // -- the security rule: business B's credentials must not work here --
      const crossed = await api('/api/auth/signin/password', {
        username: B.email, password: PRIMARY_PASSWORD, preAuthToken,
      });
      check("business B's email is REFUSED for a contact of A", crossed.status === 403,
        `${crossed.status}: ${crossed.json?.message}`);

      // -- a wrong password is refused --
      const wrongPassword = await api('/api/auth/signin/password', {
        username: A.email, password: 'NotThePassword99', preAuthToken,
      });
      check('a wrong password is refused', wrongPassword.status === 401,
        `status ${wrongPassword.status}`);

      // -- the real thing --
      const login = await api('/api/auth/signin/password', {
        username: A.email, password: PRIMARY_PASSWORD, preAuthToken,
      });
      check('the primary email + password signs this contact in', login.status === 200,
        `status ${login.status}: ${login.json?.message}`);
      check('the session is a BUSINESS session', login.json?.data?.user?.role === 'BUSINESS');

      const account = await query<{ business_id: string; contact_type: string }>(
        `SELECT business_id, contact_type FROM business_users WHERE id = ?`,
        [login.json?.data?.user?.id]
      );
      check('the session is the PRIMARY account, not a new one',
        account.rows[0]?.contact_type === 'PRIMARY',
        account.rows[0]?.contact_type);
      check('the session carries business A',
        String(account.rows[0]?.business_id) === A.businessId,
        `${account.rows[0]?.business_id} vs ${A.businessId}`);

      const rowCount = await query<{ n: number }>(
        `SELECT COUNT(*) AS n FROM business_users WHERE business_id = ?`,
        [A.businessId]
      );
      check('signing in created no new account row', Number(rowCount.rows[0].n) === 4,
        `${rowCount.rows[0].n} rows`);

      const stillNoPassword = await query<{ n: number }>(
        `SELECT COUNT(*) AS n FROM business_users
          WHERE mobile_number = ? AND password_hash IS NOT NULL`,
        [mobile]
      );
      check('the alternative contact still has no password of its own',
        Number(stillNoPassword.rows[0].n) === 0);
    }

    /* ================================================================
     * 3. WHAT MUST NOT WORK
     * ================================================================ */
    console.log('\nSECURITY');

    const unknown = await api('/api/auth/business/send-otp',
      { mobile: '9000000299', deviceId: DEVICE });
    check('an unregistered number is refused', unknown.status === 404,
      `${unknown.status}: ${unknown.json?.message}`);
    check('no OTP was sent to it', readOtpFromLog('9000000299') === null);
    const noRow = await query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM otp_verifications WHERE mobile_number = ?`,
      ['9000000299']
    );
    check('no OTP row was created for it', Number(noRow.rows[0].n) === 0);

    // -- OTP single use --
    const reuseMobile = A.alternatives[0];
    let seen = readOtpFromLog(reuseMobile);
    await api('/api/auth/business/send-otp', { mobile: reuseMobile, deviceId: DEVICE });
    const code = await waitForOtp(reuseMobile, seen);
    const firstUse = await api('/api/auth/business/verify-otp',
      { mobile: reuseMobile, otp: code, deviceId: DEVICE });
    check('a fresh OTP verifies', firstUse.status === 200, `status ${firstUse.status}`);
    const secondUse = await api('/api/auth/business/verify-otp',
      { mobile: reuseMobile, otp: code, deviceId: DEVICE });
    check('the SAME OTP cannot be used twice', secondUse.status >= 400,
      `${secondUse.status}: ${secondUse.json?.message}`);

    // -- a wrong OTP --
    seen = readOtpFromLog(reuseMobile);
    await api('/api/auth/business/send-otp', { mobile: reuseMobile, deviceId: DEVICE });
    await waitForOtp(reuseMobile, seen);
    const wrongOtp = await api('/api/auth/business/verify-otp',
      { mobile: reuseMobile, otp: '000000', deviceId: DEVICE });
    check('a wrong OTP is refused', wrongOtp.status >= 400,
      `${wrongOtp.status}: ${wrongOtp.json?.message}`);

    // -- an expired OTP --
    seen = readOtpFromLog(reuseMobile);
    await api('/api/auth/business/send-otp', { mobile: reuseMobile, deviceId: DEVICE });
    const expiredCode = await waitForOtp(reuseMobile, seen);
    await query(
      `UPDATE otp_verifications SET expires_at = DATE_SUB(NOW(), INTERVAL 1 MINUTE)
        WHERE mobile_number = ? AND is_verified = false`,
      [reuseMobile]
    );
    const expired = await api('/api/auth/business/verify-otp',
      { mobile: reuseMobile, otp: expiredCode, deviceId: DEVICE });
    check('an expired OTP is refused', expired.status >= 400,
      `${expired.status}: ${expired.json?.message}`);

    // -- a disabled contact --
    const disabledMobile = A.alternatives[1];
    await query(`UPDATE business_users SET login_enabled = 0 WHERE mobile_number = ?`,
      [disabledMobile]);
    const disabled = await api('/api/auth/business/send-otp',
      { mobile: disabledMobile, deviceId: DEVICE });
    check('a contact with sign-in disabled is refused', disabled.status === 403,
      `${disabled.status}: ${disabled.json?.message}`);
    await query(`UPDATE business_users SET login_enabled = 1 WHERE mobile_number = ?`,
      [disabledMobile]);

    // -- an inactive business --
    await query(`UPDATE businesses SET status = 'INACTIVE' WHERE id = ?`, [B.businessId]);
    const inactive = await api('/api/auth/business/send-otp',
      { mobile: B.alternatives[0], deviceId: DEVICE });
    check("an inactive business's contact is refused", inactive.status === 403,
      `${inactive.status}: ${inactive.json?.message}`);
    await query(`UPDATE businesses SET status = 'ACTIVE' WHERE id = ?`, [B.businessId]);

    // -- a forged pre-auth token --
    const forged = await api('/api/auth/signin/password', {
      username: A.email, password: PRIMARY_PASSWORD, preAuthToken: 'not.a.real.token',
    });
    check('a forged pre-auth token is refused', forged.status === 401,
      `status ${forged.status}`);

    // -- an alternative contact cannot be a username: it has no email --
    const altAsUser = await query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM business_users
        WHERE business_id = ? AND contact_type = 'ALTERNATIVE'
          AND (email IS NOT NULL OR password_hash IS NOT NULL)`,
      [A.businessId]
    );
    check('no alternative contact has an email or a password',
      Number(altAsUser.rows[0].n) === 0);

    /*
     * A CONTACT NUMBER MAY BELONG TO ONE BUSINESS ONLY.
     *
     * This is what makes "phone -> business" a single answer. If one number
     * were registered against two businesses, proving it by OTP could not say
     * which dashboard the person belongs in -- so registration refuses it, and
     * the refusal is checked here rather than assumed.
     */
    const manager = await query<{ id: string; email: string }>(
      `SELECT id, email FROM users WHERE role = 'MANAGER' AND is_active = 1 ORDER BY id LIMIT 1`
    );
    if (manager.rows[0]) {
      const managerToken = generateAccessToken({
        id: String(manager.rows[0].id),
        email: manager.rows[0].email,
        role: 'MANAGER',
      });
      const reused = await fetch(`${BASE}/api/manager/requests/business`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${managerToken}`,
        },
        body: JSON.stringify({
          registration_type: 'B2C',
          legal_name: 'Smoke Duplicate Number Test',
          legal_address: '2 Smoke Road, Test Town',
          billing_cycle: 'MONTHLY',
          business_head: {
            name: 'Smoke Dup Head',
            designation: 'Owner',
            // Already business A's alternative contact.
            mobile: A.alternatives[0],
            email: 'smoke.duplicate@example-smoke-test.com',
          },
          alternative_contacts: [],
        }),
      });
      const reusedBody: any = await reused.json().catch(() => null);
      check('a number already registered to another business is refused',
        reused.status === 409,
        `${reused.status}: ${reusedBody?.message}`);
      if (reused.status === 201 && reusedBody?.data?.id) {
        await query(`DELETE FROM creation_requests WHERE id = ?`, [reusedBody.data.id]);
      }
    } else {
      console.log('  SKIP  no active MANAGER to submit a duplicate-number registration with');
    }

    /* ================================================================
     * 4. BUSINESS B, ON ITS OWN, STILL WORKS
     * ================================================================ */
    console.log('\nSECOND BUSINESS');

    const bVerified = await otpJourney(B.alternatives[0]);
    check("B's alternative contact resolves to B", bVerified.json?.data?.business?.id === B.businessId,
      bVerified.json?.data?.business?.name);
    const bCrossed = await api('/api/auth/signin/password', {
      username: A.email, password: PRIMARY_PASSWORD, preAuthToken: bVerified.json.data.preAuthToken,
    });
    check("business A's email is REFUSED for a contact of B", bCrossed.status === 403,
      `${bCrossed.status}: ${bCrossed.json?.message}`);
    const bLogin = await api('/api/auth/signin/password', {
      username: B.email, password: PRIMARY_PASSWORD, preAuthToken: bVerified.json.data.preAuthToken,
    });
    check("B's own credentials sign in to B", bLogin.status === 200,
      `status ${bLogin.status}`);
    const bAccount = await query<{ business_id: string }>(
      `SELECT business_id FROM business_users WHERE id = ?`,
      [bLogin.json?.data?.user?.id]
    );
    check('the session carries business B',
      String(bAccount.rows[0]?.business_id) === B.businessId);

    /* ================================================================
     * 5. THE UNIFIED SIGN-IN STILL REACHES THE BUSINESS
     * ================================================================ */
    console.log('\nAUTOMATIC DETECTION — ONE ENTRY POINT, NO QUESTION ASKED');

    /*
     * Nobody declares that they are a business. The SAME endpoint every
     * customer uses is given a business contact's number, and the server works
     * out what it is from the contact rows.
     */
    const uniBefore = readOtpFromLog(A.alternatives[2]);
    const uniSent = await api('/api/auth/signin/send-otp',
      { mobile: A.alternatives[2], deviceId: DEVICE });
    check('the unified send-otp accepts a business number', uniSent.status === 200,
      `status ${uniSent.status}`);
    check('sending asks nothing about the account type',
      !JSON.stringify(uniSent.json ?? {}).toLowerCase().includes('business account'));
    const uniCode = await waitForOtp(A.alternatives[2], uniBefore);
    const uniVerified = await api('/api/auth/signin/verify-otp',
      { mobile: A.alternatives[2], otp: uniCode, deviceId: DEVICE });
    check('an ALTERNATIVE contact is detected automatically',
      uniVerified.json?.data?.mode === 'PASSWORD_REQUIRED' &&
      uniVerified.json?.data?.role === 'BUSINESS',
      `${uniVerified.json?.data?.mode} / ${uniVerified.json?.data?.role}`);
    check('the response names the business it detected',
      uniVerified.json?.data?.business?.id === A.businessId,
      uniVerified.json?.data?.business?.name);
    check('and offers the primary email to sign in with',
      uniVerified.json?.data?.business?.login_email === A.email,
      uniVerified.json?.data?.business?.login_email);
    check('and marks it as an alternative, not the primary',
      uniVerified.json?.data?.contact?.is_primary === false);
    check('no session is issued by the unified OTP step for a business',
      !uniVerified.json?.data?.accessToken);

    // The PRIMARY contact's number, through the same door.
    const priBefore = readOtpFromLog(A.primaryMobile);
    await api('/api/auth/signin/send-otp', { mobile: A.primaryMobile, deviceId: DEVICE });
    const priCode = await waitForOtp(A.primaryMobile, priBefore);
    const priVerified = await api('/api/auth/signin/verify-otp',
      { mobile: A.primaryMobile, otp: priCode, deviceId: DEVICE });
    check('a PRIMARY contact is detected automatically',
      priVerified.json?.data?.role === 'BUSINESS' &&
      priVerified.json?.data?.business?.id === A.businessId,
      priVerified.json?.data?.business?.name);
    check('and is marked as the primary contact',
      priVerified.json?.data?.contact?.is_primary === true);

    // A number that is NOT a business contact must still be a customer.
    const CUSTOMER_MOBILE = '9000000298';
    const custBefore = readOtpFromLog(CUSTOMER_MOBILE);
    const custSent = await api('/api/auth/signin/send-otp',
      { mobile: CUSTOMER_MOBILE, deviceId: DEVICE });
    check('an ordinary number is still accepted', custSent.status === 200,
      `status ${custSent.status}`);
    const custCode = await waitForOtp(CUSTOMER_MOBILE, custBefore);
    const custVerified = await api('/api/auth/signin/verify-otp',
      { mobile: CUSTOMER_MOBILE, otp: custCode, deviceId: DEVICE });
    check('a non-business number still gets the CUSTOMER flow',
      custVerified.json?.data?.mode === 'CUSTOMER_SESSION',
      custVerified.json?.data?.mode);
    check('and is signed straight in, with no password step',
      Boolean(custVerified.json?.data?.accessToken));
    // Remove the customer this created, so the run leaves nothing behind.
    await query(`DELETE FROM carts WHERE user_id IN (SELECT id FROM users WHERE mobile_number = ?)`,
      [CUSTOMER_MOBILE]);
    await query(`DELETE FROM users WHERE mobile_number = ? AND role = 'CUSTOMER'`,
      [CUSTOMER_MOBILE]);
    await query(`DELETE FROM otp_verifications WHERE mobile_number = ?`, [CUSTOMER_MOBILE]);

    const uniCrossed = await api('/api/auth/signin/password', {
      username: B.email, password: PRIMARY_PASSWORD,
      preAuthToken: uniVerified.json.data.preAuthToken,
    });
    check('the business rule applies on the unified path too', uniCrossed.status === 403,
      `${uniCrossed.status}: ${uniCrossed.json?.message}`);

    const uniLogin = await api('/api/auth/signin/password', {
      username: A.email, password: PRIMARY_PASSWORD,
      preAuthToken: uniVerified.json.data.preAuthToken,
    });
    check('and the right credentials still sign in', uniLogin.status === 200,
      `status ${uniLogin.status}`);
  } finally {
    await destroyBusiness(A);
    await destroyBusiness(B);
    console.log('\n  (both throwaway businesses removed)');
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('\nSMOKE TEST CRASHED:', error);
  process.exit(1);
});
