import { query } from '../config/database';
import { AppError } from '../utils/appError';
import { getCompleteness, Completeness } from './businessCompleteness';

/**
 * A business's own profile.
 *
 * WHERE EACH FIELD NOW LIVES. Migration 031 split what used to be one wide
 * `businesses` row in two:
 *
 *   businesses      the establishment — name, type, B2B/B2C, GSTIN, PAN,
 *                   addresses, city/state/pincode, status
 *   business_users  the people — the head (PRIMARY, which is also the login
 *                   account) and the alternative contacts
 *
 * The RESPONSE SHAPE IS UNCHANGED, deliberately: `contact_person_name`,
 * `mobile_number`, `email_id`, `alternate_contact_person` and
 * `alternate_mobile_no` are all still returned under those names, they are
 * simply read from the contact rows now. The app's existing profile screen
 * needs no change to keep working.
 */

export interface BusinessProfile {
  business_id: string;
  business_name: string;
  /** The establishment CATEGORY (hotel, restaurant…), from businesses.business_type. */
  customer_type: string | null;
  /** B2B or B2C — the registration type. */
  registration_type: string;
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

/**
 * The first alternative contact, as the two flat fields the profile has
 * always reported. A business may hold up to three; this pair is the
 * self-service view of the first, and the Super Admin screens show the
 * whole list.
 */
const ALTERNATE_COLUMNS = `
  (SELECT a.name FROM business_users a
    WHERE a.business_id = b.id AND a.contact_type = 'ALTERNATIVE'
    ORDER BY a.id LIMIT 1) AS alternate_contact_person,
  (SELECT a.mobile_number FROM business_users a
    WHERE a.business_id = b.id AND a.contact_type = 'ALTERNATIVE'
    ORDER BY a.id LIMIT 1) AS alternate_mobile_no`;

async function getProfile(businessUserId: string): Promise<BusinessProfile> {
  const businessId = await getOwnedBusinessId(businessUserId);

  const result = await query<BusinessProfile>(
    `SELECT b.id AS business_id,
            b.name AS business_name,
            b.business_type AS customer_type,
            b.registration_type,
            b.other_type_specify,
            COALESCE(b.establishment_address, b.address) AS establishment_address,
            b.gst_number, b.pan_number, b.website,
            bu.name AS contact_person_name, bu.designation,
            bu.mobile_number,
            bu.whatsapp_number,
            COALESCE(bu.email, b.email) AS email_id,
            ${ALTERNATE_COLUMNS},
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
  /**
   * The establishment's PICKUP POINT.
   *
   * `businesses` has carried these columns since the first schema and nothing
   * has ever written them through this path — only a legacy admin route did,
   * which the Super Admin onboarding flow does not use. The result was that
   * every business onboarded through the live flow had NULL coordinates.
   *
   * That is not cosmetic: rider dispatch matches a job to the riders nearest
   * the pickup point, so a business with no coordinates can never have a
   * rider offered to it at all. Both are set together or neither is.
   */
  latitude?: number | null;
  longitude?: number | null;
}

function optionalText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * What one profile submission changes, split by the table it changes.
 *
 * `businessFields` go to `businesses`, `contactFields` to the business's
 * PRIMARY `business_users` row, and `alternate` replaces the first
 * alternative contact. Splitting it here rather than at each call site is
 * what keeps the self-service update and the Super Admin's update applying
 * the same rules to the same columns.
 */
export interface ProfileUpdatePlan {
  fields: string[];
  values: unknown[];
  contactFields: string[];
  contactValues: unknown[];
  alternate?: { name: string | null; mobile: string | null };
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
): ProfileUpdatePlan {
  const fields: string[] = [];
  const values: unknown[] = [];
  const contactFields: string[] = [];
  const contactValues: unknown[] = [];

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

  /*
   * THE PICKUP POINT — both coordinates or neither.
   *
   * A half-set pair is worse than none: dispatch reads latitude AND longitude,
   * so a row carrying one of them is a row that looks located and is not.
   * Clearing the point is still allowed by passing null for both.
   */
  if (input.latitude !== undefined || input.longitude !== undefined) {
    const lat = input.latitude;
    const lng = input.longitude;

    const clearing =
      (lat === null || lat === undefined) && (lng === null || lng === undefined);

    if (clearing) {
      fields.push('latitude = ?', 'longitude = ?');
      values.push(null, null);
    } else {
      const latNum = Number(lat);
      const lngNum = Number(lng);

      if (!Number.isFinite(latNum) || !Number.isFinite(lngNum)) {
        throw new AppError('Latitude and longitude must both be numbers', 400);
      }
      if (latNum < -90 || latNum > 90) {
        throw new AppError('Latitude must be between -90 and 90', 400);
      }
      if (lngNum < -180 || lngNum > 180) {
        throw new AppError('Longitude must be between -180 and 180', 400);
      }
      // 0,0 is in the Atlantic and is what a broken client sends -- the same
      // check the service-area validator makes.
      if (latNum === 0 && lngNum === 0) {
        throw new AppError('0,0 is not a valid pickup location', 400);
      }

      fields.push('latitude = ?', 'longitude = ?');
      values.push(latNum, lngNum);
    }
  }

  /* ---- The contact person: `business_users`, not `businesses` ---- */

  if (input.contactPersonName !== undefined) {
    const value = String(input.contactPersonName).trim();
    if (value.length < 2 || value.length > 255) {
      throw new AppError('Contact person name must be between 2 and 255 characters', 400);
    }
    contactFields.push('name = ?');
    contactValues.push(value);
  }

  if (input.designation !== undefined) {
    contactFields.push('designation = ?');
    contactValues.push(optionalText(input.designation));
  }

  if (input.mobileNumber !== undefined) {
    const value = String(input.mobileNumber).trim();
    if (!MOBILE_RE.test(value)) {
      throw new AppError('Invalid mobile number', 400);
    }
    contactFields.push('mobile_number = ?');
    contactValues.push(value);
  }

  if (input.whatsappNumber !== undefined) {
    const value = optionalText(input.whatsappNumber);
    if (value && !MOBILE_RE.test(value)) {
      throw new AppError('Invalid WhatsApp number', 400);
    }
    contactFields.push('whatsapp_number = ?');
    contactValues.push(value);
  }

  if (input.emailId !== undefined) {
    const value = String(input.emailId).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      throw new AppError('Invalid email address', 400);
    }
    contactFields.push('email = ?');
    contactValues.push(value);
  }

  /* ---- The first alternative contact ---- */

  let alternate: ProfileUpdatePlan['alternate'];
  if (input.alternateContactPerson !== undefined || input.alternateMobileNo !== undefined) {
    const mobile = optionalText(input.alternateMobileNo);
    if (mobile && !MOBILE_RE.test(mobile)) {
      throw new AppError('Invalid alternate mobile number', 400);
    }
    alternate = { name: optionalText(input.alternateContactPerson), mobile };
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

  return { fields, values, contactFields, contactValues, alternate };
}

/**
 * Applies the contact half of a profile update.
 *
 * `contactRowId` is the row to write the head onto — the authenticated
 * account on the self-service path, the business's PRIMARY row on the Super
 * Admin path. The alternative is written as a real contact row, so the same
 * number that appears here is the one the sign-in lookup will find.
 */
export async function applyContactUpdate(
  businessId: string,
  contactRowId: string | null,
  plan: ProfileUpdatePlan
): Promise<void> {
  if (plan.contactFields.length > 0 && contactRowId) {
    await query(
      `UPDATE business_users SET ${plan.contactFields.join(', ')}, updated_at = NOW()
        WHERE id = ?`,
      [...plan.contactValues, contactRowId]
    );
  }

  if (!plan.alternate) return;

  const existing = await query<{ id: string }>(
    `SELECT id FROM business_users
      WHERE business_id = ? AND contact_type = 'ALTERNATIVE'
      ORDER BY id LIMIT 1`,
    [businessId]
  );

  // A blank number clears the contact rather than leaving a nameless row
  // behind; a row that carries credentials is never removed this way.
  if (!plan.alternate.mobile) {
    if (existing.rows[0]) {
      await query(`DELETE FROM business_users WHERE id = ? AND password_hash IS NULL`, [
        existing.rows[0].id,
      ]);
    }
    return;
  }

  const clash = await query<{ id: string }>(
    `SELECT id FROM business_users WHERE mobile_number = ? AND business_id <> ?`,
    [plan.alternate.mobile, businessId]
  );
  if (clash.rows[0]) {
    throw new AppError(
      'That alternate mobile number is already registered against another business.',
      409
    );
  }

  const name = plan.alternate.name || 'Alternative contact';
  if (existing.rows[0]) {
    await query(
      `UPDATE business_users SET name = ?, mobile_number = ?, updated_at = NOW() WHERE id = ?`,
      [name, plan.alternate.mobile, existing.rows[0].id]
    );
    return;
  }
  await query(
    `INSERT INTO business_users
       (business_id, contact_type, name, designation, email, mobile_number,
        whatsapp_number, password_hash, is_active, login_enabled)
     VALUES (?, 'ALTERNATIVE', ?, NULL, NULL, ?, NULL, NULL, TRUE, TRUE)`,
    [businessId, name, plan.alternate.mobile]
  );
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

  const plan = buildBusinessProfileUpdate(input);

  if (plan.fields.length > 0) {
    await query(`UPDATE businesses SET ${plan.fields.join(', ')}, updated_at = NOW() WHERE id = ?`, [
      ...plan.values,
      businessId,
    ]);
  }

  // The contact person is the signed-in account's own row, which is also
  // what the Order Summary and the PDF read.
  await applyContactUpdate(businessId, businessUserId, plan);

  return getProfile(businessUserId);
}

export { getProfile, updateProfile, getOwnedBusinessId };
