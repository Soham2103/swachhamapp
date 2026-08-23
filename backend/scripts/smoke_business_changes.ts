/**
 * Smoke test for the business consolidation change.
 *
 * Drives the REAL endpoints on a running server with REAL tokens, because the
 * things worth checking here — that a removed route is actually gone, that an
 * alternative contact's number resolves to the right business, that a changed
 * password works at sign-in — are all facts about the wired-up system rather
 * than about any one function.
 *
 * Read-mostly by design. The two writes it makes (a password change and an
 * edit) are both reverted before it exits, so running it leaves the database
 * as it found it.
 *
 *   npx ts-node scripts/smoke_business_changes.ts [baseUrl]
 */
import bcrypt from 'bcrypt';
import dotenv from 'dotenv';
import { query } from '../src/config/database';
import { generateAccessToken } from '../src/utils/jwt';
import { findAccounts, completeWithPassword } from '../src/services/unifiedAuth.service';
import { resolveLoginRoute } from '../src/services/businessContact.service';
import { generatePreAuthToken } from '../src/utils/jwt';

dotenv.config();

const BASE = process.argv[2] || 'http://localhost:5099';

let passed = 0;
let failed = 0;

/**
 * Set while a REAL business is holding this script's temporary password.
 *
 * The top-level catch calls it, so an exception anywhere after the change --
 * a rate limit, a dropped connection -- still puts the real password back
 * before the process ends.
 */
let undoPasswordChange: (() => Promise<void>) | null = null;

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
  init: { method?: string; token?: string; body?: unknown } = {}
): Promise<{ status: number; json: any; text: string }> {
  const res = await fetch(`${BASE}${path}`, {
    method: init.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* a PDF or an HTML 404 — `text` is what matters then */
  }
  return { status: res.status, json, text };
}

async function main() {
  const admin = await query<{ id: string; email: string }>(
    `SELECT id, email FROM users WHERE role = 'SUPER_ADMIN' AND is_active = 1 ORDER BY id LIMIT 1`
  );
  const manager = await query<{ id: string; email: string }>(
    `SELECT id, email FROM users WHERE role = 'MANAGER' AND is_active = 1 ORDER BY id LIMIT 1`
  );
  if (!admin.rows[0]) throw new Error('No active SUPER_ADMIN to test with.');

  const adminToken = generateAccessToken({
    id: String(admin.rows[0].id),
    email: admin.rows[0].email,
    role: 'SUPER_ADMIN',
  });
  const managerToken = manager.rows[0]
    ? generateAccessToken({
        id: String(manager.rows[0].id),
        email: manager.rows[0].email,
        role: 'MANAGER',
      })
    : null;

  const business = await query<any>(
    `SELECT id, name, registration_type, gst_number FROM businesses ORDER BY id LIMIT 1`
  );
  const biz = business.rows[0];
  if (!biz) throw new Error('No business to test with.');
  const businessId = String(biz.id);

  console.log(`\nBusiness under test: ${biz.name} (#${businessId}, ${biz.registration_type})\n`);

  /* ================================================================
   * 1. SCHEMA
   * ================================================================ */
  console.log('SCHEMA');

  const tables = await query<any>(
    `SELECT TABLE_NAME AS t FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('businesses','business_users','business_contacts')`
  );
  const names = tables.rows.map((r: any) => r.t);
  check('business_contacts is gone', !names.includes('business_contacts'), names.join(', '));
  check('businesses and business_users remain',
    names.includes('businesses') && names.includes('business_users'));

  const bizCols = await query<any>(
    `SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'businesses'`
  );
  const bizColNames = bizCols.rows.map((r: any) => r.c);
  const goneFromBusinesses = [
    'contact_person_name', 'designation', 'mobile_number', 'whatsapp_number',
    'email_id', 'alternate_contact_person', 'alternate_mobile_no',
  ].filter((c) => bizColNames.includes(c));
  check('contact columns removed from businesses', goneFromBusinesses.length === 0,
    goneFromBusinesses.join(', ') || 'none left');
  check('businesses.registration_type exists', bizColNames.includes('registration_type'));

  const userCols = await query<any>(
    `SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'business_users'`
  );
  const userColNames = userCols.rows.map((r: any) => r.c);
  check('business_users gained the contact columns',
    ['contact_type', 'designation', 'whatsapp_number', 'login_enabled']
      .every((c) => userColNames.includes(c)));

  const fk = await query<any>(
    `SELECT COUNT(*) AS n FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME = 'business_users'`
  );
  check('foreign keys still point at business_users', Number(fk.rows[0].n) >= 2,
    `${fk.rows[0].n} referencing columns`);

  const contacts = await query<any>(
    `SELECT contact_type, name, mobile_number, (password_hash IS NOT NULL) AS has_pw
       FROM business_users WHERE business_id = ? ORDER BY id`,
    [businessId]
  );
  check('contacts survived the migration', contacts.rows.length >= 2,
    contacts.rows.map((c: any) => `${c.contact_type}:${c.mobile_number}`).join(' '));
  // `(password_hash IS NOT NULL)` comes back as the STRING '0' or '1' -- the
  // pool only converts real TINYINT(1) columns to booleans -- so it is
  // compared, not merely truth-tested. `Boolean('0')` is true.
  check('exactly one row carries credentials',
    contacts.rows.filter((c: any) => String(c.has_pw) === '1').length === 1,
    contacts.rows.map((c: any) => `${c.contact_type}=${c.has_pw}`).join(' '));

  /* ================================================================
   * 2. SUPER ADMIN — WHAT WAS REMOVED
   * ================================================================ */
  console.log('\nSUPER ADMIN REMOVALS');

  const createBiz = await api('/api/super-admin/businesses', {
    method: 'POST', token: adminToken, body: { name: 'X', address: 'Y', city: 'Z' },
  });
  check('POST /super-admin/businesses is gone', createBiz.status === 404,
    `status ${createBiz.status}`);

  const createRider = await api('/api/super-admin/riders', {
    method: 'POST', token: adminToken, body: { name: 'X', mobile_number: '9999999999' },
  });
  check('POST /super-admin/riders is gone', createRider.status === 404,
    `status ${createRider.status}`);

  const createRiderAccount = await api('/api/super-admin/accounts/riders', {
    method: 'POST', token: adminToken, body: { name: 'X', email: 'x@y.z' },
  });
  check('POST /super-admin/accounts/riders is gone', createRiderAccount.status === 404,
    `status ${createRiderAccount.status}`);

  const listRiders = await api('/api/super-admin/accounts/riders', { token: adminToken });
  check('rider LISTING still works', listRiders.status === 200,
    `status ${listRiders.status}`);

  const riderApprovals = await api('/api/super-admin/approvals/riders', { token: adminToken });
  check('rider approval queue still works', riderApprovals.status === 200,
    `status ${riderApprovals.status}`);

  /* ================================================================
   * 3. SUPER ADMIN — WHAT MUST STILL WORK
   * ================================================================ */
  console.log('\nSUPER ADMIN BUSINESS MANAGEMENT');

  const list = await api('/api/super-admin/manage/businesses', { token: adminToken });
  check('business list loads', list.status === 200 && Array.isArray(list.json?.data),
    `status ${list.status}`);
  const listed = (list.json?.data || []).find((b: any) => String(b.id) === businessId);
  check('list carries the head contact', Boolean(listed?.contact_person_name),
    listed?.contact_person_name);
  check('list carries registration_type', Boolean(listed?.registration_type),
    listed?.registration_type);

  const search = await api(
    `/api/super-admin/manage/businesses?search=${encodeURIComponent(String(biz.name).slice(0, 5))}`,
    { token: adminToken }
  );
  check('business search works', search.status === 200 && (search.json?.data || []).length > 0);

  const detail = await api(`/api/super-admin/manage/businesses/${businessId}`, { token: adminToken });
  check('business detail loads with contacts',
    detail.status === 200 && Array.isArray(detail.json?.data?.contacts),
    `${detail.json?.data?.contacts?.length} contact(s)`);

  const establishment = await api(`/api/super-admin/businesses/${businessId}`, { token: adminToken });
  check('establishment details load', establishment.status === 200,
    `complete=${establishment.json?.data?.is_complete}`);

  // --- edit, then put it back ---
  const originalCity = listed?.city ?? null;
  const edit = await api(`/api/super-admin/manage/businesses/${businessId}`, {
    method: 'PUT', token: adminToken, body: { city: 'SmokeTestCity' },
  });
  check('business edit saves', edit.status === 200 && edit.json?.data?.city === 'SmokeTestCity',
    `status ${edit.status} ${edit.json?.message || ''}`);
  await api(`/api/super-admin/manage/businesses/${businessId}`, {
    method: 'PUT', token: adminToken, body: { city: originalCity },
  });

  /* ---- PDF ---- */
  const pdfRes = await fetch(
    `${BASE}/api/super-admin/manage/businesses/${businessId}/profile.pdf`,
    { headers: { Authorization: `Bearer ${adminToken}` } }
  );
  const pdfBuffer = Buffer.from(await pdfRes.arrayBuffer());
  check('profile PDF is generated',
    pdfRes.status === 200 && pdfBuffer.subarray(0, 4).toString() === '%PDF',
    `${pdfRes.status}, ${pdfBuffer.length} bytes`);

  /*
   * WHAT THE PDF CAN CONTAIN is decided by the document object the renderer
   * draws from -- it prints named fields off that object and nothing else --
   * so THAT is what is inspected here. Scanning the finished bytes proves
   * little either way: PDF content streams are deflate-compressed, so a real
   * leak would not show up in them, and a three-letter coincidence would.
   */
  const { buildBusinessProfileDocument } =
    await import('../src/services/businessProfilePdf.service');
  const document = await buildBusinessProfileDocument(businessId);
  const serialised = JSON.stringify(document).toLowerCase();

  check('the PDF document carries no password of any kind',
    !serialised.includes('password') &&
    !serialised.includes('$2a$') && !serialised.includes('$2b$'));
  check('the PDF document carries no OTP', !serialised.includes('otp'));
  check('the PDF document carries no token or secret',
    !serialised.includes('token') && !serialised.includes('secret'));
  check('the PDF document is for this business only',
    document.id === businessId &&
    document.contacts.every((c: any) => String(c.business_id) === businessId));
  check('the PDF document does carry the business fields',
    Boolean(document.name) && Boolean(document.registration_type) &&
    Boolean(document.address) && document.contacts.length > 0);

  /* ================================================================
   * 4. BUSINESS PASSWORD CHANGE, AND SIGNING IN WITH IT
   * ================================================================ */
  console.log('\nBUSINESS PASSWORD');

  const account = await query<any>(
    `SELECT id, email, password_hash, mobile_number FROM business_users
      WHERE business_id = ? AND password_hash IS NOT NULL ORDER BY id LIMIT 1`,
    [businessId]
  );
  const originalHash = account.rows[0].password_hash;
  const accountEmail = account.rows[0].email;
  const accountMobile = account.rows[0].mobile_number;

  /*
   * The restore is registered BEFORE the password is changed, and it runs on
   * the way out however this process ends.
   *
   * Doing it only at the end of the happy path is how a crash midway -- a rate
   * limit, a network blip -- leaves a REAL business locked out with a test
   * password. That is not an acceptable failure mode for a script that runs
   * against a live database.
   */
  let passwordChanged = false;
  const restorePassword = async () => {
    if (!passwordChanged) return;
    await query(`UPDATE business_users SET password_hash = ? WHERE id = ?`, [
      originalHash,
      account.rows[0].id,
    ]);
    passwordChanged = false;
    console.log('  (original password hash restored)');
  };
  undoPasswordChange = restorePassword;

  const weak = await api(`/api/super-admin/manage/businesses/${businessId}/password`, {
    method: 'POST', token: adminToken, body: { password: 'abc', confirm_password: 'abc' },
  });
  check('a weak password is refused', weak.status === 400, `status ${weak.status}`);

  const mismatch = await api(`/api/super-admin/manage/businesses/${businessId}/password`, {
    method: 'POST', token: adminToken,
    body: { password: 'SmokeTest1234', confirm_password: 'SmokeTest9999' },
  });
  check('a mismatched confirmation is refused', mismatch.status === 400, `status ${mismatch.status}`);

  const NEW_PASSWORD = 'SmokeTest1234';
  const setPw = await api(`/api/super-admin/manage/businesses/${businessId}/password`, {
    method: 'POST', token: adminToken,
    body: { password: NEW_PASSWORD, confirm_password: NEW_PASSWORD },
  });
  if (setPw.status === 200) passwordChanged = true;
  check('password change succeeds', setPw.status === 200, `status ${setPw.status}`);
  check('response never carries the password',
    !JSON.stringify(setPw.json || {}).includes(NEW_PASSWORD));
  check('response never carries a hash',
    !JSON.stringify(setPw.json || {}).includes('$2'));

  const stored = await query<{ password_hash: string }>(
    `SELECT password_hash FROM business_users WHERE id = ?`,
    [account.rows[0].id]
  );
  check('the stored value is a bcrypt hash, not the password',
    stored.rows[0].password_hash.startsWith('$2') &&
    !stored.rows[0].password_hash.includes(NEW_PASSWORD));
  check('the new password verifies against the stored hash',
    await bcrypt.compare(NEW_PASSWORD, stored.rows[0].password_hash));

  // The real sign-in path, not a direct hash compare: pre-auth token from the
  // proven mobile, then username + password.
  const preAuth = generatePreAuthToken({
    mobile: accountMobile,
    userId: `business_users:${account.rows[0].id}`,
    purpose: 'SUPER_ADMIN_LOGIN',
  });
  const signedIn = await completeWithPassword(accountEmail, NEW_PASSWORD, preAuth);
  check('business signs in with the NEW password',
    Boolean(signedIn.accessToken) && signedIn.user?.role === 'BUSINESS');

  let oldRejected = false;
  try {
    await completeWithPassword(accountEmail, 'definitely-not-it', preAuth);
  } catch {
    oldRejected = true;
  }
  check('a wrong password is rejected', oldRejected);

  // Put the original hash back, so the business's real password still works.
  await restorePassword();

  /* ================================================================
   * 5. PRIMARY AND ALTERNATIVE CONTACT SIGN-IN
   * ================================================================ */
  console.log('\nCONTACT SIGN-IN');

  const all = await query<any>(
    `SELECT id, contact_type, mobile_number, login_enabled FROM business_users
      WHERE business_id = ? ORDER BY FIELD(contact_type,'PRIMARY','ALTERNATIVE'), id`,
    [businessId]
  );
  const primary = all.rows.find((r: any) => r.contact_type === 'PRIMARY');
  const alternative = all.rows.find((r: any) => r.contact_type === 'ALTERNATIVE');

  const viaPrimary = await findAccounts(primary.mobile_number);
  check('primary number resolves to one business account',
    viaPrimary.length === 1 && viaPrimary[0].role === 'BUSINESS',
    `${viaPrimary.length} account(s)`);

  if (alternative) {
    const viaAlt = await findAccounts(alternative.mobile_number);
    check('ALTERNATIVE number resolves to one business account',
      viaAlt.length === 1 && viaAlt[0].role === 'BUSINESS',
      `${viaAlt.length} account(s)`);
    check('alternative resolves to the SAME account as the primary',
      viaAlt[0]?.id === viaPrimary[0]?.id,
      `alt -> ${viaAlt[0]?.id}, primary -> ${viaPrimary[0]?.id}`);

    const owner = await query<{ business_id: string }>(
      `SELECT business_id FROM business_users WHERE id = ?`,
      [viaAlt[0]?.id]
    );
    check('the resolved account carries the right business_id',
      String(owner.rows[0]?.business_id) === businessId,
      `${owner.rows[0]?.business_id} vs ${businessId}`);

    // login_enabled is a real restriction, not a hidden button.
    await query(`UPDATE business_users SET login_enabled = 0 WHERE id = ?`, [alternative.id]);
    const whileDisabled = await findAccounts(alternative.mobile_number);
    check('a disabled contact number stops resolving', whileDisabled.length === 0,
      `${whileDisabled.length} account(s)`);
    await query(`UPDATE business_users SET login_enabled = 1 WHERE id = ?`, [alternative.id]);

    const route = await resolveLoginRoute(alternative.mobile_number);
    check('alternative number routes to the right business login',
      route.routed === true && route.business?.id === businessId,
      route.business?.name || route.message);
  }

  const unknown = await findAccounts('6000000009');
  check('an unknown number matches no business', unknown.length === 0);

  const otpSend = await api('/api/auth/signin/send-otp', {
    method: 'POST', body: { mobile: primary.mobile_number, deviceId: 'smoke-test-device' },
  });
  check('OTP send responds without leaking the code',
    otpSend.status < 500 && !/\b\d{6}\b/.test(JSON.stringify(otpSend.json?.data ?? null)),
    `status ${otpSend.status}, data=${JSON.stringify(otpSend.json?.data ?? null)}`);

  const badOtp = await api('/api/auth/signin/verify-otp', {
    method: 'POST',
    body: { mobile: primary.mobile_number, otp: '000000', deviceId: 'smoke-test-device' },
  });
  check('a wrong OTP is rejected', badOtp.status >= 400, `status ${badOtp.status}`);

  /* ================================================================
   * 6. B2B / B2C BACKEND VALIDATION
   * ================================================================ */
  console.log('\nB2B / B2C REGISTRATION VALIDATION');

  if (!managerToken) {
    console.log('  SKIP  no active MANAGER account to submit with');
  } else {
    const base = {
      legal_name: 'Smoke Test Establishment',
      legal_address: '1 Test Road, Test Town',
      billing_cycle: 'MONTHLY',
      city: 'Pune',
      state: 'Maharashtra',
      pincode: '411001',
      business_head: {
        name: 'Smoke Head',
        designation: 'Owner',
        mobile: '9000000001',
        email: 'smoke.head.test@example.com',
      },
      alternative_contacts: [
        { name: 'Smoke Alt', designation: 'Manager', mobile: '9000000002' },
      ],
    };

    const b2bNoGst = await api('/api/manager/requests/business', {
      method: 'POST', token: managerToken,
      body: { ...base, registration_type: 'B2B' },
    });
    check('B2B without a GST number is refused', b2bNoGst.status === 400,
      `${b2bNoGst.status}: ${b2bNoGst.json?.message}`);

    const noType = await api('/api/manager/requests/business', {
      method: 'POST', token: managerToken, body: { ...base },
    });
    check('a missing registration type is refused', noType.status === 400,
      `${noType.status}: ${noType.json?.message}`);

    const badType = await api('/api/manager/requests/business', {
      method: 'POST', token: managerToken,
      body: { ...base, registration_type: 'B2X' },
    });
    check('an invalid registration type is refused', badType.status === 400,
      `${badType.status}: ${badType.json?.message}`);

    // B2C, with a GSTIN sent anyway: it must be DISCARDED, not stored, and
    // the submission must still succeed.
    const b2c = await api('/api/manager/requests/business', {
      method: 'POST', token: managerToken,
      body: { ...base, registration_type: 'B2C', gstin: '27AAPFU0939F1ZV' },
    });
    check('B2C submits with no GST number', b2c.status === 201,
      `${b2c.status}: ${b2c.json?.message}`);
    if (b2c.status === 201) {
      check('the GSTIN sent with a B2C request is discarded',
        b2c.json?.data?.payload?.gstin === null,
        `stored gstin = ${JSON.stringify(b2c.json?.data?.payload?.gstin)}`);
      check('the B2C request carries no derived PAN',
        b2c.json?.data?.payload?.pan_number === null);

      // Clean up: this was a request, never an approval, so no business exists.
      await query(`DELETE FROM creation_requests WHERE id = ?`, [b2c.json.data.id]);
      console.log('  (smoke-test creation request removed)');
    }
  }

  /* ================================================================
   * 7. THE BUSINESS'S OWN PROFILE
   * ================================================================ */
  console.log('\nBUSINESS SELF-SERVICE PROFILE');

  const bizToken = generateAccessToken({
    id: String(account.rows[0].id),
    email: accountEmail,
    role: 'BUSINESS',
  });
  const profile = await api('/api/businesses/profile', { token: bizToken });
  check('business profile loads', profile.status === 200, `status ${profile.status}`);
  if (profile.status === 200) {
    const d = profile.json.data;
    check('profile still reports contact_person_name', Boolean(d.contact_person_name),
      d.contact_person_name);
    check('profile still reports mobile_number', Boolean(d.mobile_number), d.mobile_number);
    check('profile reports registration_type', Boolean(d.registration_type), d.registration_type);
    check('profile carries no password field',
      !JSON.stringify(d).toLowerCase().includes('password'));
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('\nSMOKE TEST CRASHED:', error);
  process.exit(1);
});
