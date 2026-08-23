import fs from 'fs';
import path from 'path';
import { config } from '../config/env';
import { logger } from '../utils/logger';

/**
 * Meta WhatsApp Cloud API.
 *
 * Everything Meta needs — the phone number id, the access token — lives in
 * server environment variables and is used only here. None of it is ever
 * returned to a client, so the mobile app never holds a WhatsApp credential.
 *
 * Sending a template with an image header is two calls:
 *
 *   1. POST /{PHONE_NUMBER_ID}/media   -> upload the photo, get a media id
 *   2. POST /{PHONE_NUMBER_ID}/messages -> send the template, referencing it
 *
 * The media id is used rather than a public `link` on purpose: a link would
 * have to be reachable from Meta's servers, which rules out any deployment
 * that is not already publicly addressable. Uploading works everywhere.
 *
 * Upload and send are separate functions so one photo can be uploaded once
 * and sent to several recipients — the customer and the reporting Sorter get
 * the identical message without the image crossing the wire twice.
 */

export interface WhatsAppSendResult {
  ok: boolean;
  messageId: string | null;
  error: string | null;
}

/** True when enough is configured to attempt a send. */
export function isWhatsAppConfigured(): boolean {
  return Boolean(config.WHATSAPP_PHONE_NUMBER_ID && config.WHATSAPP_ACCESS_TOKEN);
}

/**
 * Normalises a stored mobile number to the digits-only E.164 form Meta wants
 * (no '+', no spaces). Numbers are stored as 10 digits, so the configured
 * country code is prepended unless one is already present.
 */
export function toWhatsAppNumber(mobile: string | null | undefined): string | null {
  if (!mobile) return null;
  const digits = String(mobile).replace(/\D/g, '');
  if (digits.length === 10) return `${config.WHATSAPP_DEFAULT_COUNTRY_CODE}${digits}`;
  if (digits.length === 11 && digits.startsWith('0')) {
    return `${config.WHATSAPP_DEFAULT_COUNTRY_CODE}${digits.slice(1)}`;
  }
  // Already carries a country code.
  if (digits.length >= 11 && digits.length <= 15) return digits;
  return null;
}

function graphUrl(pathSuffix: string): string {
  return `https://graph.facebook.com/${config.WHATSAPP_API_VERSION}/${config.WHATSAPP_PHONE_NUMBER_ID}/${pathSuffix}`;
}

/** Pulls the most useful line out of a Graph API error body. */
function describeGraphError(status: number, body: any): string {
  const err = body?.error;
  if (err) {
    const parts = [err.message, err.error_user_msg, err.error_data?.details].filter(Boolean);
    if (parts.length) return `${parts.join(' — ')} (HTTP ${status})`;
    if (err.type || err.code) return `${err.type || 'Error'} ${err.code ?? ''} (HTTP ${status})`.trim();
  }
  return `WhatsApp API returned HTTP ${status}`;
}

/**
 * Uploads one image and returns its media id.
 *
 * Uses the runtime's own fetch/FormData/Blob, so no HTTP or multipart
 * dependency is added to the project.
 */
export async function uploadMedia(absolutePath: string, mimeType: string): Promise<string> {
  const bytes = await fs.promises.readFile(absolutePath);
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', mimeType);
  form.append(
    'file',
    new Blob([new Uint8Array(bytes)], { type: mimeType }),
    path.basename(absolutePath)
  );

  const response = await fetch(graphUrl('media'), {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.WHATSAPP_ACCESS_TOKEN}` },
    body: form,
  });

  const body: any = await response.json().catch(() => null);
  if (!response.ok || !body?.id) {
    throw new Error(describeGraphError(response.status, body));
  }
  return String(body.id);
}

/**
 * Sends a DEFECTIVE-PIECE ADJUSTMENT template to one recipient.
 *
 * TEXT-ONLY, and the template name is supplied by the CALLER rather than
 * read from a constant here, because there is no approved template for this
 * message on the account by default: `defective_piece_notification` is
 * `Hello {{1}}, we found a defective or damaged piece in your laundry order
 * {{2}}` behind a required IMAGE header, and its body has nowhere to put a
 * quantity or an amount. Whoever configures WHATSAPP_ADJUSTMENT_TEMPLATE is
 * naming a template they have had approved.
 *
 * THE PARAMETER ORDER IS THE CONTRACT, and it is documented in .env.example
 * so the approved template is built to match:
 *
 *   {{1}} customer or establishment name
 *   {{2}} order number
 *   {{3}} item name
 *   {{4}} ordered quantity
 *   {{5}} defective quantity
 *   {{6}} final (billable) quantity
 *   {{7}} updated order amount
 *
 * Never throws. A failure comes back as `{ ok: false, error }` so the caller
 * records what actually happened — reporting a message as sent when Meta
 * rejected it is the one thing this must never do.
 */
export async function sendAdjustmentTemplate(params: {
  to: string;
  /** An APPROVED template name. Never defaulted — see above. */
  templateName: string;
  customerName: string;
  orderNumber: string;
  itemName: string;
  orderedQuantity: number;
  defectiveQuantity: number;
  finalQuantity: number;
  updatedAmount: number;
}): Promise<WhatsAppSendResult> {
  if (!isWhatsAppConfigured()) {
    return {
      ok: false,
      messageId: null,
      error:
        'WhatsApp is not configured on the server (WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_ACCESS_TOKEN).',
    };
  }

  const body = [
    params.customerName,
    params.orderNumber,
    params.itemName,
    String(params.orderedQuantity),
    String(params.defectiveQuantity),
    String(params.finalQuantity),
    params.updatedAmount.toFixed(2),
  ];

  try {
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: params.to,
      type: 'template',
      template: {
        name: params.templateName,
        language: { code: config.WHATSAPP_TEMPLATE_LANG },
        components: [
          { type: 'body', parameters: body.map((text) => ({ type: 'text', text })) },
        ],
      },
    };

    const response = await fetch(graphUrl('messages'), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const responseBody: any = await response.json().catch(() => null);
    if (!response.ok) {
      const error = describeGraphError(response.status, responseBody);
      logger.warn(`[WhatsApp] adjustment send failed for order ${params.orderNumber}: ${error}`);
      return { ok: false, messageId: null, error };
    }

    const messageId = responseBody?.messages?.[0]?.id
      ? String(responseBody.messages[0].id)
      : null;
    logger.info(
      `[WhatsApp] adjustment template sent for order ${params.orderNumber} (${messageId})`
    );
    return { ok: true, messageId, error: null };
  } catch (error: any) {
    const message = error?.message || 'Unknown WhatsApp error';
    logger.error(`[WhatsApp] adjustment send threw for order ${params.orderNumber}: ${message}`);
    return { ok: false, messageId: null, error: String(message).slice(0, 500) };
  }
}

/**
 * Sends the defect template to one customer.
 *
 * Never throws: a failure is returned as `{ ok: false, error }` so the caller
 * can record the real outcome. Marking a message "sent" when Meta rejected it
 * is the one thing this must never do.
 */
export async function sendDefectTemplate(params: {
  to: string;
  customerName: string;
  orderNumber: string;
  /** Either an already-uploaded media id, or a file to upload first. */
  mediaId?: string;
  photoAbsolutePath?: string;
  mimeType?: string;
}): Promise<WhatsAppSendResult> {
  if (!isWhatsAppConfigured()) {
    return {
      ok: false,
      messageId: null,
      error: 'WhatsApp is not configured on the server (WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_ACCESS_TOKEN).',
    };
  }

  try {
    const mediaId =
      params.mediaId ||
      (await uploadMedia(params.photoAbsolutePath as string, params.mimeType || 'image/jpeg'));

    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: params.to,
      type: 'template',
      template: {
        // Name + language, never a hardcoded template id.
        name: config.WHATSAPP_DEFECT_TEMPLATE,
        language: { code: config.WHATSAPP_TEMPLATE_LANG },
        components: [
          {
            type: 'header',
            parameters: [{ type: 'image', image: { id: mediaId } }],
          },
          {
            type: 'body',
            parameters: [
              // {{1}} customer name, {{2}} order id — in template order.
              { type: 'text', text: params.customerName },
              { type: 'text', text: params.orderNumber },
            ],
          },
        ],
      },
    };

    const response = await fetch(graphUrl('messages'), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const body: any = await response.json().catch(() => null);
    if (!response.ok) {
      const error = describeGraphError(response.status, body);
      logger.warn(`[WhatsApp] send failed for order ${params.orderNumber}: ${error}`);
      return { ok: false, messageId: null, error };
    }

    const messageId = body?.messages?.[0]?.id ? String(body.messages[0].id) : null;
    logger.info(`[WhatsApp] defect template sent for order ${params.orderNumber} (${messageId})`);
    return { ok: true, messageId, error: null };
  } catch (error: any) {
    const message = error?.message || 'Unknown WhatsApp error';
    logger.error(`[WhatsApp] send threw for order ${params.orderNumber}: ${message}`);
    return { ok: false, messageId: null, error: String(message).slice(0, 500) };
  }
}
