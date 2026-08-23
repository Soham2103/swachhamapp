/**
 * Smoke test for Super Admin -> Business Account.
 *
 * Covers the ledger arithmetic, which is the part worth being sure about:
 *
 *   Total Amount Due  = Previous Balance + Current Invoice Amount
 *   Remaining Balance = Total Amount Due - Payment Received
 *
 * and that the remaining balance of one receipt becomes the previous balance
 * of the next — across a page reload, because it is read from the ledger and
 * not from anything on a screen.
 *
 * Also: data isolation between businesses, the 12-character invoice number,
 * the establishment name as the display name, and the Billing Receipt PDF and
 * its file name.
 *
 * IT CLEANS UP AFTER ITSELF. Every receipt it writes is deleted again, and it
 * checks the orders and invoices it read are byte-identical afterwards —
 * recording a payment must never touch them.
 *
 *   npx ts-node scripts/smoke_business_account.ts [baseUrl]
 */
import dotenv from 'dotenv';
import { query, pool } from '../src/config/database';
import { generateAccessToken } from '../src/utils/jwt';

dotenv.config();

const BASE = process.argv[2] || 'http://localhost:5099';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { passed += 1; console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`); }
  else { failed += 1; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

let token = '';
async function api(path: string, init: { method?: string; body?: unknown } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: init.method || 'GET',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* pdf or html */ }
  return { status: res.status, json };
}

/** A fingerprint of every order line, so "orders untouched" is provable. */
async function orderFingerprint(): Promise<string> {
  const r = await query<any>(
    `SELECT COUNT(*) AS n, COALESCE(SUM(total_price), 0) AS t,
            COALESCE(GROUP_CONCAT(CONCAT(id,':',unit_price,':',quantity) ORDER BY id), '') AS sig
       FROM order_items`
  );
  return `${r.rows[0].n}|${r.rows[0].t}|${r.rows[0].sig}`;
}

/**
 * Stamped into `notes` on every receipt this test records.
 *
 * The cleanup finds them by this, not by ids collected during the run: a run
 * that dies part-way loses the ids, and the rows would be left in a REAL
 * business's ledger, silently moving its balance. A marker survives that.
 */
const MARKER = 'smoke-test-business-account';

const createdReceipts: string[] = [];

/**
 * Removes every receipt this test has ever written.
 *
 * Run at the START as well as the end, because this ledger belongs to a REAL
 * business: a row left behind by a run that died part-way would silently move
 * that business's balance, and the next run would start from a wrong figure.
 *
 * Test receipts are identifiable: `SWR/SMOKE/...` for the fabricated ones, and
 * the ids collected during this run for the rest.
 */
async function removeTestReceipts(): Promise<number> {
  const removed = await query(
    `DELETE FROM business_payment_receipts
      WHERE notes = ? OR receipt_number LIKE 'SWR/SMOKE/%'`,
    [MARKER]
  );
  createdReceipts.length = 0;
  return removed.rowCount || 0;
}

async function main() {
  const admin = await query<{ id: string; email: string }>(
    `SELECT id, email FROM users WHERE role = 'SUPER_ADMIN' AND is_active = 1 ORDER BY id LIMIT 1`
  );
  token = generateAccessToken({
    id: String(admin.rows[0].id), email: admin.rows[0].email, role: 'SUPER_ADMIN',
  });

  // A previous run that died part-way must not be this run's starting balance.
  const stale = await removeTestReceipts();
  if (stale) console.log(`  (cleared ${stale} receipt(s) left by an earlier run)`);

  const ordersBefore = await orderFingerprint();

  /* ================================================================
   * 1. THE BUSINESS PICKER
   * ================================================================ */
  console.log('\nBUSINESS ACCOUNT — SELECT BUSINESS');

  const list = await api('/api/super-admin/business-account/businesses');
  check('the business list loads', list.status === 200, `status ${list.status}`);
  const businesses: any[] = list.json?.data || [];
  check('every registered business appears', businesses.length > 0,
    `${businesses.length} business(es)`);

  const dbCount = await query<{ n: number }>(`SELECT COUNT(*) AS n FROM businesses`);
  check('none is missing and none is duplicated',
    businesses.length === Number(dbCount.rows[0].n) &&
    new Set(businesses.map((b) => b.id)).size === businesses.length,
    `${businesses.length} listed, ${dbCount.rows[0].n} in the table`);

  const dbNames = await query<any>(
    `SELECT id, name, establishment_name, legal_name FROM businesses`);
  const displayNameOf = (row: any) =>
    String(row.establishment_name || '').trim() || String(row.name || '').trim();
  check('each is listed under its ESTABLISHMENT name',
    businesses.every((b) => {
      const row = dbNames.rows.find((r: any) => String(r.id) === b.id);
      return row && b.name === displayNameOf(row);
    }),
    businesses.map((b) => b.name).join(' | '));
  check('the legal name is not used as the display name',
    businesses.every((b) => {
      const row = dbNames.rows.find((r: any) => String(r.id) === b.id);
      return !row?.legal_name || !row.establishment_name || b.name !== row.legal_name;
    }));

  const searched = await api(
    `/api/super-admin/business-account/businesses?search=${encodeURIComponent(businesses[0].name.slice(0, 4))}`);
  check('search finds a business by establishment name',
    searched.status === 200 && (searched.json?.data || []).some((b: any) => b.id === businesses[0].id),
    `${(searched.json?.data || []).length} match(es)`);

  const target = businesses.find((b) => b.order_count > 0) || businesses[0];
  console.log(`        selected: ${target.name} (#${target.id}, ${target.order_count} orders)`);

  /* ================================================================
   * 2. ORDER DETAIL
   * ================================================================ */
  console.log('\nORDER DETAIL');

  const otherBusiness = businesses.find((b) => b.id !== target.id);

  const orders = await api(`/api/super-admin/business-account/${target.id}/orders`);
  check('the order list loads', orders.status === 200, `status ${orders.status}`);
  check('it is scoped to the selected business',
    orders.json?.data?.business?.id === target.id, orders.json?.data?.business?.name);
  const orderRows: any[] = orders.json?.data?.orders || [];
  check('it returns that business\'s orders', orderRows.length === target.order_count,
    `${orderRows.length} of ${target.order_count}`);

  const mine = await query<any>(
    `SELECT o.id FROM orders o JOIN business_users bu ON bu.id = o.business_user_id
      WHERE bu.business_id = ?`, [target.id]);
  const mineIds = new Set(mine.rows.map((r: any) => String(r.id)));
  check('no order from another business is included',
    orderRows.every((o) => mineIds.has(o.id)));
  check('each row carries what the table shows',
    orderRows.every((o) => o.order_number && o.created_at && o.item_count >= 0));
  check('each row carries the number the order was placed on',
    orderRows.every((o) => 'placed_by_mobile' in o));

  /*
   * THE NUMBER IS NOT THE ACCOUNT'S. A row must carry `placed_by_mobile` as
   * it is stored -- NULL when the order predates the column -- and never the
   * business user's own number substituted in its place, which is exactly the
   * fallback this change removed.
   */
  const storedMobiles = await query<any>(
    `SELECT o.id, o.placed_by_mobile FROM orders o
       JOIN business_users bu ON bu.id = o.business_user_id
      WHERE bu.business_id = ?`, [target.id]);
  const storedBy = new Map(storedMobiles.rows.map((r: any) => [String(r.id), r.placed_by_mobile]));
  check('the number shown is the number stored, with nothing substituted',
    orderRows.every((o) => (o.placed_by_mobile ?? null) === (storedBy.get(o.id) ?? null)));

  check('each row names the invoice it falls under, and cancelled orders name none',
    orderRows.every((o) =>
      o.status === 'CANCELLED'
        ? o.invoice_number === null
        : typeof o.invoice_number === 'string' && o.invoice_number.startsWith('SWC/INV/')));

  /* ---- The Order Confirmation PDF's data, through Super Admin ---- */
  if (orderRows.length > 0) {
    const one = orderRows[0];
    const detail = await api(
      `/api/super-admin/business-account/${target.id}/orders/${one.id}`);
    check('an order opens in full', detail.status === 200, `status ${detail.status}`);

    const doc = detail.json?.data?.order;
    check('it is the order that was asked for', String(doc?.id) === String(one.id));
    check('it carries what the confirmation PDF prints',
      !!doc && 'placed_by_mobile' in doc && !!doc.business_name && Array.isArray(doc.items));
    check("the PDF states the number the order was placed on, not the account's",
      (doc?.placed_by_mobile ?? null) === (storedBy.get(one.id) ?? null));

    // The establishment name leads the document, not the legal name.
    const nameRow = await query<any>(
      `SELECT name, establishment_name FROM businesses WHERE id = ?`, [target.id]);
    const establishment =
      String(nameRow.rows[0]?.establishment_name || '').trim() || nameRow.rows[0]?.name;
    check('the business name on it is the establishment name',
      doc?.business_name === establishment, doc?.business_name);

    if (otherBusiness) {
      const crossed = await api(
        `/api/super-admin/business-account/${otherBusiness.id}/orders/${one.id}`);
      check('the same order cannot be opened under another business',
        crossed.status === 404, `status ${crossed.status}`);
    }

    const noSuchOrder = await api(
      `/api/super-admin/business-account/${target.id}/orders/99999999`);
    check('an unknown order is a 404', noSuchOrder.status === 404,
      `status ${noSuchOrder.status}`);
  } else {
    console.log('  SKIP  this business has no orders, so there is no PDF to open');
  }

  if (otherBusiness) {
    const theirs = await api(`/api/super-admin/business-account/${otherBusiness.id}/orders`);
    const theirIds = new Set((theirs.json?.data?.orders || []).map((o: any) => o.id));
    check('another business\'s list shares no order with this one',
      [...theirIds].every((id) => !orderRows.some((o) => o.id === id)));
  } else {
    console.log('  SKIP  only one business exists, so cross-business isolation needs two');
  }

  const missing = await api('/api/super-admin/business-account/99999999/orders');
  check('an unknown business is a 404', missing.status === 404, `status ${missing.status}`);

  /* ================================================================
   * 3. PAYMENT RECEIPT — THE CONTEXT
   * ================================================================ */
  console.log('\nPAYMENT RECEIPT — LATEST INVOICE LOADS ITSELF');

  const ctx = await api(`/api/super-admin/business-account/${target.id}/payments`);
  check('the payment context loads', ctx.status === 200, `status ${ctx.status}`);
  const context = ctx.json?.data;
  check('it is for the selected business', context?.business?.id === target.id);

  if (!context?.invoice) {
    console.log(`  SKIP  ${target.name} has no billable orders yet — ${ctx.json?.message}`);
  // No exit and no report here: both live in the .finally() below, and
  // `process.exit` at this point would skip the cleanup with them.
  }

  check('the latest invoice is found without being asked for',
    Boolean(context.invoice.invoice_number), context.invoice.invoice_number);
  check('the shown invoice id is 12 characters',
    context.invoice.invoice_number_display === context.invoice.invoice_number.slice(0, 12) &&
    context.invoice.invoice_number_display.length === 12,
    context.invoice.invoice_number_display);
  check('the full invoice number is kept alongside it',
    context.invoice.invoice_number.length > 12);
  check('the invoice total is loaded, not typed',
    Number(context.invoice.current_invoice_amount) > 0,
    String(context.invoice.current_invoice_amount));
  check('the first invoice starts from a zero previous balance',
    Number(context.previous_balance) === 0, String(context.previous_balance));
  check('total due = previous balance + current invoice',
    Number(context.total_amount_due) ===
      Number(context.previous_balance) + Number(context.invoice.current_invoice_amount),
    `${context.previous_balance} + ${context.invoice.current_invoice_amount} = ${context.total_amount_due}`);
  check('the billing periods are offered for an older invoice',
    Array.isArray(context.periods) && context.periods.length > 0,
    `${context.periods?.length} period(s)`);

  const INVOICE = context.invoice;
  const AMOUNT = Number(INVOICE.current_invoice_amount);

  /* ================================================================
   * 4. VALIDATION
   * ================================================================ */
  console.log('\nVALIDATION');

  const base = {
    invoice_period_from: INVOICE.period.from,
    invoice_period_to: INVOICE.period.to,
    payment_date: '2026-08-23',
    payment_type: 'UPI',
    payment_received: 1,
    // Marks the row as this test's, so the cleanup can always find it.
    notes: MARKER,
  };
  const post = (body: any) =>
    api(`/api/super-admin/business-account/${target.id}/payments`, { method: 'POST', body });

  check('a missing payment date is refused',
    (await post({ ...base, payment_date: undefined })).status === 400);
  check('a malformed payment date is refused',
    (await post({ ...base, payment_date: '23-08-2026' })).status === 400);
  check('a missing payment type is refused',
    (await post({ ...base, payment_type: undefined })).status === 400);
  check('an unknown payment type is refused',
    (await post({ ...base, payment_type: 'BARTER' })).status === 400);
  check('a non-numeric amount is refused',
    (await post({ ...base, payment_received: 'lots' })).status === 400);
  check('a negative amount is refused',
    (await post({ ...base, payment_received: -5 })).status === 400);
  const over = await post({ ...base, payment_received: AMOUNT + 10000 });
  check('paying more than is due is refused', over.status === 400,
    `${over.status}: ${over.json?.message}`);
  const wrongBusiness = await api(
    `/api/super-admin/business-account/99999999/payments`, { method: 'POST', body: base });
  check('an unknown business is refused', wrongBusiness.status === 404,
    `status ${wrongBusiness.status}`);

  const noneYet = await query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM business_payment_receipts WHERE business_id = ?`, [target.id]);
  check('no refused attempt wrote a row', Number(noneYet.rows[0].n) === 0);

  /* ================================================================
   * 5. THE LEDGER — PART PAYMENT, THEN CARRY FORWARD
   * ================================================================ */
  console.log('\nLEDGER — TOTAL DUE, REMAINING, AND CARRY-FORWARD');

  const FIRST = Math.round(AMOUNT * 0.4 * 100) / 100;
  const first = await post({ ...base, payment_received: FIRST, payment_type: 'CASH' });
  check('a payment is recorded', first.status === 201, `${first.status}: ${first.json?.message}`);
  const r1 = first.json?.data;
  if (r1?.id) createdReceipts.push(r1.id);

  check('it stores the previous balance it was calculated from',
    Number(r1.previous_balance) === 0, String(r1.previous_balance));
  check('it stores the current invoice amount',
    Number(r1.current_invoice_amount) === AMOUNT, String(r1.current_invoice_amount));
  check('total due = previous + current',
    Number(r1.total_amount_due) === AMOUNT, String(r1.total_amount_due));
  check('remaining = total due - received',
    Number(r1.remaining_balance) === Math.round((AMOUNT - FIRST) * 100) / 100,
    `${r1.total_amount_due} - ${FIRST} = ${r1.remaining_balance}`);
  check('it stores the FULL invoice number, not the 12-character label',
    r1.invoice_number === INVOICE.invoice_number, r1.invoice_number);
  check('and reports the 12-character label alongside',
    r1.invoice_number_display === INVOICE.invoice_number.slice(0, 12),
    r1.invoice_number_display);
  check('a receipt number was issued', Boolean(r1.receipt_number), r1.receipt_number);
  check('cash payments store no reference', r1.payment_reference === null);

  /*
   * The balance survives a reload, because it is read from the ledger.
   *
   * The invoice must NOT be billed twice: a second payment against the SAME
   * invoice starts from a previous balance of zero (nothing is carried from an
   * earlier invoice) and an already-received figure of what has been paid on
   * it, so what is still outstanding is the invoice less what was paid.
   */
  const reloaded = await api(`/api/super-admin/business-account/${target.id}/payments`);
  check('the invoice is not billed twice on a second payment',
    Number(reloaded.json?.data?.previous_balance) === 0 &&
    Number(reloaded.json?.data?.total_amount_due) === AMOUNT,
    `previous ${reloaded.json?.data?.previous_balance}, due ${reloaded.json?.data?.total_amount_due}`);
  check('it knows what has already been paid against this invoice',
    Number(reloaded.json?.data?.already_received) === FIRST,
    String(reloaded.json?.data?.already_received));
  check('after a reload the outstanding amount is the stored one',
    Number(reloaded.json?.data?.outstanding) ===
      Math.round((AMOUNT - FIRST) * 100) / 100,
    `outstanding ${reloaded.json?.data?.outstanding}`);
  check('the receipt appears in the history',
    (reloaded.json?.data?.receipts || []).some((r: any) => r.id === r1.id),
    `${(reloaded.json?.data?.receipts || []).length} receipt(s)`);

  // -- a second payment carries the balance forward --
  const SECOND = Math.round(AMOUNT * 0.2 * 100) / 100;
  const second = await post({
    ...base, payment_received: SECOND, payment_type: 'NETBANKING',
    payment_reference: 'NEFT-SMOKE-0001',
  });
  check('a second payment is recorded', second.status === 201,
    `${second.status}: ${second.json?.message}`);
  const r2 = second.json?.data;
  if (r2?.id) createdReceipts.push(r2.id);

  // A second payment on the SAME invoice: nothing is carried forward, and the
  // invoice is counted once.
  check('a second payment on the same invoice carries no previous balance',
    Number(r2.previous_balance) === 0, String(r2.previous_balance));
  check('and the invoice is still billed once', Number(r2.total_amount_due) === AMOUNT,
    String(r2.total_amount_due));
  check('remaining = due - already paid - this payment',
    Number(r2.remaining_balance) ===
      Math.round((AMOUNT - FIRST - SECOND) * 100) / 100,
    `${AMOUNT} - ${FIRST} - ${SECOND} = ${r2.remaining_balance}`);
  check('the two payments together reduce the balance exactly once',
    Number(r2.remaining_balance) === Math.round((Number(r1.remaining_balance) - SECOND) * 100) / 100,
    `${r1.remaining_balance} - ${SECOND} = ${r2.remaining_balance}`);
  check('netbanking keeps its reference', r2.payment_reference === 'NEFT-SMOKE-0001');

  const history = await api(`/api/super-admin/business-account/${target.id}/payments`);
  check('both receipts are in the history',
    (history.json?.data?.receipts || []).length === 2,
    `${(history.json?.data?.receipts || []).length}`);
  check('the history is newest first',
    history.json?.data?.receipts?.[0]?.id === r2.id);
  /*
   * THE CARRY-FORWARD, checked where it actually applies: the NEXT invoice.
   *
   * Asking for a different billing period gives a different invoice number, so
   * what this business still owes on the current one becomes that invoice's
   * previous balance — which is the rule the whole ledger exists for.
   */
  const otherPeriod = (context.periods as any[]).find(
    (p) => p.from !== INVOICE.period.from || p.to !== INVOICE.period.to);
  if (otherPeriod) {
    const nextCtx = await api(
      `/api/super-admin/business-account/${target.id}/payments` +
      `?from=${otherPeriod.from}&to=${otherPeriod.to}`);
    if (nextCtx.json?.data?.invoice) {
      check('a DIFFERENT invoice carries the outstanding balance forward',
        Number(nextCtx.json.data.previous_balance) === Number(r2.remaining_balance),
        `${r2.remaining_balance} -> ${nextCtx.json.data.previous_balance}`);
      check('and its total due = carried balance + its own amount',
        Number(nextCtx.json.data.total_amount_due) ===
          Math.round((Number(nextCtx.json.data.previous_balance) +
            Number(nextCtx.json.data.invoice.current_invoice_amount)) * 100) / 100,
        `${nextCtx.json.data.previous_balance} + ` +
        `${nextCtx.json.data.invoice.current_invoice_amount} = ` +
        `${nextCtx.json.data.total_amount_due}`);
    } else {
      console.log('  SKIP  no second billable period, so carry-forward needs two invoices');
    }
  } else {
    console.log('  SKIP  only one billing period exists');
  }

  /* ================================================================
   * 5b. THE CARRY-FORWARD, ACROSS INVOICES
   *
   * The rule the whole ledger exists for: what is left unpaid on one invoice
   * becomes the PREVIOUS BALANCE of the next.
   *
   * This database has only one billable period, so an EARLIER invoice is
   * fabricated directly in the ledger -- a receipt against a different invoice
   * number, left with an outstanding balance. The current invoice's context
   * must then open with that balance carried forward. The row is removed
   * again immediately.
   * ================================================================ */
  console.log('\nCARRY-FORWARD ACROSS INVOICES');

  const EARLIER_INVOICE = 'SWC/INV/9999/20250101-20250131';
  const CARRIED = 4321.5;
  const seeded = await query(
    `INSERT INTO business_payment_receipts
       (receipt_number, business_id, invoice_number, invoice_period_from, invoice_period_to,
        payment_date, payment_type, previous_balance, current_invoice_amount,
        total_amount_due, payment_received, remaining_balance, notes)
     VALUES (?, ?, ?, '2025-01-01', '2025-01-31', '2025-02-01', 'CASH', 0, ?, ?, ?, ?, ?)`,
    [
      `SWR/SMOKE/${Date.now()}`, target.id, EARLIER_INVOICE,
      10000, 10000, 10000 - CARRIED, CARRIED, MARKER,
    ]
  );
  const seededId = String(seeded.insertId);

  try {
    const carriedCtx = await api(`/api/super-admin/business-account/${target.id}/payments`);
    check('an unpaid earlier invoice becomes the previous balance',
      Number(carriedCtx.json?.data?.previous_balance) === CARRIED,
      `${carriedCtx.json?.data?.previous_balance} (expected ${CARRIED})`);
    check('total due = carried balance + this invoice',
      Number(carriedCtx.json?.data?.total_amount_due) ===
        Math.round((CARRIED + AMOUNT) * 100) / 100,
      `${CARRIED} + ${AMOUNT} = ${carriedCtx.json?.data?.total_amount_due}`);

    // And a payment recorded now must store and apply that carried figure.
    const carriedPay = await post({
      ...base, payment_received: 1000, payment_type: 'CARD',
    });
    check('a payment against the current invoice carries it too',
      carriedPay.status === 201 &&
      Number(carriedPay.json?.data?.previous_balance) === CARRIED,
      `previous ${carriedPay.json?.data?.previous_balance}`);
    if (carriedPay.json?.data?.id) createdReceipts.push(carriedPay.json.data.id);
    check('and its remaining = carried + invoice - already paid - this payment',
      Number(carriedPay.json?.data?.remaining_balance) ===
        Math.round((CARRIED + AMOUNT - FIRST - SECOND - 1000) * 100) / 100,
      `${CARRIED} + ${AMOUNT} - ${FIRST} - ${SECOND} - 1000 = ` +
      `${carriedPay.json?.data?.remaining_balance}`);
  } finally {
    await query(`DELETE FROM business_payment_receipts WHERE id = ?`, [seededId]);
    console.log('  (fabricated earlier invoice removed)');
  }

  /* ================================================================
   * 6. THE BILLING RECEIPT PDF
   * ================================================================ */
  console.log('\nBILLING RECEIPT PDF');

  const pdfRes = await fetch(
    `${BASE}/api/super-admin/business-account/${target.id}/payments/${r1.id}/receipt.pdf`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const pdfBuf = Buffer.from(await pdfRes.arrayBuffer());
  check('the receipt PDF is generated',
    pdfRes.status === 200 && pdfBuf.subarray(0, 4).toString() === '%PDF',
    `${pdfRes.status}, ${pdfBuf.length} bytes`);

  const disposition = pdfRes.headers.get('content-disposition') || '';
  /*
   * `EstablishmentName_InvoiceId.pdf`, as specified: only the characters a
   * filesystem rejects become underscores. Spaces are kept -- the worked
   * example is `ABC Grand Hotel_INV20260823.pdf`.
   */
  const INVALID = /[<>:"/\\|?*]/g;
  const expectedFileName =
    `${String(target.name).replace(INVALID, '_').replace(/\s+/g, ' ').trim()}` +
    `_${INVOICE.invoice_number.slice(0, 12).replace(INVALID, '_')}.pdf`;
  check('the file name is EstablishmentName_InvoiceId.pdf',
    disposition.includes(expectedFileName),
    `${disposition} (expected ${expectedFileName})`);
  check('the establishment name keeps its spaces',
    !String(target.name).includes(' ') || disposition.includes(' '),
    disposition);
  check('the file name has no character a filesystem rejects',
    !/[<>:"/\\|?*]/.test(disposition.split('filename="')[1]?.replace('"', '') || ''),
    disposition);

  const { buildBillingReceiptDocument } =
    await import('../src/services/billingReceiptPdf.service');
  const doc = await buildBillingReceiptDocument(target.id, r1.id);
  check('the receipt names the establishment', doc.business_name === target.name,
    doc.business_name);
  check('it carries the four figures',
    doc.previous_balance === 0 && doc.current_invoice_amount === AMOUNT &&
    doc.total_amount_due === AMOUNT &&
    doc.remaining_balance === Math.round((AMOUNT - FIRST) * 100) / 100);
  const serialised = JSON.stringify(doc).toLowerCase();
  check('it carries no password, OTP or token',
    !serialised.includes('password') && !serialised.includes('otp') &&
    !serialised.includes('token'));

  const foreign = await api(
    `/api/super-admin/business-account/99999999/payments/${r1.id}`);
  check('a receipt cannot be read under another business id', foreign.status === 404,
    `status ${foreign.status}`);

  /* ================================================================
   * 7. NOTHING FINANCIAL WAS REWRITTEN
   * ================================================================ */
  console.log('\nORDERS AND INVOICES UNTOUCHED');

  check('no order line changed', ordersBefore === (await orderFingerprint()),
    'fingerprint identical');

  const invoiceAgain = await api(
    `/api/super-admin/businesses/${target.id}/invoice?from=${INVOICE.period.from}&to=${INVOICE.period.to}`);
  check('the invoice still totals what it did before any payment',
    Number(invoiceAgain.json?.data?.totals?.grand_total) === AMOUNT,
    `${invoiceAgain.json?.data?.totals?.grand_total} vs ${AMOUNT}`);
  check('and still carries its own 12-character label',
    invoiceAgain.json?.data?.invoice_number_display === INVOICE.invoice_number.slice(0, 12));

  // No exit and no report here: both live in the .finally() below, which
  // is also where the ledger this test wrote is cleaned up.
}

main()
  .catch((error) => {
    console.error('\nSMOKE TEST CRASHED:', error);
    failed += 1;
  })
  .finally(async () => {
    const removed = await removeTestReceipts();
    if (removed) console.log(`  (${removed} smoke-test receipt(s) removed)`);

    const remaining = await query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM business_payment_receipts`
    );
    console.log(`  (${remaining.rows[0].n} receipt(s) left in the ledger)`);

    console.log(`\n${passed} passed, ${failed} failed\n`);

    /*
     * `process.exitCode` and NOT `process.exit()`.
     *
     * stdout here is a pipe, and writes to a pipe are asynchronous — exiting
     * outright truncates the last lines of the report, which is how a cleanup
     * that did run can appear not to have. Closing the pool lets the process
     * end on its own once everything has flushed.
     */
    process.exitCode = failed === 0 ? 0 : 1;
    await pool.end();
  });
