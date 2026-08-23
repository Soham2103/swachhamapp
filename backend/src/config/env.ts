import dotenv from 'dotenv';
import path from 'path';

/*
 * Loaded from the backend package root, not the working directory.
 *
 * `process.cwd()` alone is fragile: started from a parent folder, or by a
 * process manager whose cwd is elsewhere, the .env silently fails to load and
 * every optional variable falls back to its default — which is exactly how an
 * integration ends up reporting itself as "not configured" while the file sits
 * there correctly filled in. __dirname is stable (src/config -> backend), and
 * the cwd is kept as a fallback for anyone who relies on it.
 */
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
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

  // --- GSTIN verification (server-side only) ---
  // The app never sees any of these; it calls our own endpoint instead.
  // The provider is swappable: see gstVerification.service.ts.
  GST_PROVIDER: string;
  GST_API_KEY: string;
  /** Only the `generic` provider uses a second credential. */
  GST_API_SECRET: string;
  /** The provider endpoint. Overrides the adapter's documented default. */
  GST_API_URL: string;
  /** When true, a business cannot be created without a verified GSTIN. */
  GST_VERIFICATION_REQUIRED: boolean;

  // --- Tax invoice ---
  // The project had no GST rate or supplier details anywhere, so both are
  // configuration rather than constants baked into the invoice code.
  GST_RATE_PERCENT: number;
  COMPANY_LEGAL_NAME: string;
  COMPANY_GSTIN: string;
  COMPANY_STATE: string;
  COMPANY_ADDRESS: string;
  COMPANY_EMAIL: string;
  COMPANY_PHONE: string;
  // Shown in the invoice's "Pay To" block, exactly as the reference does.
  COMPANY_BANK_NAME: string;
  COMPANY_BANK_ACCOUNT: string;
  COMPANY_BANK_IFSC: string;
  COMPANY_BANK_HOLDER: string;
  COMPANY_INVOICE_TERMS: string;

  // --- Outbound email (SMTP) ---
  // The project had no mail configuration at all before the credential
  // emails needed one. Server-side only: none of these may reach the app.
  SMTP_HOST: string;
  SMTP_PORT: number;
  SMTP_USER: string;
  SMTP_PASSWORD: string;
  /** Overrides the From header; falls back to the company name and address. */
  SMTP_FROM: string;

  // --- Meta WhatsApp Cloud API ---
  // Server-side only. None of these may ever reach the mobile app.
  WHATSAPP_PHONE_NUMBER_ID: string;
  WHATSAPP_ACCESS_TOKEN: string;
  WHATSAPP_API_VERSION: string;
  WHATSAPP_DEFECT_TEMPLATE: string;
  /**
   * An APPROVED template for the defective-piece ADJUSTMENT message.
   *
   * Empty by default and deliberately so: the account's defect template
   * cannot carry quantities or an amount, and naming a template that has not
   * been approved would fail at Meta for every send. Set it once such a
   * template exists — see .env.example for the parameter order it must use.
   */
  WHATSAPP_ADJUSTMENT_TEMPLATE: string;
  WHATSAPP_TEMPLATE_LANG: string;
  WHATSAPP_DEFAULT_COUNTRY_CODE: string;
  /** Fallback for the Sorter copy when the sorter account has no mobile. */
  WHATSAPP_SORTER_NUMBER: string;
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

  GST_PROVIDER: optionalEnv('GST_PROVIDER', 'gstinapi'),
  GST_API_KEY: optionalEnv('GST_API_KEY', ''),
  GST_API_SECRET: optionalEnv('GST_API_SECRET', ''),
  // GST_API_BASE_URL is accepted as an older alias so an existing .env keeps
  // working; GST_API_URL is the documented name.
  GST_API_URL: optionalEnv('GST_API_URL', optionalEnv('GST_API_BASE_URL', '')),
  GST_VERIFICATION_REQUIRED: optionalEnv('GST_VERIFICATION_REQUIRED', 'true') === 'true',

  // 18% is the rate laundry and dry-cleaning services carry in India. It is
  // set here rather than hardcoded so it can be corrected without a deploy.
  GST_RATE_PERCENT: Number(optionalEnv('GST_RATE_PERCENT', '18')),
  // Defaults are the details printed on Swachham's own tax invoice, so a
  // deployment that sets nothing still produces a correct document.
  COMPANY_LEGAL_NAME: optionalEnv('COMPANY_LEGAL_NAME', 'SWACHHAM'),
  COMPANY_GSTIN: optionalEnv('COMPANY_GSTIN', '27ANNPP8398N2ZN'),
  COMPANY_STATE: optionalEnv('COMPANY_STATE', '27-Maharashtra'),
  COMPANY_ADDRESS: optionalEnv(
    'COMPANY_ADDRESS',
    'Nityanandnilayam, Dapoli Dabhol Road, Jalgaon, Dapoli 415712'
  ),
  COMPANY_EMAIL: optionalEnv('COMPANY_EMAIL', 'info@swachham.co.in'),

  // SMTP has no sensible default: an unconfigured deployment must not
  // silently appear to send mail. Empty means "not configured", which the
  // email service reports rather than throwing.
  SMTP_HOST: optionalEnv('SMTP_HOST', ''),
  SMTP_PORT: Number(optionalEnv('SMTP_PORT', '587')),
  SMTP_USER: optionalEnv('SMTP_USER', ''),
  SMTP_PASSWORD: optionalEnv('SMTP_PASSWORD', ''),
  SMTP_FROM: optionalEnv('SMTP_FROM', ''),
  COMPANY_PHONE: optionalEnv('COMPANY_PHONE', '9684029990'),
  COMPANY_BANK_NAME: optionalEnv(
    'COMPANY_BANK_NAME',
    'IDBI BANK, 118 BY 1, RATHOD SADAN, FAMILY MAL, DAPOLI'
  ),
  COMPANY_BANK_ACCOUNT: optionalEnv('COMPANY_BANK_ACCOUNT', '1330651100001861'),
  COMPANY_BANK_IFSC: optionalEnv('COMPANY_BANK_IFSC', 'IBKL0001330'),
  COMPANY_BANK_HOLDER: optionalEnv('COMPANY_BANK_HOLDER', 'SWACHHAM'),
  COMPANY_INVOICE_TERMS: optionalEnv(
    'COMPANY_INVOICE_TERMS',
    'Thank you for doing business with us.'
  ),

  // Optional so the app still boots without WhatsApp configured; the defect
  // service reports a clear "not configured" failure instead of crashing.
  WHATSAPP_PHONE_NUMBER_ID: optionalEnv('WHATSAPP_PHONE_NUMBER_ID', ''),
  WHATSAPP_ACCESS_TOKEN: optionalEnv('WHATSAPP_ACCESS_TOKEN', ''),
  WHATSAPP_API_VERSION: optionalEnv('WHATSAPP_API_VERSION', 'v21.0'),
  // Template name, not a template id — the name plus language is what the
  // Cloud API resolves, and it stays configurable.
  WHATSAPP_DEFECT_TEMPLATE: optionalEnv('WHATSAPP_DEFECT_TEMPLATE', 'defective_piece_notification'),
  WHATSAPP_ADJUSTMENT_TEMPLATE: optionalEnv('WHATSAPP_ADJUSTMENT_TEMPLATE', ''),
  WHATSAPP_TEMPLATE_LANG: optionalEnv('WHATSAPP_TEMPLATE_LANG', 'en'),
  // Indian numbers are stored as 10 digits; Meta needs them in E.164.
  WHATSAPP_DEFAULT_COUNTRY_CODE: optionalEnv('WHATSAPP_DEFAULT_COUNTRY_CODE', '91'),
  // Optional: used only when the reporting sorter has no number on file.
  WHATSAPP_SORTER_NUMBER: optionalEnv('WHATSAPP_SORTER_NUMBER', ''),
};

export { config };
export type { AppConfig };
