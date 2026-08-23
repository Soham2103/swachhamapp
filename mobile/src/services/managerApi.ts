import apiClient from './api';
import { ApiResponse } from '../types';

/**
 * Manager API.
 *
 * The same axios client every other module uses, so the bearer token, base
 * URL and error shaping are the ones the app already has.
 *
 * A Manager PROPOSES. There is no approve, no reject and no credential call
 * on this client, because there is no such endpoint on the manager router —
 * approval lives entirely on the Super Admin side.
 */

export type RequestType = 'BUSINESS' | 'RIDER' | 'SORTER';
export type RequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

export const BILLING_CYCLES: Array<{ value: string; label: string }> = [
  { value: 'MONTHLY', label: 'Monthly' },
  // Every 14 days, anchored to the month: 1st-14th and 15th-end.
  { value: 'FORTNIGHTLY', label: 'Fortnightly' },
  { value: 'QUARTERLY', label: 'Quarterly' },
  { value: 'HALF_YEARLY', label: 'Half-Yearly' },
  { value: 'YEARLY', label: 'Yearly' },
];

/**
 * The BUSINESS HEAD contact — the primary one. Their email becomes the login
 * username, which is why it is required here and nowhere else.
 */
export interface HeadContactForm {
  name: string;
  designation?: string;
  mobile: string;
  /** Not defaulted from `mobile`: they are frequently different numbers. */
  whatsapp?: string;
  email: string;
}

/**
 * An ALTERNATIVE contact: name, designation and mobile, and nothing else.
 *
 * No email and no WhatsApp — the server discards both if they are sent. The
 * mobile number is what lets that person be routed to this business's login
 * page; it is not a credential.
 */
export interface AlternativeContactForm {
  name: string;
  designation: string;
  mobile: string;
}

export interface CreationRequest {
  id: string;
  request_type: RequestType;
  status: RequestStatus;
  requested_by: string;
  requested_by_name: string | null;
  subject_name: string;
  subject_email: string | null;
  payload: any;
  rejection_reason: string | null;
  approved_at: string | null;
  created_entity_id: string | null;
  email_status: 'NOT_SENT' | 'SENT' | 'FAILED';
  email_error: string | null;
  created_at: string;
}

/** What the GST lookup gives the New Business form. */
export interface GstLookup {
  verified: boolean;
  data?: {
    gstin: string;
    /** Derived by the server from GSTIN characters 3-12. Never typed. */
    pan_number: string;
    legalName: string | null;
    tradeName: string | null;
    registrationStatus: string | null;
    state: string | null;
    address: string | null;
    city: string | null;
    pincode: string | null;
  };
  message?: string;
}

const managerApi = {
  getSummary: async (): Promise<{ counts: Record<string, number> }> => {
    const res = await apiClient.get<ApiResponse<{ counts: Record<string, number> }>>(
      '/api/manager/summary'
    );
    return res.data.data;
  },

  /**
   * Verifies a GSTIN through the backend.
   *
   * No provider key exists in this app: it sends a number and renders the
   * answer, and the PAN comes back already derived.
   */
  verifyGst: async (gstin: string): Promise<GstLookup> => {
    const res = await apiClient.post<ApiResponse<GstLookup>>('/api/manager/gst/verify', { gstin });
    return { ...res.data.data, message: res.data.message };
  },

  submitBusiness: async (payload: Record<string, unknown>): Promise<CreationRequest> => {
    const res = await apiClient.post<ApiResponse<CreationRequest>>(
      '/api/manager/requests/business',
      payload
    );
    return res.data.data;
  },

  submitRider: async (payload: Record<string, unknown>): Promise<CreationRequest> => {
    const res = await apiClient.post<ApiResponse<CreationRequest>>(
      '/api/manager/requests/rider',
      payload
    );
    return res.data.data;
  },

  submitSorter: async (payload: Record<string, unknown>): Promise<CreationRequest> => {
    const res = await apiClient.post<ApiResponse<CreationRequest>>(
      '/api/manager/requests/sorter',
      payload
    );
    return res.data.data;
  },

  /** Own requests only — the server scopes this to the signed-in manager. */
  listRequests: async (filters: { type?: string; status?: string } = {}): Promise<CreationRequest[]> => {
    const res = await apiClient.get<ApiResponse<CreationRequest[]>>('/api/manager/requests', {
      params: filters,
    });
    return res.data.data;
  },

  getRequest: async (id: string): Promise<CreationRequest> => {
    const res = await apiClient.get<ApiResponse<CreationRequest>>(`/api/manager/requests/${id}`);
    return res.data.data;
  },
};

export default managerApi;
