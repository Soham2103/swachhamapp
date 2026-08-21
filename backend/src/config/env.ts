import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

interface AppConfig {
  DATABASE_HOST: string;
  DATABASE_PORT: number;
  DATABASE_USER: string;
  DATABASE_PASSWORD: string;
  DATABASE_NAME: string;
  DATABASE_SSL: boolean;
  JWT_SECRET: string;
  JWT_EXPIRES_IN: string;
  JWT_REFRESH_SECRET: string;
  JWT_REFRESH_EXPIRES_IN: string;
  PORT: number;
  NODE_ENV: string;
  CLIENT_URL: string;
  OTP_PROVIDER: string;
  OTP_API_KEY: string;
  OTP_SENDER_ID: string;
  BUSINESS_TZ_OFFSET: string;
}

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value || value.trim() === '') {
    throw new Error(`[Config] Missing required environment variable: ${key}`);
  }
  return value.trim();
}

function optionalEnv(key: string, defaultValue: string): string {
  const value = process.env[key];
  return value && value.trim() !== '' ? value.trim() : defaultValue;
}

/**
 * Strict boolean parse for security-relevant switches.
 *
 * The previous form was `optionalEnv('DATABASE_SSL', 'false') === 'true'`, which
 * quietly turned ANY unrecognised value into `false`. A .env carrying the
 * perfectly reasonable-looking `DATABASE_SSL=REQUIRED` therefore disabled TLS
 * and the pool connected to a remote managed database in plaintext, with no
 * warning anywhere. A typo must never be the thing that downgrades transport
 * security, so an unrecognised value is a startup error instead.
 */
const TRUE_VALUES = new Set(['true', '1', 'yes', 'on', 'required', 'require']);
const FALSE_VALUES = new Set(['false', '0', 'no', 'off', 'disabled', 'disable']);

function booleanEnv(key: string, defaultValue: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return defaultValue;

  const normalized = raw.trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;

  throw new Error(
    `[Config] Invalid boolean for ${key}: "${raw.trim()}". ` +
      `Use one of ${[...TRUE_VALUES].join(', ')} or ${[...FALSE_VALUES].join(', ')}.`
  );
}

const config: AppConfig = {
  DATABASE_HOST: requireEnv('DATABASE_HOST'),
  DATABASE_PORT: parseInt(optionalEnv('DATABASE_PORT', '3306'), 10),
  DATABASE_USER: requireEnv('DATABASE_USER'),
  DATABASE_PASSWORD: requireEnv('DATABASE_PASSWORD'),
  DATABASE_NAME: requireEnv('DATABASE_NAME'),
  DATABASE_SSL: booleanEnv('DATABASE_SSL', false),
  JWT_SECRET: requireEnv('JWT_SECRET'),
  JWT_EXPIRES_IN: optionalEnv('JWT_EXPIRES_IN', '7d'),
  JWT_REFRESH_SECRET: optionalEnv('JWT_REFRESH_SECRET', requireEnv('JWT_SECRET') + '_refresh'),
  JWT_REFRESH_EXPIRES_IN: optionalEnv('JWT_REFRESH_EXPIRES_IN', '30d'),
  PORT: parseInt(optionalEnv('PORT', '5000'), 10),
  NODE_ENV: optionalEnv('NODE_ENV', 'development'),
  CLIENT_URL: optionalEnv('CLIENT_URL', 'http://localhost:3000'),
  OTP_PROVIDER: optionalEnv('OTP_PROVIDER', 'development'),
  OTP_API_KEY: optionalEnv('OTP_API_KEY', ''),
  OTP_SENDER_ID: optionalEnv('OTP_SENDER_ID', ''),
  // Business calendar day used for daily order-number sequences. The DB
  // server runs in UTC, so this offset decides when the day rolls over.
  BUSINESS_TZ_OFFSET: optionalEnv('BUSINESS_TZ_OFFSET', '+05:30'),
};

export { config };
export type { AppConfig };
