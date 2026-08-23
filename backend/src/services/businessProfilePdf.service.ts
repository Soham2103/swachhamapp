import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';
import { query } from '../config/database';
import { AppError } from '../utils/appError';
import { listContacts, BusinessContactRow } from './businessContact.service';

/**
 * The Business Profile, as a PDF, rendered on the server.
 *
 * WHY THE SERVER. Every figure and every field is read from the database
 * here and drawn here, so the file the Super Admin downloads is a record of
 * what is actually stored — not of what a screen happened to be showing. The
 * app receives finished bytes and has nothing left to assemble.
 *
 * IT REUSES THE EXISTING PDF STACK. `pdfkit` is what `invoicePdf.service`
 * already draws the tax invoice with, down to the same blue band, the same
 * label/value pairs and the same logo lookup, so the two documents look like
 * they came from the same company. No second PDF library was added.
 *
 * WHAT IS DELIBERATELY NOT ON IT:
 *
 *   no password, and no password hash
 *   no OTP, and nothing about how one is verified
 *   no token, no session, no provider key
 *
 * The SELECT below names its columns one by one for exactly that reason:
 * `password_hash` is not among them, so there is no path by which a
 * credential could reach the page even if a column were added later.
 *
 * ONE BUSINESS PER FILE. The id is bound as a parameter and the document is
 * built from that single row, so a download can never spill a second
 * business's details into the first one's record.
 */

/** The blue the Swachham documents are banded and ruled in. */
const BLUE = '#097AA8';
const TEXT = '#1B1B1B';
const MUTED = '#5A6672';
const RULE = '#C9D6DE';
const PANEL = '#F2F8FB';

const MARGIN = 40;

/** The Swachham mark, drawn when the asset is present. */
function logoPath(): string | null {
  const candidates = [
    path.resolve(process.cwd(), '../mobile/assets/swachham-logo.png'),
    path.resolve(process.cwd(), 'assets/swachham-logo.png'),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

/** A Date or an ISO string as "21 August 2026". */
function longDate(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

/** HOTEL_RESORT -> "Hotel / Resort", so the page reads as English. */
function prettyEnum(value: unknown): string {
  const text = String(value ?? '').trim();
  if (!text) return '—';
  return text
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' / ');
}

export interface BusinessProfileDocument {
  id: string;
  name: string;
  legal_name: string | null;
  establishment_name: string | null;
  business_type: string | null;
  registration_type: string;
  other_type_specify: string | null;
  gst_number: string | null;
  gst_verified: boolean;
  gst_status: string | null;
  pan_number: string | null;
  address: string | null;
  establishment_address: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
  website: string | null;
  billing_cycle: string | null;
  status: string;
  created_at: Date;
  updated_at: Date;
  contacts: BusinessContactRow[];
}

/**
 * Everything the document prints, for ONE business.
 *
 * Columns are listed explicitly rather than `SELECT *` so that what can
 * appear on the page is a decision made here, in the open, instead of a
 * consequence of the table's shape.
 */
export async function buildBusinessProfileDocument(
  businessId: string
): Promise<BusinessProfileDocument> {
  const result = await query<any>(
    `SELECT b.id, b.name, b.legal_name, b.establishment_name, b.business_type,
            b.registration_type, b.other_type_specify,
            b.gst_number, b.gst_verified, b.gst_status, b.pan_number,
            b.address, b.establishment_address, b.city, b.state, b.pincode,
            b.website, b.billing_cycle, b.status, b.created_at, b.updated_at
       FROM businesses b
      WHERE b.id = ?`,
    [businessId]
  );
  const row = result.rows[0];
  if (!row) throw new AppError('Business not found.', 404);

  return {
    ...row,
    id: String(row.id),
    gst_verified: Boolean(row.gst_verified),
    // Contacts, but only the fields a business record should carry: the
    // helper returns `has_login` as a boolean and never a hash.
    contacts: await listContacts(String(businessId)),
  };
}

/** A filename that is safe on every platform, derived from the business name. */
export function businessProfileFileName(doc: BusinessProfileDocument): string {
  const slug = (doc.establishment_name || doc.name || 'business')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'business';
  return `business-profile-${slug}-${doc.id}.pdf`;
}

export function renderBusinessProfilePdf(doc: BusinessProfileDocument): Promise<Buffer> {
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

    /* ---- Small drawing helpers, so the page has one visual grammar ---- */

    const sectionTitle = (title: string, y: number): number => {
      pdf.rect(left, y, width, 18).fill(PANEL);
      pdf.fillColor(BLUE).font('Helvetica-Bold').fontSize(9.5)
        .text(title.toUpperCase(), left + 8, y + 5, { width: width - 16 });
      return y + 26;
    };

    /**
     * One label/value pair in a column. Returns the y it finished at, so the
     * caller can lay the next row under the taller of two columns rather than
     * assuming both are one line high.
     */
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
      leftLabel: string, leftValue: unknown,
      rightLabel: string, rightValue: unknown,
      y: number
    ): number => {
      const a = field(leftLabel, leftValue, left, y, colWidth);
      const b = field(rightLabel, rightValue, left + colWidth + 16, y, colWidth);
      return Math.max(a, b);
    };

    // =================================================================
    // HEADER
    // =================================================================
    pdf.rect(left, MARGIN, width, 26).fill(BLUE);
    pdf.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(13)
      .text('Business Profile', left, MARGIN + 7, { width, align: 'center' });

    let y = MARGIN + 38;

    const logo = logoPath();
    if (logo) {
      try {
        pdf.image(logo, left, y, { fit: [48, 48] });
      } catch {
        // A missing or unreadable image must never cost the document.
      }
    }

    const titleX = left + (logo ? 58 : 0);
    pdf.fillColor(BLUE).font('Helvetica-Bold').fontSize(16)
      .text(doc.establishment_name || doc.name, titleX, y, { width: width - (logo ? 58 : 0) - 120 });

    // The legal name earns a line only when it differs from the trading one.
    if (doc.legal_name && doc.legal_name !== (doc.establishment_name || doc.name)) {
      pdf.fillColor(MUTED).font('Helvetica').fontSize(9)
        .text(doc.legal_name, titleX, pdf.y + 1, { width: width - (logo ? 58 : 0) - 120 });
    }

    // The registration type, as a badge, because it is the first thing
    // somebody reading this record wants to know.
    const badge = String(doc.registration_type || 'B2B').toUpperCase();
    const badgeWidth = 52;
    pdf.roundedRect(right - badgeWidth, MARGIN + 38, badgeWidth, 20, 4).fill(BLUE);
    pdf.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(10)
      .text(badge, right - badgeWidth, MARGIN + 44, { width: badgeWidth, align: 'center' });

    pdf.fillColor(MUTED).font('Helvetica').fontSize(7.5)
      .text(`Status: ${doc.status}`, right - 140, MARGIN + 62, { width: 140, align: 'right' });

    y = Math.max(pdf.y + 12, y + 58);
    pdf.moveTo(left, y).lineTo(right, y).strokeColor(BLUE).lineWidth(1).stroke();
    y += 12;

    // =================================================================
    // BUSINESS INFORMATION
    // =================================================================
    y = sectionTitle('Business Information', y);
    y = pair('Business name', doc.establishment_name || doc.name,
             'Legal name', doc.legal_name, y);
    y = pair(
      'Business type',
      doc.business_type === 'OTHER' && doc.other_type_specify
        ? doc.other_type_specify
        : prettyEnum(doc.business_type),
      'Registration type', badge,
      y
    );
    y = pair('Billing cycle', prettyEnum(doc.billing_cycle), 'Website', doc.website, y);

    // =================================================================
    // TAX REGISTRATION
    //
    // Printed for both kinds. A B2C record has no GSTIN by definition, and
    // saying so is more useful on a filed document than an omitted section
    // that reads like a gap in the record.
    // =================================================================
    y = sectionTitle('Tax Registration', y);
    if (String(doc.registration_type).toUpperCase() === 'B2C') {
      pdf.fillColor(TEXT).font('Helvetica').fontSize(9.5)
        .text(
          'This is a B2C registration, which does not carry a GST number.',
          left, y, { width }
        );
      y = pdf.y + 10;
      y = pair('PAN number', doc.pan_number, 'GST number', 'Not applicable (B2C)', y);
    } else {
      y = pair('GST number', doc.gst_number, 'PAN number', doc.pan_number, y);
      y = pair(
        'GST status', doc.gst_status,
        'GST verified', doc.gst_verified ? 'Yes' : 'No',
        y
      );
    }

    // =================================================================
    // ADDRESS
    // =================================================================
    y = sectionTitle('Address', y);
    y = field('Legal address', doc.address, left, y, width);
    // Only when it is genuinely a different place.
    if (doc.establishment_address && doc.establishment_address !== doc.address) {
      y = field('Establishment address', doc.establishment_address, left, y, width);
    }
    y = pair('City', doc.city, 'State', doc.state, y);
    y = field('Pincode', doc.pincode, left, y, colWidth);

    // =================================================================
    // CONTACT INFORMATION
    //
    // The primary contact and every alternative, each with the number the
    // business is actually reachable on. `login_enabled` is shown because it
    // is a real property of the record — whether that number identifies this
    // business at sign-in — and it is a yes/no, never a credential.
    // =================================================================
    const head = doc.contacts.find((c) => c.contact_type === 'BUSINESS_HEAD');
    const alternatives = doc.contacts.filter((c) => c.contact_type === 'ALTERNATIVE');

    y = sectionTitle('Contact Information', y);
    y = pair('Primary contact', head?.name, 'Designation', head?.designation, y);
    y = pair('Primary contact number', head?.mobile, 'WhatsApp number', head?.whatsapp, y);
    y = field('Email', head?.email, left, y, width);

    if (alternatives.length > 0) {
      y = sectionTitle('Alternative Contacts', y);
      alternatives.forEach((contact, index) => {
        // A new page rather than a contact sliced in half at the foot.
        if (y > pdf.page.height - MARGIN - 70) {
          pdf.addPage();
          y = MARGIN;
        }
        y = pair(
          `Alternative contact ${index + 1}`, contact.name,
          'Designation', contact.designation,
          y
        );
        y = pair(
          'Alternative contact number', contact.mobile,
          'Sign-in enabled', contact.login_enabled ? 'Yes' : 'No',
          y
        );
        if (index < alternatives.length - 1) {
          pdf.moveTo(left, y - 4).lineTo(right, y - 4).strokeColor(RULE).lineWidth(0.5).stroke();
          y += 4;
        }
      });
    }

    // =================================================================
    // RECORD
    // =================================================================
    if (y > pdf.page.height - MARGIN - 90) {
      pdf.addPage();
      y = MARGIN;
    }
    y = sectionTitle('Record', y);
    y = pair('Business ID', doc.id, 'Account status', doc.status, y);
    y = pair('Registered on', longDate(doc.created_at), 'Last updated', longDate(doc.updated_at), y);

    // =================================================================
    // FOOT
    // =================================================================
    const footY = Math.max(y + 12, pdf.page.height - MARGIN - 34);
    pdf.moveTo(left, footY).lineTo(right, footY).strokeColor(RULE).lineWidth(0.5).stroke();
    pdf.fillColor(MUTED).font('Helvetica').fontSize(7.5)
      .text(
        `Generated on ${longDate(new Date())} from the Swachham business register. ` +
        'This document contains no passwords or authentication details.',
        left, footY + 6, { width, align: 'center' }
      );

    pdf.end();
  });
}
