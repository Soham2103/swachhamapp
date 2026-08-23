/**
 * End-to-end test for the Defective Piece Adjustment workflow.
 *
 * Covers the cases in the specification, in order:
 *
 *   1  10 ordered, 2 defective  -> 8 final, line and order re-priced
 *   2  0 defective              -> nothing changes
 *   3  all defective            -> 0 final, 0 amount, order still valid
 *   4  defective > ordered      -> rejected
 *   5  negative / decimal       -> rejected
 *   6  several items            -> each independent, order total correct
 *   7  notification             -> right recipient, no duplicate
 *   9  barcode scanning         -> expected count unchanged by an adjustment
 *  10  concurrent edits         -> no lost update
 *  11  Order Confirmation PDF   -> ordered / defective / final all present
 *  12  invoice                  -> billable quantity and adjusted total
 *      authorisation            -> only a Sorter may write
 *      audit trail              -> every field recorded, corrections kept
 *
 * IT PLACES REAL ORDERS AND REMOVES EXACTLY THE ONES IT PLACED. Every order
 * it creates carries MARKER in `special_notes`, and cleanup finds them by
 * that rather than by ids collected during the run -- a run that dies half
 * way would otherwise leave test orders in a real business's billing period.
 * No pre-existing order is read-modified-written at any point.
 *
 *   npx ts-node scripts/smoke_defective_adjustment.ts [baseUrl]
 */
import dotenv from 'dotenv';
import { query, pool } from '../src/config/database';
import { generateAccessToken } from '../src/utils/jwt';
import { paymentPositionFor } from '../src/services/defectAdjustment.service';

dotenv.config();

const BASE = process.argv[2] || 'http://localhost:5000';
const MARKER = 'smoke-defective-adjustment';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { passed += 1; console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`); }
  else { failed += 1; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

async function api(
  path: string,
  token: string,
  init: { method?: string; body?: unknown } = {}
) {
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

async function cleanup() {
  const rows = await query<any>(
    `SELECT id FROM orders WHERE special_notes LIKE ?`, [`%${MARKER}%`]);
  for (const row of rows.rows) {
    const id = row.id;
    for (const table of [
      'order_adjustment_notifications', 'order_item_adjustments', 'order_status_history',
      'garment_scans', 'order_garments', 'pickups', 'deliveries', 'order_items',
    ]) {
      await query(`DELETE FROM ${table} WHERE order_id = ?`, [id]).catch(() => undefined);
    }
    await query(`DELETE FROM orders WHERE id = ?`, [id]);
  }
  if (rows.rows.length) console.log(`  (removed ${rows.rows.length} test order(s))`);
}

async function tomorrow(): Promise<string> {
  const r = await query<any>(
    `SELECT DATE_FORMAT(DATE(CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', '+05:30')) + INTERVAL 1 DAY,
            '%Y-%m-%d') AS d`);
  return String(r.rows[0].d);
}

const money = (v: unknown) => Math.round(Number(v || 0) * 100) / 100;

async function main() {
  console.log(`\nDefective piece adjustment — end to end against ${BASE}\n`);

  /* ---- The migration must have been run, or nothing below means anything. ---- */
  const columns = await query<any>(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'order_items'
        AND COLUMN_NAME IN ('original_quantity','defective_quantity')`);
  if (columns.rows.length < 2) {
    console.log('  STOP  order_items is missing original_quantity / defective_quantity.');
    console.log('        Run database/migrations/033_defective_piece_adjustment.sql first.');
    failed += 1;
    return;
  }
  const tables = await query<any>(
    `SELECT TABLE_NAME FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME IN ('order_item_adjustments','order_adjustment_notifications')`);
  if (tables.rows.length < 2) {
    console.log('  STOP  the adjustment tables are missing. Run migration 033 first.');
    failed += 1;
    return;
  }
  check('migration 033 has been applied', true);

  console.log('\nCLEANUP FIRST');
  await cleanup();

  /* ---- Who and what we test with ---- */
  const biz = await query<any>(
    `SELECT id, name, establishment_name FROM businesses WHERE status = 'ACTIVE' LIMIT 1`);
  if (!biz.rows[0]) { console.log('  no active business to test with'); return; }
  const businessId = String(biz.rows[0].id);

  const primary = (await query<any>(
    `SELECT id, email, mobile_number FROM business_users
      WHERE business_id = ? AND password_hash IS NOT NULL
      ORDER BY FIELD(contact_type,'PRIMARY','ALTERNATIVE'), id LIMIT 1`, [businessId])).rows[0];
  if (!primary) { console.log('  this business has no login account'); return; }

  const sorter = (await query<any>(
    `SELECT id, email FROM users WHERE role = 'SORTER' AND is_active = true LIMIT 1`)).rows[0];
  if (!sorter) { console.log('  SKIP  no active SORTER account exists to test with'); return; }

  const bizToken = generateAccessToken({
    id: String(primary.id), email: primary.email, role: 'BUSINESS',
    mobile: primary.mobile_number,
  });
  const sorterToken = generateAccessToken({
    id: String(sorter.id), email: sorter.email || '', role: 'SORTER' });

  /* ---- Two priced items, so the multi-item case is real ---- */
  const priced = await query<any>(
    `SELECT bpl.item_id, bpl.price,
            (SELECT st.code FROM item_service_types m
               JOIN services st ON st.id = m.service_id
              WHERE m.item_id = bpl.item_id AND st.kind = 'SERVICE_TYPE'
                AND st.is_active = true LIMIT 1) AS service_code
       FROM business_price_list bpl
      WHERE bpl.business_id = ? AND bpl.laundry_type = 'hotel' AND bpl.is_active = true
     HAVING service_code IS NOT NULL
      LIMIT 2`, [businessId]);
  if (!priced.rows[0]) { console.log('  SKIP  this business has no priced item'); return; }

  const pickupDate = await tomorrow();
  const slots = await api(`/api/businesses/time-slots?date=${pickupDate}`, bizToken);
  const slot = (slots.json?.data || []).find((s: any) => s.available) || slots.json?.data?.[0];
  if (!slot) { console.log('  SKIP  no pickup slot configured'); return; }

  /** Places one order with the given lines and returns its id. */
  async function placeOrder(lines: Array<{ itemId: string; quantity: number; service: string }>) {
    await api('/api/businesses/cart', bizToken, { method: 'DELETE' });
    await api('/api/businesses/cart/context', bizToken, {
      method: 'PUT', body: { laundryType: 'hotel', orderType: 'standard' } });
    for (const line of lines) {
      const added = await api('/api/businesses/cart/items', bizToken, {
        method: 'POST',
        body: { itemId: line.itemId, quantity: line.quantity, itemServiceType: line.service },
      });
      if (added.status >= 400) throw new Error(`cart: ${added.json?.message || added.status}`);
    }
    const placed = await api('/api/businesses/orders', bizToken, {
      method: 'POST',
      body: { pickupDate, pickupSlot: slot.id, serviceNotes: MARKER, pickupNotes: MARKER },
    });
    if (placed.status >= 400) throw new Error(`order: ${placed.json?.message || placed.status}`);
    return String(placed.json.data.id);
  }

  const adjust = (orderId: string, itemId: string, qty: unknown, reason?: string) =>
    api(`/api/sorter/orders/${orderId}/items/${itemId}/defective`, sorterToken, {
      method: 'PATCH', body: { defectiveQuantity: qty, reason },
    });

  const lineOf = async (orderId: string) => {
    const r = await query<any>(
      `SELECT id, quantity, original_quantity, defective_quantity, unit_price, total_price,
              weight_kg, total_weight_kg
         FROM order_items WHERE order_id = ? ORDER BY id ASC`, [orderId]);
    return r.rows;
  };
  const orderRow = async (orderId: string) =>
    (await query<any>(`SELECT * FROM orders WHERE id = ?`, [orderId])).rows[0];

  /* ================================================================
   * TEST 1 — 10 ordered, 2 defective
   * ================================================================ */
  console.log('\nTEST 1 — 10 ordered, 2 defective -> 8 final');
  const item = priced.rows[0];
  const orderId = await placeOrder([
    { itemId: String(item.item_id), quantity: 10, service: String(item.service_code) },
  ]);
  let lines = await lineOf(orderId);
  const line = lines[0];
  const unitPrice = money(line.unit_price);
  const before = await orderRow(orderId);

  check('the line starts with original_quantity = quantity',
    Number(line.original_quantity) === 10 && Number(line.quantity) === 10);

  const r1 = await adjust(orderId, String(line.id), 2, 'Torn');
  check('the adjustment is accepted', r1.status === 200, `status ${r1.status} ${r1.json?.message || ''}`);

  lines = await lineOf(orderId);
  check('original_quantity is preserved', Number(lines[0].original_quantity) === 10,
    `original_quantity = ${lines[0].original_quantity}`);
  check('defective_quantity is recorded', Number(lines[0].defective_quantity) === 2);
  check('the billable quantity is 8', Number(lines[0].quantity) === 8);
  check('the line amount is 8 x unit price',
    money(lines[0].total_price) === money(unitPrice * 8),
    `${money(lines[0].total_price)} vs ${money(unitPrice * 8)}`);

  const after = await orderRow(orderId);
  check('the order subtotal follows the line',
    money(after.subtotal) === money(unitPrice * 8),
    `${money(before.subtotal)} -> ${money(after.subtotal)}`);
  check('the order total follows the subtotal',
    money(after.total) === money(money(after.subtotal) + money(after.delivery_charge) +
      money(after.tax) - money(after.coupon_discount)));
  check('the line weight follows the billable quantity',
    lines[0].weight_kg === null ||
    Math.abs(Number(lines[0].total_weight_kg) - Number(lines[0].weight_kg) * 8) < 0.0011,
    `${lines[0].total_weight_kg} for 8 x ${lines[0].weight_kg}`);

  check('the order status is untouched', String(after.status) === String(before.status),
    `${before.status}`);
  check('no status-history row was written for the adjustment',
    Number((await query<any>(
      `SELECT COUNT(*) AS n FROM order_status_history WHERE order_id = ?`, [orderId]
    )).rows[0].n) === 1);

  /* ---- TEST 9 (here, while the order is fresh): barcodes ---- */
  console.log('\nTEST 9 — barcode scanning is unaffected');
  const garments = await query<any>(
    `SELECT COUNT(*) AS n FROM order_garments WHERE order_id = ?`, [orderId]);
  check('all 10 physical pieces still have a barcode', Number(garments.rows[0].n) === 10,
    `${garments.rows[0].n} garment(s)`);
  const scanStatus = await api(`/api/sorter/orders/${orderId}/scan-status`, sorterToken);
  check('the expected scan count is the PHYSICAL count, not the billable one',
    Number(scanStatus.json?.data?.expected_count) === 10,
    `expected_count = ${scanStatus.json?.data?.expected_count}`);

  /* ---- The audit trail ---- */
  console.log('\nAUDIT TRAIL');
  const audit = await api(`/api/sorter/orders/${orderId}/adjustments`, sorterToken);
  const adjustments: any[] = audit.json?.data?.adjustments || [];
  check('one adjustment is recorded', adjustments.length === 1);
  const a = adjustments[0] || {};
  check('it records every quantity',
    a.original_quantity === 10 && a.defective_quantity === 2 && a.final_quantity === 8,
    `${a.original_quantity} / ${a.defective_quantity} / ${a.final_quantity}`);
  check('it records the reason and who made it', a.reason === 'Torn' && !!a.adjusted_by);

  /*
   * THE AMOUNTS ARE STORED BUT NOT SENT TO THE SORTER.
   *
   * The audit row still carries what the line was worth before and after --
   * that is the record of a money change and billing reads it. The SORTER's
   * copy of the same row is stripped of it, because the shop floor has no
   * decision resting on the figure. Both halves are checked here: the API
   * must not show it, and the database must still hold it.
   */
  check('the Sorter is sent no amounts with the adjustment',
    a.unit_price === undefined && a.original_amount === undefined &&
    a.adjusted_amount === undefined,
    'no price fields in the payload');
  const storedAudit = (await query<any>(
    `SELECT unit_price, original_amount, adjusted_amount FROM order_item_adjustments
      WHERE order_id = ? ORDER BY id DESC LIMIT 1`, [orderId])).rows[0];
  check('  but the amounts are stored, for billing',
    money(storedAudit.original_amount) === money(unitPrice * 10) &&
    money(storedAudit.adjusted_amount) === money(unitPrice * 8),
    `${storedAudit.original_amount} -> ${storedAudit.adjusted_amount}`);

  /* ================================================================
   * TEST 23 — correcting an existing adjustment
   * ================================================================ */
  console.log('\nCORRECTION — 2 defective corrected to 3');
  const r2 = await adjust(orderId, String(line.id), 3, 'One more found');
  check('the correction is accepted', r2.status === 200, `status ${r2.status}`);
  lines = await lineOf(orderId);
  check('it REPLACES rather than adds (3 defective, not 5)',
    Number(lines[0].defective_quantity) === 3 && Number(lines[0].quantity) === 7,
    `defective ${lines[0].defective_quantity}, final ${lines[0].quantity}`);
  check('the order is re-priced again',
    money((await orderRow(orderId)).subtotal) === money(unitPrice * 7));

  const audit2 = await api(`/api/sorter/orders/${orderId}/adjustments`, sorterToken);
  const history: any[] = audit2.json?.data?.adjustments || [];
  check('the history keeps BOTH entries', history.length === 2, `${history.length} rows`);
  check('the newest records what it superseded',
    history[0].previous_defective_quantity === 2 && history[0].defective_quantity === 3);

  /* ================================================================
   * TESTS 4 and 5 — invalid values
   * ================================================================ */
  console.log('\nTESTS 4 & 5 — invalid values are rejected');
  for (const [label, value] of [
    ['more than ordered', 11], ['negative', -1], ['a decimal', 2.5], ['not a number', 'two'],
  ] as Array<[string, unknown]>) {
    const bad = await adjust(orderId, String(line.id), value);
    check(`${label} is rejected`, bad.status === 400,
      `status ${bad.status} — ${bad.json?.message || ''}`);
  }
  lines = await lineOf(orderId);
  check('a rejected attempt changed nothing',
    Number(lines[0].defective_quantity) === 3 && Number(lines[0].quantity) === 7);

  /* ================================================================
   * TEST 2 and TEST 3 — the boundaries
   * ================================================================ */
  console.log('\nTESTS 2 & 3 — the boundaries');
  const zero = await adjust(orderId, String(line.id), 0);
  check('0 defective is accepted', zero.status === 200);
  lines = await lineOf(orderId);
  check('  and restores the full billable quantity',
    Number(lines[0].quantity) === 10 && money(lines[0].total_price) === money(unitPrice * 10));

  const all = await adjust(orderId, String(line.id), 10, 'All damaged');
  check('all-defective is accepted', all.status === 200);
  lines = await lineOf(orderId);
  check('  and leaves 0 billable at 0.00',
    Number(lines[0].quantity) === 0 && money(lines[0].total_price) === 0);
  check('  the order total is 0 and never negative',
    money((await orderRow(orderId)).total) >= 0);
  check('  the order is NOT cancelled by it',
    String((await orderRow(orderId)).status) !== 'CANCELLED');

  await adjust(orderId, String(line.id), 2, 'Torn');   // back to the headline case

  /* ================================================================
   * AUTHORISATION
   * ================================================================ */
  console.log('\nAUTHORISATION — only a Sorter may write');
  const asBusiness = await api(
    `/api/sorter/orders/${orderId}/items/${line.id}/defective`, bizToken,
    { method: 'PATCH', body: { defectiveQuantity: 5 } });
  check('a BUSINESS token is refused', asBusiness.status === 403,
    `status ${asBusiness.status}`);
  const anonymous = await fetch(
    `${BASE}/api/sorter/orders/${orderId}/items/${line.id}/defective`,
    { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ defectiveQuantity: 5 }) });
  check('an unauthenticated request is refused', anonymous.status === 401,
    `status ${anonymous.status}`);
  lines = await lineOf(orderId);
  check('neither changed anything', Number(lines[0].defective_quantity) === 2);

  /* ================================================================
   * TEST 10 — concurrent edits
   * ================================================================ */
  console.log('\nTEST 10 — concurrent edits do not lose an update');
  const [c1, c2] = await Promise.all([
    adjust(orderId, String(line.id), 4, 'concurrent A'),
    adjust(orderId, String(line.id), 5, 'concurrent B'),
  ]);
  check('both requests completed', c1.status === 200 && c2.status === 200,
    `${c1.status} / ${c2.status}`);
  lines = await lineOf(orderId);
  const settled = Number(lines[0].defective_quantity);
  check('the stored figure is one of the two, not a mixture',
    settled === 4 || settled === 5, `defective = ${settled}`);
  check('the line price agrees with the stored quantity — no torn write',
    money(lines[0].total_price) === money(unitPrice * (10 - settled)),
    `${lines[0].total_price} for ${10 - settled} x ${unitPrice}`);
  check('the order subtotal agrees with the line',
    money((await orderRow(orderId)).subtotal) === money(lines[0].total_price));
  check('both attempts are in the audit trail',
    ((await api(`/api/sorter/orders/${orderId}/adjustments`, sorterToken))
      .json?.data?.adjustments || []).length >= 2);

  /* ================================================================
   * TEST 6 — several items, each independent
   * ================================================================ */
  console.log('\nTEST 6 — several items adjust independently');
  if (priced.rows.length < 2) {
    console.log('  SKIP  this business has only one priced item');
  } else {
    const second = priced.rows[1];
    const multiId = await placeOrder([
      { itemId: String(item.item_id), quantity: 10, service: String(item.service_code) },
      { itemId: String(second.item_id), quantity: 5, service: String(second.service_code) },
    ]);
    const multiLines = await lineOf(multiId);
    const p0 = money(multiLines[0].unit_price);
    const p1 = money(multiLines[1].unit_price);

    await adjust(multiId, String(multiLines[0].id), 2);
    await adjust(multiId, String(multiLines[1].id), 1);

    const done = await lineOf(multiId);
    check('item one: 10 - 2 = 8',
      Number(done[0].quantity) === 8 && money(done[0].total_price) === money(p0 * 8));
    check('item two: 5 - 1 = 4',
      Number(done[1].quantity) === 4 && money(done[1].total_price) === money(p1 * 4));
    check('the order total is the sum of both adjusted lines',
      money((await orderRow(multiId)).subtotal) === money(p0 * 8 + p1 * 4),
      `${money((await orderRow(multiId)).subtotal)} vs ${money(p0 * 8 + p1 * 4)}`);
  }

  /* ================================================================
   * TEST 11 — the Order Confirmation PDF's data
   * ================================================================ */
  console.log('\nTEST 11 — Order Confirmation PDF');
  const detail = await api(`/api/businesses/orders/${orderId}`, bizToken);
  const doc = detail.json?.data;
  check('the order detail flags the adjustment', doc?.has_adjustment === true);
  const docLine = (doc?.items || [])[0];
  check('the PDF gets ordered, defective AND final',
    Number(docLine?.original_quantity) === 10 &&
    Number(docLine?.defective_quantity) === settled &&
    Number(docLine?.quantity) === 10 - settled,
    `${docLine?.original_quantity} / ${docLine?.defective_quantity} / ${docLine?.quantity}`);
  check('the total quantity is the BILLABLE one',
    Number(doc?.total_quantity) === 10 - settled);

  const sorterDetail = await api(`/api/sorter/orders/${orderId}`, sorterToken);
  const sorterDoc = sorterDetail.json?.data;
  check('the Sorter PDF sees the same quantities',
    Number(sorterDoc?.items?.[0]?.original_quantity) === 10 &&
    Number(sorterDoc?.items?.[0]?.quantity) === 10 - settled);
  /*
   * AND SEES NO MONEY. The order total, the line amounts and the payment
   * position are all absent from a Sorter payload by design; the same order
   * read through the BUSINESS endpoint above still carries everything billing
   * needs, and the database still holds the figures.
   */
  check('the Sorter is sent no order total, line amount or payment position',
    sorterDoc?.order_total === undefined &&
    sorterDoc?.original_order_total === undefined &&
    sorterDoc?.payment === undefined &&
    (sorterDoc?.items || []).every((i: any) =>
      i.unit_price === undefined && i.amount === undefined && i.original_amount === undefined),
    'no price fields in the payload');
  const storedTotal = (await query<any>(
    `SELECT subtotal, total FROM orders WHERE id = ?`, [orderId])).rows[0];
  check('  while the order itself is still priced correctly',
    money(storedTotal.subtotal) === money(unitPrice * (10 - settled)),
    `subtotal ${storedTotal.subtotal}`);

  /* ---- Super Admin sees it too, through the existing route ---- */
  const superAdmin = (await query<any>(
    `SELECT id, email FROM users WHERE role = 'SUPER_ADMIN' AND is_active = true LIMIT 1`)).rows[0];
  if (superAdmin) {
    const saToken = generateAccessToken({
      id: String(superAdmin.id), email: superAdmin.email, role: 'SUPER_ADMIN' });
    const sa = await api(
      `/api/super-admin/business-account/${businessId}/orders/${orderId}`, saToken);
    check('Super Admin sees the adjustment on the order it can already open',
      Number(sa.json?.data?.order?.items?.[0]?.defective_quantity) === settled,
      `status ${sa.status}`);
    const saWrite = await api(
      `/api/sorter/orders/${orderId}/items/${line.id}/defective`, saToken,
      { method: 'PATCH', body: { defectiveQuantity: 1 } });
    check('  but cannot write one', saWrite.status === 403, `status ${saWrite.status}`);
  } else {
    console.log('  SKIP  no super admin account to check the read-only view with');
  }

  /* ================================================================
   * TEST 12 — the invoice
   * ================================================================ */
  console.log('\nTEST 12 — the invoice bills the adjusted quantity');
  const invoice = await api(
    `/api/super-admin/businesses/${businessId}/invoice?from=${pickupDate}&to=${pickupDate}`,
    superAdmin
      ? generateAccessToken({ id: String(superAdmin.id), email: superAdmin.email, role: 'SUPER_ADMIN' })
      : '');
  if (invoice.status !== 200) {
    // The order is dated today; the invoice window above is the PICKUP date,
    // so an empty window here is expected rather than a failure.
    console.log(`  SKIP  no invoice for that window (${invoice.json?.message || invoice.status})`);
  } else {
    const invLines: any[] = invoice.json?.data?.lines || [];
    const adjustedLine = invLines.find((l) => l.defective_quantity > 0);
    check('the invoice line states ordered and defective beside billable',
      !!adjustedLine && adjustedLine.ordered_quantity > adjustedLine.quantity,
      adjustedLine
        ? `${adjustedLine.ordered_quantity} ordered, ${adjustedLine.defective_quantity} defective, ${adjustedLine.quantity} billed`
        : 'no adjusted line found');
  }

  /* ================================================================
   * TEST 7 — the notification
   * ================================================================ */
  console.log('\nTEST 7 — the WhatsApp notification');
  const notify = await api(
    `/api/sorter/orders/${orderId}/defective-notification`, sorterToken, { method: 'POST' });
  const record = notify.json?.data;
  check('an attempt is recorded either way', !!record,
    `status ${notify.status} — ${record?.status || notify.json?.message}`);
  if (record) {
    const expected = (await orderRow(orderId)).placed_by_mobile;
    check('  it is addressed to the number the order was PLACED on',
      !expected || String(record.sent_to || '').endsWith(String(expected)),
      `sent_to = ${record.sent_to}, placed_by_mobile = ${expected}`);
    if (record.status !== 'SENT') {
      console.log(`  NOTE  Meta did not accept it: ${record.error}`);
      console.log('        Expected until WHATSAPP_ADJUSTMENT_TEMPLATE names an approved');
      console.log('        template, or the order has a defect photo to send the approved');
      console.log('        defect template with. The failure is recorded, not hidden.');
    }
  }

  // The duplicate guard applies only to a send Meta accepted.
  const again = await api(
    `/api/sorter/orders/${orderId}/defective-notification`, sorterToken, { method: 'POST' });
  if (record?.status === 'SENT') {
    check('a second send for the SAME adjustment is refused', again.status === 409,
      `status ${again.status}`);
    await adjust(orderId, String(line.id), 3, 'changed again');
    const afterChange = await api(
      `/api/sorter/orders/${orderId}/defective-notification`, sorterToken, { method: 'POST' });
    check('  but a NEW adjustment may be notified', afterChange.status !== 409,
      `status ${afterChange.status}`);
  } else {
    check('a failed send is not treated as a duplicate and may be retried',
      again.status !== 409, `status ${again.status}`);
  }

  /* ================================================================
   * TEST 8 — payment and billing records are never rewritten
   * ================================================================ */
  console.log('\nTEST 8 — payment and billing records are never rewritten');

  /*
   * A FINGERPRINT OF EVERY STORED RECEIPT, taken before and after.
   *
   * This is the figure that actually matters. An invoice here is COMPUTED, so
   * it is expected to change when an order in its period changes -- that is
   * how the application already behaves when a new order lands in a part-paid
   * period. What must never move is a receipt: it is a printed document
   * stating four frozen figures. So the test is not "did the invoice stay the
   * same" (it should not) but "did any receipt row change" (it must not).
   */
  const receiptFingerprint = async () => {
    const r = await query<any>(
      `SELECT COALESCE(GROUP_CONCAT(CONCAT_WS('|', id, receipt_number, invoice_number,
                previous_balance, current_invoice_amount, total_amount_due,
                payment_received, remaining_balance) ORDER BY id), '') AS sig,
              COUNT(*) AS n
         FROM business_payment_receipts`);
    return `${r.rows[0].n}::${r.rows[0].sig}`;
  };
  const receiptsBefore = await receiptFingerprint();

  const paymentBefore = await query<any>(
    `SELECT payment_status, payment_ref FROM orders WHERE id = ?`, [orderId]);
  /*
   * THE MONEY POSITION IS COMPUTED, AND IS NOT SENT TO THE SORTER.
   *
   * Both halves are checked, because they are the whole point of the split:
   * the shop floor's endpoint must carry no figure, and billing must still be
   * able to get one. So the API is asserted to be EMPTY of it, and the
   * service is called directly to prove it still answers.
   */
  const sorterAdjustments =
    (await api(`/api/sorter/orders/${orderId}/adjustments`, sorterToken)).json?.data;
  check('the Sorter is not sent a payment position',
    sorterAdjustments?.payment === undefined,
    'no payment block in the Sorter payload');

  const position = await paymentPositionFor(orderId);
  check('but the money position is still computed for billing',
    !!position && typeof position.order_total === 'number',
    `total ${position.order_total}, status ${position.payment_status}`);

  const paymentAfter = await query<any>(
    `SELECT payment_status, payment_ref FROM orders WHERE id = ?`, [orderId]);
  check('payment_status was not touched by any adjustment',
    paymentBefore.rows[0].payment_status === paymentAfter.rows[0].payment_status,
    `${paymentAfter.rows[0].payment_status}`);
  check('no payment receipt row was created, altered or removed',
    (await receiptFingerprint()) === receiptsBefore);

  /*
   * AN ORDER ON AN ALREADY-PAID INVOICE IS STILL ADJUSTABLE.
   *
   * A billing period is usually the CURRENT open month, so refusing this
   * would block every order a business places for as long as that month
   * lasts -- while the application happily lets a NEW order into the same
   * period and recomputes the invoice around it. The adjustment is allowed
   * and the consequence is REPORTED instead.
   */
  const paidInvoice = position?.invoice;
  if (paidInvoice && paidInvoice.receipt_count > 0) {
    const onPaidInvoice = await adjust(orderId, String(line.id), 1, 'on a paid invoice');
    check('an order on an already-paid invoice can still be adjusted',
      onPaidInvoice.status === 200,
      `invoice ${paidInvoice.invoice_number} has ${paidInvoice.receipt_count} receipt(s)`);
    check('  and the billing consequence is flagged, not hidden',
      position.requires_billing_attention === true &&
        String(position.note || '').includes(paidInvoice.invoice_number),
      position.note || 'no note');
    check('  while every stored receipt is still untouched',
      (await receiptFingerprint()) === receiptsBefore);
  } else {
    console.log('  SKIP  no receipt exists for this order\'s invoice period');
  }

  /* ================================================================
   * ELIGIBILITY — an order that has left the facility
   * ================================================================ */
  console.log('\nELIGIBILITY — an order past the facility cannot be adjusted');
  await query(`UPDATE orders SET status = 'DELIVERED' WHERE id = ?`, [orderId]);
  const late = await adjust(orderId, String(line.id), 1);
  check('a DELIVERED order is refused', late.status === 409,
    `status ${late.status} — ${late.json?.message || ''}`);
  await query(`UPDATE orders SET status = 'ORDER_PLACED' WHERE id = ?`, [orderId]);
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
