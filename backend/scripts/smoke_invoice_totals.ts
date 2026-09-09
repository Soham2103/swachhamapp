/**
 * Smoke test for the invoice's arithmetic, end to end.
 *
 * ONE QUESTION: does every figure the invoice states follow from the ones
 * printed beside it?
 *
 *   Sum of the Amount column   =  Sub Total
 *   Sub Total  -  Deduction    =  Taxable Amount
 *   Taxable Amount  x  rate    =  CGST + SGST (or IGST)
 *   Taxable Amount  +  tax     =  Total
 *   Quantity  x  Price/unit    =  the line's own Amount
 *
 * and does the PDF print those same numbers rather than working any of them
 * out again? The rendered document is read back and its Total row is compared
 * with the invoice's Sub Total, because the table total used to be a second,
 * independently written sum and could land a paisa away from it.
 *
 * It runs against whatever is in the database: every business with billable
 * orders, over its own current billing period and over an explicit range,
 * at several deductions. NOTHING IS WRITTEN — `buildInvoice` is called with
 * `issue` left false throughout, so no invoice serial is consumed and no
 * history row is created or changed.
 *
 *   npx ts-node scripts/smoke_invoice_totals.ts
 */
import dotenv from 'dotenv';
import { query, pool } from '../src/config/database';
import { buildInvoice, GstInvoice, InvoiceLaundryType } from '../src/services/gstInvoice.service';
import { renderInvoicePdf } from '../src/services/invoicePdf.service';

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

/** Money compares to the paisa: anything further out is a rounding fault. */
const EQ = (a: number, b: number) => Math.abs(a - b) < 0.005;
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Every figure on one invoice, checked against the ones it is derived from.
 *
 * The label carries the business and the period so a failure names the
 * invoice that produced it rather than only the rule that broke.
 */
function assertInvoiceAddsUp(label: string, invoice: GstInvoice) {
  const t = invoice.totals;

  // Each line's Amount is the multiplication the two columns beside it state.
  const badLine = invoice.lines.find((l) => !EQ(l.amount, r2(l.quantity * l.rate)));
  check(
    `${label}: every line Amount = Quantity x Price/unit`,
    !badLine,
    badLine
      ? `"${badLine.description}" shows ${badLine.amount} for ${badLine.quantity} x ${badLine.rate}`
      : `${invoice.lines.length} line(s)`
  );

  // The subtotal is that column added up — the whole point of the fix.
  const columnSum = r2(invoice.lines.reduce((s, l) => s + l.amount, 0));
  check(
    `${label}: Sub Total = sum of the Amount column`,
    EQ(columnSum, t.subtotal),
    `column ${columnSum} vs subtotal ${t.subtotal}`
  );

  // ...and the line value the tax is taken on is that same figure, not a
  // second one read from order_items.total_price.
  const taxableSum = r2(invoice.lines.reduce((s, l) => s + l.taxable, 0));
  check(
    `${label}: the billed line values are the printed ones`,
    EQ(taxableSum, columnSum),
    `taxable ${taxableSum} vs column ${columnSum}`
  );

  check(
    `${label}: Sub Total - deduction = Taxable Amount`,
    EQ(r2(t.subtotal - t.discount_amount), t.taxable_value),
    `${t.subtotal} - ${t.discount_amount} = ${t.taxable_value}`
  );

  check(
    `${label}: tax = ${t.gst_rate}% of the Taxable Amount`,
    EQ(t.total_tax, r2((t.taxable_value * t.gst_rate) / 100)),
    `${t.total_tax} vs ${r2((t.taxable_value * t.gst_rate) / 100)}`
  );

  check(
    `${label}: the tax rows add up to the tax`,
    EQ(r2(t.cgst + t.sgst + t.igst), t.total_tax),
    `${t.cgst} + ${t.sgst} + ${t.igst} = ${t.total_tax}`
  );

  check(
    `${label}: Taxable Amount + tax = Total`,
    EQ(r2(t.taxable_value + t.total_tax), t.grand_total),
    `${t.taxable_value} + ${t.total_tax} = ${t.grand_total}`
  );

  // The scan-to-pay amount is the Total, not a third calculation of it.
  if (invoice.upi_payment.available && invoice.upi_payment.amount != null) {
    check(
      `${label}: the UPI amount is the Total`,
      EQ(Number(invoice.upi_payment.amount), t.grand_total),
      `${invoice.upi_payment.amount} vs ${t.grand_total}`
    );
  }
}

/**
 * EVERY STRING THE PDF ACTUALLY DRAWS, read back out of the rendered bytes.
 *
 * Two layers have to come off first:
 *
 *   1. PDFKit FlateDecodes its content streams, so they are inflated. The
 *      ones that are not deflate (the logo, the QR, the watermark) are
 *      skipped rather than reported.
 *   2. It shows text as a KERNED ARRAY of hex runs — `[<54> 80 <6178> 0] TJ`,
 *      not `(Tax) Tj` — so the hex runs inside each array are concatenated
 *      and decoded. The numbers between them are letter-spacing adjustments
 *      and carry no characters.
 *
 * One `doc.text(...)` call becomes one TJ, so each returned string is one
 * thing the document printed — which is what makes counting occurrences of a
 * figure meaningful.
 */
function drawnStringsIn(pdf: Buffer): string[] {
  const zlib = require('zlib') as typeof import('zlib');
  const raw = pdf.toString('latin1');
  const out: string[] = [];

  const collect = (content: string) => {
    const showRe = /\[((?:\s*<[0-9a-fA-F]*>\s*-?[\d.]*)*)\s*\]\s*TJ/g;
    let m: RegExpExecArray | null;
    while ((m = showRe.exec(content)) !== null) {
      const hex = (m[1].match(/<([0-9a-fA-F]*)>/g) || [])
        .map((h) => h.slice(1, -1))
        .join('');
      if (hex) out.push(Buffer.from(hex, 'hex').toString('latin1'));
    }
  };

  const streamRe = /stream\r?\n/g;
  let s: RegExpExecArray | null;
  while ((s = streamRe.exec(raw)) !== null) {
    const start = s.index + s[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) continue;
    try {
      collect(zlib.inflateSync(Buffer.from(raw.slice(start, end), 'latin1')).toString('latin1'));
    } catch {
      // Not a deflate stream — an image or a font, with nothing to read.
    }
  }
  return out;
}

/** Just the money-shaped ones, which is what the totals tests compare. */
function moneyStringsIn(pdf: Buffer): string[] {
  return drawnStringsIn(pdf).filter((s) => /^-?[\d,]+\.\d{2}$/.test(s.trim())).map((s) => s.trim());
}

const inr = (value: number): string => {
  const fixed = Math.abs(value).toFixed(2);
  const [whole, paise] = fixed.split('.');
  const last3 = whole.slice(-3);
  const rest = whole.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}` : last3;
  return `${value < 0 ? '-' : ''}${grouped}.${paise}`;
};

async function assertPdfPrintsTheSameFigures(label: string, invoice: GstInvoice) {
  const pdf = await renderInvoicePdf(invoice);
  const printed = moneyStringsIn(pdf);

  const subtotal = inr(invoice.totals.subtotal);
  const total = inr(invoice.totals.grand_total);

  /*
   * The Sub Total has to appear TWICE on an undiscounted invoice — once
   * closing the Amount column, once in the summary block. That count is the
   * test: the table total being a separately computed sum is exactly what
   * would show up here as one occurrence and one near-miss.
   */
  const subtotalCount = printed.filter((s) => s === subtotal).length;
  check(
    `${label}: the PDF's table Total is the Sub Total`,
    subtotalCount >= 2,
    `"${subtotal}" printed ${subtotalCount} time(s)`
  );

  check(
    `${label}: the PDF prints the Total`,
    printed.includes(total),
    `"${total}"`
  );

  /*
   * Nothing on the page may be a near-miss of the Sub Total: a figure one or
   * two paise away is the signature of a second calculation, and is the fault
   * this whole test exists for.
   */
  const nearMiss = printed.find((s) => {
    const v = Number(s.replace(/,/g, ''));
    return s !== subtotal && Math.abs(v - invoice.totals.subtotal) < 0.05;
  });
  check(
    `${label}: no figure sits a paisa away from the Sub Total`,
    !nearMiss,
    nearMiss ? `found "${nearMiss}" against "${subtotal}"` : ''
  );
}

async function main() {
  console.log('\nINVOICE TOTALS — the document has to add up\n');

  // Businesses that actually have something to bill. An empty one throws 404
  // from `buildInvoice` and would tell us nothing.
  const businesses = await query<any>(
    `SELECT b.id,
            COALESCE(NULLIF(b.establishment_name, ''), b.name) AS name,
            COUNT(o.id) AS order_count,
            DATE_FORMAT(MIN(o.created_at), '%Y-%m-%d') AS first_order,
            DATE_FORMAT(MAX(o.created_at), '%Y-%m-%d') AS last_order
       FROM businesses b
       JOIN business_users bu ON bu.business_id = b.id
       JOIN orders o ON o.business_user_id = bu.id AND o.status <> 'CANCELLED'
      GROUP BY b.id, name
      HAVING order_count > 0
      ORDER BY order_count DESC
      LIMIT 5`
  );

  if (businesses.rows.length === 0) {
    console.log('  No business has billable orders — nothing to check.\n');
    return;
  }

  /*
   * The cases: both laundry types and the untyped invoice, at no deduction,
   * a whole percentage and a fractional one. The fractional deduction is the
   * one that puts a third decimal into the arithmetic, which is where a
   * rounding fault surfaces.
   */
  const types: Array<InvoiceLaundryType | null> = ['hotel', 'guest', null];
  const discounts = [0, 10, 7.5, 33.33];

  for (const business of businesses.rows) {
    const id = String(business.id);
    const from = String(business.first_order);
    const to = String(business.last_order);
    console.log(`\n${business.name} (#${id}) — ${business.order_count} order(s), ${from} to ${to}`);

    for (const type of types) {
      for (const discount of discounts) {
        const label = `${type ?? 'both'} @ ${discount}%`;
        let invoice: GstInvoice;
        try {
          // `issue` left false: this reads, it does not raise anything.
          invoice = await buildInvoice(id, from, to, type, discount);
        } catch (e: any) {
          if (e?.statusCode === 404) continue; // nothing of that type in the window
          throw e;
        }
        assertInvoiceAddsUp(label, invoice);
        // The PDF is only worth rendering once per type — the deduction does
        // not change how the document is drawn, only what it prints.
        if (discount === 0 || discount === 7.5) {
          await assertPdfPrintsTheSameFigures(label, invoice);
        }
      }
    }

    /*
     * THE BILLING-CYCLE PATH TOO, which is the one the Generate Invoice sheet
     * uses when no dates are picked. It bills the business's CURRENT period,
     * which may well be empty — that is a 404, not a failure.
     */
    try {
      const current = await buildInvoice(id, undefined, undefined, 'hotel', 0);
      assertInvoiceAddsUp('current period, hotel', current);
    } catch (e: any) {
      if (e?.statusCode !== 404) throw e;
    }
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
      /* the pool may already be closed */
    }
  });
