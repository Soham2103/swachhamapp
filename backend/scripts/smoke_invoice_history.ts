/**
 * Smoke test for Invoice History and the Weekly billing cycle.
 *
 * The two things worth being certain about:
 *
 *   ISOLATION   one business's invoices never appear in another's history,
 *               and asking for business A's invoice id under business B is a
 *               404 rather than a disclosure.
 *
 *   SNAPSHOT    the stored amounts are what the invoice was ISSUED for, and
 *               regenerating the same period updates that one row instead of
 *               minting a second invoice.
 *
 * Plus the billing-cycle arithmetic, which is pure and needs no server.
 *
 * IT CLEANS UP AFTER ITSELF: every row it writes is deleted again.
 *
 *   npx ts-node scripts/smoke_invoice_history.ts
 */
import dotenv from 'dotenv';
import { query, pool } from '../src/config/database';
import { periodFor, BILLING_CYCLE_LABELS, listBillingCycles } from '../src/services/billingCycle.service';
import {
  recordInvoice,
  listInvoicesForBusiness,
  getInvoiceForBusiness,
} from '../src/services/invoiceHistory.service';

dotenv.config();

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { passed += 1; console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`); }
  else { failed += 1; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

/**
 * A minimal invoice shaped like the one gstInvoice.service returns.
 *
 * `discountPercent` drives the sub total, because the two are only the same
 * figure when there is no deduction — which is exactly the case the stored
 * `subtotal_amount` exists to tell apart from the taxable value.
 */
function fakeInvoice(
  businessId: string,
  number: string,
  from: string,
  to: string,
  total: number,
  discountPercent = 0
) {
  const taxable = total / 1.18;
  const subtotal = discountPercent > 0 ? taxable / (1 - discountPercent / 100) : taxable;
  return {
    invoice_number: number,
    period: { from, to, cycle: 'MONTHLY' as const },
    customer: { id: businessId },
    laundry_type: null,
    lines: [{}, {}, {}],
    orders: [{}, {}],
    totals: {
      subtotal: Math.round(subtotal * 100) / 100,
      discount_percent: discountPercent,
      discount_amount: Math.round((subtotal - taxable) * 100) / 100,
      taxable_value: Math.round(taxable * 100) / 100,
      total_tax: Math.round((total - taxable) * 100) / 100,
      grand_total: total,
    },
  } as any;
}

/** Waits out MySQL's one-second TIMESTAMP resolution, so an order is provable. */
const tick = () => new Promise((r) => setTimeout(r, 1100));

async function main() {
  /* ================================================================
   * BILLING CYCLES — pure arithmetic, no server needed
   * ================================================================ */
  console.log('\nBILLING CYCLES');

  const cycles = listBillingCycles();
  check('registration offers exactly four cycles', cycles.length === 4, cycles.map((c) => c.label).join(', '));
  check('they are Weekly, 15 Days, Monthly, Yearly',
    ['Weekly', '15 Days', 'Monthly', 'Yearly'].every((l) => cycles.some((c) => c.label === l)),
    cycles.map((c) => `${c.value}=${c.label}`).join(' | '));
  check('Quarterly and Half-Yearly are no longer offered',
    !cycles.some((c) => c.value === 'QUARTERLY' || c.value === 'HALF_YEARLY'));
  check('but they remain addressable for a legacy business',
    listBillingCycles({ all: true }).some((c) => c.value === 'QUARTERLY'));
  check('FORTNIGHTLY is labelled "15 Days"', BILLING_CYCLE_LABELS.FORTNIGHTLY === '15 Days');

  // -- WEEKLY: Monday to Sunday, anchored to the calendar --
  // 2026-08-28 is a Friday; its week is Mon 24 Aug – Sun 30 Aug.
  const w = periodFor('WEEKLY', '2026-08-28');
  check('a weekly period starts on Monday', w.from === '2026-08-24', w.from);
  check('and ends on the Sunday', w.to === '2026-08-30', w.to);
  check('it is exactly seven days',
    (Date.parse(w.to) - Date.parse(w.from)) / 86400000 === 6, w.label);

  const monday = periodFor('WEEKLY', '2026-08-24');
  check('a Monday belongs to the week it starts', monday.from === '2026-08-24', monday.from);
  const sunday = periodFor('WEEKLY', '2026-08-30');
  check('a Sunday belongs to the week it ends, not the next one',
    sunday.from === '2026-08-24', `${sunday.from}..${sunday.to}`);

  // A week spanning a month boundary must still be seven days.
  const across = periodFor('WEEKLY', '2026-10-01');
  check('a week across a month boundary is still seven days',
    (Date.parse(across.to) - Date.parse(across.from)) / 86400000 === 6,
    `${across.from}..${across.to} — ${across.label}`);
  check('and its label names both months', across.label.includes('–'), across.label);

  // The other cycles must not have moved.
  check('MONTHLY is unchanged', periodFor('MONTHLY', '2026-08-28').from === '2026-08-01');
  check('FORTNIGHTLY is unchanged (15th–end)',
    periodFor('FORTNIGHTLY', '2026-08-28').from === '2026-08-15');
  check('YEARLY is unchanged', periodFor('YEARLY', '2026-08-28').to === '2026-12-31');

  /* ================================================================
   * INVOICE HISTORY — against the real database
   * ================================================================ */
  console.log('\nINVOICE HISTORY');

  const businesses = await query<{ id: number; name: string }>(
    `SELECT id, name FROM businesses ORDER BY id LIMIT 2`
  );
  if (businesses.rows.length < 2) {
    console.log('  SKIP  need two businesses in the database to test isolation');
    console.log(`\n${passed} passed, ${failed} failed`);
    await pool.end();
    process.exit(failed ? 1 : 0);
  }

  const [A, B] = businesses.rows;
  const numA = `SMOKE/INV/${A.id}/A`;
  const numB = `SMOKE/INV/${B.id}/B`;

  // Clean any leftovers from an interrupted run.
  await query(`DELETE FROM business_invoices WHERE invoice_number IN (?, ?)`, [numA, numB]);

  try {
    /*
     * A PERIOD NO REAL INVOICE CAN BE IN.
     *
     * These were August 2026 — a month these businesses do have invoices for.
     * `recordInvoice` is idempotent per business + cycle + laundry type +
     * period month, so a fixture landing on a real invoice's month UPDATES
     * that row, renaming it to the SMOKE number — and the cleanup at the end
     * of this block then deletes it. 2019 predates the system, so these rows
     * can only ever be this test's own.
     */
    await recordInvoice(fakeInvoice(String(A.id), numA, '2019-08-01', '2019-08-31', 1180));
    await recordInvoice(fakeInvoice(String(B.id), numB, '2019-08-01', '2019-08-31', 2360));

    const histA = await listInvoicesForBusiness(String(A.id));
    const histB = await listInvoicesForBusiness(String(B.id));

    check('the invoice appears in its own business history',
      histA.invoices.some((i) => i.invoice_number === numA));
    check("and NOT in the other business's history",
      !histA.invoices.some((i) => i.invoice_number === numB),
      `business ${A.id} history has ${histA.invoices.length} invoice(s)`);
    check("the other business sees only its own",
      histB.invoices.some((i) => i.invoice_number === numB) &&
      !histB.invoices.some((i) => i.invoice_number === numA));

    const mine = histA.invoices.find((i) => i.invoice_number === numA)!;
    check('the stored total is the amount it was issued for', mine.total_amount === 1180, String(mine.total_amount));
    check('the order and line counts are stored', mine.order_count === 2 && mine.line_count === 3,
      `${mine.order_count} orders, ${mine.line_count} lines`);
    check('an unpaid invoice reads ISSUED', mine.status === 'ISSUED', mine.status);
    check('the whole total is outstanding', mine.amount_due === 1180, String(mine.amount_due));
    check('it carries the business name', !!mine.business_name, mine.business_name);
    check('the period is returned as plain dates',
      mine.period_from === '2019-08-01' && mine.period_to === '2019-08-31',
      `${mine.period_from}..${mine.period_to}`);

    // -- REGENERATING THE SAME INVOICE MUST NOT DUPLICATE IT --
    const before = (await listInvoicesForBusiness(String(A.id))).total;
    await recordInvoice(fakeInvoice(String(A.id), numA, '2019-08-01', '2019-08-31', 1500));
    const after = await listInvoicesForBusiness(String(A.id));
    check('regenerating the same invoice does not add a second row',
      after.total === before, `${before} -> ${after.total}`);
    check('but it does update the amount',
      after.invoices.find((i) => i.invoice_number === numA)?.total_amount === 1500);

    // -- CROSS-BUSINESS LOOKUP MUST 404 --
    const idOfA = mine.id;
    let refused = false;
    try {
      await getInvoiceForBusiness(String(B.id), idOfA);
    } catch (e: any) {
      refused = e?.statusCode === 404 || /not found/i.test(String(e?.message));
    }
    check("business B cannot open business A's invoice by id", refused);

    // And the same id under its own business still works.
    const ok = await getInvoiceForBusiness(String(A.id), idOfA);
    check('while its own business can', ok.invoice_number === numA);
  } finally {
    await query(`DELETE FROM business_invoices WHERE invoice_number IN (?, ?)`, [numA, numB]);
  }

  /* ================================================================
   * ISSUED INVOICE — the latest generated one is at the TOP
   *
   * The list used to be ordered by the period it covered, so an invoice
   * raised today for an older month appeared below one raised weeks ago for
   * a later month — and an operator who had just pressed Generate Invoice
   * could not find it. These are the three cases that distinguishes.
   * ================================================================ */
  console.log('\nISSUED INVOICE — ORDERING');

  const numOld = `SMOKE/INV/${A.id}/OLD`;
  const numNew = `SMOKE/INV/${A.id}/NEW`;
  await query(`DELETE FROM business_invoices WHERE invoice_number IN (?, ?)`, [numOld, numNew]);

  try {
    /*
     * THE PERIODS ARE IN 2019, DELIBERATELY.
     *
     * `recordInvoice` is idempotent per business + cycle + laundry type +
     * period MONTH, so a fixture landing on a month this business really has
     * an invoice for would update that row — and the cleanup below would then
     * delete a real invoice. 2019 predates the system, so these rows can only
     * ever be this test's own.
     */
    // Raised first, for the LATER period. Under the old ordering this row
    // outranked everything below it whatever was generated afterwards.
    await recordInvoice(fakeInvoice(String(A.id), numNew, '2019-08-01', '2019-08-31', 5000));
    await tick();
    // Raised second, for an EARLIER period — the case that used to sink.
    await recordInvoice(fakeInvoice(String(A.id), numOld, '2019-01-01', '2019-01-31', 3000));

    let list = (await listInvoicesForBusiness(String(A.id))).invoices;
    check(
      'the invoice generated last is first, even though its period is older',
      list[0]?.invoice_number === numOld,
      `top is ${list[0]?.invoice_number}`
    );
    check(
      'the one generated before it is next',
      list[1]?.invoice_number === numNew,
      `second is ${list[1]?.invoice_number}`
    );

    // -- REGENERATING AN OLD INVOICE BRINGS IT BACK TO THE TOP --
    const countBefore = (await listInvoicesForBusiness(String(A.id))).total;
    const issuedBefore = list.find((i) => i.invoice_number === numNew)!.generated_at;
    await tick();
    await recordInvoice(fakeInvoice(String(A.id), numNew, '2019-08-01', '2019-08-31', 5000));

    const after = await listInvoicesForBusiness(String(A.id));
    list = after.invoices;
    check(
      'regenerating an invoice brings it to the top of the list',
      list[0]?.invoice_number === numNew,
      `top is ${list[0]?.invoice_number}`
    );
    check(
      'and does NOT add a second entry for it',
      after.total === countBefore,
      `${countBefore} -> ${after.total}`
    );
    check(
      'while the moment it was first issued is untouched',
      list[0]?.generated_at === issuedBefore,
      `${issuedBefore} -> ${list[0]?.generated_at}`
    );
    check(
      'and its last-generated time HAS moved',
      !!list[0] && list[0].last_generated_at > list[0].generated_at,
      `issued ${list[0]?.generated_at}, regenerated ${list[0]?.last_generated_at}`
    );

    /* ================================================================
     * ISSUED INVOICE — the figures the card shows
     * ================================================================ */
    console.log('\nISSUED INVOICE — FIGURES');

    const numDisc = `SMOKE/INV/${A.id}/DISC`;
    await query(`DELETE FROM business_invoices WHERE invoice_number = ?`, [numDisc]);
    // 11800 payable at 12% off: sub total 11363.64, deduction 1363.64,
    // taxable 10000, tax 1800.
    await recordInvoice(fakeInvoice(String(A.id), numDisc, '2019-03-01', '2019-03-31', 11800, 12));
    const disc = (await listInvoicesForBusiness(String(A.id))).invoices
      .find((i) => i.invoice_number === numDisc)!;

    check(
      'the Sub Total is stored, not inferred from the taxable value',
      Math.abs(disc.subtotal_amount - 11363.64) < 0.02,
      String(disc.subtotal_amount)
    );
    check(
      'the deduction is the difference between Sub Total and Taxable',
      Math.abs(disc.subtotal_amount - disc.discount_amount - disc.taxable_amount) < 0.02,
      `${disc.subtotal_amount} - ${disc.discount_amount} = ${disc.taxable_amount}`
    );
    check(
      'Taxable + tax = Total on the stored row',
      Math.abs(disc.taxable_amount + disc.tax_amount - disc.total_amount) < 0.02,
      `${disc.taxable_amount} + ${disc.tax_amount} = ${disc.total_amount}`
    );
    check('the deduction percentage is carried', disc.discount_percent === 12,
      String(disc.discount_percent));

    await query(`DELETE FROM business_invoices WHERE invoice_number = ?`, [numDisc]);
  } finally {
    await query(`DELETE FROM business_invoices WHERE invoice_number IN (?, ?)`, [numOld, numNew]);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  await pool.end();
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
