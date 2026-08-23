import { AppError } from './appError';

/**
 * Initial-password policy.
 *
 * THERE IS NO PASSWORD GENERATOR HERE, deliberately. Every initial password
 * in this system — Manager, Business user, Rider, Sorter — is typed by a
 * Super Admin. Nothing generates one, so there is nothing to accidentally
 * fall back to: a caller that forgets to pass a password gets a 400, not a
 * random string nobody knows.
 *
 * THE POLICY IS THE ONE THE APP ALREADY HAD. `validators/auth.validators`
 * has required at least 8 characters with a letter and a digit since
 * customer registration was written. That rule is restated here rather than
 * invented, so a Super Admin setting a password and a customer choosing one
 * are held to the same standard.
 *
 * A plaintext password passes through this module and is never kept: nothing
 * here stores, caches, logs or returns one.
 */

/** The existing rule: at least this many characters. */
export const PASSWORD_MIN_LENGTH = 8;

/**
 * An upper bound as well as a lower one.
 *
 * bcrypt silently ignores everything past 72 bytes, so a longer password
 * would be quietly truncated — better to say so than to accept a 200
 * character passphrase and hash only its start.
 */
export const PASSWORD_MAX_LENGTH = 72;

/**
 * Validates an initial password and its confirmation.
 *
 * Returns the password so the caller can hash it in one expression; the
 * value is not retained here.
 *
 * CONFIRMATION IS MANDATORY. There is no "single field" mode: an omitted
 * confirm is a rejected request, not a skipped check. An earlier version
 * treated `undefined` as "nothing to compare" and consequently accepted a
 * body carrying `password` alone, which is exactly the typo this field
 * exists to catch.
 */
export function validatePassword(
  password: unknown,
  confirm: unknown,
  label = 'Password'
): string {
  if (typeof password !== 'string' || password.length === 0) {
    throw new AppError(`${label} is required.`, 400);
  }

  // Not trimmed: a leading or trailing space is a legitimate character in a
  // password, and silently removing it would make the stored hash disagree
  // with what was typed and emailed.
  if (password.length < PASSWORD_MIN_LENGTH) {
    throw new AppError(
      `${label} must be at least ${PASSWORD_MIN_LENGTH} characters long.`,
      400
    );
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    throw new AppError(
      `${label} must be at most ${PASSWORD_MAX_LENGTH} characters long.`,
      400
    );
  }
  if (!/[A-Za-z]/.test(password)) {
    throw new AppError(`${label} must contain at least one letter.`, 400);
  }
  if (!/\d/.test(password)) {
    throw new AppError(`${label} must contain at least one number.`, 400);
  }

  if (typeof confirm !== 'string' || confirm.length === 0) {
    throw new AppError('Please confirm the password.', 400);
  }
  if (confirm !== password) {
    throw new AppError('Passwords do not match.', 400);
  }

  return password;
}
