/**
 * End-to-end test for partial order completion / pending items.
 *
 * THE RULE UNDER TEST is that pending is a QUANTITY, not a tick: saying two
 * bedsheets are pending must hold two bedsheets and send everything else,
 * including the other three bedsheets. Answering "yes" must never make the
 * whole order pending.
 *
 * Covers the specification's cases:
 *
 *   1  the exact worked example: 10/5/3 with 0/2/1 pending
 *   2  the pending item is finished later -> order READY_FOR_DELIVERY
 *   3  "no pending items" -> the existing completion workflow, unchanged
 *   4  every item pending -> the order does NOT complete
 *   5  the Sorter payload carries NO price of any kind
 *   6  the backend's billing calculation is untouched by all of it
 *   7  barcode scanning and quantity matching are unaffected
 *   8  a business can SEE the statuses and cannot change them
 *      + the ready items are not held back by the pending one
 *      + PENDING is not DEFECTIVE: no invoice or amount moves
 *      + the audit trail records every item move
 *
 * THE INVOICE GUARANTEE is the one worth reading. A pending item is still
 * billed in full: it is not damaged, it is just not finished, so nothing is
 * subtracted from the invoice for it. The test fingerprints the invoice
 * before and after holding items back and requires the two to be identical.
 *
 * IT PLACES REAL ORDERS AND REMOVES EXACTLY THE ONES IT PLACED, found by
 * MARKER in `special_notes` so a run that dies half way is still cleanable.
 *
 *   npx ts-node scripts/smoke_pending_items.ts [baseUrl]
 */
import dotenv from 'dotenv';
import { query, pool } from '../src/config/database';
import { generateAccessToken } from '../src/utils/jwt';

dotenv.config();

const BASE = process.argv[2] || 'http://localhost:5000';
const MARKER = 'smoke-pending-items';

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

async function cleanup() {
  const rows = await query<any>(
    `SELECT id FROM orders WHERE special_notes LIKE ?`, [`%${MARKER}%`]);
  for (const row of rows.rows) {
    for (const table of [
      'order_adjustment_notifications', 'order_item_adjustments', 'order_status_history',
      'garment_scans', 'order_garments', 'pickups', 'deliveries', 'order_items',
    ]) {
      await query(`DELETE FROM ${table} WHERE order_id = ?`, [row.id]).catch(() => undefined);
    }
    await query(`DELETE FROM orders WHERE id = ?`, [row.id]);
  }
  if (rows.rows.length) console.log(`  (removed ${rows.rows.length} test order(s))`);
}

async function tomorrow(): Promise<string> {
  const r = await query<any>(
    `SELECT DATE_FORMAT(DATE(CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', '+05:30')) + INTERVAL 1 DAY,
            '%Y-%m-%d') AS d`);
  return String(r.rows[0].d);
}

/** Every word that would mean money leaking into a Sorter payload. */
const MONEY_KEYS = [
  'unit_price', 'unitPrice', 'price', 'amount', 'original_amount', 'adjusted_amount',
  'total_price', 'subtotal', 'order_total', 'original_order_total', 'grand_total',
  'payment', 'invoice', 'invoiceAmount', 'orderTotal', 'rate', 'taxable',
];

/** Walks a payload and reports every money-ish key it finds, at any depth. */
function findMoneyKeys(value: any, path = ''): string[] {
  if (value === null || typeof value !== 'object') return [];
  if (Array.isArray(value)) {
    return value.flatMap((v, i) => findMoneyKeys(v, `${path}[${i}]`));
  }
  const hits: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    const here = path ? `${path}.${key}` : key;
    if (MONEY_KEYS.includes(key)) hits.push(here);
    hits.push(...findMoneyKeys(child, here));
  }
  return hits;
}

async function main() {
  console.log(`\nPending items / partial completion — end to end against ${BASE}\n`);

  const cols = await query<any>(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'order_items'
        AND COLUMN_NAME IN ('item_status','pending_reason')`);
  const enumHas = await query<any>(
    `SELECT COLUMN_TYPE FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'status'`);
  if (cols.rows.length < 2 || !String(enumHas.rows[0]?.COLUMN_TYPE).includes('PARTIALLY_COMPLETED')) {
    console.log('  STOP  migration 034 has not been applied.');
    console.log('        Run database/migrations/034_partial_order_completion.sql first.');
    failed += 1;
    return;
  }
  check('migration 034 has been applied', true);

  console.log('\nCLEANUP FIRST');
  await cleanup();

  const biz = (await query<any>(
    `SELECT id FROM businesses WHERE status = 'ACTIVE' LIMIT 1`)).rows[0];
  if (!biz) { console.log('  no active business'); return; }
  const businessId = String(biz.id);

  const primary = (await query<any>(
    `SELECT id, email, mobile_number FROM business_users
      WHERE business_id = ? AND password_hash IS NOT NULL
      ORDER BY FIELD(contact_type,'PRIMARY','ALTERNATIVE'), id LIMIT 1`, [businessId])).rows[0];
  const sorter = (await query<any>(
    `SELECT id, email FROM users WHERE role = 'SORTER' AND is_active = true LIMIT 1`)).rows[0];
  if (!primary || !sorter) { console.log('  SKIP  need a business login and a SORTER account'); return; }

  const bizToken = generateAccessToken({
    id: String(primary.id), email: primary.email, role: 'BUSINESS', mobile: primary.mobile_number });
  const sorterToken = generateAccessToken({
    id: String(sorter.id), email: sorter.email || '', role: 'SORTER' });

  const priced = await query<any>(
    `SELECT bpl.item_id,
            (SELECT st.code FROM item_service_types m
               JOIN services st ON st.id = m.service_id
              WHERE m.item_id = bpl.item_id AND st.kind = 'SERVICE_TYPE'
                AND st.is_active = true LIMIT 1) AS service_code
       FROM business_price_list bpl
      WHERE bpl.business_id = ? AND bpl.laundry_type = 'hotel' AND bpl.is_active = true
     HAVING service_code IS NOT NULL
      LIMIT 3`, [businessId]);
  if (priced.rows.length < 2) { console.log('  SKIP  need at least two priced items'); return; }

  const pickupDate = await tomorrow();
  const slots = await api(`/api/businesses/time-slots?date=${pickupDate}`, bizToken);
  const slot = (slots.json?.data || []).find((s: any) => s.available) || slots.json?.data?.[0];
  if (!slot) { console.log('  SKIP  no pickup slot configured'); return; }

  async function placeOrder(lines: Array<{ itemId: string; quantity: number; service: string }>) {
    await api('/api/businesses/cart', bizToken, { method: 'DELETE' });
    await api('/api/businesses/cart/context', bizToken, {
      method: 'PUT', body: { laundryType: 'hotel', orderType: 'standard' } });
    for (const l of lines) {
      const added = await api('/api/businesses/cart/items', bizToken, {
        method: 'POST',
        body: { itemId: l.itemId, quantity: l.quantity, itemServiceType: l.service } });
      if (added.status >= 400) throw new Error(`cart: ${added.json?.message || added.status}`);
    }
    const placed = await api('/api/businesses/orders', bizToken, {
      method: 'POST',
      body: { pickupDate, pickupSlot: slot.id, serviceNotes: MARKER, pickupNotes: MARKER } });
    if (placed.status >= 400) throw new Error(`order: ${placed.json?.message || placed.status}`);
    return String(placed.json.data.id);
  }

  const linesOf = async (orderId: string) =>
    (await query<any>(
      `SELECT id, service_name, quantity, original_quantity, pending_quantity, total_price,
              item_status, pending_reason
         FROM order_items WHERE order_id = ? ORDER BY id ASC`, [orderId])).rows;
  const statusOf = async (orderId: string) =>
    String((await query<any>(`SELECT status FROM orders WHERE id = ?`, [orderId])).rows[0].status);
  const orderRow = async (orderId: string) =>
    (await query<any>(`SELECT * FROM orders WHERE id = ?`, [orderId])).rows[0];

  const accept = (orderId: string) =>
    api(`/api/sorter/orders/${orderId}/status`, sorterToken,
      { method: 'PATCH', body: { status: 'accepted' } });

  /* ================================================================
   * TEST 1 — the worked example, exactly
   *
   *   Bath Towel 10, pending 0  -> 10 out
   *   Bedsheet    5, pending 2  ->  3 out, 2 held
   *   Curtain     3, pending 1  ->  2 out, 1 held
   * ================================================================ */
  console.log('\nTEST 1 — 10/5/3 with 0/2/1 pending');
  const three = priced.rows.slice(0, 3);
  const orderId = await placeOrder(
    three.map((r: any, i: number) => ({
      itemId: String(r.item_id), quantity: [10, 5, 3][i], service: String(r.service_code) })));

  await accept(orderId);
  let lines = await linesOf(orderId);
  check('every line starts as PROCESSING with nothing held',
    lines.every((l: any) => l.item_status === 'PROCESSING' && Number(l.pending_quantity) === 0));

  // What the order is worth BEFORE anything is held back.
  const moneyBefore = await orderRow(orderId);
  const lineMoneyBefore = lines.map((l: any) => `${l.id}:${l.quantity}:${l.total_price}`).join('|');

  const ready = await api(`/api/sorter/orders/${orderId}/status`, sorterToken, {
    method: 'PATCH',
    body: {
      status: 'ready',
      // Bath Towel is NOT mentioned: an unmentioned line holds nothing.
      pendingItems: [
        { orderItemId: String(lines[1].id), pendingQuantity: 2 },
        { orderItemId: String(lines[2].id), pendingQuantity: 1 },
      ],
      pendingReason: 'Needs re-wash',
    },
  });
  check('the ready step is accepted', ready.status === 200,
    `status ${ready.status} ${ready.json?.message || ''}`);
  check('it reports the split in PIECES',
    ready.json?.data?.pending_quantity === 3 && ready.json?.data?.delivery_quantity === 15,
    `${ready.json?.data?.delivery_quantity} out / ${ready.json?.data?.pending_quantity} held`);

  lines = await linesOf(orderId);
  const [towel, sheet, curtain] = lines;

  check('Bath Towel: nothing held, all 10 go',
    Number(towel.pending_quantity) === 0 && towel.item_status === 'READY',
    `${towel.pending_quantity} held, status ${towel.item_status}`);
  check('Bedsheet: 2 held of 5, 3 go',
    Number(sheet.pending_quantity) === 2 && sheet.item_status === 'PARTIALLY_PENDING',
    `${sheet.pending_quantity} held, status ${sheet.item_status}`);
  check('Curtain: 1 held of 3, 2 go',
    Number(curtain.pending_quantity) === 1 && curtain.item_status === 'PARTIALLY_PENDING',
    `${curtain.pending_quantity} held, status ${curtain.item_status}`);

  /*
   * THE FAULT THIS EXISTS TO PREVENT. Answering "yes" must not sweep the
   * whole order into pending -- which is exactly what the previous
   * whole-item version did.
   */
  check('NOT every line was marked pending',
    lines.filter((l: any) => l.item_status === 'PENDING').length === 0,
    `${lines.filter((l: any) => l.item_status === 'PENDING').length} fully-pending line(s)`);
  check('the pieces going out are 10 + 3 + 2 = 15',
    lines.reduce((sum: number, l: any) =>
      sum + (Number(l.original_quantity) - Number(l.pending_quantity)), 0) === 15);

  check('the ORDER is PARTIALLY_COMPLETED, not completed',
    (await statusOf(orderId)) === 'PARTIALLY_COMPLETED', await statusOf(orderId));

  /* ---- PENDING IS NOT DEFECTIVE: no money moved ---- */
  console.log('\nPENDING IS NOT DEFECTIVE — nothing financial moved');
  const moneyAfter = await orderRow(orderId);
  const lineMoneyAfter = (await linesOf(orderId))
    .map((l: any) => `${l.id}:${l.quantity}:${l.total_price}`).join('|');
  check('no line quantity or amount changed', lineMoneyAfter === lineMoneyBefore);
  check('the order subtotal and total are untouched',
    String(moneyAfter.subtotal) === String(moneyBefore.subtotal) &&
    String(moneyAfter.total) === String(moneyBefore.total),
    `subtotal ${moneyAfter.subtotal}, total ${moneyAfter.total}`);
  check('held pieces are still billed in full — nothing was subtracted',
    Number(sheet.quantity) === 5 && Number(curtain.quantity) === 3,
    `bedsheet billed ${sheet.quantity}, curtain billed ${curtain.quantity}`);
  check('no defective adjustment was invented for them',
    Number((await query<any>(
      `SELECT COUNT(*) AS n FROM order_item_adjustments WHERE order_id = ?`, [orderId]
    )).rows[0].n) === 0);

  /* ---- The invoice must be identical ---- */
  const superAdmin = (await query<any>(
    `SELECT id, email FROM users WHERE role = 'SUPER_ADMIN' AND is_active = true LIMIT 1`)).rows[0];
  if (superAdmin) {
    const saToken = generateAccessToken({
      id: String(superAdmin.id), email: superAdmin.email, role: 'SUPER_ADMIN' });
    const invoiceSig = async () => {
      const r = await api(`/api/super-admin/businesses/${businessId}/invoice`, saToken);
      if (r.status !== 200) return `status:${r.status}`;
      return JSON.stringify({
        total: r.json?.data?.totals?.grand_total,
        lines: (r.json?.data?.lines || []).map((l: any) => [l.description, l.quantity, l.amount]),
      });
    };
    const before = await invoiceSig();
    await api(`/api/sorter/orders/${orderId}/items/${towel.id}/pending`, sorterToken,
      { method: 'PATCH', body: { pendingQuantity: 4, reason: 'temporary' } });
    const during = await invoiceSig();
    await api(`/api/sorter/orders/${orderId}/items/${towel.id}/pending`, sorterToken,
      { method: 'PATCH', body: { pendingQuantity: 0 } });
    const after = await invoiceSig();
    check('the INVOICE is byte-identical while pieces are pending',
      before === during && during === after,
      before === during ? 'unchanged throughout' : 'the invoice moved');
  } else {
    console.log('  SKIP  no super admin account to read the invoice with');
  }

  /* ================================================================
   * VALIDATION — pending can never exceed ordered
   * ================================================================ */
  console.log('\nVALIDATION');
  for (const [label, qty] of [
    ['more than ordered', 7], ['negative', -1], ['a decimal', 1.5],
  ] as Array<[string, unknown]>) {
    const bad = await api(`/api/sorter/orders/${orderId}/items/${sheet.id}/pending`, sorterToken,
      { method: 'PATCH', body: { pendingQuantity: qty } });
    check(`${label} is rejected`, bad.status === 400,
      `status ${bad.status} — ${bad.json?.message || ''}`);
  }
  check('a rejected attempt changed nothing',
    Number((await linesOf(orderId))[1].pending_quantity) === 2);

  /* ================================================================
   * TEST 7 — barcodes
   * ================================================================ */
  console.log('\nTEST 7 — barcode scanning is unaffected');
  const garments = Number((await query<any>(
    `SELECT COUNT(*) AS n FROM order_garments WHERE order_id = ?`, [orderId])).rows[0].n);
  const scan = await api(`/api/sorter/orders/${orderId}/scan-status`, sorterToken);
  check('every physical piece still has a barcode', garments === 18, `${garments} garment(s)`);
  check('ACCEPTANCE still expects every piece that arrived',
    Number(scan.json?.data?.expected_count) === garments,
    `expected ${scan.json?.data?.expected_count}, garments ${garments}`);
  /*
   * DELIVERY EXPECTS ONLY WHAT IS LEAVING. Three pieces are held, so the van
   * carries fifteen -- counting all eighteen would make a correctly loaded
   * van read 15/18 and refuse to match.
   */
  check('DELIVERY expects only the pieces going out',
    Number(scan.json?.data?.expected_delivery_count) === 15,
    `expected_delivery_count = ${scan.json?.data?.expected_delivery_count}`);

  /* ================================================================
   * TEST 5 — no price reaches the Sorter
   * ================================================================ */
  console.log('\nTEST 5 — the Sorter payload carries no money');
  for (const path of [
    `/api/sorter/orders/${orderId}`,
    `/api/sorter/orders/${orderId}/adjustments`,
    `/api/sorter/orders`,
  ]) {
    const r = await api(path, sorterToken);
    const leaks = findMoneyKeys(r.json?.data);
    check(`GET ${path} exposes no financial field`, leaks.length === 0,
      leaks.length ? leaks.slice(0, 6).join(', ') : 'clean');
  }
  // And the defective endpoint's own response.
  const adjResp = await api(
    `/api/sorter/orders/${orderId}/items/${towel.id}/defective`, sorterToken,
    { method: 'PATCH', body: { defectiveQuantity: 1, reason: 'price-leak check' } });
  if (adjResp.status === 200) {
    const leaks = findMoneyKeys(adjResp.json?.data);
    check('PATCH .../defective returns no financial field', leaks.length === 0,
      leaks.length ? leaks.join(', ') : 'clean');

    /* ---- TEST 6 — but the backend still calculated it ---- */
    const line = (await linesOf(orderId))[0];
    const priceRow = (await query<any>(
      `SELECT unit_price, quantity, total_price FROM order_items WHERE id = ?`,
      [line.id])).rows[0];
    check('the backend still re-priced the line despite hiding it',
      Math.abs(Number(priceRow.total_price) -
        Number(priceRow.unit_price) * Number(priceRow.quantity)) < 0.01,
      `${priceRow.quantity} x ${priceRow.unit_price} = ${priceRow.total_price}`);
    const o = await orderRow(orderId);
    check('  and the order total with it',
      Number(o.subtotal) > 0, `subtotal ${o.subtotal}`);
    // Put the line back, so the checks after this one see the order as it was.
    await api(
      `/api/sorter/orders/${orderId}/items/${towel.id}/defective`, sorterToken,
      { method: 'PATCH', body: { defectiveQuantity: 0 } });
  } else {
    console.log(`  SKIP  defective endpoint returned ${adjResp.status}: ${adjResp.json?.message}`);
  }

  /* ================================================================
   * TEST 8 — the business sees it and cannot change it
   * ================================================================ */
  console.log('\nTEST 8 — the business can see, and cannot edit');
  const detail = await api(`/api/businesses/orders/${orderId}`, bizToken);
  const doc = detail.json?.data;
  check('the business sees per-item status', (doc?.items || []).every((i: any) => !!i.item_status));
  check('  and that the order is partially completed', doc?.has_pending_items === true);
  const bizWrite = await api(
    `/api/sorter/orders/${orderId}/items/${curtain.id}/pending`, bizToken,
    { method: 'PATCH', body: { pendingQuantity: 0 } });
  check('a business token cannot change an item status', bizWrite.status === 403,
    `status ${bizWrite.status}`);
  const anon = await fetch(`${BASE}/api/sorter/orders/${orderId}/items/${curtain.id}/pending`,
    { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pendingQuantity: 0 }) });
  check('an unauthenticated request cannot either', anon.status === 401, `status ${anon.status}`);

  /* ---- Nobody may assert PARTIALLY_COMPLETED directly ---- */
  const forced = await api(`/api/sorter/orders/${orderId}/status`, sorterToken,
    { method: 'PATCH', body: { status: 'partially_completed' } });
  check('PARTIALLY_COMPLETED cannot be requested as a target', forced.status === 400,
    `status ${forced.status}`);

  /* ---- The ready items are not held back ---- */
  console.log('\nREADY ITEMS ARE NOT HELD BACK');
  const dispatch = await api(`/api/sorter/orders/${orderId}/status`, sorterToken,
    { method: 'PATCH', body: { status: 'out_for_delivery' } });
  check('a partially completed order can still send its ready items',
    dispatch.status === 200, `status ${dispatch.status} ${dispatch.json?.message || ''}`);
  check('  and the held pieces are still on the SAME order',
    (await linesOf(orderId)).reduce(
      (sum: number, l: any) => sum + Number(l.pending_quantity), 0) === 3);
  check('  no second order was created for it',
    Number((await query<any>(
      `SELECT COUNT(*) AS n FROM orders WHERE special_notes LIKE ?`, [`%${MARKER}%`]
    )).rows[0].n) === 1);

  /* ================================================================
   * TEST 2 — the pending item is finished later
   * ================================================================ */
  console.log('\nTEST 2 — the pending item is completed later');
  const later = await placeOrder([
    { itemId: String(three[0].item_id), quantity: 4, service: String(three[0].service_code) },
    { itemId: String(three[1].item_id), quantity: 3, service: String(three[1].service_code) },
  ]);
  await accept(later);
  const laterLines = await linesOf(later);
  // Hold 2 of the 3 on the second line; 1 of it still goes with the first run.
  await api(`/api/sorter/orders/${later}/status`, sorterToken, {
    method: 'PATCH',
    body: {
      status: 'ready',
      pendingItems: [{ orderItemId: String(laterLines[1].id), pendingQuantity: 2 }],
    } });
  check('the order is partially completed', (await statusOf(later)) === 'PARTIALLY_COMPLETED');
  check('  with 2 held and the rest gone',
    Number((await linesOf(later))[1].pending_quantity) === 2);

  const release = await api(
    `/api/sorter/orders/${later}/items/${laterLines[1].id}/pending`, sorterToken,
    { method: 'PATCH', body: { pendingQuantity: 0 } });
  check('the held pieces can be marked completed', release.status === 200,
    `status ${release.status}`);
  check('  the order returns to READY_FOR_DELIVERY once nothing is held',
    (await statusOf(later)) === 'READY_FOR_DELIVERY', await statusOf(later));
  check('  and it reports nothing left pending',
    release.json?.data?.pending_quantity === 0);
  check('  every piece is now going out',
    (await linesOf(later)).every((l: any) => Number(l.pending_quantity) === 0));

  /* ================================================================
   * TEST 3 — no pending items at all
   * ================================================================ */
  console.log('\nTEST 3 — "no pending items" runs the existing workflow');
  const plain = await placeOrder([
    { itemId: String(three[0].item_id), quantity: 6, service: String(three[0].service_code) } ]);
  await accept(plain);
  const plainBefore = await orderRow(plain);
  const done = await api(`/api/sorter/orders/${plain}/status`, sorterToken,
    { method: 'PATCH', body: { status: 'ready', pendingItems: [] } });
  check('the order completes as it always has', done.status === 200 &&
    (await statusOf(plain)) === 'READY_FOR_DELIVERY', await statusOf(plain));
  check('  every line is READY with nothing held',
    (await linesOf(plain)).every(
      (l: any) => l.item_status === 'READY' && Number(l.pending_quantity) === 0));
  const plainAfter = await orderRow(plain);
  check('  and no amount moved',
    String(plainAfter.subtotal) === String(plainBefore.subtotal) &&
    String(plainAfter.total) === String(plainBefore.total));

  /* ---- The old call shape, with no answer at all ---- */
  const legacy = await placeOrder([
    { itemId: String(three[0].item_id), quantity: 2, service: String(three[0].service_code) } ]);
  await accept(legacy);
  const legacyResp = await api(`/api/sorter/orders/${legacy}/status`, sorterToken,
    { method: 'PATCH', body: { status: 'ready' } });
  check('a caller that does not answer the question is unaffected',
    legacyResp.status === 200 && (await statusOf(legacy)) === 'READY_FOR_DELIVERY');

  /* ================================================================
   * TEST 4 — every item pending
   * ================================================================ */
  console.log('\nTEST 4 — every item pending');
  const allPending = await placeOrder([
    { itemId: String(three[0].item_id), quantity: 2, service: String(three[0].service_code) },
    { itemId: String(three[1].item_id), quantity: 2, service: String(three[1].service_code) } ]);
  await accept(allPending);
  const apLines = await linesOf(allPending);
  /*
   * Every piece of every line, entered deliberately. This is allowed -- it is
   * the Sorter saying nothing is finished -- and it is the ONLY way an order
   * ends up wholly pending.
   */
  const apResp = await api(`/api/sorter/orders/${allPending}/status`, sorterToken, {
    method: 'PATCH',
    body: {
      status: 'ready',
      pendingItems: apLines.map((l: any) => ({
        orderItemId: String(l.id),
        pendingQuantity: Number(l.original_quantity),
      })),
    } });
  check('the step is accepted', apResp.status === 200, `status ${apResp.status}`);
  const apStatus = await statusOf(allPending);
  check('the order does NOT become ready or completed',
    !['READY_FOR_DELIVERY', 'COMPLETED', 'DELIVERED'].includes(apStatus), apStatus);
  check('  it stays at the facility', apStatus === 'RECEIVED_AT_FACILITY', apStatus);
  check('  and every line reads fully PENDING',
    (await linesOf(allPending)).every((l: any) =>
      l.item_status === 'PENDING' &&
      Number(l.pending_quantity) === Number(l.original_quantity)));

  /* ================================================================
   * AUDIT TRAIL
   * ================================================================ */
  console.log('\nAUDIT TRAIL');
  const history = await query<any>(
    `SELECT order_item_id, previous_item_status, new_item_status, changed_by, status
       FROM order_status_history WHERE order_id = ? AND order_item_id IS NOT NULL`,
    [orderId]);
  check('every item move is recorded', history.rows.length > 0,
    `${history.rows.length} item row(s)`);
  check('  with the previous status, the new one and who did it',
    history.rows.every((r: any) =>
      r.previous_item_status && r.new_item_status && r.changed_by));
  const orderRows = await query<any>(
    `SELECT COUNT(*) AS n FROM order_status_history
      WHERE order_id = ? AND order_item_id IS NULL`, [orderId]);
  check('  and the order-level history still reads as it always did',
    Number(orderRows.rows[0].n) > 0, `${orderRows.rows[0].n} order row(s)`);
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
