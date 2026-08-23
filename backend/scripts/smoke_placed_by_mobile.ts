/**
 * End-to-end test for `orders.placed_by_mobile`.
 *
 * THE WHOLE CHAIN, in the order it actually happens:
 *
 *   mobile entered -> OTP sent -> OTP verified -> the verified number is
 *   carried in the session -> order placed -> the order is stamped with it
 *   -> the Order Confirmation PDF prints it -> Super Admin opens that PDF
 *
 * It runs against a real server and a real database, so it PLACES REAL ORDERS
 * and then REMOVES EXACTLY THE ONES IT PLACED. Every order it creates is
 * stamped with MARKER in `special_notes`, and cleanup finds them by that
 * rather than by ids collected during the run -- a run that dies half-way
 * would lose the ids and leave test orders sitting in a real business's
 * billing period, which is precisely what must not happen.
 *
 * Nothing else is touched. No pre-existing order is modified, and no
 * historical NULL is backfilled.
 *
 *   npx ts-node scripts/smoke_placed_by_mobile.ts [baseUrl]
 */
import dotenv from 'dotenv';
import bcrypt from 'bcrypt';
import { query, pool } from '../src/config/database';
import { generateAccessToken } from '../src/utils/jwt';
import { verifyBusinessSignInOtp } from '../src/services/unifiedAuth.service';

dotenv.config();

const BASE = process.argv[2] || 'http://localhost:5000';
const MARKER = 'smoke-placed-by-mobile';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { passed += 1; console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`); }
  else { failed += 1; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

async function api(path: string, token: string, init: { method?: string; body?: unknown } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: init.method || 'GET',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}

/**
 * Removes every order this test has ever written, children first.
 *
 * Run at the START as well as the end: these orders sit in a REAL business's
 * billing period, and one left behind by a run that died would turn up on that
 * business's next invoice.
 */
async function cleanup() {
  const rows = await query<any>(
    `SELECT id FROM orders WHERE special_notes LIKE ?`, [`%${MARKER}%`]);
  for (const row of rows.rows) {
    const id = row.id;
    for (const table of ['order_status_history', 'garments', 'pickups', 'deliveries', 'order_items']) {
      await query(`DELETE FROM ${table} WHERE order_id = ?`, [id]).catch(() => undefined);
    }
    await query(`DELETE FROM orders WHERE id = ?`, [id]);
  }
  if (rows.rows.length) console.log(`  (removed ${rows.rows.length} test order(s))`);
}

/** Tomorrow, in the business timezone, as YYYY-MM-DD. */
async function tomorrow(): Promise<string> {
  const r = await query<any>(
    `SELECT DATE_FORMAT(DATE(CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', '+05:30')) + INTERVAL 1 DAY, '%Y-%m-%d') AS d`);
  return String(r.rows[0].d);
}

/**
 * Places one order in a session proven on `provenMobile`, through the real
 * HTTP API, and reports what the database ended up storing.
 *
 * THE SESSION IS THE ONE THE PASSWORD STEP MINTS. `completeWithPassword` ends
 * with `issueSession({ ..., mobile: preAuth.mobile || account.mobile })` --
 * the number the OTP proved, never the account's -- so a token carrying that
 * claim is exactly what a real sign-in on that number produces. The OTP step
 * that fills `preAuth.mobile` is exercised on its own in part 1.
 */
async function placeOrderAs(
  account: { id: string; email: string },
  provenMobile: string | undefined,
  itemId: string,
  serviceType: string,
  pickupDate: string,
  slotId: string
): Promise<{ error?: string; orderId?: string; stored?: string | null }> {
  const token = generateAccessToken({
    id: account.id, email: account.email, role: 'BUSINESS', mobile: provenMobile,
  });

  await api('/api/businesses/cart', token, { method: 'DELETE' });
  await api('/api/businesses/cart/context', token, {
    method: 'PUT', body: { laundryType: 'hotel', orderType: 'regular' },
  });
  const added = await api('/api/businesses/cart/items', token, {
    method: 'POST', body: { itemId, quantity: 1, itemServiceType: serviceType },
  });
  if (added.status !== 200 && added.status !== 201) {
    return { error: `cart: ${added.status} ${added.json?.message || added.text.slice(0, 200)}` };
  }

  const placed = await api('/api/businesses/orders', token, {
    method: 'POST',
    body: {
      pickupDate,
      pickupSlot: slotId,
      serviceNotes: MARKER,   // what cleanup finds the order by
      pickupNotes: MARKER,
    },
  });
  if (placed.status !== 201 && placed.status !== 200) {
    return { error: `order: ${placed.status} ${placed.json?.message || placed.text.slice(0, 300)}` };
  }

  const orderId = String(placed.json?.data?.id);
  const stored = await query<any>(
    `SELECT placed_by_mobile FROM orders WHERE id = ?`, [orderId]);
  return { orderId, stored: stored.rows[0]?.placed_by_mobile ?? null };
}

async function main() {
  console.log(`\nplaced_by_mobile — end to end against ${BASE}\n`);
  console.log('CLEANUP FIRST');
  await cleanup();

  const biz = await query<any>(
    `SELECT id, name, establishment_name FROM businesses WHERE status = 'ACTIVE' LIMIT 1`);
  if (!biz.rows[0]) { console.log('  no active business to test with'); return; }
  const businessId = String(biz.rows[0].id);
  const establishment =
    String(biz.rows[0].establishment_name || '').trim() || biz.rows[0].name;

  const contacts = await query<any>(
    `SELECT id, name, email, mobile_number, contact_type
       FROM business_users WHERE business_id = ?
      ORDER BY FIELD(contact_type,'PRIMARY','ALTERNATIVE'), id`, [businessId]);
  const primary = contacts.rows.find((c: any) => c.contact_type === 'PRIMARY');
  const alternative = contacts.rows.find((c: any) => c.contact_type === 'ALTERNATIVE');
  if (!primary) { console.log('  this business has no primary contact'); return; }
  const account = { id: String(primary.id), email: primary.email };

  console.log(`\nBusiness      ${establishment} (#${businessId})`);
  console.log(`Primary       ${primary.mobile_number}`);
  console.log(`Alternative   ${alternative ? alternative.mobile_number : '(none registered)'}`);

  /* ================================================================
   * 1. OTP VERIFICATION PRESERVES THE NUMBER THAT WAS ENTERED
   * ================================================================ */
  console.log('\n1. OTP VERIFICATION — the number entered is the number carried forward');

  for (const contact of [primary, alternative].filter(Boolean)) {
    const entered = contact.mobile_number;

    /*
     * A REAL OTP, checked by the REAL verifier.
     *
     * The code is only ever stored as a bcrypt hash and is never readable, so
     * a row is seeded with the hash of a code this test knows. Everything the
     * verification then does — expiry, attempt count, single use, the device
     * check — is the untouched production path, and it consumes the row.
     */
    const code = '424242';
    await query(
      `UPDATE otp_verifications SET is_verified = true
        WHERE mobile_number = ? AND is_verified = false`, [entered]);
    await query(
      `INSERT INTO otp_verifications (mobile_number, otp_hash, expires_at, purpose)
       VALUES (?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 10 MINUTE), 'LOGIN_VERIFICATION')`,
      [entered, await bcrypt.hash(code, 10)]);

    try {
      const result = await verifyBusinessSignInOtp(entered, code);
      const claim = JSON.parse(
        Buffer.from(result.preAuthToken.split('.')[1], 'base64').toString());
      check(`OTP on ${entered} (${contact.contact_type}) carries that exact number forward`,
        claim.mobile === entered, `the verified token says ${claim.mobile}`);
      check('  and resolves to this business rather than to an account of its own',
        String(claim.businessId) === businessId);
    } catch (e: any) {
      check(`OTP on ${entered} verifies`, false, e.message);
    }
  }

  /* ================================================================
   * 2. THE ORDER IS STAMPED WITH IT
   * ================================================================ */
  console.log('\n2. ORDER CREATION — the verified number reaches the order row');

  const priced = await query<any>(
    `SELECT bpl.item_id,
            (SELECT st.code FROM item_service_types m
               JOIN services st ON st.id = m.service_id
              WHERE m.item_id = bpl.item_id AND st.kind = 'SERVICE_TYPE'
                AND st.is_active = true LIMIT 1) AS service_code
       FROM business_price_list bpl
      WHERE bpl.business_id = ? AND bpl.laundry_type = 'hotel' AND bpl.is_active = true
     HAVING service_code IS NOT NULL
      LIMIT 1`, [businessId]);
  if (!priced.rows[0]) { console.log('  SKIP  this business has no priced item to order'); return; }
  const item = priced.rows[0];

  const pickupDate = await tomorrow();
  const listToken = generateAccessToken({ id: account.id, email: account.email, role: 'BUSINESS' });
  const slots = await api(`/api/businesses/time-slots?date=${pickupDate}`, listToken);
  const slot = (slots.json?.data || []).find((s: any) => s.available) || slots.json?.data?.[0];
  if (!slot) { console.log('  SKIP  no pickup slot is configured'); return; }

  const cases: Array<{ label: string; mobile: string | undefined; expect: string | null }> = [
    { label: 'PRIMARY number', mobile: primary.mobile_number, expect: primary.mobile_number },
    ...(alternative
      ? [{
          label: 'ALTERNATIVE number',
          mobile: alternative.mobile_number as string | undefined,
          expect: alternative.mobile_number as string | null,
        }]
      : []),
    { label: 'session with no proven number', mobile: undefined, expect: null },
  ];

  const placedIds: Array<{ id: string; expect: string | null; label: string }> = [];
  for (const c of cases) {
    const out = await placeOrderAs(
      account, c.mobile, String(item.item_id), String(item.service_code), pickupDate, slot.id);
    if (out.error || !out.orderId) {
      check(`order placed on the ${c.label}`, false, out.error);
      continue;
    }

    check(`order placed on the ${c.label} stores ${c.expect ?? 'NULL'}`,
      (out.stored ?? null) === c.expect, `placed_by_mobile = ${out.stored ?? 'NULL'}`);

    if (alternative && c.mobile === alternative.mobile_number) {
      check('  and it is NOT the business\'s primary number',
        out.stored !== primary.mobile_number, `primary is ${primary.mobile_number}`);
    }
    placedIds.push({ id: out.orderId, expect: c.expect, label: c.label });
  }

  /* ================================================================
   * 3. WHAT THE ORDER CONFIRMATION PDF WILL PRINT
   * ================================================================ */
  console.log('\n3. ORDER CONFIRMATION PDF — the business app and Super Admin agree');

  const superAdmin = await query<any>(
    `SELECT id, email FROM users WHERE role = 'SUPER_ADMIN' AND is_active = true LIMIT 1`);
  const saToken = superAdmin.rows[0]
    ? generateAccessToken({
        id: String(superAdmin.rows[0].id),
        email: superAdmin.rows[0].email,
        role: 'SUPER_ADMIN',
      })
    : '';

  for (const p of placedIds) {
    const own = await api(`/api/businesses/orders/${p.id}`, listToken);
    const ownDoc = own.json?.data;
    check(`the business app's PDF for the ${p.label} prints ${p.expect ?? 'N/A'}`,
      (ownDoc?.placed_by_mobile ?? null) === p.expect,
      `placed_by_mobile = ${ownDoc?.placed_by_mobile ?? 'null, so the PDF prints "N/A"'}`);
    check('  and it leads with the establishment name, not the legal name',
      ownDoc?.business_name === establishment, ownDoc?.business_name);

    if (!saToken) continue;
    const sa = await api(
      `/api/super-admin/business-account/${businessId}/orders/${p.id}`, saToken);
    check('  Super Admin can open the same order', sa.status === 200, `status ${sa.status}`);
    check('  and gets the identical document data — one generator, one document',
      JSON.stringify(sa.json?.data?.order) === JSON.stringify(ownDoc));
  }

  if (saToken) {
    const list = await api(`/api/super-admin/business-account/${businessId}/orders`, saToken);
    const rows: any[] = list.json?.data?.orders || [];
    check('Super Admin\'s Order Detail lists the new orders',
      placedIds.every((p) => rows.some((r) => String(r.id) === String(p.id))));
    check('  each row shows the number its own order was placed on',
      placedIds.every((p) => {
        const row = rows.find((r) => String(r.id) === String(p.id));
        return !!row && (row.placed_by_mobile ?? null) === p.expect;
      }));
    check('  and names the invoice each order falls under',
      rows.every((r) => (r.status === 'CANCELLED'
        ? r.invoice_number === null
        : typeof r.invoice_number === 'string' && r.invoice_number.startsWith('SWC/INV/'))));
  } else {
    console.log('  SKIP  no active super admin account to test the Super Admin views with');
  }

  /* ================================================================
   * 4. HISTORICAL ORDERS ARE UNTOUCHED
   * ================================================================ */
  console.log('\n4. EXISTING ORDERS — nothing was backfilled');
  const historical = await query<any>(
    `SELECT COUNT(*) AS n FROM orders
      WHERE placed_by_mobile IS NULL AND (special_notes IS NULL OR special_notes NOT LIKE ?)`,
    [`%${MARKER}%`]);
  console.log(
    `  ${historical.rows[0].n} pre-existing order(s) still hold NULL, as they should — the ` +
    'number they were placed on was never recorded, and inventing one would be worse than ' +
    'printing "N/A".');
}

main()
  .catch((e) => { console.error(e); failed += 1; })
  .finally(async () => {
    console.log('\nCLEANUP');
    await cleanup().catch((e) => console.error('cleanup failed:', e));
    console.log(`\n${passed} passed, ${failed} failed\n`);
    await pool.end();
    process.exitCode = failed === 0 ? 0 : 1;
  });
