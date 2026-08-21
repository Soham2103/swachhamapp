import { query } from '../config/database';
import { AppError } from '../utils/appError';
import { getCompleteness, Completeness } from './businessCompleteness';

export interface BusinessProfile {
  business_id: string;
  business_name: string;
  customer_type: string | null;
  other_type_specify: string | null;
  establishment_address: string | null;
  gst_number: string | null;
  pan_number: string | null;
  website: string | null;
  contact_person_name: string | null;
  designation: string | null;
  mobile_number: string | null;
  whatsapp_number: string | null;
  email_id: string | null;
  alternate_contact_person: string | null;
  alternate_mobile_no: string | null;
  status: string;
  /** Whether the mandatory establishment details are all on file. */
  is_complete?: boolean;
  missing_fields?: Completeness['missing_fields'];
  account_name: string;
  account_email: string;
  created_at: Date;
  updated_at: Date;
}

const CUSTOMER_TYPES = ['HOTEL_RESORT', 'RESTAURANT', 'HOSTEL', 'CORPORATE', 'INSTITUTION', 'OTHER'];

const GST_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/i;
const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/i;
const MOBILE_RE = /^[6-9]\d{9}$/;
const URL_RE = /^https?:\/\/.+/i;

/**
 * Resolves the business owned by the authenticated business user.
 * Every profile read/write goes through this, so a business user can
 * never reach another business's row.
 */
async function getOwnedBusinessId(businessUserId: string): Promise<string> {
  const result = await query<{ business_id: string }>(
    `SELECT business_id FROM business_users WHERE id = ? AND is_active = true`,
    [businessUserId]
  );
  const row = result.rows[0];
  if (!row) {
    throw new AppError('Business account not found', 404);
  }
  return row.business_id;
}

async function getProfile(businessUserId: string): Promise<BusinessProfile> {
  const businessId = await getOwnedBusinessId(businessUserId);

  const result = await query<BusinessProfile>(
    `SELECT b.id AS business_id,
            b.name AS business_name,
            b.business_type AS customer_type,
            b.other_type_specify,
            COALESCE(b.establishment_address, b.address) AS establishment_address,
            b.gst_number, b.pan_number, b.website,
            b.contact_person_name, b.designation,
            COALESCE(bu.mobile_number, b.mobile_number) AS mobile_number,
            b.whatsapp_number,
            COALESCE(b.email_id, bu.email) AS email_id,
            b.alternate_contact_person, b.alternate_mobile_no,
            b.status,
            bu.name AS account_name,
            bu.email AS account_email,
            b.created_at, b.updated_at
     FROM businesses b
     JOIN business_users bu ON bu.business_id = b.id
     WHERE b.id = ? AND bu.id = ?`,
    [businessId, businessUserId]
  );

  const profile = result.rows[0];
  if (!profile) {
    throw new AppError('Business profile not found', 404);
  }

  // Returned with the profile so the screen can prompt for exactly what
  // is missing instead of only finding out at checkout.
  const completeness = await getCompleteness(businessId);
  return { ...profile, ...completeness };
}

export interface UpdateBusinessProfileInput {
  customerType?: string;
  otherTypeSpecify?: string | null;
  establishmentAddress?: string;
  gstNumber?: string | null;
  panNumber?: string | null;
  website?: string | null;
  contactPersonName?: string;
  designation?: string | null;
  mobileNumber?: string;
  whatsappNumber?: string | null;
  emailId?: string;
  alternateContactPerson?: string | null;
  alternateMobileNo?: string | null;
}

function optionalText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Turns a profile input into SQL assignments, with every field's
 * validation in one place.
 *
 * Shared by the business's own profile update and by the super admin's
 * Company / Establishment Details screen, so a record saved on the
 * client's behalf is validated exactly like one the client saves
 * itself — no second, drifting copy of these rules.
 */
export function buildBusinessProfileUpdate(
  input: UpdateBusinessProfileInput & { establishmentName?: string },
  options: { allowNameChange?: boolean } = {}
): { fields: string[]; values: unknown[] } {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (input.customerType !== undefined) {
    const value = String(input.customerType).trim().toUpperCase();
    if (!CUSTOMER_TYPES.includes(value)) {
      throw new AppError('Invalid customer type', 400);
    }
    fields.push('business_type = ?');
    values.push(value);
  }

  if (input.otherTypeSpecify !== undefined) {
    fields.push('other_type_specify = ?');
    values.push(optionalText(input.otherTypeSpecify));
  }

  if (input.establishmentAddress !== undefined) {
    const value = String(input.establishmentAddress).trim();
    if (value.length < 5) {
      throw new AppError('Establishment address must be at least 5 characters', 400);
    }
    fields.push('establishment_address = ?', 'address = ?');
    values.push(value, value);
  }

  if (input.gstNumber !== undefined) {
    const value = optionalText(input.gstNumber);
    if (value && !GST_RE.test(value)) {
      throw new AppError('Invalid GST number', 400);
    }
    fields.push('gst_number = ?');
    values.push(value ? value.toUpperCase() : null);
  }

  if (input.panNumber !== undefined) {
    const value = optionalText(input.panNumber);
    if (value && !PAN_RE.test(value)) {
      throw new AppError('Invalid PAN number', 400);
    }
    fields.push('pan_number = ?');
    values.push(value ? value.toUpperCase() : null);
  }

  if (input.website !== undefined) {
    const value = optionalText(input.website);
    if (value && !URL_RE.test(value)) {
      throw new AppError('Website must be a valid URL starting with http:// or https://', 400);
    }
    fields.push('website = ?');
    values.push(value);
  }

  if (input.contactPersonName !== undefined) {
    const value = String(input.contactPersonName).trim();
    if (value.length < 2 || value.length > 255) {
      throw new AppError('Contact person name must be between 2 and 255 characters', 400);
    }
    fields.push('contact_person_name = ?');
    values.push(value);
  }

  if (input.designation !== undefined) {
    fields.push('designation = ?');
    values.push(optionalText(input.designation));
  }

  if (input.mobileNumber !== undefined) {
    const value = String(input.mobileNumber).trim();
    if (!MOBILE_RE.test(value)) {
      throw new AppError('Invalid mobile number', 400);
    }
    fields.push('mobile_number = ?');
    values.push(value);
  }

  if (input.whatsappNumber !== undefined) {
    const value = optionalText(input.whatsappNumber);
    if (value && !MOBILE_RE.test(value)) {
      throw new AppError('Invalid WhatsApp number', 400);
    }
    fields.push('whatsapp_number = ?');
    values.push(value);
  }

  if (input.emailId !== undefined) {
    const value = String(input.emailId).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      throw new AppError('Invalid email address', 400);
    }
    fields.push('email_id = ?');
    values.push(value);
  }

  if (input.alternateContactPerson !== undefined) {
    fields.push('alternate_contact_person = ?');
    values.push(optionalText(input.alternateContactPerson));
  }

  if (input.alternateMobileNo !== undefined) {
    const value = optionalText(input.alternateMobileNo);
    if (value && !MOBILE_RE.test(value)) {
      throw new AppError('Invalid alternate mobile number', 400);
    }
    fields.push('alternate_mobile_no = ?');
    values.push(value);
  }


  // Only the super admin path may correct the establishment name; on the
  // self-service path the name is the profile's identity and is fixed.
  if (options.allowNameChange && input.establishmentName !== undefined) {
    const value = String(input.establishmentName).trim();
    if (value.length < 2 || value.length > 255) {
      throw new AppError('Establishment name must be between 2 and 255 characters', 400);
    }
    fields.push('name = ?', 'establishment_name = ?');
    values.push(value, value);
  }

  return { fields, values };
}

/**
 * Business name is intentionally not updatable here: it is set once at
 * registration and is the profile's identity.
 */
async function updateProfile(
  businessUserId: string,
  input: UpdateBusinessProfileInput
): Promise<BusinessProfile> {
  const businessId = await getOwnedBusinessId(businessUserId);

  const { fields, values } = buildBusinessProfileUpdate(input);

  if (fields.length === 0) {
    return getProfile(businessUserId);
  }

  fields.push('updated_at = NOW()');
  values.push(businessId);

  await query(`UPDATE businesses SET ${fields.join(', ')} WHERE id = ?`, values);

  // Keep the account row's mobile number in step with the profile, since the
  // authenticated record is what the Order Summary and PDF read.
  if (input.mobileNumber !== undefined) {
    await query(`UPDATE business_users SET mobile_number = ?, updated_at = NOW() WHERE id = ?`, [
      String(input.mobileNumber).trim(),
      businessUserId,
    ]);
  }

  return getProfile(businessUserId);
}

export { getProfile, updateProfile, getOwnedBusinessId };
