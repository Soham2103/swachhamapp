import apiClient from './api';
import { ApiResponse } from '../types';

/**
 * DOOR TICKETS AND RIDER MESSAGES — the business's side.
 *
 * When a rider takes a load WITHOUT counting it, they raise a ticket and then
 * WAIT. Nothing moves until the business accepts it here, so this is not a
 * passive inbox: the accept call is what releases a rider standing at the
 * door.
 *
 * The business is taken from the bearer token on the server — there is no id
 * to pass and no way to name another business's ticket.
 *
 * WHY THIS IS NOT `notifications`. A business account lives in
 * `business_users`, and the `notifications` table's `user_id` is a foreign key
 * to `users` — a different table with its own ids — so a business has never
 * been addressable there. These endpoints read `business_messages`, which
 * exists for exactly that reason. See migration 062.
 */

export interface DoorTicket {
  ticket_id: string;
  order_id: string;
  order_number: string | null;
  job_id: string;
  status: 'PENDING' | 'ACCEPTED';
  created_at: string;
  accepted_at: string | null;
  rider_name: string | null;
  address_text: string | null;
  item_count: number;
  weight_kg: number;
}

export interface BusinessMessage {
  id: string;
  order_id: string | null;
  order_number: string | null;
  ticket_id: string | null;
  /** DOOR_CHECKED or DOOR_UNCOUNTED_AGREED. */
  type: string;
  body: string;
  is_read: boolean;
  created_at: string;
}

export interface InboxCounts {
  unread_messages: number;
  pending_tickets: number;
}

const businessDoorApi = {
  /** Tickets waiting on this business. A rider is blocked on each one. */
  getPendingTickets: async (): Promise<ApiResponse<DoorTicket[]>> => {
    const response = await apiClient.get('/api/businesses/door-tickets');
    return response.data;
  },

  /**
   * Accept a ticket.
   *
   * This releases the rider AND sends them the mismatch notice. Accepting a
   * ticket that is already accepted is not an error — it reports the same
   * ticket back with `messaged: false`, so a double tap cannot post the
   * notice twice.
   */
  acceptTicket: async (
    ticketId: string
  ): Promise<ApiResponse<{ ticket: DoorTicket; messaged: boolean }>> => {
    const response = await apiClient.post(`/api/businesses/door-tickets/${ticketId}/accept`);
    return response.data;
  },

  getMessages: async (): Promise<ApiResponse<BusinessMessage[]>> => {
    const response = await apiClient.get('/api/businesses/messages');
    return response.data;
  },

  getInboxCounts: async (): Promise<ApiResponse<InboxCounts>> => {
    const response = await apiClient.get('/api/businesses/inbox-counts');
    return response.data;
  },

  markMessagesRead: async (): Promise<ApiResponse<{ updated: number }>> => {
    const response = await apiClient.post('/api/businesses/messages/read');
    return response.data;
  },
};

export default businessDoorApi;
