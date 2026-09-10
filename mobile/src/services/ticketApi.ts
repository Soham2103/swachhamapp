import apiClient from './api';
import { ApiResponse } from '../types';

/**
 * THE ONE TICKET CLIENT.
 *
 * Every role calls the same endpoints — Sorter, Manager, Business and Super
 * Admin — because there is one ticket system behind them. What a caller may
 * see and do is decided by the server from the token, so there is nothing
 * role-specific in this file and no second client anywhere.
 */

export type TicketCategory =
  | 'QUANTITY_MISMATCHED'
  | 'DAMAGE_ITEM'
  | 'MATERIAL_REQUISITION'
  | 'TECHNICAL_ISSUE'
  | 'QUALITY_ISSUE'
  | 'MISSING_ITEM'
  | 'INVOICE_ISSUE'
  | 'REWASH_REQUEST';

export type TicketPriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
export type TicketStatus =
  | 'OPEN'
  | 'IN_PROGRESS'
  | 'WAITING_FOR_RESPONSE'
  | 'RESOLVED'
  | 'CLOSED';
export type TicketRole = 'SORTER' | 'MANAGER' | 'BUSINESS' | 'SUPER_ADMIN';

export interface TicketMessage {
  id: string;
  ticket_id: string;
  sender_role: TicketRole;
  sender_name: string;
  message: string;
  created_at: string;
}

export interface TicketStatusChange {
  id: string;
  previous_status: TicketStatus | null;
  new_status: TicketStatus;
  changed_by_role: TicketRole;
  changed_by_name: string;
  note: string | null;
  created_at: string;
}

export interface Ticket {
  id: string;
  ticket_number: string;
  category: TicketCategory;
  category_label: string;
  title: string;
  description: string;
  priority: TicketPriority;
  status: TicketStatus;
  status_label: string;
  created_by_role: 'SORTER' | 'MANAGER' | 'BUSINESS';
  created_by_name: string;
  created_by_user_id: string | null;
  created_by_business_user_id: string | null;
  business_id: string | null;
  business_name: string | null;
  order_id: string | null;
  order_number: string | null;
  assigned_to_user_id: string | null;
  assigned_to_name: string | null;
  assigned_at: string | null;
  resolved_at: string | null;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
  message_count: number;
}

export interface TicketDetail extends Ticket {
  messages: TicketMessage[];
  history: TicketStatusChange[];
}

/** What this caller may raise, plus the labels every screen renders. */
export interface TicketMeta {
  role: TicketRole;
  categories: Array<{ value: TicketCategory; label: string }>;
  categories_by_role: Record<string, TicketCategory[]>;
  category_labels: Record<TicketCategory, string>;
  status_labels: Record<TicketStatus, string>;
  /** The categories that require a delivered order to be chosen first. */
  categories_needing_order: TicketCategory[];
  priorities: TicketPriority[];
  can_raise: boolean;
}

/**
 * A delivered order a hotel may still raise a ticket against.
 *
 * THE REFERENCE ONLY — the number, when it was delivered and how long is left.
 * The server sends no items, amounts or status, so a ticket form cannot become
 * a way to read an order back.
 */
export interface TicketOrderRef {
  order_id: string;
  order_number: string;
  delivered_at: string;
  hours_remaining: number;
}

/** How long is left to raise a delivery-related ticket against an order. */
export interface TicketWindow {
  order_id: string;
  delivered_at: string | null;
  deadline: string | null;
  hours_remaining: number | null;
  expired: boolean;
  allowed_categories: TicketCategory[];
}

export interface TicketFilters {
  ticket_number?: string;
  status?: TicketStatus | '';
  priority?: TicketPriority | '';
  category?: TicketCategory | '';
  business_id?: string;
  order_number?: string;
  date_from?: string;
  date_to?: string;
  limit?: number;
  offset?: number;
}

/** Only the filters actually set are sent, so an empty box is not a filter. */
function params(filters: TicketFilters): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === null || value === '') continue;
    out[key] = String(value);
  }
  return out;
}

export const PRIORITY_LABELS: Record<TicketPriority, string> = {
  LOW: 'Low',
  MEDIUM: 'Medium',
  HIGH: 'High',
  URGENT: 'Urgent',
};

const ticketApi = {
  meta: async (): Promise<ApiResponse<TicketMeta>> =>
    (await apiClient.get<ApiResponse<TicketMeta>>('/api/tickets/meta')).data,

  list: async (
    filters: TicketFilters = {}
  ): Promise<ApiResponse<{ tickets: Ticket[]; total: number }>> =>
    (
      await apiClient.get<ApiResponse<{ tickets: Ticket[]; total: number }>>('/api/tickets', {
        params: params(filters),
      })
    ).data,

  get: async (ticketId: string): Promise<ApiResponse<TicketDetail>> =>
    (await apiClient.get<ApiResponse<TicketDetail>>(`/api/tickets/${ticketId}`)).data,

  /**
   * Raises a ticket.
   *
   * The server re-checks the category against the caller's role and, for the
   * three delivery-related categories, the 48-hour window — so a form that
   * offers the wrong thing is refused rather than trusted.
   */
  create: async (payload: {
    category: TicketCategory;
    title: string;
    description: string;
    priority?: TicketPriority;
    order_id?: string | null;
    business_id?: string | null;
  }): Promise<ApiResponse<Ticket>> =>
    (await apiClient.post<ApiResponse<Ticket>>('/api/tickets', payload)).data,

  reply: async (ticketId: string, message: string): Promise<ApiResponse<TicketDetail>> =>
    (
      await apiClient.post<ApiResponse<TicketDetail>>(`/api/tickets/${ticketId}/messages`, {
        message,
      })
    ).data,

  /** Resolvers only; the server refuses a creator. */
  setStatus: async (
    ticketId: string,
    status: TicketStatus,
    note?: string
  ): Promise<ApiResponse<TicketDetail>> =>
    (
      await apiClient.patch<ApiResponse<TicketDetail>>(`/api/tickets/${ticketId}/status`, {
        status,
        note,
      })
    ).data,

  assign: async (
    ticketId: string,
    assignedToUserId: string | null
  ): Promise<ApiResponse<TicketDetail>> =>
    (
      await apiClient.patch<ApiResponse<TicketDetail>>(`/api/tickets/${ticketId}/assign`, {
        assigned_to_user_id: assignedToUserId,
      })
    ).data,

  assignable: async (
    ticketId: string
  ): Promise<ApiResponse<Array<{ id: string; name: string; role: string }>>> =>
    (
      await apiClient.get<ApiResponse<Array<{ id: string; name: string; role: string }>>>(
        `/api/tickets/${ticketId}/assignable`
      )
    ).data,

  /** The delivered orders still inside the 48-hour window, newest first. */
  eligibleOrders: async (): Promise<ApiResponse<TicketOrderRef[]>> =>
    (await apiClient.get<ApiResponse<TicketOrderRef[]>>('/api/tickets/eligible-orders')).data,

  window: async (orderId: string): Promise<ApiResponse<TicketWindow>> =>
    (await apiClient.get<ApiResponse<TicketWindow>>(`/api/tickets/order/${orderId}/window`)).data,
};

export default ticketApi;
