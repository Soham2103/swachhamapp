import { config } from '../config/env';
import { AppError } from '../utils/appError';
import { logger } from '../utils/logger';

/**
 * GSTIN verification.
 *
 * Which provider does the lookup is an implementation detail of this file:
 * the route, the service interface and the app are all unchanged when it is
 * swapped. `GST_PROVIDER` picks the adapter, and every credential stays here
 * on the server — the app sends a GSTIN and receives the taxpayer details,
 * never an endpoint or a key.
 *
 * Adapters differ only in how the request is addressed and authenticated.
 * The response mapping is shared, because these providers all pass through
 * the GSTN "search taxpayer" payload (`lgnm`, `tradeNam`, `sts`, `rgdt`,
 * `ctb`, `pradr`) — which is also what a licensed GSP returns, so moving to
 * one later needs no change beyond configuration.
 *
 * Only fields that actually arrive are surfaced: anything absent is returned
 * as null rather than guessed at, because a wrong legal name on a tax invoice
 * is worse than a blank one.
 */

export interface GstAddress {
  full: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
}

export interface GstDetails {
  gstin: string;
  /** `lgnm` — the registered legal name. */
  legalName: string | null;
  /** `tradeNam` — the trading name, often what the place is called. */
  tradeName: string | null;
  /** `sts` — Active / Cancelled / Suspended / Provisional. */
  status: string | null;
  /** `rgdt` — registration date, as the GST system formats it (dd/mm/yyyy). */
  registrationDate: string | null;
  /** `ctb` — constitution of business, e.g. Private Limited Company. */
  constitution: string | null;
  address: GstAddress;
  /** True only when `status` reads Active. */
  active: boolean;
}

/**
 * The GSTIN shape prescribed by the GST system:
 * 2 state digits, 10-character PAN, 1 entity digit, 'Z', 1 checksum char.
 */
const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;

const CHECKSUM_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * The GSTIN's own check digit.
 *
 * Verified before the provider is called at all: a mistyped number is rejected
 * here for free, which is what keeps a typo from spending an API call.
 */
function hasValidChecksum(gstin: string): boolean {
  let sum = 0;
  for (let i = 0; i < 14; i += 1) {
    const value = CHECKSUM_ALPHABET.indexOf(gstin[i]);
    if (value < 0) return false;
    const factor = i % 2 === 0 ? 1 : 2;
    const product = value * factor;
    sum += Math.floor(product / CHECKSUM_ALPHABET.length) + (product % CHECKSUM_ALPHABET.length);
  }
  const expected = CHECKSUM_ALPHABET[(CHECKSUM_ALPHABET.length - (sum % CHECKSUM_ALPHABET.length)) % CHECKSUM_ALPHABET.length];
  return expected === gstin[14];
}

/** Normalises and format-checks a GSTIN. Throws 400 when it cannot be one. */
export function normaliseGstin(raw: unknown): string {
  const gstin = String(raw ?? '').trim().toUpperCase().replace(/\s+/g, '');

  if (!gstin) {
    throw new AppError('GST number is required.', 400);
  }
  if (gstin.length !== 15 || !GSTIN_PATTERN.test(gstin)) {
    throw new AppError('That is not a valid GST number. A GSTIN is 15 characters, e.g. 27AAPFU0939F1ZV.', 400);
  }
  if (!hasValidChecksum(gstin)) {
    throw new AppError('That GST number failed its check digit. Please re-enter it.', 400);
  }
  return gstin;
}

/**
 * One provider adapter: where to send the lookup, and how to authenticate it.
 *
 * `url` receives the already-validated GSTIN and returns the full request URL;
 * `headers` returns whatever the provider expects to be sent with it. Keys are
 * read from configuration inside these functions and never leave the module.
 */
interface GstProvider {
  /** Value of GST_PROVIDER that selects this adapter. */
  id: string;
  /** Human name, used in logs. */
  label: string;
  /** Endpoint used when GST_API_URL is not set. */
  defaultBaseUrl: string;
  /** Settings that must be present for this adapter to work. */
  requires: string[];
  url: (gstin: string, baseUrl: string) => string;
  headers: () => Record<string, string>;
}

const PROVIDERS: GstProvider[] = [
  {
    /*
     * gstinapi.in — documented at https://gstinapi.in/docs
     * GET https://gstinapi.in/v1/gstin/<gstin> with the key in `x-api-key`.
     * The response is already normalised snake_case, and 402 is used for an
     * exhausted credit balance, which the caller below treats as our fault
     * rather than the GSTIN's.
     */
    id: 'gstinapi',
    label: 'gstinapi.in',
    defaultBaseUrl: 'https://gstinapi.in',
    requires: ['GST_API_KEY'],
    url: (gstin, baseUrl) => `${baseUrl}/v1/gstin/${encodeURIComponent(gstin)}`,
    headers: () => ({
      'x-api-key': config.GST_API_KEY,
      Accept: 'application/json',
    }),
  },
  {
    /*
     * Appyflow — documented at https://appyflow.in/verify-gst/
     * GET/POST https://appyflow.in/api/verifyGST?gstNo=<gstin>&key_secret=<key>
     * The key travels as a query parameter; that is what the provider
     * specifies, and it never leaves the server either way.
     */
    id: 'appyflow',
    label: 'Appyflow',
    defaultBaseUrl: 'https://appyflow.in/api/verifyGST',
    requires: ['GST_API_KEY'],
    url: (gstin, baseUrl) =>
      `${baseUrl}?gstNo=${encodeURIComponent(gstin)}` +
      `&key_secret=${encodeURIComponent(config.GST_API_KEY)}`,
    headers: () => ({ Accept: 'application/json' }),
  },
  {
    /*
     * GSTINCheck — documented at https://gstincheck.co.in/
     * GET https://sheet.gstincheck.co.in/check/<api-key>/<gstin>
     * The key is a path segment. Their response schema is not published, so
     * the shared mapper is what makes it usable; fields it does not recognise
     * come back null rather than wrong.
     */
    id: 'gstincheck',
    label: 'GSTINCheck',
    defaultBaseUrl: 'https://sheet.gstincheck.co.in/check',
    requires: ['GST_API_KEY'],
    url: (gstin, baseUrl) =>
      `${baseUrl}/${encodeURIComponent(config.GST_API_KEY)}/${encodeURIComponent(gstin)}`,
    headers: () => ({ Accept: 'application/json' }),
  },
  {
    /*
     * Generic header-authenticated lookup, for an aggregator or a licensed
     * GSP. GST_API_URL must be the full endpoint; the GSTIN is appended
     * as ?gstin=. This is the path back to a GSP if one is licensed later.
     */
    id: 'generic',
    label: 'Generic GST provider',
    defaultBaseUrl: '',
    requires: ['GST_API_URL', 'GST_API_KEY'],
    url: (gstin, baseUrl) => `${baseUrl}?gstin=${encodeURIComponent(gstin)}`,
    headers: () => {
      const headers: Record<string, string> = {
        Accept: 'application/json',
        'client-id': config.GST_API_KEY,
      };
      if (config.GST_API_SECRET) headers['client-secret'] = config.GST_API_SECRET;
      return headers;
    },
  },
];

/** The adapter GST_PROVIDER selects, or null when the name is unknown. */
function activeProvider(): GstProvider | null {
  const id = (config.GST_PROVIDER || '').trim().toLowerCase();
  return PROVIDERS.find((provider) => provider.id === id) ?? null;
}

/** Reads a configured setting by name. Values never leave this function. */
function settingValue(name: string): string {
  switch (name) {
    case 'GST_API_KEY':
      return config.GST_API_KEY;
    case 'GST_API_SECRET':
      return config.GST_API_SECRET;
    case 'GST_API_URL':
      return config.GST_API_URL;
    default:
      return '';
  }
}

/** Every provider id this build understands, for error messages. */
export function supportedGstProviders(): string[] {
  return PROVIDERS.map((provider) => provider.id);
}

/**
 * The names of the settings that are still blank for the selected provider.
 * Names only — a value is never returned, logged or displayed.
 */
export function missingGstSettings(): string[] {
  const provider = activeProvider();
  if (!provider) return ['GST_PROVIDER'];
  return provider.requires.filter((name) => !settingValue(name).trim());
}

/**
 * Why verification cannot run, phrased for whoever has to fix it.
 *
 * A blank setting and a setting filled in with something unrecognised are
 * different problems, and saying "set GST_PROVIDER" when it IS set just sends
 * the reader back to a file that already looks correct.
 */
function configurationFault(): string | null {
  const configured = (config.GST_PROVIDER || '').trim();
  if (!configured) {
    return `GST_PROVIDER is not set. Expected one of: ${supportedGstProviders().join(', ')}.`;
  }
  if (!activeProvider()) {
    return (
      `GST_PROVIDER is set to "${configured}", which this build does not support. ` +
      `Expected one of: ${supportedGstProviders().join(', ')}.`
    );
  }
  const missing = missingGstSettings();
  return missing.length
    ? `Set these in backend/.env: ${missing.join(', ')}.`
    : null;
}

/** True when the configuration the selected provider needs is present. */
export function isGstVerificationConfigured(): boolean {
  return missingGstSettings().length === 0;
}

/** Reads a field under any of the names a GSP payload may use. */
function pick(source: any, ...names: string[]): string | null {
  for (const name of names) {
    const value = source?.[name];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

/**
 * Providers wrap the taxpayer under different keys — Appyflow uses
 * `taxpayerInfo`, GSPs use `data`/`taxpayerDetails`, others use `result` — so
 * the payload is unwrapped by looking for the one that carries a legal name
 * rather than by trusting any single shape.
 */
function unwrap(payload: any): any {
  const candidates = [
    payload?.taxpayerInfo,
    payload?.data?.taxpayerInfo,
    payload?.data?.taxpayerDetails,
    payload?.data?.result,
    payload?.taxpayerDetails,
    payload?.result,
    payload?.data,
    payload,
  ];
  for (const candidate of candidates) {
    if (
      candidate &&
      (candidate.lgnm ||
        candidate.legalName ||
        candidate.legal_name ||
        candidate.tradeNam ||
        candidate.trade_name)
    ) {
      return candidate;
    }
  }
  return payload?.data ?? payload;
}

/**
 * The GST state codes, which are fixed by the GST system itself.
 *
 * The first two digits of every GSTIN are its state code, so a state name is
 * derivable from the number alone. That matters twice over: providers differ
 * on whether they return a name, a code or a jurisdiction string, and the
 * invoice decides CGST/SGST versus IGST by comparing this against the
 * company's own state — a bare "24" would never match "27-Maharashtra", and
 * the wrong tax split is worse than a blank field.
 */
const GST_STATE_NAMES: Record<string, string> = {
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab',
  '04': 'Chandigarh', '05': 'Uttarakhand', '06': 'Haryana', '07': 'Delhi',
  '08': 'Rajasthan', '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim',
  '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur', '15': 'Mizoram',
  '16': 'Tripura', '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal',
  '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh',
  '24': 'Gujarat', '25': 'Daman and Diu', '26': 'Dadra and Nagar Haveli and Daman and Diu',
  '27': 'Maharashtra', '28': 'Andhra Pradesh', '29': 'Karnataka', '30': 'Goa',
  '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry',
  '35': 'Andaman and Nicobar Islands', '36': 'Telangana', '37': 'Andhra Pradesh',
  '38': 'Ladakh', '96': 'Other Country', '97': 'Other Territory', '99': 'Centre Jurisdiction',
};

/**
 * "27-Maharashtra" for a GSTIN or a state code, which is the form the rest of
 * the application already stores and compares.
 *
 * A name the provider supplied is kept as-is; only a bare code is expanded.
 */
function resolveState(reported: string | null, gstin: string): string | null {
  const code = (reported && /^\d{2}$/.test(reported.trim()))
    ? reported.trim()
    : gstin.slice(0, 2);

  const name = GST_STATE_NAMES[code];

  // A provider value that is already a name (or a jurisdiction) is left alone,
  // rather than being overwritten by a guess.
  if (reported && !/^\d{2}$/.test(reported.trim())) return reported.trim();

  return name ? `${code}-${name}` : reported;
}

function mapAddress(taxpayer: any): GstAddress {
  /*
   * A normalised provider returns the address as one string alongside
   * `state_code` / `state_jurisdiction` / `pincode`; a GSTN passthrough
   * returns `pradr.addr` in parts. Both are read, flat form first.
   */
  const flat = pick(taxpayer, 'address');
  if (flat) {
    return {
      full: flat,
      city: pick(taxpayer, 'city', 'district'),
      state: pick(taxpayer, 'state', 'state_jurisdiction', 'state_code'),
      pincode: pick(taxpayer, 'pincode', 'pin'),
    };
  }

  // `pradr` is the principal place of business; `addr` inside it holds the
  // parts. Some responses flatten it to a single string instead.
  const principal = taxpayer?.pradr ?? taxpayer?.principalAddress ?? null;
  const addr = principal?.addr ?? principal ?? null;

  if (typeof principal === 'string') {
    return { full: principal.trim() || null, city: null, state: null, pincode: null };
  }

  const parts = [
    pick(addr, 'bno', 'buildingNumber'),
    pick(addr, 'bnm', 'buildingName'),
    pick(addr, 'flno', 'floorNumber'),
    pick(addr, 'st', 'street'),
    pick(addr, 'loc', 'location'),
    pick(addr, 'dst', 'district'),
  ].filter(Boolean);

  const full = pick(principal, 'adr') || (parts.length ? parts.join(', ') : null);

  return {
    full,
    city: pick(addr, 'dst', 'district', 'loc', 'city'),
    state: pick(addr, 'stcd', 'state', 'stateCode'),
    pincode: pick(addr, 'pncd', 'pincode', 'pin'),
  };
}

/**
 * Asks the configured provider about one GSTIN.
 *
 * Network and credential problems are reported as such (503) and never as
 * "invalid GST": a business must not be turned away because the upstream was
 * down or a key expired, and an operator needs to know which of the two
 * happened.
 */
export async function verifyGstin(rawGstin: string): Promise<GstDetails> {
  const gstin = normaliseGstin(rawGstin);

  const fault = configurationFault();
  const provider = activeProvider();
  if (fault || !provider) {
    // The reason goes to the server log so an operator can act on it; the
    // caller is told only that it is unavailable. No value is ever logged.
    logger.error(`[GST] verification unavailable — ${fault}`);
    throw new AppError('GST verification service is not configured.', 503);
  }

  const baseUrl = (config.GST_API_URL || provider.defaultBaseUrl).replace(/\/+$/, '');
  const url = provider.url(gstin, baseUrl);

  // A misconfigured endpoint otherwise surfaces as an opaque "Failed to parse
  // URL" from fetch. Checking it here names the setting at fault instead.
  try {
    // eslint-disable-next-line no-new
    new URL(url);
  } catch {
    logger.error(`[GST] GST_API_URL is not a valid URL for provider ${provider.id}`);
    throw new AppError('GST verification service is not configured correctly.', 503);
  }

  // Global fetch, the same client the WhatsApp integration uses. The timeout
  // is explicit so a hung upstream cannot hold the request open.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  let payload: any;
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: provider.headers(),
      signal: controller.signal,
    });

    if (response.status === 404) {
      // A 404 from a taxpayer search is a real answer: no such GSTIN.
      throw new AppError('No GST registration was found for that number.', 404);
    }
    if (response.status === 402) {
      // Payment required: the account is out of lookup credits. An operator
      // problem, so it must never read as "this GSTIN is invalid".
      logger.error(`[GST] ${provider.label} reports no remaining lookup credits`);
      throw new AppError(
        'GST verification is temporarily unavailable. Please contact the administrator.',
        503
      );
    }
    if (response.status === 401 || response.status === 403) {
      // The key is wrong, expired, or out of quota. That is an operator
      // problem, not the GSTIN's, so it must not read as "invalid GST".
      logger.error(
        `[GST] ${provider.label} rejected our credentials or quota (upstream ${response.status})`
      );
      throw new AppError('GST verification service is not configured correctly.', 503);
    }
    if (!response.ok) {
      logger.error(`[GST] ${provider.label} lookup failed for ${gstin} (upstream ${response.status})`);
      throw new AppError(
        'GST verification is unavailable right now. Please try again in a moment.',
        503
      );
    }
    payload = await response.json();
  } catch (error: any) {
    if (error instanceof AppError) throw error;
    logger.error(
      `[GST] ${provider.label} lookup failed for ${gstin}: ${error?.message || 'unknown error'}`
    );
    throw new AppError(
      'GST verification is unavailable right now. Please try again in a moment.',
      503
    );
  } finally {
    clearTimeout(timeout);
  }

  /*
   * Several providers answer 200 with `{ error: true, message }` — Appyflow
   * does this both for an unknown GSTIN and for a bad key or exhausted quota.
   * Treating that as success would be the worst possible outcome, so it is
   * read here and separated: anything that mentions the key or the quota is
   * reported as a configuration fault, not as an invalid GSTIN.
   */
  if (payload?.error === true || payload?.error === 'true') {
    const message = String(payload?.message || '').trim();
    if (/key|auth|quota|credit|balance|subscri/i.test(message)) {
      logger.error(`[GST] ${provider.label} refused the request: ${message}`);
      throw new AppError('GST verification service is not configured correctly.', 503);
    }
    logger.warn(`[GST] ${provider.label} could not verify ${gstin}: ${message}`);
    throw new AppError(
      message || 'No GST registration was found for that number.',
      404
    );
  }

  const taxpayer = unwrap(payload);
  const legalName = pick(taxpayer, 'lgnm', 'legalName', 'legal_name');
  const tradeName = pick(taxpayer, 'tradeNam', 'tradeName', 'trade_name');

  if (!legalName && !tradeName) {
    // A 200 with nothing recognisable in it is not a verification.
    logger.warn(`[GST] ${provider.label} returned no taxpayer details for ${gstin}`);
    throw new AppError('No GST registration was found for that number.', 404);
  }

  const status = pick(taxpayer, 'sts', 'status', 'gstinStatus', 'gstin_status');

  const details: GstDetails = {
    gstin,
    legalName,
    tradeName,
    status,
    registrationDate: pick(taxpayer, 'rgdt', 'registrationDate', 'registration_date'),
    constitution: pick(
      taxpayer,
      'ctb',
      'constitutionOfBusiness',
      'businessConstitution',
      'business_constitution',
      'taxpayer_type'
    ),
    address: mapAddress(taxpayer),
    active: (status || '').toLowerCase() === 'active',
  };

  // A bare state code becomes "27-Maharashtra"; anything the provider named
  // itself is left exactly as it came.
  details.address.state = resolveState(details.address.state, gstin);

  logger.info(`[GST] verified ${gstin}: status=${details.status ?? 'unknown'}`);
  return details;
}

/* ===================================================================
 * NORMALISED RESULT
 *
 * The shape the rest of the application consumes. It is deliberately
 * flat and provider-neutral: nothing outside this file should have to
 * know that `lgnm` means legal name, or that one provider reports a
 * failure as a 404 while another returns 200 with `error: true`.
 * =================================================================== */

export interface GstinVerificationResult {
  valid: boolean;
  gstin: string;
  legalName?: string | null;
  tradeName?: string | null;
  registrationStatus?: string | null;
  businessType?: string | null;
  state?: string | null;
  registrationDate?: string | null;
  /** ISO timestamp of the lookup that produced this result. */
  verifiedAt?: string;
  /** Present only when `valid` is false. Safe to show a user. */
  message?: string;
}

/**
 * Verifies one GSTIN and returns the normalised result.
 *
 * `valid: false` is an ANSWER, not a failure: it means the provider was
 * reached and said no, or said the registration is not active. Problems that
 * are ours rather than the GSTIN's — a missing key, an exhausted quota, a
 * provider outage — still throw, because the caller must not record an
 * unverified business as "checked and rejected" when nothing was checked.
 *
 * The API key never appears in the result; only what the provider said about
 * the taxpayer does.
 */
export async function verifyGSTIN(rawGstin: unknown): Promise<GstinVerificationResult> {
  let gstin: string;
  try {
    // Trims, strips inner spaces and upper-cases before anything else.
    gstin = normaliseGstin(rawGstin);
  } catch (error: any) {
    // A malformed GSTIN is answered, not thrown: it is a verdict about the
    // input, and the caller renders it the same way as "not found".
    return {
      valid: false,
      gstin: String(rawGstin ?? '').trim().toUpperCase(),
      message: error?.message || 'Invalid GSTIN',
    };
  }

  try {
    const details = await verifyGstin(gstin);
    return {
      valid: details.active,
      gstin: details.gstin,
      legalName: details.legalName,
      tradeName: details.tradeName,
      registrationStatus: details.status,
      businessType: details.constitution,
      state: details.address.state,
      registrationDate: details.registrationDate,
      verifiedAt: new Date().toISOString(),
      message: details.active
        ? undefined
        : `This GST registration is ${details.status || 'not active'}.`,
    };
  } catch (error: any) {
    // 404 is the provider's verdict on the number; anything else is an
    // operational fault and is rethrown for the route to turn into 5xx.
    if (error instanceof AppError && error.statusCode === 404) {
      return { valid: false, gstin, message: error.message || 'Invalid GSTIN' };
    }
    throw error;
  }
}

/**
 * Verification as the registration flow needs it: the details, plus the
 * refusal when the registration is not Active.
 *
 * Cancelled and suspended registrations cannot be billed against, so they are
 * refused here rather than being stored as a verified business.
 */
export async function verifyGstinForRegistration(rawGstin: string): Promise<GstDetails> {
  const details = await verifyGstin(rawGstin);

  if (!details.active) {
    throw new AppError(
      `This GST registration is ${details.status || 'not active'}. Only an active GST registration can be onboarded.`,
      422
    );
  }
  return details;
}
