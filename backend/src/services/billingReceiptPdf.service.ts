import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';
import { query } from '../config/database';
import { AppError } from '../utils/appError';
import { displayInvoiceNumber } from './gstInvoice.service';
import {
  getReceipt,
  displayBusinessName,
  PaymentReceiptRow,
} from './paymentReceipt.service';

/**
 * The Billing Receipt, as a PDF.
 *
 * WHAT IT IS FOR. A receipt is handed to the business as proof of a payment,
 * and it states the four figures that payment was calculated from: what was
 * outstanding before, what this invoice came to, what the two add up to, and
 * what is left after the amount received.
 *
 * THOSE FIGURES ARE READ FROM THE RECEIPT ROW, NOT RECOMPUTED. The receipt is
 * a document about a moment. A later payment changes what the business owes
 * today, and a receipt reprinted after one must still say what it said when it
 * was issued — recomputing at print time would silently reissue an old receipt
 * with new numbers. `business_payment_receipts` stores all four for exactly
 * this reason.
 *
 * It reuses the existing `pdfkit` stack and the Swachham green the invoice and
 * the business order documents are drawn in, so the three read as one family.
 *
 * NOTHING SENSITIVE. No password, no OTP, no token — the SELECT names its
 * columns, so there is no path by which one could reach the page.
 */

/** The Swachham palette, shared with the invoice and the order documents. */
const GREEN = '#2D6A4F';
const DARK = '#1B4332';
const TEXT = '#1B1B1B';
const MUTED = '#6B7280';
const RULE = '#D8E6DD';
const PANEL = '#F1F7F3';
const BAND = '#E8F3EC';

const MARGIN = 40;

function logoPath(): string | null {
  const candidates = [
    path.resolve(process.cwd(), '../mobile/assets/swachham-logo.png'),
    path.resolve(process.cwd(), 'assets/swachham-logo.png'),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

/** 1234.5 -> "1,234.50", Indian digit grouping. */
function inr(value: number): string {
  const fixed = Math.abs(Number(value || 0)).toFixed(2);
  const [whole, paise] = fixed.split('.');
  const last3 = whole.slice(-3);
  const rest = whole.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}` : last3;
  return `${Number(value) < 0 ? '-' : ''}${grouped}.${paise}`;
}

/** "2026-08-23" -> "23-08-2026". */
function dmy(iso: string): string {
  const [y, m, d] = String(iso ?? '').split('-');
  return y && m && d ? `${d}-${m}-${y}` : String(iso ?? '');
}

const PAYMENT_TYPE_LABEL: Record<string, string> = {
  CASH: 'Cash',
  CARD: 'Card',
  UPI: 'UPI',
  NETBANKING: 'Netbanking',
};

export interface BillingReceiptDocument extends PaymentReceiptRow {
  business_name: string;
}

/** One receipt, with the business it belongs to. */
export async function buildBillingReceiptDocument(
  businessId: string,
  receiptId: string
): Promise<BillingReceiptDocument> {
  // Scoped to the business, so another business's receipt id is a 404.
  const receipt = await getReceipt(businessId, receiptId);

  const business = await query<{ name: string; establishment_name: string | null }>(
    `SELECT name, establishment_name FROM businesses WHERE id = ?`,
    [businessId]
  );
  if (!business.rows[0]) throw new AppError('Business not found.', 404);

  return { ...receipt, business_name: displayBusinessName(business.rows[0]) };
}

/**
 * Characters a filesystem actually rejects — reserved on Windows and/or
 * POSIX, plus the control range.
 *
 * SPACES AND HYPHENS ARE NOT HERE. Both are legal in a file name on every
 * platform this app runs on, and an establishment name is far more readable
 * with them: "ABC Grand Hotel_SWC_INV_0025.pdf" rather than
 * "ABC_Grand_Hotel_SWC_INV_0025.pdf". Only what would break the download goes.
 */
const INVALID_FILENAME_CHARS = /[<>:"/\\|?*\u0000-\u001F]/g;

/**
 * A file name a filesystem will accept, on every platform.
 *
 * EstablishmentName_InvoiceId.pdf, where the invoice id is its first 12
 * characters — so "ABC/Grand Hotel" and "SWC/INV/0025" become
 * "ABC_Grand Hotel_SWC_INV_0025.pdf": the slashes that would break it are
 * gone, and the spaces that make it readable are not.
 */
export function billingReceiptFileName(doc: BillingReceiptDocument): string {
  const name = String(doc.business_name || 'Business')
    .replace(INVALID_FILENAME_CHARS, '_')
    // Collapse the runs an odd name can leave behind.
    .replace(/\s+/g, ' ')
    .trim()
    // A trailing dot or space is legal in the string and rejected by Windows.
    .replace(/[. ]+$/, '')
    .slice(0, 60) || 'Business';

  const invoice = displayInvoiceNumber(doc.invoice_number)
    .replace(INVALID_FILENAME_CHARS, '_')
    .trim() || 'Invoice';

  return `${name}_${invoice}.pdf`;
}

export function renderBillingReceiptPdf(doc: BillingReceiptDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({ size: 'A4', margin: MARGIN });
    const chunks: Buffer[] = [];

    pdf.on('data', (chunk: Buffer) => chunks.push(chunk));
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
    pdf.on('error', reject);

    const left = MARGIN;
    const right = pdf.page.width - MARGIN;
    const width = right - left;
    const colWidth = (width - 16) / 2;

    const sectionTitle = (title: string, y: number): number => {
      pdf.rect(left, y, width, 18).fill(PANEL);
      pdf.fillColor(GREEN).font('Helvetica-Bold').fontSize(9.5)
        .text(title.toUpperCase(), left + 8, y + 5, { width: width - 16 });
      return y + 26;
    };

    const field = (label: string, value: unknown, x: number, y: number, w: number): number => {
      const shown = value === null || value === undefined || String(value).trim() === ''
        ? '—'
        : String(value);
      pdf.fillColor(MUTED).font('Helvetica').fontSize(7.5)
        .text(label.toUpperCase(), x, y, { width: w });
      pdf.fillColor(TEXT).font('Helvetica-Bold').fontSize(10)
        .text(shown, x, pdf.y + 1, { width: w });
      return pdf.y + 8;
    };

    const pair = (
      la: string, va: unknown, lb: string, vb: unknown, y: number
    ): number => Math.max(
      field(la, va, left, y, colWidth),
      field(lb, vb, left + colWidth + 16, y, colWidth)
    );

    /** One line of the money block: label left, amount right. */
    const amountRow = (label: string, value: number, y: number, strong = false): number => {
      if (strong) pdf.rect(left, y - 3, width, 20).fill(BAND);
      pdf.fillColor(strong ? DARK : TEXT)
        .font(strong ? 'Helvetica-Bold' : 'Helvetica')
        .fontSize(strong ? 11 : 10)
        .text(label, left + 8, y, { width: width - 130 });
      pdf.fillColor(strong ? DARK : TEXT)
        .font('Helvetica-Bold').fontSize(strong ? 11 : 10)
        .text(`INR ${inr(value)}`, right - 130, y, { width: 122, align: 'right' });
      return y + (strong ? 22 : 16);
    };

    // =================================================================
    // HEADER
    // =================================================================
    pdf.rect(left, MARGIN, width, 26).fill(GREEN);
    pdf.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(13)
      .text('Billing Receipt', left, MARGIN + 7, { width, align: 'center' });

    let y = MARGIN + 38;

    const logo = logoPath();
    if (logo) {
      try {
        pdf.image(logo, left, y, { fit: [48, 48] });
      } catch {
        // A missing or unreadable image must never cost the receipt.
      }
    }

    const titleX = left + (logo ? 58 : 0);
    // THE ESTABLISHMENT NAME is the business's display name, here as everywhere.
    pdf.fillColor(GREEN).font('Helvetica-Bold').fontSize(16)
      .text(doc.business_name, titleX, y, { width: width - (logo ? 58 : 0) - 150 });
    pdf.fillColor(MUTED).font('Helvetica').fontSize(9)
      .text('Business of Laundering', titleX, pdf.y + 1);

    pdf.fillColor(MUTED).font('Helvetica').fontSize(8)
      .text(`Receipt No. ${doc.receipt_number}`, right - 200, MARGIN + 40,
            { width: 200, align: 'right' });
    pdf.text(`Date ${dmy(doc.payment_date)}`, right - 200, pdf.y, { width: 200, align: 'right' });

    y = Math.max(pdf.y + 12, y + 56);
    pdf.moveTo(left, y).lineTo(right, y).strokeColor(GREEN).lineWidth(1).stroke();
    y += 12;

    // =================================================================
    // PAYMENT DETAILS
    // =================================================================
    y = sectionTitle('Payment Details', y);
    y = pair(
      // The SHOWN invoice number: its first 12 characters, the same string the
      // invoice and the screen use.
      'Invoice ID', displayInvoiceNumber(doc.invoice_number),
      'Payment date', dmy(doc.payment_date),
      y
    );
    y = pair(
      'Payment type', PAYMENT_TYPE_LABEL[doc.payment_type] || doc.payment_type,
      'Invoice period', `${dmy(doc.invoice_period_from)} to ${dmy(doc.invoice_period_to)}`,
      y
    );
    // Shown only when there is one — it is collected for Netbanking alone.
    if (doc.payment_reference) {
      y = field('Payment reference', doc.payment_reference, left, y, width);
    }

    // =================================================================
    // THE MONEY
    //
    // Read from the stored receipt, so a reprint says what it said when it was
    // issued rather than what the business owes today.
    // =================================================================
    y = sectionTitle('Amount', y);
    y = amountRow('Previous balance', doc.previous_balance, y);
    y = amountRow('Current invoice amount', doc.current_invoice_amount, y);
    pdf.moveTo(left + 8, y - 4).lineTo(right - 8, y - 4)
      .strokeColor(RULE).lineWidth(0.5).stroke();
    y += 2;
    y = amountRow('Total amount due', doc.total_amount_due, y, true);
    y += 4;
    y = amountRow('Payment received', doc.payment_received, y);
    y = amountRow('Remaining payment amount', doc.remaining_balance, y, true);

    if (doc.notes) {
      y += 8;
      y = sectionTitle('Notes', y);
      pdf.fillColor(TEXT).font('Helvetica').fontSize(9)
        .text(doc.notes, left, y, { width });
      y = pdf.y + 8;
    }

    // =================================================================
    // FOOT
    // =================================================================
    const footY = Math.max(y + 20, pdf.page.height - MARGIN - 40);
    pdf.moveTo(left, footY).lineTo(right, footY).strokeColor(RULE).lineWidth(0.5).stroke();
    pdf.fillColor(MUTED).font('Helvetica').fontSize(7.5)
      .text(
        'This receipt records a payment against the invoice named above. ' +
        'It does not alter the invoice, and the amounts it states are those at the time of payment.',
        left, footY + 6, { width, align: 'center' }
      );

    pdf.end();
  });
}
