/**
 * Smoke test for the INVOICE DATE and LAST GENERATED ON.
 *
 * Two dates that are routinely confused, so the rules are stated as tests:
 *
 *   INVOICE DATE = the billing period's last day + 2. A fact about the cycle:
 *   it does not depend on when anyone pressed Generate, and regenerating the
 *   invoice never moves it.
 *
 *   LAST GENERATED ON = when the document was actually produced, and it moves
 *   every time it is produced again.
 *
 *   ONE SOURCE. The Invoice Details block at the head of the PDF and the
 *   Acknowledgment strip at its foot both print the SAME field, so they can
 *   never disagree — checked by reading the dates back out of rendered bytes.
 *
 *   AND THE CARD AGREES WITH THE DOCUMENT. The Issued Invoice list derives the
 *   invoice date from the period on the row, through the same function, so a
 *   card and the PDF it opens are dated identically.
 *
 * It writes only 2019-period fixtures and removes them again.
 *
 *   npx ts-node scripts/smoke_invoice_dates.ts
 */
import dotenv from 'dotenv';
import zlib from 'zlib';
import { query, pool } from '../src/config/database';
import {
  invoiceDateFor,
  INVOICE_DATE_DAYS_AFTER_PERIOD,
  buildInvoice,
  GstInvoice,
} from '../src/services/gstInvoice.service';
import { renderInvoicePdf } from '../src/services/invoicePdf.service';
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

/** Every string the PDF draws — PDFKit writes kerned hex TJ arrays. */
function drawnStringsIn(pdf: Buffer): string[] {
  const raw = pdf.toString('latin1');
  const out: string[] = [];
  const streamRe = /stream\r?\n/g;
  let s: RegExpExecArray | null;
  while ((s = streamRe.exec(raw)) !== null) {
    const start = s.index + s[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) continue;
    let txt = '';
    try {
      txt = zlib.inflateSync(Buffer.from(raw.slice(start, end), 'latin1')).toString('latin1');
    } catch {
      continue;
    }
    const showRe = /\[((?:\s*<[0-9a-fA-F]*>\s*-?[\d.]*)*)\s*\]\s*TJ/g;
    let m: RegExpExecArray | null;
    while ((m = showRe.exec(txt)) !== null) {
      const hex = (m[1].match(/<([0-9a-fA-F]*)>/g) || []).map((h) => h.slice(1, -1)).join('');
      if (hex) out.push(Buffer.from(hex, 'hex').toString('latin1'));
    }
  }
  return out;
}

/** "2026-10-02" -> "02-10-2026", the format the document prints. */
const dmy = (iso: string) => {
  const [y, m, d] = iso.split('-');
  return `${d}-${m}-${y}`;
};

function fakeInvoice(
  businessId: string, number: string, from: string, to: string,
  laundryType: 'hotel' | 'guest' | null
): GstInvoice {
  return {
    invoice_number: number,
    invoice_serial: 9500,
    laundry_type: laundryType,
    period: { from, to, cycle: 'MONTHLY' },
    customer: { id: businessId },
    lines: [{}],
    orders: [{}],
    totals: {
      subtotal: 1000, discount_percent: 0, discount_amount: 0, taxable_value: 1000,
      total_tax: 180, grand_total: 1180,
    },
  } as any;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log('\nINVOICE DATE vs LAST GENERATED ON\n');

  /* ---- The rule itself, pure ---- */
  check('the offset is two days', INVOICE_DATE_DAYS_AFTER_PERIOD === 2);
  check('1–30 September bills as 2 October',
    invoiceDateFor('2026-09-30') === '2026-10-02', invoiceDateFor('2026-09-30'));
  check('1–15 October bills as 17 October',
    invoiceDateFor('2026-10-15') === '2026-10-17', invoiceDateFor('2026-10-15'));
  check('a 31-day month rolls into the next',
    invoiceDateFor('2026-08-31') === '2026-09-02', invoiceDateFor('2026-08-31'));
  check('the end of December rolls into the next YEAR',
    invoiceDateFor('2026-12-31') === '2027-01-02', invoiceDateFor('2026-12-31'));
  check('February in a leap year is handled',
    invoiceDateFor('2028-02-29') === '2028-03-02', invoiceDateFor('2028-02-29'));
  check('February in a common year is handled',
    invoiceDateFor('2027-02-28') === '2027-03-02', invoiceDateFor('2027-02-28'));
  check('a fortnight ending mid-month stays in the month',
    invoiceDateFor('2026-09-14') === '2026-09-16', invoiceDateFor('2026-09-14'));

  /* ---- IT DOES NOT DEPEND ON TODAY ---- */
  const twice = [invoiceDateFor('2026-09-30'), invoiceDateFor('2026-09-30')];
  check('the same period always yields the same date', twice[0] === twice[1]);

  /* ================================================================
   * THE DOCUMENT — both places print the one field
   * ================================================================ */
  console.log('\nTHE PDF\n');

  const withOrders = await query<{ business_id: string; period_from: unknown; period_to: unknown;
    laundry_type: any; discount_percent: any }>(
    `SELECT business_id, period_from, period_to, laundry_type, discount_percent
       FROM business_invoices ORDER BY id DESC LIMIT 6`
  );

  let rendered = 0;
  for (const row of withOrders.rows) {
    const from = String(row.period_from instanceof Date
      ? row.period_from.toISOString().slice(0, 10) : String(row.period_from).slice(0, 10));
    const to = String(row.period_to instanceof Date
      ? row.period_to.toISOString().slice(0, 10) : String(row.period_to).slice(0, 10));
    let invoice: GstInvoice;
    try {
      invoice = await buildInvoice(
        String(row.business_id), from, to, row.laundry_type,
        Number(row.discount_percent || 0), false, true
      );
    } catch (e: any) {
      if (e?.statusCode === 404 || e?.statusCode === 400) continue;
      throw e;
    }
    rendered += 1;

    const expected = invoiceDateFor(invoice.period.to);
    check(`${invoice.invoice_number}: invoice_date is period end + 2`,
      invoice.invoice_date === expected, `${invoice.period.to} -> ${invoice.invoice_date}`);

    const printed = drawnStringsIn(await renderInvoicePdf(invoice));
    const wanted = dmy(invoice.invoice_date);

    check(`${invoice.invoice_number}: the Invoice Details block prints it`,
      printed.some((s) => s.trim() === 'Invoice Date:') && printed.some((s) => s.includes(wanted)),
      `"${wanted}"`);
    check(`${invoice.invoice_number}: no bare "Date:" label remains`,
      !printed.some((s) => s.trim() === 'Date:'));

    /*
     * THE ACKNOWLEDGMENT IS ONLY DRAWN WHEN IT FITS — the strip is skipped on
     * an invoice whose lines reach the foot of the page, which is layout
     * behaviour this test does not govern. What it DOES govern: wherever a
     * date is printed under an "Invoice Date" label, it is the one date.
     */
    const labelled = printed.filter((s) => /Invoice Date\s*:/.test(s) && /\d{2}-\d{2}-\d{4}/.test(s));
    const wrong = labelled.filter((s) => !s.includes(wanted));
    check(`${invoice.invoice_number}: every printed Invoice Date is the same date`,
      wrong.length === 0, wrong.join(' | ') || `${labelled.length} labelled occurrence(s)`);

    const hasAcknowledgment = printed.some((s) => s.includes('Acknowledgment'));
    if (hasAcknowledgment) {
      check(`${invoice.invoice_number}: the Acknowledgment repeats the same date`,
        labelled.some((s) => s.includes(wanted)), `"${wanted}"`);
    } else {
      console.log(
        `  note  ${invoice.invoice_number}: no Acknowledgment strip — its lines fill the page`
      );
    }
  }
  if (rendered === 0) console.log('  SKIP  no stored invoice could be rebuilt to render');

  /* ================================================================
   * THE CARD — two different dates, and regeneration moves only one
   * ================================================================ */
  console.log('\nTHE INVOICE CARD\n');

  const biz = await query<{ id: number }>(`SELECT id FROM businesses ORDER BY id LIMIT 1`);
  const id = String(biz.rows[0].id);
  const NUM = 'SWCH/INV/9500';
  const FROM = '2019-06-01';
  const TO = '2019-06-30';
  const cleanup = `DELETE FROM business_invoices WHERE business_id = ? AND period_from = '2019-06-01'`;
  await query(cleanup, [id]);

  try {
    await recordInvoice(fakeInvoice(id, NUM, FROM, TO, 'hotel'));
    let entry = (await listInvoicesForBusiness(id)).invoices.find((i) => i.invoice_number === NUM)!;

    check('the card\'s invoice date is period end + 2',
      entry.invoice_date === invoiceDateFor(TO), `${TO} -> ${entry.invoice_date}`);
    check('and it is NOT today', entry.invoice_date !== entry.last_generated_on,
      `invoice date ${entry.invoice_date}, generated ${entry.last_generated_on}`);
    check('last generated on is a plain date', /^\d{4}-\d{2}-\d{2}$/.test(entry.last_generated_on),
      entry.last_generated_on);

    const firstInvoiceDate = entry.invoice_date;
    const firstGeneratedOn = entry.last_generated_on;
    const firstGeneratedAt = entry.last_generated_at;

    // Regenerate the same billing period, as adding late orders would.
    await sleep(1100);
    await recordInvoice(fakeInvoice(id, NUM, FROM, TO, 'hotel'));
    entry = (await listInvoicesForBusiness(id)).invoices.find((i) => i.invoice_number === NUM)!;

    check('regenerating does NOT move the invoice date',
      entry.invoice_date === firstInvoiceDate, `${firstInvoiceDate} -> ${entry.invoice_date}`);
    check('but it DOES move last generated at',
      entry.last_generated_at > firstGeneratedAt,
      `${firstGeneratedAt} -> ${entry.last_generated_at}`);
    check('and last generated on stays a valid date',
      /^\d{4}-\d{2}-\d{2}$/.test(entry.last_generated_on) &&
        entry.last_generated_on >= firstGeneratedOn,
      entry.last_generated_on);
    check('the two dates are different fields, not one',
      entry.invoice_date !== entry.last_generated_on,
      `${entry.invoice_date} vs ${entry.last_generated_on}`);
  } finally {
    await query(cleanup, [id]);
    const left = await query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM business_invoices WHERE business_id = ? AND period_from = '2019-06-01'`,
      [id]
    );
    check('the fixture was removed', Number(left.rows[0].n) === 0);
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
