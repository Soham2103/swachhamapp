/*
 * The MODULAR entry points, which are the supported API in firebase-admin
 * v13+. The old `import admin from 'firebase-admin'` namespace no longer
 * carries `app` or `credential` as types, so it does not compile here.
 */
import { initializeApp, cert, App } from 'firebase-admin/app';
import { getMessaging, SendResponse } from 'firebase-admin/messaging';
import { query } from '../config/database';
import { config } from '../config/env';
import { logger } from '../utils/logger';

/**
 * Firebase Cloud Messaging.
 *
 * WHAT THIS IS FOR. A notification the recipient has to ACT ON NOW — the
 * handover code above all, which a rider is standing at a door waiting to be
 * read. Those already reach their recipient durably (`notifications` for a
 * customer, `business_messages` for an establishment) and always will; this
 * adds the part those cannot do, which is reaching the phone rather than
 * waiting on a screen somebody has to open.
 *
 * IT IS AN ADDITION, NEVER A REPLACEMENT. Push is best-effort by nature: the
 * handset may be off, the token stale, the project misconfigured. So nothing
 * here ever throws into a caller and nothing here decides whether a message
 * was "delivered" — the durable row remains the record, and a failed push is
 * logged and returned, never raised.
 *
 * CREDENTIALS. A service account, from the environment, used only here. The
 * private key signs for the entire Firebase project and must never reach the
 * app: what the app holds is `google-services.json`, which is not a secret.
 * When the credentials are absent the service reports itself unconfigured
 * instead of failing at import, exactly like the mail and WhatsApp services.
 */

export interface PushResult {
  /** How many devices Firebase accepted the message for. */
  sent: number;
  /** How many it refused, for any reason. */
  failed: number;
  /** Populated when nothing could be attempted at all. */
  error?: string;
}

/** True when enough is configured to attempt a send. */
export function isPushConfigured(): boolean {
  return Boolean(
    config.FIREBASE_PROJECT_ID && config.FIREBASE_CLIENT_EMAIL && config.FIREBASE_PRIVATE_KEY
  );
}

/** Which settings are missing, for an operator-facing message. */
export function missingPushSettings(): string[] {
  const missing: string[] = [];
  if (!config.FIREBASE_PROJECT_ID) missing.push('FIREBASE_PROJECT_ID');
  if (!config.FIREBASE_CLIENT_EMAIL) missing.push('FIREBASE_CLIENT_EMAIL');
  if (!config.FIREBASE_PRIVATE_KEY) missing.push('FIREBASE_PRIVATE_KEY');
  return missing;
}

/**
 * The private key as PEM, whatever shape the .env put it in.
 *
 * THE KEY IS ALWAYS COPIED OUT OF A JSON FILE, and that is where every one of
 * these comes from:
 *
 *   a trailing comma   the line was copied with JSON's `,` still on the end.
 *                      That comma also stops dotenv stripping the quotes, so
 *                      Firebase is handed `"-----BEGIN...-----\n",` and fails
 *                      with "Failed to parse private key" — which reads like
 *                      a bad key rather than a punctuation mistake.
 *   surrounding quotes kept when dotenv did not treat the value as quoted.
 *   literal \n         the JSON form, when dotenv did not expand it.
 *
 * None of these is a different key; they are the same key wearing the
 * packaging of the file it was copied from. Unwrapping them here turns three
 * silent misconfigurations into none, and cannot turn an invalid key into a
 * valid one — `cert()` still rejects anything that is not really a key.
 */
function normalisePrivateKey(raw: string): string {
  let key = String(raw || '').trim();
  // JSON's separator, if the line was copied whole.
  if (key.endsWith(',')) key = key.slice(0, -1).trim();
  // Matched surrounding quotes, either style.
  if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
    key = key.slice(1, -1);
  }
  // Escaped newlines back to real ones. A no-op when dotenv already did it.
  return key.replace(/\\n/g, '\n');
}

let app: App | null = null;
let initFailed = false;

/**
 * The Firebase app, built once on first use.
 *
 * Lazily rather than at import: a deployment with no push configured must
 * still boot, and the credentials are only needed when something is actually
 * being sent. `initFailed` latches so a broken key is reported once instead
 * of re-thrown on every notification.
 */
function firebase(): App | null {
  if (app) return app;
  if (initFailed || !isPushConfigured()) return null;

  try {
    app = initializeApp(
      {
        credential: cert({
          projectId: config.FIREBASE_PROJECT_ID,
          clientEmail: config.FIREBASE_CLIENT_EMAIL,
          // Unwrapped from whatever the .env wrapped it in — see above.
          privateKey: normalisePrivateKey(config.FIREBASE_PRIVATE_KEY),
        }),
      },
      // Named, so this cannot collide with a default app initialised
      // elsewhere in the process.
      'swachham-push'
    );
    logger.info(`[Push] Firebase initialised for project ${config.FIREBASE_PROJECT_ID}`);
    return app;
  } catch (error: any) {
    initFailed = true;
    logger.error(
      `[Push] Firebase could not be initialised: ${String(error?.message || error).slice(0, 300)}`
    );
    return null;
  }
}

/** Who a token belongs to. Exactly one, matching the table's CHECK. */
export type PushOwner = { userId: string } | { businessUserId: string };

function ownerColumns(owner: PushOwner): { column: string; value: string } {
  return 'userId' in owner
    ? { column: 'user_id', value: String(owner.userId) }
    : { column: 'business_user_id', value: String(owner.businessUserId) };
}

/**
 * Records a device against an account.
 *
 * REGISTERING AN EXISTING TOKEN REASSIGNS IT. The same handset can be signed
 * out of one account and into another, and FCM will hand the app the same
 * token — so the row is moved rather than duplicated. Both owner columns are
 * written on every upsert (one to a value, the other to NULL) because a
 * device changing hands must not keep the previous owner's claim on it.
 */
export async function registerToken(params: {
  owner: PushOwner;
  token: string;
  platform?: string;
  deviceName?: string | null;
}): Promise<void> {
  const token = String(params.token || '').trim();
  if (!token) return;

  const { column } = ownerColumns(params.owner);
  const userId = 'userId' in params.owner ? params.owner.userId : null;
  const businessUserId = 'businessUserId' in params.owner ? params.owner.businessUserId : null;

  const platform = ['android', 'ios', 'web'].includes(String(params.platform))
    ? String(params.platform)
    : 'android';

  await query(
    `INSERT INTO push_tokens
       (user_id, business_user_id, token, platform, device_name, last_seen_at, is_active)
     VALUES (?, ?, ?, ?, ?, NOW(), TRUE)
     ON DUPLICATE KEY UPDATE
       user_id = VALUES(user_id),
       business_user_id = VALUES(business_user_id),
       platform = VALUES(platform),
       device_name = VALUES(device_name),
       last_seen_at = NOW(),
       -- A device that re-registers is alive again, whatever FCM said before.
       is_active = TRUE`,
    [userId, businessUserId, token, platform, params.deviceName || null]
  );

  logger.info(`[Push] Registered a ${platform} device for ${column}=${userId ?? businessUserId}`);
}

/**
 * Forgets one device.
 *
 * Called on sign-out. The row is DELETED rather than deactivated: the person
 * signing out is saying this handset should stop receiving their messages,
 * and a deactivated row would be revived by the next `registerToken`.
 */
export async function unregisterToken(token: string): Promise<void> {
  const value = String(token || '').trim();
  if (!value) return;
  await query(`DELETE FROM push_tokens WHERE token = ?`, [value]);
}

/** The live tokens for one account. */
async function tokensFor(owner: PushOwner): Promise<string[]> {
  const { column, value } = ownerColumns(owner);
  const result = await query<{ token: string }>(
    `SELECT token FROM push_tokens WHERE ${column} = ? AND is_active = TRUE`,
    [value]
  );
  return result.rows.map((r) => r.token);
}

/**
 * Firebase replies that a token is dead.
 *
 * Deactivated rather than deleted, so a reinstall is recognised as the same
 * device instead of accumulating rows. Anything else — a network blip, a
 * quota — leaves the token alone: only Firebase saying the registration is
 * gone is evidence that it is.
 */
const DEAD_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument',
]);

async function deactivate(tokens: string[]): Promise<void> {
  if (!tokens.length) return;
  const placeholders = tokens.map(() => '?').join(', ');
  await query(
    `UPDATE push_tokens SET is_active = FALSE WHERE token IN (${placeholders})`,
    tokens
  );
  logger.info(`[Push] Deactivated ${tokens.length} token(s) Firebase no longer recognises`);
}

export interface PushMessage {
  title: string;
  body: string;
  /**
   * Extra values delivered with the message.
   *
   * FCM data values must be STRINGS — a number here is rejected for the whole
   * message — so everything is stringified before it is sent.
   */
  data?: Record<string, string | number | null | undefined>;
}

/**
 * Sends one notification to every device an account has.
 *
 * NEVER THROWS. Callers are in the middle of a status change that has already
 * happened; a push failure must not undo it or read as one.
 */
export async function sendToOwner(owner: PushOwner, message: PushMessage): Promise<PushResult> {
  if (!isPushConfigured()) {
    return { sent: 0, failed: 0, error: `Push is not configured (missing ${missingPushSettings().join(', ')}).` };
  }

  const client = firebase();
  if (!client) return { sent: 0, failed: 0, error: 'Firebase could not be initialised.' };

  let tokens: string[];
  try {
    tokens = await tokensFor(owner);
  } catch (error: any) {
    // Almost always "table doesn't exist" — migration 068 not yet run.
    const detail = String(error?.message || error).slice(0, 200);
    logger.warn(`[Push] Could not read device tokens (is migration 068 applied?): ${detail}`);
    return { sent: 0, failed: 0, error: detail };
  }

  if (!tokens.length) {
    const { column, value } = ownerColumns(owner);
    logger.info(`[Push] No registered device for ${column}=${value}; nothing to push`);
    return { sent: 0, failed: 0, error: 'No registered device.' };
  }

  // Every data value as a string, per FCM's contract.
  const data: Record<string, string> = {};
  for (const [key, value] of Object.entries(message.data || {})) {
    if (value !== null && value !== undefined) data[key] = String(value);
  }

  try {
    const response = await getMessaging(client).sendEachForMulticast({
      tokens,
      notification: { title: message.title, body: message.body },
      data,
      android: {
        // The handover code is time-critical: it is read out while a rider
        // waits at the door, so it must wake the device rather than be
        // batched by Android's power manager.
        priority: 'high',
        notification: { channelId: 'default', sound: 'default' },
      },
      apns: {
        payload: { aps: { sound: 'default' } },
      },
    });

    const dead: string[] = [];
    response.responses.forEach((r: SendResponse, i: number) => {
      if (!r.success) {
        const code = (r.error as any)?.code;
        if (code && DEAD_TOKEN_CODES.has(code)) dead.push(tokens[i]);
        logger.warn(`[Push] Device ${i + 1}/${tokens.length} refused: ${code || r.error?.message}`);
      }
    });
    await deactivate(dead);

    logger.info(
      `[Push] "${message.title}" → ${response.successCount}/${tokens.length} device(s)` +
        (response.failureCount ? `, ${response.failureCount} failed` : '')
    );
    return { sent: response.successCount, failed: response.failureCount };
  } catch (error: any) {
    const detail = String(error?.message || 'Unknown FCM error').slice(0, 300);
    logger.error(`[Push] Send failed for "${message.title}": ${detail}`);
    return { sent: 0, failed: tokens.length, error: detail };
  }
}

/** Convenience wrappers, so callers do not build the owner shape by hand. */
export function sendToUser(userId: string, message: PushMessage): Promise<PushResult> {
  return sendToOwner({ userId: String(userId) }, message);
}

export function sendToBusinessUser(
  businessUserId: string,
  message: PushMessage
): Promise<PushResult> {
  return sendToOwner({ businessUserId: String(businessUserId) }, message);
}
