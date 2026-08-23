/**
 * Smoke test for the business CONTACT endpoints after the consolidation.
 *
 * These are the paths that now write to `business_users` instead of the
 * dropped `business_contacts`, so each one is exercised end to end: add, edit,
 * toggle the sign-in switch, delete, and the rules that refuse each of those.
 *
 * Everything it creates it removes, and it restores the contact list it found.
 *
 *   npx ts-node scripts/smoke_business_contacts.ts [baseUrl]
 */
import dotenv from 'dotenv';
import { query } from '../src/config/database';
import { generateAccessToken } from '../src/utils/jwt';
import { findAccounts } from '../src/services/unifiedAuth.service';

dotenv.config();

const BASE = process.argv[2] || 'http://localhost:5099';

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
  init: { method?: string; token?: string; body?: unknown } = {}
): Promise<{ status: number; json: any }> {
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
    /* not JSON — the status is what matters */
  }
  return { status: res.status, json };
}

/** A number that is free right now, so the test never collides with real data. */
async function freeMobile(): Promise<string> {
  for (let n = 9000000101; n <= 9000000199; n += 1) {
    const mobile = String(n);
    const taken = await query(
      `SELECT id FROM business_users WHERE mobile_number = ?
       UNION SELECT id FROM users WHERE mobile_number = ?`,
      [mobile, mobile]
    );
    if (!taken.rows[0]) return mobile;
  }
  throw new Error('No free test mobile number.');
}

async function main() {
  const admin = await query<{ id: string; email: string }>(
    `SELECT id, email FROM users WHERE role = 'SUPER_ADMIN' AND is_active = 1 ORDER BY id LIMIT 1`
  );
  const token = generateAccessToken({
    id: String(admin.rows[0].id),
    email: admin.rows[0].email,
    role: 'SUPER_ADMIN',
  });

  const business = await query<any>(`SELECT id, name FROM businesses ORDER BY id LIMIT 1`);
  const businessId = String(business.rows[0].id);
  console.log(`\nBusiness under test: ${business.rows[0].name} (#${businessId})\n`);

  const before = await query<any>(
    `SELECT id, contact_type, name, designation, mobile_number, login_enabled
       FROM business_users WHERE business_id = ? ORDER BY id`,
    [businessId]
  );
  const beforeIds = before.rows.map((r: any) => String(r.id));
  console.log(`CONTACT CRUD (${before.rows.length} contacts on file)`);

  const list = await api(`/api/super-admin/manage/businesses/${businessId}/contacts`, { token });
  check('contacts list loads', list.status === 200 && Array.isArray(list.json?.data));
  const head = (list.json?.data || []).find((c: any) => c.contact_type === 'BUSINESS_HEAD');
  check('the head is reported as BUSINESS_HEAD', Boolean(head), head?.name);
  check('the head is flagged as a login account', head?.has_login === true,
    `has_login=${head?.has_login}`);
  const alts = (list.json?.data || []).filter((c: any) => c.contact_type === 'ALTERNATIVE');
  check('alternatives are NOT flagged as login accounts',
    alts.length > 0 && alts.every((c: any) => c.has_login === false),
    alts.map((c: any) => `${c.name}=${c.has_login}`).join(' '));

  /* ---- add ---- */
  const mobile = await freeMobile();
  const added = await api(`/api/super-admin/manage/businesses/${businessId}/contacts`, {
    method: 'POST', token,
    body: { name: 'Smoke Contact', designation: 'Tester', mobile },
  });
  const wasFull = added.status === 409;
  if (wasFull) {
    console.log(`  NOTE  the business already holds the maximum alternatives — ${added.json?.message}`);
    check('a fourth alternative contact is refused', true, '409 as designed');
  } else {
    check('an alternative contact is added', added.status === 201, `status ${added.status}`);
    const newId = String(added.json?.data?.id);

    const resolved = await findAccounts(mobile);
    check('the new number identifies this business at sign-in',
      resolved.length === 1 && resolved[0].role === 'BUSINESS',
      `${resolved.length} account(s)`);

    /* ---- edit ----
     *
     * The duplicate and bad-number rules are probed through EDIT rather than
     * ADD. Adding this contact may have taken the business to its three-
     * alternative maximum, and that count check runs first -- so a POST would
     * come back 409 "already has 3", which says nothing about the rule under
     * test. Edit has no count guard, so the answer is the one being asked for.
     */
    const dupe = await api(
      `/api/super-admin/manage/businesses/${businessId}/contacts/${newId}`,
      { method: 'PUT', token, body: { name: 'Smoke Dupe', mobile: head.mobile } }
    );
    check("a number already on this business is refused", dupe.status === 409,
      `${dupe.status}: ${dupe.json?.message}`);

    const badMobile = await api(
      `/api/super-admin/manage/businesses/${businessId}/contacts/${newId}`,
      { method: 'PUT', token, body: { name: 'Smoke Bad', mobile: '123' } }
    );
    check('an invalid mobile number is refused', badMobile.status === 400,
      `${badMobile.status}: ${badMobile.json?.message}`);

    const stillMine = await query<{ mobile_number: string }>(
      `SELECT mobile_number FROM business_users WHERE id = ?`,
      [newId]
    );
    check('a refused edit changed nothing', stillMine.rows[0]?.mobile_number === mobile,
      stillMine.rows[0]?.mobile_number);

    const full = await api(`/api/super-admin/manage/businesses/${businessId}/contacts`, {
      method: 'POST', token,
      body: { name: 'Smoke Fourth', designation: 'Tester', mobile: await freeMobile() },
    });
    check('a fourth alternative contact is refused', full.status === 409,
      `${full.status}: ${full.json?.message}`);

    const edited = await api(
      `/api/super-admin/manage/businesses/${businessId}/contacts/${newId}`,
      { method: 'PUT', token, body: { name: 'Smoke Renamed', designation: 'Supervisor', mobile } }
    );
    check('a contact can be edited',
      edited.status === 200 && edited.json?.data?.name === 'Smoke Renamed',
      `status ${edited.status}`);

    /* ---- the sign-in switch ---- */
    const off = await api(
      `/api/super-admin/manage/businesses/${businessId}/contacts/${newId}/login`,
      { method: 'PATCH', token, body: { login_enabled: false } }
    );
    check('sign-in access can be turned off',
      off.status === 200 && off.json?.data?.login_enabled === false,
      `login_enabled=${off.json?.data?.login_enabled}`);
    const whileOff = await findAccounts(mobile);
    check('a disabled number no longer identifies the business', whileOff.length === 0);

    const on = await api(
      `/api/super-admin/manage/businesses/${businessId}/contacts/${newId}/login`,
      { method: 'PATCH', token, body: { login_enabled: true } }
    );
    check('sign-in access can be turned back on',
      on.status === 200 && on.json?.data?.login_enabled === true);

    /* ---- delete ---- */
    const deleted = await api(
      `/api/super-admin/manage/businesses/${businessId}/contacts/${newId}`,
      { method: 'DELETE', token }
    );
    check('an alternative contact can be deleted', deleted.status === 200,
      `${deleted.status}: ${deleted.json?.message}`);
    const gone = await query(`SELECT id FROM business_users WHERE id = ?`, [newId]);
    check('the row is really gone', gone.rows.length === 0);
  }

  /* ---- what must be refused ---- */
  const headId = head?.id;
  const deleteHead = await api(
    `/api/super-admin/manage/businesses/${businessId}/contacts/${headId}`,
    { method: 'DELETE', token }
  );
  check('the business head cannot be deleted as a contact', deleteHead.status === 400,
    `${deleteHead.status}: ${deleteHead.json?.message}`);
  const headStillThere = await query(
    `SELECT password_hash FROM business_users WHERE id = ?`,
    [headId]
  );
  check('the head row and its credentials are untouched',
    Boolean(headStillThere.rows[0]?.password_hash));

  const otherBusiness = await query<any>(
    `SELECT id FROM businesses WHERE id <> ? LIMIT 1`,
    [businessId]
  );
  if (otherBusiness.rows[0]) {
    const crossed = await api(
      `/api/super-admin/manage/businesses/${otherBusiness.rows[0].id}/contacts/${headId}`,
      { method: 'PUT', token, body: { name: 'Hijack', mobile: '9000000199' } }
    );
    check("another business's contact id is a 404", crossed.status === 404,
      `status ${crossed.status}`);
  } else {
    console.log('  SKIP  only one business exists, so cross-business access cannot be tested');
  }

  /* ---- the list is as it was ---- */
  const after = await query<any>(
    `SELECT id FROM business_users WHERE business_id = ? ORDER BY id`,
    [businessId]
  );
  const afterIds = after.rows.map((r: any) => String(r.id));
  check('the contact list is back to what it was',
    afterIds.length === beforeIds.length && afterIds.every((id: string) => beforeIds.includes(id)),
    `${beforeIds.length} before, ${afterIds.length} after`);

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('\nSMOKE TEST CRASHED:', error);
  process.exit(1);
});
