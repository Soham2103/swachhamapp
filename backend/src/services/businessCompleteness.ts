import { query } from '../config/database';
import { AppError } from '../utils/appError';

/**
 * The information a business must have on file before it is allowed to
 * place an order.
 *
 * This list is the single source of truth: the ordering gate, the
 * business's own profile response and the super admin's Company /
 * Establishment Details screen all read it, so "complete" can never
 * mean one thing in one place and something else in another.
 */
export const MANDATORY_FIELDS = [
  { key: 'establishment_name', label: 'Establishment name' },
  { key: 'establishment_address', label: 'Address' },
  { key: 'gst_number', label: 'GST number' },
  { key: 'contact_person_name', label: 'Contact person name' },
  { key: 'mobile_number', label: 'Mobile number' },
  { key: 'email_id', label: 'Email ID' },
] as const;

export type MandatoryFieldKey = (typeof MANDATORY_FIELDS)[number]['key'];

/**
 * A field counts as present only if it is non-null AND non-blank — a
 * row saved with an empty string is missing information just as much
 * as a NULL, and treating the two differently is how a "complete"
 * business ends up with a blank GST number.
 *
 * The COALESCE chains mirror businessProfile.getProfile exactly, so a
 * value the profile screen displays is a value this counts as present.
 */
const PRESENCE_SQL = `
  SELECT b.id,
         COALESCE(NULLIF(TRIM(b.establishment_name), ''), NULLIF(TRIM(b.name), ''))            AS establishment_name,
         COALESCE(NULLIF(TRIM(b.establishment_address), ''), NULLIF(TRIM(b.address), ''))      AS establishment_address,
         NULLIF(TRIM(b.gst_number), '')                                                        AS gst_number,
         NULLIF(TRIM(b.contact_person_name), '')                                               AS contact_person_name,
         COALESCE(NULLIF(TRIM(b.mobile_number), ''), MIN(NULLIF(TRIM(bu.mobile_number), '')))  AS mobile_number,
         COALESCE(NULLIF(TRIM(b.email_id), ''), NULLIF(TRIM(b.email), ''),
                  MIN(NULLIF(TRIM(bu.email), '')))                                             AS email_id
    FROM businesses b
    LEFT JOIN business_users bu ON bu.business_id = b.id
   WHERE b.id = ?
   GROUP BY b.id`;

export interface Completeness {
  is_complete: boolean;
  missing_fields: Array<{ key: MandatoryFieldKey; label: string }>;
}

/** Which mandatory fields this business is still missing. */
async function getCompleteness(businessId: string): Promise<Completeness> {
  const result = await query<Record<string, string | null>>(PRESENCE_SQL, [businessId]);
  const row = result.rows[0];
  if (!row) {
    throw new AppError('Business not found', 404);
  }

  const missing = MANDATORY_FIELDS.filter((field) => !row[field.key]).map((field) => ({
    key: field.key,
    label: field.label,
  }));

  return { is_complete: missing.length === 0, missing_fields: missing };
}

/**
 * Ordering gate. Throws with the exact list of what is missing rather
 * than a generic refusal, so the client can say which fields to fill
 * instead of making someone guess.
 */
async function assertComplete(businessId: string): Promise<void> {
  const { is_complete, missing_fields } = await getCompleteness(businessId);
  if (is_complete) return;

  const labels = missing_fields.map((f) => f.label).join(', ');
  const error = new AppError(
    `This business account is missing required information (${labels}). Please complete the Company / Establishment Details before placing an order.`,
    403
  );
  (error as AppError & { missing_fields?: unknown }).missing_fields = missing_fields;
  throw error;
}

export { getCompleteness, assertComplete };
