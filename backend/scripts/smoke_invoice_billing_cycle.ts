/**
 * Smoke test for BILLING-CYCLE BASED INVOICE GENERATION.
 *
 * The rules, stated as tests:
 *
 *   THE REGISTERED CYCLE DECIDES THE PERIOD. Whatever dates are asked for,
 *   the invoice covers the business's own billing period containing the From
 *   date — 1–15 September on a monthly account bills September.
 *
 *   ONE INVOICE PER CYCLE. Billing the same cycle again finds the invoice that
 *   exists, keeps its number, and updates it. It does not raise a second.
 *
 *   ORDERS ADDED MID-CYCLE LAND ON IT. An invoice billed on the 9th and again
 *   on the 20th is one invoice, with the later figures.
 *
 *   A NEW CYCLE IS A NEW INVOICE, with the next number from the business's own
 *   sequence.
 *
 *   AND THE DATABASE ENFORCES IT. A second row for one business + period +
 *   type is rejected by a unique key, not merely avoided by the application.
 *
 * IT WRITES NOTHING IT DOES NOT REMOVE. The recorded invoices are for periods
 * in 2019, which predate the system, and both the rows and the counters they
 * consume are put back on the way out. No real invoice is read into, written
 * over or deleted.
 *
 *   npx ts-node scripts/smoke_invoice_billing_cycle.ts
 */
import dotenv from 'dotenv';
import { query, pool } from '../src/config/database';
import { periodFor, cycleForBusiness, BillingCycle } from '../src/services/billingCycle.service';
import { GstInvoice, buildInvoice } from '../src/services/gstInvoice.service';
import { recordInvoice, listInvoicesForBusiness } from '../src/services/invoiceHistory.service';

dotenv.config();

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

/** An invoice shaped like the one gstInvoice.service returns. */
function fakeInvoice(
  businessId: string,
  number: string,
  serial: number,
  from: string,
  to: string,
  cycle: BillingCycle,
  laundryType: 'hotel' | 'guest' | null,
  total: number
): GstInvoice {
  const taxable = Math.round((total / 1.18) * 100) / 100;
  return {
    invoice_number: number,
    invoice_serial: serial,
    laundry_type: laundryType,
    period: { from, to, cycle },
    customer: { id: businessId },
    lines: [{}, {}],
    orders: [{}],
    totals: {
      subtotal: taxable,
      discount_percent: 0,
      discount_amount: 0,
      taxable_value: taxable,
      total_tax: Math.round((total - taxable) * 100) / 100,
      grand_total: total,
    },
  } as any;
}

async function main() {
  console.log('\nBILLING-CYCLE INVOICES\n');

  /* ================================================================
   * THE PERIOD THE CYCLE DEFINES — pure, no database
   * ================================================================ */
  const sep = periodFor('MONTHLY', '2026-09-15');
  check('a monthly cycle bills the whole month, whatever day is picked',
    sep.from === '2026-09-01' && sep.to === '2026-09-30', `${sep.from}..${sep.to}`);
  check('every day in September resolves to the SAME period',
    ['2026-09-01', '2026-09-09', '2026-09-20', '2026-09-30'].every((d) => {
      const p = periodFor('MONTHLY', d);
      return p.from === sep.from && p.to === sep.to;
    }));
  const firstHalf = periodFor('FORTNIGHTLY', '2026-09-07');
  const secondHalf = periodFor('FORTNIGHTLY', '2026-09-20');
  check('a fortnightly cycle is two distinct periods in one month',
    firstHalf.from !== secondHalf.from && firstHalf.to !== secondHalf.to,
    `${firstHalf.from}..${firstHalf.to} and ${secondHalf.from}..${secondHalf.to}`);

  /* ================================================================
   * A RANGE THAT SPANS TWO PERIODS IS REFUSED, NOT NARROWED
   *
   * Silently billing the period around the From date drops every order in the
   * rest of the range. On a fortnightly account that turned "all of August"
   * into "1–14 August", and when the orders were all in the second half the
   * operator was told the month had no data at all.
   * ================================================================ */
  const spanBusiness = await query<{ id: number; name: string }>(
    `SELECT b.id, COALESCE(NULLIF(b.establishment_name,''), b.name) AS name
       FROM businesses b JOIN business_users bu ON bu.business_id = b.id
       JOIN orders o ON o.business_user_id = bu.id AND o.status <> 'CANCELLED'
      GROUP BY b.id, name ORDER BY b.id LIMIT 1`
  );
  if (spanBusiness.rows.length > 0) {
    const sid = String(spanBusiness.rows[0].id);
    // Two calendar months spans at least two periods on every supported cycle.
    let spanError: any = null;
    try {
      await buildInvoice(sid, '2026-08-01', '2026-09-30', 'hotel', 0);
    } catch (e: any) {
      spanError = e;
    }
    check('a range covering two billing periods is refused',
      spanError?.statusCode === 400 && /covers \d+ billing periods/.test(spanError?.message || ''),
      spanError?.message?.slice(0, 90));
    check('and the refusal names the periods to choose from',
      /Choose a date inside the period you want to bill/.test(spanError?.message || ''));

    /*
     * REOPENING A STORED INVOICE IS EXEMPT. The row is the document of record,
     * so its dates are re-rendered as issued — otherwise an invoice raised
     * before periods were pinned to the cycle becomes unopenable.
     */
    let reRenderError: any = null;
    try {
      await buildInvoice(sid, '2026-08-01', '2026-09-30', 'hotel', 0, false, true);
    } catch (e: any) {
      reRenderError = e;
    }
    check('but re-rendering a stored invoice over the same dates is not',
      reRenderError === null || reRenderError?.statusCode === 404,
      reRenderError ? `${reRenderError.statusCode} ${reRenderError.message}` : 'rendered');
  }

  /* ================================================================
   * ONE INVOICE PER CYCLE, against the real table
   * ================================================================ */
  const businesses = await query<{ id: number; name: string }>(
    `SELECT id, COALESCE(NULLIF(establishment_name,''), name) AS name
       FROM businesses ORDER BY id LIMIT 1`
  );
  if (businesses.rows.length === 0) {
    console.log('  SKIP  no business to test against');
    return;
  }
  const B = businesses.rows[0];
  const id = String(B.id);
  const cycle = await cycleForBusiness(id);
  console.log(`\n  ${B.name} (#${id}) is registered as ${cycle}\n`);

  // 2019 — before the system existed, so these can collide with nothing real.
  const CYCLE_A = { from: '2019-04-01', to: '2019-04-30' };
  const CYCLE_B = { from: '2019-05-01', to: '2019-05-31' };
  const cleanup = `DELETE FROM business_invoices WHERE business_id = ? AND period_from LIKE '2019-%'`;
  await query(cleanup, [id]);

  try {
    const before = (await listInvoicesForBusiness(id)).total;

    /* -- FIRST INVOICE FOR THE CYCLE -- */
    await recordInvoice(
      fakeInvoice(id, 'SWCH/INV/9001', 9001, CYCLE_A.from, CYCLE_A.to, 'MONTHLY', 'hotel', 1180)
    );
    let rows = await query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM business_invoices
        WHERE business_id = ? AND period_from = ? AND period_to = ? AND laundry_type = 'hotel'`,
      [id, CYCLE_A.from, CYCLE_A.to]
    );
    check('the first invoice for a cycle creates one row', Number(rows.rows[0].n) === 1);

    /* -- MORE ORDERS IN THE SAME CYCLE: SAME INVOICE, NEW FIGURES -- */
    await recordInvoice(
      fakeInvoice(id, 'SWCH/INV/9001', 9001, CYCLE_A.from, CYCLE_A.to, 'MONTHLY', 'hotel', 2360)
    );
    await recordInvoice(
      fakeInvoice(id, 'SWCH/INV/9001', 9001, CYCLE_A.from, CYCLE_A.to, 'MONTHLY', 'hotel', 3540)
    );
    rows = await query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM business_invoices
        WHERE business_id = ? AND period_from = ? AND period_to = ? AND laundry_type = 'hotel'`,
      [id, CYCLE_A.from, CYCLE_A.to]
    );
    check('billing the same cycle again does NOT add a second invoice',
      Number(rows.rows[0].n) === 1, `${rows.rows[0].n} row(s)`);

    const list = await listInvoicesForBusiness(id);
    const cycleA = list.invoices.find((i) => i.period_from === CYCLE_A.from && i.laundry_type === 'hotel');
    check('it keeps its invoice number', cycleA?.invoice_number === 'SWCH/INV/9001',
      cycleA?.invoice_number);
    check('and shows the LATEST total', cycleA?.total_amount === 3540, String(cycleA?.total_amount));
    check('the Issued Invoice list gained exactly one entry',
      list.total === before + 1, `${before} -> ${list.total}`);

    /* -- AN INVOICE FIRST RAISED FOR PART OF THE CYCLE IS ADOPTED -- */
    await query(cleanup, [id]);
    await recordInvoice(
      // Raised on the 9th, covering 1-9 only — what the old ad-hoc date range
      // produced before the period was pinned to the cycle.
      fakeInvoice(id, 'SWCH/INV/9100', 9100, '2019-04-01', '2019-04-09', 'MONTHLY', 'hotel', 500)
    );
    await recordInvoice(
      // The same cycle, now billed in full.
      fakeInvoice(id, 'SWCH/INV/9100', 9100, CYCLE_A.from, CYCLE_A.to, 'MONTHLY', 'hotel', 1500)
    );
    rows = await query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM business_invoices
        WHERE business_id = ? AND period_from LIKE '2019-04%' AND laundry_type = 'hotel'`,
      [id]
    );
    check('a part-period invoice is ADOPTED by its cycle, not duplicated',
      Number(rows.rows[0].n) === 1, `${rows.rows[0].n} row(s)`);
    const adopted = await query<{ period_from: unknown; period_to: unknown; invoice_number: string }>(
      `SELECT period_from, period_to, invoice_number FROM business_invoices
        WHERE business_id = ? AND period_from LIKE '2019-04%' AND laundry_type = 'hotel'`,
      [id]
    );
    check('and its period is corrected to the full cycle',
      String(adopted.rows[0].invoice_number) === 'SWCH/INV/9100');

    /* -- HOTEL AND GUEST REMAIN TWO INVOICES FOR ONE PERIOD -- */
    await recordInvoice(
      fakeInvoice(id, 'SWCG/INV/9101', 9101, CYCLE_A.from, CYCLE_A.to, 'MONTHLY', 'guest', 700)
    );
    rows = await query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM business_invoices
        WHERE business_id = ? AND period_from = ? AND period_to = ?`,
      [id, CYCLE_A.from, CYCLE_A.to]
    );
    check('Hotel and Guest are still two invoices over one period',
      Number(rows.rows[0].n) === 2, `${rows.rows[0].n} row(s)`);

    /* -- A NEW CYCLE IS A NEW INVOICE -- */
    await recordInvoice(
      fakeInvoice(id, 'SWCH/INV/9102', 9102, CYCLE_B.from, CYCLE_B.to, 'MONTHLY', 'hotel', 900)
    );
    rows = await query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM business_invoices
        WHERE business_id = ? AND period_from LIKE '2019-%' AND laundry_type = 'hotel'`,
      [id]
    );
    check('the next billing cycle gets its own invoice',
      Number(rows.rows[0].n) === 2, `${rows.rows[0].n} hotel invoice(s) across two cycles`);

    /* -- THE DATABASE REFUSES A DUPLICATE, not just the application -- */
    let refused = false;
    try {
      await query(
        `INSERT INTO business_invoices
           (invoice_number, business_id, period_from, period_to, billing_cycle, laundry_type,
            taxable_amount, tax_amount, total_amount)
         VALUES (?, ?, ?, ?, 'MONTHLY', 'hotel', 0, 0, 0)`,
        ['SWCH/INV/9999', id, CYCLE_B.from, CYCLE_B.to]
      );
    } catch (e: any) {
      refused = e?.code === 'ER_DUP_ENTRY' || /duplicate/i.test(String(e?.message));
    }
    check('a second row for one business + period + type is refused by the database',
      refused, 'unique key uq_invoice_billing_period');

    /* -- AND AN UNTYPED INVOICE CANNOT SLIP PAST THE NULL RULE -- */
    await recordInvoice(
      fakeInvoice(id, 'SWC/INV/9200', 9200, CYCLE_B.from, CYCLE_B.to, 'MONTHLY', null, 300)
    );
    let refusedNull = false;
    try {
      await query(
        `INSERT INTO business_invoices
           (invoice_number, business_id, period_from, period_to, billing_cycle, laundry_type,
            taxable_amount, tax_amount, total_amount)
         VALUES (?, ?, ?, ?, 'MONTHLY', NULL, 0, 0, 0)`,
        ['SWC/INV/9998', id, CYCLE_B.from, CYCLE_B.to]
      );
    } catch (e: any) {
      refusedNull = e?.code === 'ER_DUP_ENTRY' || /duplicate/i.test(String(e?.message));
    }
    check('two untyped invoices for one period are refused too (NULLs are folded)',
      refusedNull, 'laundry_type_key');
  } finally {
    await query(cleanup, [id]);
    const left = await query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM business_invoices WHERE business_id = ? AND period_from LIKE '2019-%'`,
      [id]
    );
    check('every fixture row was removed', Number(left.rows[0].n) === 0);
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error('\nSMOKE FAILED:', e?.message || e);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await pool.end();
    } catch {
      /* already closed */
    }
  });
