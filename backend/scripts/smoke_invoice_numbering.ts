/**
 * Smoke test for INVOICE NUMBERING.
 *
 * The rules, stated as tests:
 *
 *   SWCH/INV/n for Hotel, SWCG/INV/n for Guest — the prefix, and ONLY the
 *   prefix, is decided by the laundry type.
 *
 *   ONE SEQUENCE PER BUSINESS, SHARED BY BOTH TYPES. Hotel, Guest, Hotel,
 *   Guest issued in that order are numbered n, n+1, n+2, n+3. A Guest invoice
 *   never restarts the count and never runs a second counter alongside it.
 *
 *   EACH BUSINESS COUNTS FOR ITSELF. Two businesses issuing at the same time
 *   do not consume each other's numbers.
 *
 *   A NUMBER IS PERMANENT. Re-issuing the same invoice returns the number it
 *   already has instead of taking another.
 *
 *   NO DUPLICATES UNDER CONCURRENCY. Numbers allocated simultaneously for one
 *   business are all different.
 *
 *   A PREVIEW COSTS NOTHING. Looking at what an invoice would be numbered does
 *   not consume a number.
 *
 *   AND THE NUMBER IS THE SAME EVERYWHERE — the invoice object, the stored row
 *   and the printed PDF.
 *
 * IT CLEANS UP AFTER ITSELF. The allocations it makes are against periods in
 * 2019, which predate the system so they can collide with no real invoice; the
 * claims are deleted and every counter it moved is put back exactly where it
 * was. No `business_invoices` row is created, and no real invoice is touched.
 *
 *   npx ts-node scripts/smoke_invoice_numbering.ts
 */
import dotenv from 'dotenv';
import zlib from 'zlib';
import { query, pool } from '../src/config/database';
import {
  resolveInvoiceNumber,
  invoiceNumberForSerial,
  displayInvoiceNumber,
  buildInvoice,
  InvoiceLaundryType,
} from '../src/services/gstInvoice.service';
import { renderInvoicePdf } from '../src/services/invoicePdf.service';
import { listInvoicesForBusiness } from '../src/services/invoiceHistory.service';

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

/** The 2019 periods this test allocates against, one per allocation. */
const P = (n: number) => ({ from: `2019-${String(n).padStart(2, '0')}-01`, to: `2019-${String(n).padStart(2, '0')}-28` });

async function counterFor(businessId: string): Promise<number> {
  const r = await query<{ next_value: number }>(
    `SELECT next_value FROM business_invoice_sequence WHERE business_id = ?`,
    [businessId]
  );
  return r.rows.length > 0 ? Number(r.rows[0].next_value) : 1;
}

async function main() {
  console.log('\nINVOICE NUMBERING\n');

  /* ---- The pure formatting rule, which needs no database ---- */
  check('Hotel is SWCH/INV/n', invoiceNumberForSerial(27, 'hotel') === 'SWCH/INV/27',
    invoiceNumberForSerial(27, 'hotel'));
  check('Guest is SWCG/INV/n', invoiceNumberForSerial(28, 'guest') === 'SWCG/INV/28',
    invoiceNumberForSerial(28, 'guest'));
  check('the number is not padded', invoiceNumberForSerial(1, 'hotel') === 'SWCH/INV/1',
    invoiceNumberForSerial(1, 'hotel'));
  check('a four-digit number survives being displayed',
    displayInvoiceNumber('SWCH/INV/1234') === 'SWCH/INV/1234',
    displayInvoiceNumber('SWCH/INV/1234'));
  check('a number issued under the previous scheme still displays whole',
    displayInvoiceNumber('SWC/HL/INV/0059') === 'SWC/HL/INV/0059',
    displayInvoiceNumber('SWC/HL/INV/0059'));
  check('the original period-based number is still trimmed',
    displayInvoiceNumber('SWC/INV/0025/20260801-20260831') === 'SWC/INV/0025',
    displayInvoiceNumber('SWC/INV/0025/20260801-20260831'));

  /* ---- The sequence itself ---- */
  const businesses = await query<{ id: number; name: string }>(
    `SELECT id, COALESCE(NULLIF(establishment_name,''), name) AS name
       FROM businesses ORDER BY id LIMIT 2`
  );
  if (businesses.rows.length < 2) {
    console.log('  SKIP  need two businesses to test per-business isolation');
    console.log(`\n${passed} passed, ${failed} failed`);
    return;
  }
  const [A, B] = businesses.rows;
  const idA = String(A.id);
  const idB = String(B.id);

  const beforeA = await counterFor(idA);
  const beforeB = await counterFor(idB);
  console.log(`\n  ${A.name} (#${idA}) is at ${beforeA}; ${B.name} (#${idB}) is at ${beforeB}\n`);

  const allocate = (businessId: string, month: number, type: InvoiceLaundryType | null) => {
    const period = P(month);
    return resolveInvoiceNumber(businessId, period.from, period.to, type, { allocate: true });
  };

  try {
    /* -- A PREVIEW TAKES NOTHING -- */
    const previewPeriod = P(1);
    const preview = await resolveInvoiceNumber(
      idA, previewPeriod.from, previewPeriod.to, 'hotel', { allocate: false }
    );
    check('a preview shows the number the invoice would take',
      preview.invoiceNumber === `SWCH/INV/${beforeA}`, preview.invoiceNumber);
    check('and reserves nothing', preview.serial === null && (await counterFor(idA)) === beforeA,
      `counter still ${await counterFor(idA)}`);

    /* -- HOTEL, GUEST, HOTEL, GUEST — ONE RUNNING SEQUENCE -- */
    const first = await allocate(idA, 1, 'hotel');
    const second = await allocate(idA, 2, 'guest');
    const third = await allocate(idA, 3, 'hotel');
    const fourth = await allocate(idA, 4, 'guest');

    check('the first issued invoice takes the number the preview showed',
      first.invoiceNumber === `SWCH/INV/${beforeA}`, first.invoiceNumber);
    check('a Guest invoice continues the SAME sequence, it does not restart',
      second.invoiceNumber === `SWCG/INV/${beforeA + 1}`, second.invoiceNumber);
    check('the next Hotel invoice carries on from the Guest one',
      third.invoiceNumber === `SWCH/INV/${beforeA + 2}`, third.invoiceNumber);
    check('and so does the Guest one after it',
      fourth.invoiceNumber === `SWCG/INV/${beforeA + 3}`, fourth.invoiceNumber);
    check('the four numbers are consecutive across both types',
      [first, second, third, fourth].every((r, i) => r.serial === beforeA + i),
      [first, second, third, fourth].map((r) => r.serial).join(', '));

    /* -- A NUMBER IS PERMANENT -- */
    const again = await allocate(idA, 2, 'guest');
    check('re-issuing the same invoice returns the number it already has',
      again.invoiceNumber === second.invoiceNumber, `${second.invoiceNumber} -> ${again.invoiceNumber}`);
    check('and takes nothing further from the counter',
      (await counterFor(idA)) === beforeA + 4, `counter at ${await counterFor(idA)}`);

    /* -- EACH BUSINESS COUNTS FOR ITSELF -- */
    const other = await allocate(idB, 1, 'hotel');
    check("another business's invoice uses ITS OWN next number",
      other.serial === beforeB, `${other.invoiceNumber} (expected serial ${beforeB})`);
    check("and did not disturb the first business's counter",
      (await counterFor(idA)) === beforeA + 4, `counter at ${await counterFor(idA)}`);

    /* -- NO DUPLICATES UNDER CONCURRENCY -- */
    const CONCURRENT = 8;
    const results = await Promise.all(
      Array.from({ length: CONCURRENT }, (_, i) =>
        allocate(idA, 5 + i, i % 2 === 0 ? 'hotel' : 'guest')
      )
    );
    const serials = results.map((r) => r.serial as number);
    check(`${CONCURRENT} invoices issued at once all get different numbers`,
      new Set(serials).size === CONCURRENT, serials.join(', '));
    check('and they are one unbroken run, with nothing skipped',
      Math.max(...serials) - Math.min(...serials) === CONCURRENT - 1,
      `${Math.min(...serials)}..${Math.max(...serials)}`);
    check('the prefixes still follow each invoice\'s own type',
      results.every((r, i) => r.invoiceNumber.startsWith(i % 2 === 0 ? 'SWCH/' : 'SWCG/')),
      results.map((r) => r.invoiceNumber).join(' '));
  } finally {
    /*
     * PUT EVERYTHING BACK. The claims this test wrote are deleted and both
     * counters are restored to the values they held on entry, so the next real
     * invoice takes the number it would have taken had this never run.
     */
    await query(`DELETE FROM invoice_serial_claims WHERE period_from LIKE '2019-%'`);
    await query(
      `UPDATE business_invoice_sequence SET next_value = ? WHERE business_id = ?`,
      [beforeA, idA]
    );
    await query(
      `UPDATE business_invoice_sequence SET next_value = ? WHERE business_id = ?`,
      [beforeB, idB]
    );
    const restoredA = await counterFor(idA);
    const restoredB = await counterFor(idB);
    check('the counters were restored', restoredA === beforeA && restoredB === beforeB,
      `${A.name} at ${restoredA}, ${B.name} at ${restoredB}`);
    const leftover = await query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM invoice_serial_claims WHERE period_from LIKE '2019-%'`
    );
    check('and no claim was left behind', Number(leftover.rows[0].n) === 0);
  }

  /* ================================================================
   * THE SAME NUMBER EVERYWHERE
   *
   * On a REAL, already-issued invoice, so nothing is allocated: the stored
   * row, the rebuilt invoice object and the printed PDF must all say the same
   * thing.
   * ================================================================ */
  console.log('\nONE NUMBER, EVERYWHERE\n');

  const withInvoices = await query<{ business_id: string }>(
    `SELECT DISTINCT business_id FROM business_invoices LIMIT 3`
  );
  for (const row of withInvoices.rows) {
    const list = await listInvoicesForBusiness(String(row.business_id));
    for (const entry of list.invoices) {
      let invoice;
      try {
        invoice = await buildInvoice(
          String(row.business_id),
          entry.period_from,
          entry.period_to,
          entry.laundry_type,
          entry.discount_percent,
          false,
          // Exactly as the Issued Invoice list's View PDF does: reopening a
          // stored invoice renders the period on its row, not today's cycle.
          true
        );
      } catch (e: any) {
        /*
         * The stored invoice's period no longer holds orders of that type — a
         * laundry type corrected, or a period rewritten by a later re-issue.
         * The PDF is re-rendered rather than stored, so such an invoice cannot
         * be reopened at all. That is a data condition, not a numbering fault,
         * and it is reported rather than failed.
         */
        if (e?.statusCode === 404) {
          console.log(`  SKIP  ${entry.invoice_number}: cannot be rebuilt — ${e.message}`);
          continue;
        }
        throw e;
      }
      check(
        `${entry.invoice_number}: the rebuilt invoice keeps the stored number`,
        invoice.invoice_number === entry.invoice_number,
        invoice.invoice_number
      );
      const printed = drawnStringsIn(await renderInvoicePdf(invoice));
      check(
        `${entry.invoice_number}: the PDF prints it`,
        printed.some((s) => s.includes(entry.invoice_number_display)),
        entry.invoice_number_display
      );
      check(
        `${entry.invoice_number}: the list shows the same string`,
        entry.invoice_number_display === displayInvoiceNumber(invoice.invoice_number)
      );
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
      /* already closed */
    }
  });
