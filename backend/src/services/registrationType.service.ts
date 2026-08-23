import { AppError } from '../utils/appError';

/**
 * B2B or B2C — the registration type of a business account.
 *
 * ONE PLACE, because three would drift. The Manager's registration form, the
 * Super Admin's edit form and the approval path all validate through here, so
 * "B2B needs a GSTIN" cannot mean something different depending on which
 * screen the record came in through.
 *
 * IT IS NOT `business_type`. That column is the establishment CATEGORY —
 * hotel, restaurant, hostel, corporate — and answers a different question.
 * The registration type lives in `businesses.registration_type`, which
 * migration 031 made out of the unused `customer_type` column rather than
 * adding a second field for one fact.
 *
 * THE RULE, in full:
 *
 *   B2B   a GSTIN is REQUIRED. It is still verified against the provider by
 *         whichever path is writing the record; this only settles whether one
 *         has to be there at all.
 *
 *   B2C   a GSTIN is NOT collected, and any value sent with a B2C submission
 *         is DISCARDED rather than stored. The form disables the field, but
 *         the form is not the enforcement: a client that posts one anyway
 *         gets a business with no GSTIN, never a B2C registration quietly
 *         carrying a tax number nobody verified.
 *
 * Anything that is neither is refused outright, so an API caller cannot slip
 * a third value past the check by inventing one.
 */

export type RegistrationType = 'B2B' | 'B2C';

export const REGISTRATION_TYPES: RegistrationType[] = ['B2B', 'B2C'];

export const REGISTRATION_TYPE_OPTIONS: Array<{ value: RegistrationType; label: string }> = [
  { value: 'B2B', label: 'B2B' },
  { value: 'B2C', label: 'B2C' },
];

/**
 * The submitted registration type, or a 400.
 *
 * `fallback` is what an ABSENT value means. It is only ever supplied by the
 * edit path, where "not sent" means "leave it as it is"; a registration with
 * no type at all is rejected, because guessing it is how a B2C account ends
 * up demanding a GSTIN.
 */
export function parseRegistrationType(
  value: unknown,
  fallback?: RegistrationType
): RegistrationType {
  const text = String(value ?? '').trim().toUpperCase();
  if (!text) {
    if (fallback) return fallback;
    throw new AppError('Please choose a registration type: B2B or B2C.', 400);
  }
  if (!REGISTRATION_TYPES.includes(text as RegistrationType)) {
    throw new AppError('Registration type must be B2B or B2C.', 400);
  }
  return text as RegistrationType;
}

/**
 * What GSTIN this submission actually gets to keep.
 *
 * Returns the submitted value for a B2B registration, having first insisted
 * that there is one, and `null` for a B2C one whatever was sent. Callers
 * write the return value, so the discarding is not something each of them has
 * to remember to do.
 */
export function gstForRegistrationType(
  registrationType: RegistrationType,
  submittedGstin: unknown
): string | null {
  const gstin = String(submittedGstin ?? '').trim();

  if (registrationType === 'B2B') {
    if (!gstin) {
      throw new AppError('GST number is required for a B2B registration.', 400);
    }
    return gstin;
  }

  // B2C: ignored on purpose, not stored. A number typed into a disabled field
  // by a client that ignores the form is simply not a B2C registration's GST.
  return null;
}
