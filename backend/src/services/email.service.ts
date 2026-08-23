import nodemailer, { Transporter } from 'nodemailer';
import { config } from '../config/env';
import { logger } from '../utils/logger';

/**
 * Outbound email.
 *
 * The project had NO email infrastructure before this — no nodemailer, no
 * SMTP settings, no mail service of any kind (SMS and WhatsApp existed, mail
 * did not). This is that infrastructure, added once and used by everything
 * that needs to send mail rather than each caller building its own transport.
 *
 * CONFIGURATION. Read from the environment, alongside the other provider
 * settings. When SMTP is not configured the service does not throw at import
 * time and does not pretend to succeed: `send` returns a failure the caller
 * can record, which is what lets an account still be created when the mail
 * server is unreachable.
 *
 * NOTHING SECRET IS LOGGED. A generated password passes through `sendMail`
 * and is never written to a log line, an error message, or a stored field.
 */

export interface SendResult {
  sent: boolean;
  /** Populated when `sent` is false. Safe to store and show to an operator. */
  error?: string;
  messageId?: string;
}

let cached: Transporter | null = null;

/** True when enough SMTP settings exist to attempt a send. */
export function isEmailConfigured(): boolean {
  return Boolean(config.SMTP_HOST && config.SMTP_USER && config.SMTP_PASSWORD);
}

/** Which settings are missing, for an operator-facing message. */
export function missingEmailSettings(): string[] {
  const missing: string[] = [];
  if (!config.SMTP_HOST) missing.push('SMTP_HOST');
  if (!config.SMTP_USER) missing.push('SMTP_USER');
  if (!config.SMTP_PASSWORD) missing.push('SMTP_PASSWORD');
  return missing;
}

/**
 * The shared transport, built once.
 *
 * `pool: true` keeps a small number of connections open, because approvals
 * arrive in bursts and a fresh TLS handshake per credential email is wasteful.
 */
function transport(): Transporter {
  if (cached) return cached;
  cached = nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    // 465 is implicit TLS; anything else starts plain and upgrades.
    secure: config.SMTP_PORT === 465,
    auth: { user: config.SMTP_USER, pass: config.SMTP_PASSWORD },
    pool: true,
    maxConnections: 3,
  });
  return cached;
}

export interface MailInput {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/**
 * Sends one message.
 *
 * NEVER THROWS. A caller sending credentials has already created the account
 * by the time it gets here, and an exception at that point would either lose
 * the account or roll back work that genuinely succeeded. The failure is
 * returned instead, so it can be recorded against the request and acted on.
 */
export async function send(mail: MailInput): Promise<SendResult> {
  if (!isEmailConfigured()) {
    const error = `Email is not configured (missing ${missingEmailSettings().join(', ')}).`;
    logger.warn(`[Email] not sent to ${mail.to}: ${error}`);
    return { sent: false, error };
  }

  try {
    const info = await transport().sendMail({
      from: config.SMTP_FROM || `${config.COMPANY_LEGAL_NAME} <${config.COMPANY_EMAIL}>`,
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
    });
    // The recipient and the subject, never the body — the body is where the
    // password is.
    logger.info(`[Email] sent "${mail.subject}" to ${mail.to}`);
    return { sent: true, messageId: info.messageId };
  } catch (error: any) {
    const message = String(error?.message || 'Unknown mail error').slice(0, 400);
    logger.error(`[Email] failed to send "${mail.subject}" to ${mail.to}: ${message}`);
    return { sent: false, error: message };
  }
}

/** The account kinds that get a credentials email. */
export type CredentialAccountKind = 'BUSINESS' | 'RIDER' | 'SORTER' | 'MANAGER';

const KIND_LABEL: Record<CredentialAccountKind, string> = {
  BUSINESS: 'Business',
  RIDER: 'Rider',
  SORTER: 'Sorter',
  MANAGER: 'Manager',
};

/**
 * The credentials email.
 *
 * The ONLY place a generated password is ever rendered. It is passed in, used
 * here, and dropped — the caller does not store it and neither does this.
 */
export async function sendCredentialsEmail(input: {
  kind: CredentialAccountKind;
  to: string;
  accountName: string;
  username: string;
  password: string;
}): Promise<SendResult> {
  const label = KIND_LABEL[input.kind];
  const brand = config.COMPANY_LEGAL_NAME;

  const subject =
    input.kind === 'BUSINESS'
      ? 'Swachcham Business Account Created'
      : `Swachcham ${label} Account Created`;

  const text = [
    `Welcome to ${brand}.`,
    '',
    input.kind === 'BUSINESS'
      ? 'Your business account has been approved.'
      : `Your ${label.toLowerCase()} account has been approved.`,
    '',
    `${input.kind === 'BUSINESS' ? 'Business Name' : 'Name'}: ${input.accountName}`,
    '',
    `Username: ${input.username}`,
    '',
    `Password: ${input.password}`,
    '',
    'Please log in and change your password after your first login.',
    '',
    `— ${brand}`,
  ].join('\n');

  const html = `
    <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1B1B1B;line-height:1.6">
      <p>Welcome to <strong>${escapeHtml(brand)}</strong>.</p>
      <p>${
        input.kind === 'BUSINESS'
          ? 'Your business account has been approved.'
          : `Your ${escapeHtml(label.toLowerCase())} account has been approved.`
      }</p>
      <table style="border-collapse:collapse;margin:16px 0">
        <tr><td style="padding:4px 12px 4px 0;color:#6B7280">${
          input.kind === 'BUSINESS' ? 'Business Name' : 'Name'
        }</td><td style="padding:4px 0"><strong>${escapeHtml(input.accountName)}</strong></td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#6B7280">Username</td><td style="padding:4px 0"><strong>${escapeHtml(
          input.username
        )}</strong></td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#6B7280">Password</td><td style="padding:4px 0"><code style="font-size:15px">${escapeHtml(
          input.password
        )}</code></td></tr>
      </table>
      <p>Please log in and change your password after your first login.</p>
      <p style="color:#6B7280">— ${escapeHtml(brand)}</p>
    </div>`;

  return send({ to: input.to, subject, text, html });
}

function escapeHtml(value: string): string {
  return String(value).replace(
    /[&<>"']/g,
    (ch) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] as string
  );
}
