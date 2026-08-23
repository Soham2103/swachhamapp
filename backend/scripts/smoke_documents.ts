/**
 * Smoke test for the invoice number, the invoice PDF and the Business Order PDF.
 *
 * The Business Order PDF is BUILT IN THE APP, from
 * `mobile/src/utils/businessOrderPdf.ts`, so that module is imported and run
 * here rather than re-described — what is asserted is the HTML the device
 * would print.
 *
 * The invoice is built on the server; its number and its colours are checked
 * on the object and on the rendered bytes.
 *
 *   npx ts-node --compiler-options '{"rootDir":"..","module":"commonjs"}' scripts/smoke_documents.ts
 */
import dotenv from 'dotenv';
import zlib from 'zlib';
import { query } from '../src/config/database';
import { displayInvoiceNumber } from '../src/services/gstInvoice.service';
import {
  buildBusinessOrderPdfHtml,
  buildPdfFileName,
} from '../../mobile/src/utils/businessOrderPdfHtml';

dotenv.config();

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { passed += 1; console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`); }
  else { failed += 1; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

/** A Business Order the app would render, shaped like the API's response. */
const ORDER: any = {
  id: '1',
  order_number: 'SWB-20260823-0001',
  laundry_type: 'hotel',
  order_type: 'PICKUP',
  service_type: null,
  service_name: 'Wash & Iron',
  status: 'CONFIRMED',
  created_at: '2026-08-23T06:30:00.000Z',
  business_name: 'Smoke Doc Hotel',
  contact_person_name: 'Priya Placer',
  business_mobile: '9812345678',
  business_email: 'priya@example.com',
  business_address: '1 Test Road, Pune',
  item_count: 3,
  total_quantity: 30,
  total_weight_kg: 12.5,
  items: [
    { id: '1', service_name: 'Bed Sheet', category_name: 'Bed Linen',
      laundry_service_name: 'Wash & Iron', quantity: 10, unit: 'Piece',
      weight_kg: 0.5, total_weight_kg: 5 },
    { id: '2', service_name: 'Pillow Cover', category_name: 'Bed Linen',
      laundry_service_name: 'Wash & Iron', quantity: 15, unit: 'Piece',
      weight_kg: 0.2, total_weight_kg: 3 },
    { id: '3', service_name: 'Towel', category_name: 'Towels',
      laundry_service_name: 'Wash & Iron', quantity: 5, unit: 'Piece',
      weight_kg: 0.9, total_weight_kg: 4.5 },
  ],
};

/**
 * Every content stream of a PDF, decompressed.
 *
 * PDFKit deflates its page content, so the drawing operators — colours
 * included — are NOT in the raw bytes. Searching the file for them directly
 * finds nothing whatever the document actually contains.
 */
function pdfContentStreams(buf: Buffer): string {
  const parts: string[] = [];
  let i = 0;
  while (true) {
    const start = buf.indexOf('stream', i);
    if (start < 0) break;
    let p = start + 6;
    if (buf[p] === 13) p += 1;
    if (buf[p] === 10) p += 1;
    const end = buf.indexOf('endstream', p);
    if (end < 0) break;
    try { parts.push(zlib.inflateSync(buf.subarray(p, end)).toString('latin1')); } catch { /* image */ }
    i = end + 9;
  }
  return parts.join('\n');
}

/** The visible text of a PDFKit document, decoded from its content streams. */
function pdfText(buf: Buffer): string {
  const parts: string[] = [];
  let i = 0;
  while (true) {
    const start = buf.indexOf('stream', i);
    if (start < 0) break;
    let p = start + 6;
    if (buf[p] === 13) p += 1;
    if (buf[p] === 10) p += 1;
    const end = buf.indexOf('endstream', p);
    if (end < 0) break;
    let text = '';
    try { text = zlib.inflateSync(buf.subarray(p, end)).toString('latin1'); } catch { /* image */ }
    if (text.includes('TJ')) {
      const re = /\[([^\]]*)\]\s*TJ/g;
      let m;
      while ((m = re.exec(text)) !== null) {
        const hex = /<([0-9a-fA-F]+)>/g;
        let h;
        let line = '';
        while ((h = hex.exec(m[1])) !== null) line += Buffer.from(h[1], 'hex').toString('latin1');
        if (line.trim()) parts.push(line);
      }
    }
    i = end + 9;
  }
  return parts.join('\n');
}

async function main() {
  /* ================================================================
   * BUSINESS ORDER PDF
   * ================================================================ */
  console.log('\nBUSINESS ORDER PDF');

  const html = buildBusinessOrderPdfHtml(ORDER, null);

  // -- the two weight columns are gone from the item table --
  const thead = html.slice(html.indexOf('<thead>'), html.indexOf('</thead>'));
  check('the Std. Weight column header is gone', !thead.includes('Std. Weight'), thead.replace(/\s+/g, ' ').slice(0, 120));
  check('the item table has no Weight column header', !/>\s*Weight\s*</.test(thead));
  check('the columns kept are #, Item, Category, Service, Qty, Unit',
    ['>#<', '>Item<', '>Category<', '>Service<', '>Qty<', '>Unit<'].every((h) => thead.includes(h)));

  const tbody = html.slice(html.indexOf('<tbody>'), html.indexOf('</tbody>'));
  const cellsPerRow = (tbody.match(/<tr>[\s\S]*?<\/tr>/)?.[0].match(/<td/g) || []).length;
  check('each item row carries six cells, not eight', cellsPerRow === 6, `${cellsPerRow} cells`);
  check('no per-item weight value is printed',
    !tbody.includes('0.50') && !tbody.includes('5.00 kg') && !/\bkg\b/.test(tbody),
    'no kg in the rows');

  // -- Order Summary --
  const summary = html.slice(html.indexOf('<h2>Order Summary</h2>'), html.indexOf('<footer>'));
  check('Order Summary shows Total Items', summary.includes('Total Items:'));
  check('Order Summary shows Total Quantity', summary.includes('Total Quantity:'));
  check('Order Summary no longer shows Total Weight', !summary.includes('Total Weight'));
  check('Total Items is the number of distinct lines',
    summary.includes('>3<'), `item_count ${ORDER.item_count}, lines ${ORDER.items.length}`);
  check('Total Quantity is the sum of the quantities',
    summary.includes('>30<'),
    `10 + 15 + 5 = ${ORDER.items.reduce((n: number, i: any) => n + i.quantity, 0)}`);
  check('the two are not the same number', ORDER.item_count !== ORDER.total_quantity);

  // -- the centred heading --
  check('the heading says exactly "Order Details"', html.includes('>Order Details</p>'));
  const titleStyle = html.slice(html.indexOf('.doctitle'), html.indexOf('.doctitle') + 200);
  check('the heading is centred', titleStyle.includes('text-align: center'), titleStyle.split('\n')[0]);

  // -- the order placer's mobile --
  const orderInfo = html.slice(html.indexOf('<h2>Order Information</h2>'), html.indexOf('<h2>Items</h2>'));
  check('the Order Details section shows a Mobile Number',
    orderInfo.includes('Mobile Number:'));
  check('it is the mobile of whoever PLACED the order',
    orderInfo.includes(ORDER.business_mobile), ORDER.business_mobile);
  check('it names who placed it', orderInfo.includes('Placed By:') &&
    orderInfo.includes(ORDER.contact_person_name));
  check('the mobile is not repeated in the Business block',
    (html.match(/Mobile Number:/g) || []).length === 1,
    `${(html.match(/Mobile Number:/g) || []).length} occurrence(s)`);

  // -- nothing else was lost --
  for (const kept of ['Order Number:', 'Order Date:', 'Order Time:', 'Order Status:',
                      'Laundry Type:', 'Order Type:', 'Business Name:', 'Address:']) {
    check(`"${kept}" is still on the document`, html.includes(kept));
  }
  check('the item names are still listed',
    ORDER.items.every((i: any) => html.includes(i.service_name)));
  check('no price appears anywhere on a business order',
    !/₹|INR|Amount|Subtotal|Grand total/i.test(html));

  /* ---- the establishment name leads the document ---- */
  check('the establishment name is printed as the document heading',
    html.includes(`<p class="docbusiness">${ORDER.business_name}</p>`),
    ORDER.business_name);
  check('and "Order Details" sits under it',
    html.indexOf('docbusiness') < html.indexOf('Order Details</p>'));

  /* ---- the file name ---- */
  const fileName = buildPdfFileName(ORDER.order_number, ORDER.business_name);
  check('the PDF file name leads with the establishment name',
    fileName.startsWith('Smoke Doc Hotel_'), fileName);
  check('and keeps the order number', fileName.includes(ORDER.order_number), fileName);
  check('a slash in the name cannot break the file name',
    !buildPdfFileName('SWH#1', 'ABC/Grand Hotel').includes('/'),
    buildPdfFileName('SWH#1', 'ABC/Grand Hotel'));
  check('a name with no invalid characters keeps its spaces',
    buildPdfFileName('SWH#1', 'ABC Grand Hotel') === 'ABC Grand Hotel_SWH#1.pdf',
    buildPdfFileName('SWH#1', 'ABC Grand Hotel'));
  check('an order with no business name still gets a file name',
    buildPdfFileName('SWH#1') === 'SWH#1.pdf', buildPdfFileName('SWH#1'));

  /* ================================================================
   * INVOICE NUMBER
   * ================================================================ */
  console.log('\nINVOICE NUMBER');

  const full = 'SWC/INV/0025/20260801-20260831';
  check('the shown number is the first 12 characters',
    displayInvoiceNumber(full) === full.slice(0, 12),
    `${full} -> ${displayInvoiceNumber(full)}`);
  check('it is exactly 12 characters', displayInvoiceNumber(full).length === 12);
  check('a short number is left alone', displayInvoiceNumber('ABC') === 'ABC');
  check('an empty value does not throw', displayInvoiceNumber('') === '');

  /* ================================================================
   * INVOICE PDF — number and colours
   * ================================================================ */
  console.log('\nINVOICE PDF');

  const orders = await query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM orders WHERE business_user_id IS NOT NULL AND status <> 'CANCELLED'`
  );
  if (Number(orders.rows[0].n) === 0) {
    console.log('  SKIP  no business orders on this database to raise an invoice from');
  } else {
    const { buildInvoice } = await import('../src/services/gstInvoice.service');
    const { renderInvoicePdf } = await import('../src/services/invoicePdf.service');
    const row = await query<any>(
      `SELECT bu.business_id AS bid,
              DATE_FORMAT(MIN(o.created_at), '%Y-%m-%d') AS f,
              DATE_FORMAT(MAX(o.created_at), '%Y-%m-%d') AS t
         FROM orders o JOIN business_users bu ON bu.id = o.business_user_id
        WHERE o.status <> 'CANCELLED' GROUP BY bu.business_id LIMIT 1`
    );
    const invoice = await buildInvoice(String(row.rows[0].bid), row.rows[0].f, row.rows[0].t);
    check('the invoice carries the full number internally',
      invoice.invoice_number.length > 10, invoice.invoice_number);
    check('and a 12-character number to show',
      invoice.invoice_number_display === invoice.invoice_number.slice(0, 12),
      invoice.invoice_number_display);

    const pdf = await renderInvoicePdf(invoice);
    const text = pdfText(pdf);
    check('the PDF prints the 12-character number',
      text.includes(invoice.invoice_number_display), invoice.invoice_number_display);
    check('the PDF does NOT print the full number', !text.includes(invoice.invoice_number));

    /*
     * Colours: the Swachham green, not the old blue. Read from the
     * DECOMPRESSED content streams — the colour operators are deflated inside
     * the page, so the raw file never contains them.
     */
    const ops = pdfContentStreams(pdf);
    const GREEN = '0.17647058823529413 0.41568627450980394 0.30980392156862746'; // #2D6A4F
    const OLD_BLUE = '0.03529411764705882 0.47843137254901963 0.6588235294117647'; // #097AA8
    check('the invoice is drawn in the Swachham green', ops.includes(GREEN));
    check('the old blue is gone', !ops.includes(OLD_BLUE));

    // ONLY the colours changed: the same sections are in the same places.
    for (const kept of [
      'Tax Invoice', 'Bill To', 'Invoice Details', 'Invoice Amount In Words',
      'Terms And Conditions', 'Authorized Signatory', 'Acknowledgment',
    ]) {
      check(`"${kept}" is still on the invoice`, text.includes(kept));
    }
    check('the item table still has its columns',
      ['Item name', 'Quantity', 'Amount'].every((h) => text.includes(h)),
      'header row intact');
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('\nSMOKE TEST CRASHED:', error);
  process.exit(1);
});
