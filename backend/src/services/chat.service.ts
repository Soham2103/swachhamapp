import { query } from '../config/database';
import { getOrders, CANCELLABLE_STATUSES } from './businessOrder.service';
import { logger } from '../utils/logger';

/**
 * Swachham — the in-app assistant.
 *
 * There is no LLM anywhere in this project and no model credentials in the
 * environment, so this does not call one. Every answer is composed here, on
 * the server, from two sources and nothing else:
 *
 *   1. The workflow this application actually implements, written out below.
 *   2. Live rows — the service types in the catalogue, and the caller's own
 *      orders.
 *
 * That is a deliberate trade: the assistant cannot hold an open-ended
 * conversation, but it also cannot invent a service, a price, a delivery
 * window or a policy, which is the one thing it must never do. Anything it
 * has no grounded answer for is declined and pointed at support.
 *
 * The answer text lives on the server, so the wording can be corrected
 * without shipping a new build, and nothing about how it is produced is
 * exposed to the app.
 */

export type ChatSection = 'business' | 'customer' | 'general';

export interface ChatReply {
  /** What Swachham says. Plain text; the app renders it as one bubble. */
  reply: string;
  /** Follow-up chips to offer after this answer. */
  suggestions: string[];
}

export interface ChatRequest {
  message: string;
  section?: ChatSection;
}

/** The quick questions offered when the chat opens. */
export const QUICK_QUESTIONS = [
  'How to book pickup?',
  'How to book delivery?',
  'How to place an order?',
  'Check order status',
  'What services are available?',
  'Contact support',
];

export const GREETING =
  "Hello! 👋\nI'm Swachham, your laundry assistant.\n\nHow can I help you?";

/** Longest message worth reading; anything past this is noise or an attack. */
const MAX_MESSAGE_LENGTH = 500;

interface Intent {
  key: string;
  /** Words that point at this intent. Matched case-insensitively. */
  keywords: string[];
  /** Phrases that settle it outright, before scoring. */
  phrases?: string[];
  /**
   * Tie-break weight, default 1. Higher wins an equal keyword score.
   *
   * "How much does a wash cost?" hits `wash` for services and `cost` for
   * pricing; the honest answer is the pricing one, so money words outrank a
   * passing mention of a service.
   */
  priority?: number;
  respond: (ctx: AnswerContext) => Promise<ChatReply> | ChatReply;
}

interface AnswerContext {
  userId: string;
  role: string;
  section: ChatSection;
  message: string;
}

/** Only a business account has business orders to look up. */
function isBusiness(ctx: AnswerContext): boolean {
  return String(ctx.role).toUpperCase() === 'BUSINESS';
}

/**
 * The laundry services the catalogue actually offers, read from the same
 * table the ordering screens read. Never a hardcoded list.
 */
async function activeServiceTypes(): Promise<string[]> {
  const result = await query<{ name: string }>(
    `SELECT name FROM services WHERE kind = 'SERVICE_TYPE' AND is_active = true ORDER BY name`
  );
  return result.rows.map((row) => row.name);
}

/** The main catalogue sections, for "what can I send". */
async function mainCategories(limit = 8): Promise<string[]> {
  const result = await query<{ name: string }>(
    `SELECT name FROM service_categories WHERE parent_id IS NULL ORDER BY id LIMIT ${limit}`
  );
  return result.rows.map((row) => row.name);
}

/** Status code -> the wording the tracking screen shows. */
const STATUS_LABEL: Record<string, string> = {
  ORDER_PLACED: 'Order Placed',
  RECEIVED_AT_FACILITY: 'Confirmed — received at the facility',
  IN_PROCESS: 'Processing',
  READY_FOR_DELIVERY: 'Ready',
  // Some of the order is finished and some is still being worked on. Worded
  // for the person waiting on it, not in the database's vocabulary.
  PARTIALLY_COMPLETED: 'Partly ready — some items still in process',
  OUT_FOR_DELIVERY: 'Out for Delivery',
  DELIVERED: 'Completed',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
};

function statusLabel(status: string): string {
  return STATUS_LABEL[status] || status;
}

const ORDER_STEPS =
  'Select Items → choose the laundry service for each item and set the quantity → open the Cart → ' +
  'choose Order Type (Standard or Quick) and Laundry Type (Hotel or Guest) → Confirm Order. ' +
  'Your order number appears on the confirmation as soon as it is placed.';

const INTENTS: Intent[] = [
  {
    key: 'place-order',
    phrases: ['how to place an order', 'how do i place an order', 'place order'],
    keywords: ['place', 'order', 'new', 'create', 'booking', 'book'],
    respond: () => ({
      reply:
        `Here is how an order is placed in the app:\n\n${ORDER_STEPS}\n\n` +
        'Each item carries its own laundry service, so one order can mix services. ' +
        'Order Type and Laundry Type are both required before the order can be confirmed.',
      suggestions: ['What services are available?', 'Check order status', 'How can I cancel my order?'],
    }),
  },

  {
    key: 'pickup',
    phrases: ['how to book pickup', 'how do i book a pickup', 'book a pickup'],
    keywords: ['pickup', 'pick', 'collect', 'collection'],
    respond: () => ({
      // Said plainly, because there is no pickup-scheduling screen in this
      // app and inventing time slots would be exactly the wrong answer.
      reply:
        'The Business section does not have a separate pickup-booking screen. Placing the order is ' +
        'how your items are registered with Swachham:\n\n' +
        `${ORDER_STEPS}\n\n` +
        'Once it is placed you can follow it under Orders. For how collection is arranged for your ' +
        'account, please check with Swachham — I cannot confirm that from the app.',
      suggestions: ['How to place an order?', 'Check order status', 'Contact support'],
    }),
  },

  {
    key: 'delivery',
    phrases: ['how to book delivery', 'how do i book delivery'],
    keywords: ['delivery', 'deliver', 'dispatch', 'shipping', 'return'],
    respond: () => ({
      reply:
        'Delivery is not booked separately — it follows the order. After you confirm an order it moves ' +
        'through Order Placed → Confirmed → Processing → Ready → Out for Delivery → Completed.\n\n' +
        'You can see exactly which stage an order has reached under Orders → open the order → Track. ' +
        'The app does not show delivery dates or time windows, so I cannot give you one.',
      suggestions: ['Check order status', 'How to place an order?', 'Contact support'],
    }),
  },

  {
    key: 'order-status',
    phrases: ['check order status', 'where is my order', 'track my order'],
    keywords: ['status', 'track', 'tracking', 'where', 'progress', 'ready'],
    respond: async (ctx) => {
      const base =
        'Open the Orders tab to see your orders, newest first. Tap one to see its items and status, ' +
        'and Track for the full stage-by-stage history.';

      if (!isBusiness(ctx)) {
        return { reply: base, suggestions: ['How to place an order?', 'Contact support'] };
      }

      // The caller's own orders only — scoped by their authenticated id, so
      // no other account's data can ever be reached from here.
      const orders = await getOrders(ctx.userId);
      if (orders.length === 0) {
        return {
          reply: `${base}\n\nYou do not have any orders yet.`,
          suggestions: ['How to place an order?', 'What services are available?'],
        };
      }

      const recent = orders
        .slice(0, 3)
        .map((order) => `• ${order.order_number} — ${statusLabel(order.status)}`)
        .join('\n');

      return {
        reply: `${base}\n\nYour most recent orders:\n${recent}`,
        suggestions: ['How can I cancel my order?', 'How to book delivery?', 'Contact support'],
      };
    },
  },

  {
    key: 'services',
    phrases: ['what services are available', 'what services do you provide'],
    keywords: ['service', 'services', 'wash', 'iron', 'dry', 'clean', 'offer', 'provide'],
    respond: async () => {
      const services = await activeServiceTypes();
      const categories = await mainCategories();

      const serviceLine = services.length
        ? `The laundry services available in the app are: ${services.join(' and ')}.`
        : 'I could not read the service list just now. Please try again in a moment.';

      const categoryLine = categories.length
        ? `\n\nItems are organised into sections such as ${categories.slice(0, 6).join(', ')}, ` +
          'and each item lists the services it supports on the Select Items page.'
        : '';

      return {
        reply: `${serviceLine}${categoryLine}`,
        suggestions: ['How to place an order?', 'Check order status', 'Contact support'],
      };
    },
  },

  {
    key: 'cancel',
    phrases: ['how can i cancel my order', 'cancel my order', 'cancel order'],
    keywords: ['cancel', 'cancellation', 'stop', 'remove'],
    respond: async (ctx) => {
      const base =
        'An order can be cancelled only while it is still at the Order Placed stage. Open Orders → tap ' +
        'the order → Cancel Order. Once it has been received at the facility it can no longer be ' +
        'cancelled from the app.';

      if (!isBusiness(ctx)) {
        return { reply: base, suggestions: ['Check order status', 'Contact support'] };
      }

      const orders = await getOrders(ctx.userId);
      const cancellable = orders.filter((order) => CANCELLABLE_STATUSES.includes(order.status));

      if (cancellable.length === 0) {
        return {
          reply: `${base}\n\nRight now none of your orders are at that stage.`,
          suggestions: ['Check order status', 'Contact support'],
        };
      }

      const list = cancellable
        .slice(0, 3)
        .map((order) => `• ${order.order_number}`)
        .join('\n');

      return {
        reply: `${base}\n\nOrders you can still cancel:\n${list}`,
        suggestions: ['Check order status', 'Contact support'],
      };
    },
  },

  {
    key: 'pricing',
    phrases: ['how much does it cost', 'what is the price'],
    keywords: ['price', 'prices', 'pricing', 'cost', 'rate', 'rates', 'charges', 'bill', 'payment', 'discount'],
    priority: 2,
    respond: () => ({
      // The Business screens show weight, never amounts. Quoting a number
      // here would be inventing one.
      reply:
        'The Business section of the app shows the weight of an order rather than prices, so I do not ' +
        'have rates to quote and I would rather not guess. Please contact Swachham directly for ' +
        'pricing for your account.',
      suggestions: ['What services are available?', 'Contact support'],
    }),
  },

  {
    key: 'cart',
    phrases: ['how do i use the cart', 'change quantity'],
    keywords: ['cart', 'quantity', 'qty', 'basket', 'edit', 'change'],
    respond: () => ({
      reply:
        'The Cart tab holds everything you have selected. There you can change a quantity, switch the ' +
        'laundry service on a line, or remove it. Order Type (Standard or Quick) and Laundry Type ' +
        '(Hotel or Guest) are chosen in the Cart too, and both are required before Confirm Order.',
      suggestions: ['How to place an order?', 'What services are available?'],
    }),
  },

  {
    key: 'account',
    phrases: ['my account', 'business profile'],
    keywords: ['account', 'profile', 'details', 'password', 'login', 'register', 'logout'],
    respond: () => ({
      reply:
        'Your account lives under the Profile tab: business details, past orders, Store Locator, and ' +
        'sign out. Profile details can be opened and updated from there.',
      suggestions: ['Check order status', 'Contact support'],
    }),
  },

  {
    key: 'navigation',
    phrases: ['how do i use the app', 'where do i find'],
    keywords: ['navigate', 'find', 'where', 'menu', 'tab', 'screen', 'page', 'use'],
    respond: () => ({
      reply:
        'The Business section has four tabs along the bottom:\n\n' +
        '• Home — Select Items, the catalogue you order from\n' +
        '• Orders — your orders and their status\n' +
        '• Cart — what you have selected, and Confirm Order\n' +
        '• Profile — business details, Store Locator and sign out',
      suggestions: ['How to place an order?', 'Check order status'],
    }),
  },

  {
    key: 'support',
    phrases: ['contact support', 'talk to a human', 'customer care'],
    keywords: ['support', 'help', 'contact', 'complaint', 'issue', 'problem', 'call', 'phone'],
    respond: () => ({
      // No support number or email exists anywhere in the app, so none is
      // offered. Store Locator is real and is the honest pointer.
      reply:
        'The app does not list a support phone number, so I cannot give you one. What it does have is ' +
        'Profile → Store Locator, which shows the nearest Swachham store and directions to it. Your ' +
        'store is the right place for anything about pricing, collection or a specific order.',
      suggestions: ['Check order status', 'What services are available?'],
    }),
  },

  {
    key: 'greeting',
    phrases: ['hi', 'hello', 'hey', 'good morning', 'good evening', 'thanks', 'thank you'],
    keywords: ['hi', 'hello', 'hey', 'thanks', 'thank'],
    respond: () => ({
      reply: "Hello! I'm Swachham, your laundry assistant. What would you like help with?",
      suggestions: QUICK_QUESTIONS.slice(0, 4),
    }),
  },
];

/** What Swachham says when nothing matched. It never guesses. */
function fallback(): ChatReply {
  return {
    reply:
      "I'm not able to confirm that from the app, and I would rather not guess. I can help with " +
      'placing an order, order status, cancelling an order, the available laundry services, and ' +
      'finding your way around the app. For anything else, your nearest Swachham store is under ' +
      'Profile → Store Locator.',
    suggestions: QUICK_QUESTIONS.slice(0, 4),
  };
}

/** Word-boundary match, so "iron" does not fire on "environment". */
function countKeywords(text: string, keywords: string[]): number {
  let score = 0;
  for (const keyword of keywords) {
    const pattern = new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (pattern.test(text)) score += 1;
  }
  return score;
}

function pickIntent(message: string): Intent | null {
  const text = message.toLowerCase().trim();

  // An exact-ish phrase wins outright — this is what makes the quick-question
  // chips land on the intent they name.
  for (const intent of INTENTS) {
    if (intent.phrases?.some((phrase) => text.includes(phrase))) return intent;
  }

  let best: { intent: Intent; score: number; priority: number } | null = null;
  for (const intent of INTENTS) {
    const score = countKeywords(text, intent.keywords);
    if (score === 0) continue;
    const priority = intent.priority ?? 1;
    const better =
      !best || score > best.score || (score === best.score && priority > best.priority);
    if (better) best = { intent, score, priority };
  }

  return best ? best.intent : null;
}

/**
 * Answers one message.
 *
 * `userId` is the authenticated caller's id and is the only account any
 * lookup here touches, so the assistant cannot surface another customer's
 * orders. Nothing from the request is echoed back into the reply either.
 */
export async function answerMessage(
  userId: string,
  role: string,
  request: ChatRequest
): Promise<ChatReply> {
  const raw = typeof request.message === 'string' ? request.message.trim() : '';
  if (!raw) {
    return { reply: GREETING, suggestions: QUICK_QUESTIONS };
  }

  const message = raw.slice(0, MAX_MESSAGE_LENGTH);
  const ctx: AnswerContext = {
    userId,
    role,
    section: request.section || 'general',
    message,
  };

  const intent = pickIntent(message);
  if (!intent) {
    logger.debug('[Chat] no intent matched');
    return fallback();
  }

  try {
    return await intent.respond(ctx);
  } catch (error: any) {
    // A failed lookup must not surface as a wrong answer.
    logger.error(`[Chat] intent ${intent.key} failed: ${error?.message || 'unknown error'}`);
    return {
      reply:
        "I could not look that up just now. Please try again in a moment, or check under Orders in " +
        'the app.',
      suggestions: QUICK_QUESTIONS.slice(0, 4),
    };
  }
}
