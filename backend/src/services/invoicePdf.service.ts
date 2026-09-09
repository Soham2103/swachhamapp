import PDFDocument from 'pdfkit';
import { GstInvoice } from './gstInvoice.service';
import { qrPngBuffer } from './upiPayment.service';
import {
  THEME,
  LOGO_SIZE,
  logoPath,
  drawPageWatermark,
  inr,
  dmy,
  periodFileNamePart,
  safeFileNamePart,
} from './pdfTheme';

/**
 * Renders a tax invoice to PDF, on the server.
 *
 * The layout follows the Swachham reference invoice (Sale_21, 18-07-2026):
 * a blue-banded header carrying the company block, a Bill To / Invoice
 * Details pair, the `# | Item name | Quantity | Unit | Price/ unit | Amount`
 * table with a totals row, the amount in words, terms, the Pay To bank
 * block, the authorised-signatory line, and the tear-off acknowledgment at
 * the foot.
 *
 * NO GST COLUMN. The tax is still computed, still summed and still printed —
 * in the summary block under the table, as SGST/CGST or IGST — but it is no
 * longer a column of the line table. `Amount` is quantity x price/unit, so
 * the three money columns read as one multiplication.
 *
 * Every figure comes from the invoice object the service computed, so the page
 * shows what the database produced — the app receives finished bytes and has
 * nothing left to calculate. Fields the invoice does not carry are omitted
 * rather than filled with a placeholder.
 */

/*
 * THE PALETTE, THE MARK'S SIZE AND THE FORMATTERS NOW LIVE IN `pdfTheme`,
 * shared with the Order Summary so the two documents cannot drift apart.
 *
 * The local aliases below are kept deliberately: `BLUE` names the ACCENT
 * ROLE in this layout — the banded header, the table head, the section
 * rules — and renaming it at every use site would have meant touching thirty
 * lines that are not part of this change. It is teal now, not blue.
 */
const BLUE = THEME.PRIMARY;
const TEXT = THEME.TEXT;
const MUTED = THEME.MUTED;
const RULE = THEME.RULE;
const ZEBRA = THEME.ZEBRA;
/** The tinted band behind a totals/section strip. */
const BAND = THEME.BAND;

const MARGIN = 36;

/*
 * THE WATERMARK NOW LIVES IN `pdfTheme` as `drawPageWatermark`.
 *
 * It was defined here and used only by this document. The Order Summary needs
 * the identical behaviour — same asset, same alpha, same centred `fit` box —
 * so it moved beside the palette rather than being copied into a second file.
 * Nothing about what this document draws changed with the move.
 */

/**
 * The tax invoice's file name.
 *
 *   "The_Taj_Mumbai_01-Aug-2026_to_15-Aug-2026_Hotel_Laundry.pdf"
 *
 * NAMED BY THE ESTABLISHMENT AND THE PERIOD, not by the invoice number: a
 * folder of downloads then sorts and reads by business and date, which is how
 * an accounts inbox is actually searched. The full invoice number stays on
 * the document and in the log line, where it remains the identifier.
 *
 * `customer.name` is the establishment name — `buildInvoice` resolves it as
 * `establishment_name || name` — so nothing here is hardcoded, and a business
 * whose two names differ is filed under the one it trades as.
 *
 * The laundry type is appended when the invoice has one, because Hotel and
 * Guest are two different invoices over the same business and dates and would
 * otherwise download over each other.
 */
export function invoiceFileName(invoice: GstInvoice): string {
  const name = safeFileNamePart(invoice.customer.name) || 'Invoice';
  const period = periodFileNamePart(invoice.period.from, invoice.period.to);
  const type = invoice.laundry_type_label
    ? `_${safeFileNamePart(invoice.laundry_type_label)}`
    : '';
  return `${name}_${period}${type}.pdf`;
}

/**
 * The "UPI | SCAN TO PAY" badge printed directly under the QR.
 *
 * DRAWN, NOT SHIPPED AS AN IMAGE. A bitmap of a badge would need an asset in
 * the repository, would blur when the PDF is zoomed or printed at anything
 * but its native size, and would have to be kept in step with the palette by
 * hand. Vector primitives stay sharp at any resolution — which matters here,
 * because this label sits right beneath the one thing on the page that has to
 * survive being photographed.
 *
 * It names the rail so the reader knows what to scan it WITH: a bare QR on an
 * invoice could as easily be a tracking link. The tricolour arrow is the UPI
 * mark's, in the national colours it is always drawn in.
 *
 * Returns the y the badge ends at, so the caller can lay out beneath it.
 */
function drawUpiBadge(doc: PDFKit.PDFDocument, x: number, y: number): number {
  const HEIGHT = 15;
  const LABEL = 'SCAN TO PAY';
  const ARROW_W = 7;

  // Measured, not guessed: the badge is exactly as wide as its own contents,
  // so a change of wording or type size cannot leave text overhanging.
  doc.font('Helvetica-BoldOblique').fontSize(8);
  const upiW = doc.widthOfString('UPI');
  doc.font('Helvetica-Bold').fontSize(6.5);
  const leftW = 6 + upiW + 3 + ARROW_W + 5;
  const rightW = doc.widthOfString(LABEL) + 14;

  /*
   * The pill, then the green half painted INSIDE a clip of the same rounded
   * shape — so the badge's outer corners stay rounded while the join between
   * the two halves stays a straight edge.
   */
  doc.save();
  doc.roundedRect(x, y, leftW + rightW, HEIGHT, 3.5).fill('#ECEFEF');
  doc.roundedRect(x, y, leftW + rightW, HEIGHT, 3.5).clip();
  doc.rect(x + leftW, y, rightW, HEIGHT).fill('#16D08A');
  doc.restore();

  doc.fillColor('#5F6B6C').font('Helvetica-BoldOblique').fontSize(8)
    .text('UPI', x + 6, y + 4.2, { lineBreak: false });

  // The arrow: saffron above, green below, apex to the right, with a hairline
  // of the badge's own grey left between them.
  const ax = x + 6 + upiW + 3;
  const ay = y + 3.4;
  const apex = ay + 4.1;
  doc.moveTo(ax, ay).lineTo(ax + ARROW_W, apex).lineTo(ax, apex - 0.5).fill('#FF9933');
  doc.moveTo(ax, apex + 0.5).lineTo(ax + ARROW_W, apex).lineTo(ax, ay + 8.2).fill('#138808');

  doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(6.5)
    .text(LABEL, x + leftW, y + 4.6, { width: rightW, align: 'center', lineBreak: false });

  return y + HEIGHT;
}

export function renderInvoicePdf(invoice: GstInvoice): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    /*
     * NO AUTOMATIC FIRST PAGE, so the watermark handler can be attached
     * before any page exists. PDFKit creates the first page during
     * construction, which would fire `pageAdded` before there is a listener
     * for it — page one would be the single page in the document with no
     * watermark. Adding it by hand below means every page, first included,
     * goes through the identical path.
     */
    const doc = new PDFDocument({ size: 'A4', margin: MARGIN, autoFirstPage: false });
    doc.on('pageAdded', () => drawPageWatermark(doc));
    doc.addPage();
    const chunks: Buffer[] = [];

    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = MARGIN;
    const right = doc.page.width - MARGIN;
    const width = right - left;
    const mid = left + width / 2;

    // =================================================================
    // HEADER — company block, with the title on the band
    // =================================================================
    doc.rect(left, MARGIN, width, 26).fill(BLUE);
    doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(13)
      .text('Tax Invoice', left, MARGIN + 7, { width, align: 'center' });

    let y = MARGIN + 38;

    /*
     * THE MARK, AT `LOGO_SIZE` — the same size the Order Summary draws it.
     *
     * The source art is square and this is a square `fit` box, so PDFKit
     * scales it without distortion; the aspect ratio holds by construction.
     * It sits BESIDE the company block, and the block's width is measured
     * from where the logo ends, so a larger mark narrows that column rather
     * than being written over by it.
     */
    const logo = logoPath();
    if (logo) {
      try {
        doc.image(logo, left, y, { fit: [LOGO_SIZE, LOGO_SIZE] });
      } catch {
        // A missing or unreadable image must never cost the invoice.
      }
    }

    const companyX = left + (logo ? LOGO_SIZE + 10 : 0);
    /** Stops short of the page's midpoint, which is where Bill To begins. */
    const companyW = mid - 12 - companyX;

    doc.fillColor(BLUE).font('Helvetica-Bold').fontSize(15)
      .text(invoice.supplier.legal_name, companyX, y, { width: companyW });

    doc.font('Helvetica').fontSize(8.5).fillColor(TEXT)
      .text(invoice.supplier.address, companyX, doc.y + 1, { width: companyW });

    if (invoice.supplier.phone) {
      doc.text(`Phone no.: ${invoice.supplier.phone}`, companyX, doc.y, { width: companyW });
    }
    if (invoice.supplier.email) {
      doc.text(`Email: ${invoice.supplier.email}`, companyX, doc.y, { width: companyW });
    }
    if (invoice.supplier.gstin) {
      doc.font('Helvetica-Bold')
        .text(`GSTIN: ${invoice.supplier.gstin}`, companyX, doc.y, { width: companyW });
    }
    doc.font('Helvetica')
      .text(`State: ${invoice.supplier.state}`, companyX, doc.y, { width: companyW });

    // Whichever is taller — the mark or the company block — decides where the
    // rule goes, so the larger logo can never be crossed by it.
    y = Math.max(doc.y + 10, y + LOGO_SIZE + 8);
    doc.moveTo(left, y).lineTo(right, y).strokeColor(BLUE).lineWidth(1).stroke();
    y += 10;

    // =================================================================
    // BILL TO  |  INVOICE DETAILS
    // =================================================================
    const blockTop = y;

    doc.fillColor(BLUE).font('Helvetica-Bold').fontSize(9.5).text('Bill To', left, y);
    let leftY = doc.y + 3;

    doc.fillColor(TEXT).font('Helvetica-Bold').fontSize(10.5)
      .text(invoice.customer.legal_name || invoice.customer.name, left, leftY, { width: width / 2 - 14 });
    leftY = doc.y;

    // The trading name earns a line only when it differs from the legal one.
    if (invoice.customer.legal_name && invoice.customer.legal_name !== invoice.customer.name) {
      doc.font('Helvetica').fontSize(8.5).fillColor(MUTED)
        .text(invoice.customer.name, left, leftY, { width: width / 2 - 14 });
      leftY = doc.y;
    }

    const addressLine = [
      invoice.customer.address,
      invoice.customer.city,
      invoice.customer.pincode,
    ].filter(Boolean).join(', ');
    if (addressLine) {
      doc.font('Helvetica').fontSize(8.5).fillColor(TEXT)
        .text(addressLine, left, leftY, { width: width / 2 - 14 });
      leftY = doc.y;
    }
    if (invoice.customer.gstin) {
      doc.font('Helvetica-Bold').fontSize(8.5)
        .text(`GSTIN Number: ${invoice.customer.gstin}`, left, leftY, { width: width / 2 - 14 });
      leftY = doc.y;
    }
    if (invoice.customer.state) {
      doc.font('Helvetica').fontSize(8.5)
        .text(`State: ${invoice.customer.state}`, left, leftY, { width: width / 2 - 14 });
      leftY = doc.y;
    }

    doc.fillColor(BLUE).font('Helvetica-Bold').fontSize(9.5)
      .text('Invoice Details', mid + 10, blockTop);
    let rightY = doc.y + 3;

    const detail = (label: string, value: string) => {
      doc.fillColor(TEXT).font('Helvetica').fontSize(8.5)
        .text(label, mid + 10, rightY, { width: 110, continued: false });
      doc.font('Helvetica-Bold')
        .text(value, mid + 120, rightY, { width: right - (mid + 120), align: 'right' });
      rightY += 13;
    };

    detail('Invoice No.:', invoice.invoice_number_display);
    /*
     * INVOICE DATE — the billing period's last day plus two, NOT the day the
     * document was produced. Labelled in full because "Date" beside a billing
     * period invited reading it as the generation date, which is what it used
     * to be. `invoice.invoice_date` is the only source; the Acknowledgment at
     * the foot of this page prints the very same field, so the two cannot
     * disagree.
     */
    detail('Invoice Date:', dmy(invoice.invoice_date));
    // WHICH LAUNDRY TYPE THIS INVOICE IS. Hotel and Guest are now two separate
    // invoices over the same business and dates, so the document has to say
    // which of them it is. Omitted on an invoice that covers both, where there
    // is no single type to name.
    if (invoice.laundry_type_label) {
      detail('Type:', invoice.laundry_type_label);
    }
    detail('Billing Period:', `${dmy(invoice.period.from)} to ${dmy(invoice.period.to)}`);
    detail('Place of Supply:', invoice.customer.state || invoice.supplier.state);

    y = Math.max(leftY, rightY) + 12;

    // =================================================================
    // LINE TABLE
    // =================================================================
    /*
     * THE GST COLUMN IS GONE, and the 82pt it held has been given to the item
     * name rather than left as a gap — the remaining five columns keep their
     * own widths and their right-hand positions, so nothing else moved.
     *
     * The tax itself is untouched: it is still computed per line, still
     * summed into the tax summary block below the table, and still printed
     * there as SGST/CGST or IGST. Only the COLUMN was removed.
     */
    const col = {
      sn: left,
      item: left + 24,
      qty: left + 290,
      unit: left + 336,
      rate: left + 380,
      amount: right - 78,
    };
    /**
     * How wide the item name may run before it wraps.
     *
     * The five boxes are laid out so none overlaps the next on an A4 page:
     * item 60-320, qty 326-368, unit 372-410, rate 416-478, amount 481-553.
     * The right-hand four are right-aligned, so their text sits at the far
     * edge of each box and a wide figure still cannot run into its neighbour.
     */
    const ITEM_W = 260;

    const tableHead = (top: number): number => {
      doc.rect(left, top, width, 19).fill(BLUE);
      doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(8.5);
      doc.text('#', col.sn + 5, top + 6);
      doc.text('Item name', col.item, top + 6);
      doc.text('Quantity', col.qty, top + 6, { width: 42, align: 'right' });
      doc.text('Unit', col.unit, top + 6, { width: 38 });
      // PDFKit's built-in fonts are WinAnsi and have no rupee glyph, so the
      // currency is stated in the heading instead of printed per amount.
      doc.text('Price/ unit', col.rate, top + 6, { width: 62, align: 'right' });
      doc.text('Amount', col.amount, top + 6, { width: 72, align: 'right' });
      return top + 19;
    };

    y = tableHead(y);

    invoice.lines.forEach((line, index) => {
      // A continued table keeps its headings, so page two is still readable.
      if (y > doc.page.height - 250) {
        doc.addPage();
        y = MARGIN;
        y = tableHead(y);
      }

      /*
       * THE ITEM NAME, AND NOTHING ELSE.
       *
       * The laundry type and the laundry service used to be appended here as
       * qualifiers, because one invoice could carry the same item at both the
       * Hotel and the Guest rate and needed to say which line was which.
       * Hotel and Guest are now SEPARATE INVOICES, each headed with its Type,
       * so the qualifier the reader needed is on the document rather than
       * repeated down every row.
       */
      const hasDuplicateName =
        invoice.lines.filter((l) => l.description === line.description).length > 1;
      const named =
        hasDuplicateName && line.service ? `${line.description} (${line.service})` : line.description;

      /*
       * THE DEFECTIVE ADJUSTMENT, WHERE IT FITS.
       *
       * The Quantity column shows what is BILLED, which is the figure the
       * amount is derived from and must stay that. A line billing 8 of 10
       * pieces would otherwise invite the obvious query with nothing on the
       * document to answer it, so the movement is stated under the item name
       * instead — the description column already wraps, and `rowHeight` below
       * is measured from this string, so the row grows to fit rather than
       * overlapping the next one. No column is added, resized or moved.
       *
       * Only when something WAS defective: an ordinary line renders exactly
       * as it always has.
       */
      const label =
        line.defective_quantity > 0
          ? `${named}
${line.ordered_quantity} ordered, ${line.defective_quantity} defective — ` +
            `${line.quantity} billable`
          : named;
      doc.font('Helvetica').fontSize(8.5);
      const rowHeight = Math.max(17, doc.heightOfString(label, { width: ITEM_W }) + 7);

      if (index % 2 === 1) {
        doc.rect(left, y, width, rowHeight).fill(ZEBRA);
      }

      doc.fillColor(TEXT).font('Helvetica').fontSize(8.5);
      doc.text(String(index + 1), col.sn + 5, y + 5);
      doc.text(label, col.item, y + 5, { width: ITEM_W });
      doc.text(String(line.quantity), col.qty, y + 5, { width: 42, align: 'right' });
      doc.text(line.unit, col.unit, y + 5, { width: 38 });
      doc.text(`${inr(line.rate)}`, col.rate, y + 5, { width: 62, align: 'right' });
      // Quantity x Price/ unit — the two columns immediately to its left.
      doc.text(`${inr(line.amount)}`, col.amount, y + 5, { width: 72, align: 'right' });

      y += rowHeight;
      doc.strokeColor(RULE).lineWidth(0.5).moveTo(left, y).lineTo(right, y).stroke();
    });

    /*
     * Totals row across the foot of the table.
     *
     * IT PRINTS `totals.subtotal`, IT DOES NOT ADD THE COLUMN UP AGAIN.
     * `buildInvoice` sums the very `line.amount` values rendered above into
     * that field, so re-summing them here could only ever produce the same
     * number or — through a second rounding of a floating-point sum — a
     * number a paisa away from the Sub Total in the summary block below. One
     * figure, computed once, printed in both places.
     *
     * The quantity beside it is a COUNT, not money: nothing downstream states
     * a total quantity, so it is summed here and rounding does not arise.
     */
    const quantityTotal = invoice.lines.reduce((sum, line) => sum + line.quantity, 0);

    doc.rect(left, y, width, 19).fill(BAND);
    doc.fillColor(TEXT).font('Helvetica-Bold').fontSize(9);
    doc.text('Total', col.item, y + 5);
    doc.text(String(quantityTotal), col.qty, y + 5, { width: 42, align: 'right' });
    doc.text(inr(invoice.totals.subtotal), col.amount, y + 5, { width: 72, align: 'right' });
    y += 30;

    if (y > doc.page.height - 230) {
      doc.addPage();
      y = MARGIN;
    }

    // =================================================================
    // AMOUNT IN WORDS + TERMS   |   TAX SUMMARY
    // =================================================================
    const summaryLeft = right - 210;
    const summaryTop = y;

    doc.fillColor(MUTED).font('Helvetica').fontSize(7.5)
      .text('All amounts in INR', left, y - 12);

    doc.fillColor(BLUE).font('Helvetica-Bold').fontSize(8.5)
      .text('Invoice Amount In Words', left, y);
    doc.fillColor(TEXT).font('Helvetica').fontSize(8.5)
      .text(invoice.totals.amount_in_words, left, doc.y + 2, { width: width - 230 });

    let summaryY = summaryTop;
    const summaryRow = (label: string, value: string, strong = false) => {
      if (strong) {
        doc.rect(summaryLeft, summaryY - 2, 210, 20).fill(BLUE);
        doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(10);
      } else {
        doc.fillColor(TEXT).font('Helvetica').fontSize(9);
      }
      doc.text(label, summaryLeft + 8, summaryY + 3, { width: 110 });
      doc.text(value, summaryLeft + 118, summaryY + 3, { width: 84, align: 'right' });
      summaryY += strong ? 24 : 15;
    };

    /*
     * Sub Total is the lines added up, as it always was — `subtotal` equals
     * `taxable_value` on every invoice without a deduction, so this block is
     * unchanged for them.
     *
     * WHERE ONE WAS TAKEN, IT IS SHOWN. The deduction and the value left to
     * tax are stated between the subtotal and the GST rows, so the reader can
     * follow the figure GST was actually charged on rather than finding a
     * taxable value that does not match the column above it.
     */
    summaryRow('Sub Total', inr(invoice.totals.subtotal));
    if (invoice.totals.discount_amount > 0) {
      summaryRow(
        `Less ${invoice.totals.discount_percent}%`,
        `- ${inr(invoice.totals.discount_amount)}`
      );
      summaryRow('Taxable Amount', inr(invoice.totals.taxable_value));
    }
    if (invoice.totals.intra_state) {
      summaryRow(`SGST@${(invoice.totals.gst_rate / 2).toFixed(1)}%`, inr(invoice.totals.sgst));
      summaryRow(`CGST@${(invoice.totals.gst_rate / 2).toFixed(1)}%`, inr(invoice.totals.cgst));
    } else {
      summaryRow(`IGST@${invoice.totals.gst_rate.toFixed(1)}%`, inr(invoice.totals.igst));
    }
    summaryRow('Total', inr(invoice.totals.grand_total), true);

    y = Math.max(doc.y, summaryY) + 14;

    // Terms, with the QR + "Pay To" pair on its own row beneath them.
    doc.fillColor(BLUE).font('Helvetica-Bold').fontSize(8.5)
      .text('Terms And Conditions', left, y);
    if (invoice.supplier.terms) {
      doc.fillColor(TEXT).font('Helvetica').fontSize(8.5)
        .text(invoice.supplier.terms, left, doc.y + 2, { width: width / 2 - 14 });
    }
    /*
     * THE SCAN-TO-PAY QR, AT THE LEFT MARGIN UNDER THE TERMS, with the bank
     * details beside it — the two ways of paying, read as one block.
     *
     * `qrPngBuffer` decodes the very PNG the invoice object carries, so the
     * printed code is byte-identical to the one the app previews. Nothing is
     * encoded here.
     *
     * 72pt is about 25mm on paper. The intent encodes to a version-6 symbol
     * (41 modules), so each module prints at roughly 0.6mm — comfortably
     * above the ~0.4mm a phone camera needs, with margin for a page that has
     * been folded or photocopied.
     */
    const QR_SIZE = 72;
    const qrPng = qrPngBuffer(invoice.upi_payment);
    let leftBottom = doc.y;
    /*
     * The top of the QR/Pay To row, fixed BEFORE either is drawn so both
     * start from it. Deriving it inside the QR branch would leave "Pay To"
     * without a row to align to on an invoice that has no QR.
     */
    const qrTop = leftBottom + 10;

    if (qrPng) {
      try {
        // A white plate under the code. The quiet zone is already inside the
        // PNG; this guarantees it stays white even if the block is ever drawn
        // over a tint.
        doc.rect(left - 3, qrTop - 3, QR_SIZE + 6, QR_SIZE + 6).fill('#FFFFFF');
        doc.image(qrPng, left, qrTop, { fit: [QR_SIZE, QR_SIZE] });
        leftBottom = drawUpiBadge(doc, left, qrTop + QR_SIZE + 4);
      } catch {
        // A QR that will not draw must never cost the invoice its page.
        leftBottom = doc.y;
      }
    } else {
      /*
       * WHEN THERE IS NO QR, THE INVOICE SAYS SO rather than leaving a gap
       * the reader has to interpret — in the column the QR would have taken,
       * so "Pay To" stays exactly where it is either way.
       */
      doc.fillColor(MUTED).font('Helvetica').fontSize(7)
        .text(invoice.upi_payment.message || 'UPI payment unavailable', left, qrTop, {
          width: QR_SIZE + 12,
        });
      leftBottom = doc.y;
    }

    const termsBottom = leftBottom;

    /*
     * "PAY TO" SITS IMMEDIATELY RIGHT OF THE QR, not out at the page's far
     * side.
     *
     * The two are the same instruction — here is how to pay us — and putting
     * half a page of white between them read as two unrelated blocks. Beside
     * the code they are one, and the bank lines get the whole remaining width
     * instead of half of it, so the long bank name stops wrapping.
     */
    const payToLeft = left + QR_SIZE + 18;
    const bankWidth = right - payToLeft;

    if (invoice.supplier.bank_account || invoice.upi_payment.available) {
      // Level with the top of the QR, so the two line up as one block.
      doc.fillColor(BLUE).font('Helvetica-Bold').fontSize(8.5).text('Pay To:', payToLeft, qrTop);

      doc.fillColor(TEXT).font('Helvetica').fontSize(8.5);
      const bank = [
        invoice.supplier.bank_name ? `Bank Name: ${invoice.supplier.bank_name}` : null,
        invoice.supplier.bank_account ? `Bank Account No.: ${invoice.supplier.bank_account}` : null,
        invoice.supplier.bank_ifsc ? `Bank IFSC code: ${invoice.supplier.bank_ifsc}` : null,
        invoice.supplier.bank_holder ? `Account Holder's Name: ${invoice.supplier.bank_holder}` : null,
        /*
         * THE VPA IN TEXT AS WELL AS IN THE CODE. A QR that will not scan —
         * a creased printout, a camera that cannot focus — leaves the payer
         * with an identifier they can type, which is the whole point of
         * printing the bank details beside it too.
         */
        invoice.supplier.upi_id ? `UPI ID: ${invoice.supplier.upi_id}` : null,
      ].filter(Boolean) as string[];

      let bankY = doc.y + 2;
      bank.forEach((line) => {
        doc.text(line, payToLeft, bankY, { width: bankWidth });
        bankY = doc.y;
      });
    }

    y = Math.max(termsBottom, doc.y) + 16;

    // Signature block.
    doc.fillColor(TEXT).font('Helvetica-Bold').fontSize(9)
      .text(`For: ${invoice.supplier.legal_name}`, mid, y, { width: right - mid, align: 'right' });
    /*
     * The gap between the company name and the signatory line is the space a
     * signature is actually written in, so it is sized for a pen rather than
     * for the type: 48pt is a comfortable 17mm.
     */
    doc.font('Helvetica').fontSize(8).fillColor(MUTED)
      .text('Authorized Signatory', mid, y + 48, { width: right - mid, align: 'right' });

    y += 68;

    // =================================================================
    // ACKNOWLEDGMENT — the tear-off strip at the foot of the reference
    // =================================================================
    if (y < doc.page.height - 120) {
      doc.strokeColor(RULE).lineWidth(0.8).dash(3, { space: 3 })
        .moveTo(left, y).lineTo(right, y).stroke().undash();
      y += 10;

      doc.fillColor(BLUE).font('Helvetica-Bold').fontSize(9)
        .text('Acknowledgment', left, y, { width, align: 'center' });
      y = doc.y + 6;

      doc.fillColor(TEXT).font('Helvetica-Bold').fontSize(9)
        .text(invoice.supplier.legal_name, left, y);

      doc.font('Helvetica-Bold').fontSize(8.5).text('Invoice To:', left, doc.y + 4);
      doc.font('Helvetica').fontSize(8.5)
        .text(invoice.customer.legal_name || invoice.customer.name, left, doc.y, { width: 240 });
      if (addressLine) {
        doc.text(addressLine, left, doc.y, { width: 240 });
      }

      doc.font('Helvetica-Bold').fontSize(8.5).text('Invoice Details:', mid + 10, y + 14);
      /*
       * THE SAME `invoice.invoice_date` THE BLOCK AT THE HEAD OF THE PAGE
       * PRINTS. One field, read twice — the date is never recomputed here, so
       * the tear-off strip a customer signs and the invoice it is attached to
       * cannot state different dates.
       */
      doc.font('Helvetica').fontSize(8.5)
        .text(`Invoice No. : ${invoice.invoice_number_display}`, mid + 10, doc.y)
        .text(`Invoice Date : ${dmy(invoice.invoice_date)}`, mid + 10, doc.y)
        .text(`Invoice Amount : ${inr(invoice.totals.grand_total)}`, mid + 10, doc.y);

      doc.fillColor(MUTED).fontSize(8)
        .text("Receiver's Seal & Sign", mid + 10, doc.y + 14, {
          width: right - (mid + 10),
          align: 'right',
        });
    }

    doc.end();
  });
}
