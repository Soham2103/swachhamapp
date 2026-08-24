import apiClient from './api';
import { ApiResponse } from '../types';

/**
 * Rider API.
 *
 * Same axios client as every other module, so the bearer token, base URL and
 * error shaping are the ones the app already has.
 *
 * NOTHING HERE CARRIES A PRICE. The rider endpoints do not return unit
 * prices, line amounts or order totals — a rider carries bags, and what the
 * bags are worth is not their question. The types below are the whole of what
 * a rider session can learn about an order.
 */

export type VehicleType = 'BIKE' | 'SCOOTER' | 'CYCLE' | 'VAN' | 'OTHER';

export type JobType = 'PICKUP' | 'DELIVERY';

export type JobStatus =
  | 'PENDING'
  | 'OFFERED'
  | 'ASSIGNED'
  | 'EN_ROUTE'
  | 'ARRIVED'
  | 'COLLECTED'
  | 'HELD'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'UNASSIGNED';

export interface RiderProfile {
  user_id: string;
  name: string | null;
  mobile_number: string | null;
  vehicle_type: VehicleType;
  vehicle_number: string | null;
  license_number: string | null;
  is_online: boolean;
  last_latitude: number | null;
  last_longitude: number | null;
  last_location_at: string | null;
  active_job_count: number;
  max_active_jobs: number;
  completed_jobs: number;
  cancelled_jobs: number;
}

/** A job waiting for this rider to accept or decline, with its countdown. */
export interface JobOffer {
  offer_id: string;
  job_id: string;
  order_id: string;
  order_number: string;
  job_type: JobType;
  address_text: string | null;
  contact_name: string | null;
  latitude: number | null;
  longitude: number | null;
  /** Where a DELIVERY is collected from — the facility. Null for a pickup. */
  origin_address: string | null;
  origin_latitude: number | null;
  origin_longitude: number | null;
  distance_m: number;
  distance_label: string;
  item_count: number;
  /**
   * The order's weight, shown as INFORMATION only.
   *
   * Nothing is computed from it and nothing is refused because of it. It is
   * on the card because it is how a rider decides whether to take a second
   * pickup now or hold it — the judgement is theirs, not the server's.
   */
  weight_kg: number;
  offered_at: string;
  /**
   * Seconds left on the offer, as the SERVER counted them.
   *
   * Not a timestamp: an `expires_at` would have to survive MySQL's timezone
   * on the way out and the phone's clock on the way in, and a phone with a
   * wrong clock would show a wrong countdown. A duration is immune to both.
   */
  expires_in_seconds: number;
}

export interface RiderJob {
  job_id: string;
  order_id: string;
  order_number: string;
  job_type: JobType;
  status: JobStatus;
  address_text: string | null;
  latitude: number | null;
  longitude: number | null;
  /**
   * Where a DELIVERY is collected from — the facility. Null for a pickup.
   *
   * A delivery therefore has two stops, and which one the rider is heading
   * for depends on whether they have loaded yet.
   */
  origin_address: string | null;
  origin_latitude: number | null;
  origin_longitude: number | null;
  contact_name: string | null;
  /** Only present while the rider is carrying the job. */
  contact_mobile: string | null;
  handover_code_required: boolean;
  weight_kg: number;
  item_count: number;
  total_quantity: number;
  assigned_at: string | null;
  en_route_at: string | null;
  arrived_at: string | null;
  /** When the handover happened. The load is on the bike from here. */
  collected_at: string | null;
  /** When it came off the bike — for a pickup, at the facility. */
  completed_at: string | null;
  rider_notes: string | null;
}

/** Job detail adds the piece list. Quantities only — never an amount. */
export interface RiderJobDetail extends RiderJob {
  items: Array<{ item_name: string; quantity: number }>;
}

export interface RiderSummary {
  profile: RiderProfile;
  today: { pickups: number; deliveries: number; completed: number };
  active_jobs: number;
  open_offers: number;
  held_jobs: number;
  /** Collected pickups still to be dropped at the facility. */
  carrying_jobs: number;
  lifetime: { completed: number; cancelled: number };
}

/** A job parked until the rider has room, with its reclaim countdown. */
export interface HeldJob extends RiderJob {
  held_minutes: number;
  reclaim_in_minutes: number;
}

const riderApi = {
  // ---- profile and duty ----

  getProfile: async (): Promise<ApiResponse<RiderProfile>> => {
    const response = await apiClient.get('/api/rider/me');
    return response.data;
  },

  updateProfile: async (input: {
    vehicle_type?: VehicleType;
    vehicle_number?: string;
    license_number?: string;
  }): Promise<ApiResponse<RiderProfile>> => {
    const response = await apiClient.put('/api/rider/me', input);
    return response.data;
  },

  /**
   * Go on or off duty.
   *
   * Going online REQUIRES a position: the server refuses with 428 otherwise,
   * because a rider with no coordinates is invisible to dispatch and would
   * sit waiting for offers that can never reach them.
   */
  setDuty: async (
    online: boolean,
    location?: { latitude: number; longitude: number; accuracy?: number }
  ): Promise<ApiResponse<RiderProfile>> => {
    const response = await apiClient.post('/api/rider/duty', { online, ...(location || {}) });
    return response.data;
  },

  pingLocation: async (
    latitude: number,
    longitude: number,
    accuracy?: number
  ): Promise<ApiResponse<{ updated: boolean; broadcastTo: number }>> => {
    const response = await apiClient.post('/api/rider/location', {
      latitude,
      longitude,
      accuracy,
    });
    return response.data;
  },

  // ---- offers ----

  getOffers: async (): Promise<ApiResponse<JobOffer[]>> => {
    const response = await apiClient.get('/api/rider/offers');
    return response.data;
  },

  /**
   * Take the job.
   *
   * A 409 here is normal, not an error to apologise for: another rider got
   * there first. The screen should say so plainly and drop the card.
   */
  acceptOffer: async (jobId: string): Promise<ApiResponse<RiderJob>> => {
    const response = await apiClient.post(`/api/rider/offers/${jobId}/accept`);
    return response.data;
  },

  /**
   * "I want it, but I am full."
   *
   * Reserves the job for this rider rather than passing it on, so a loaded
   * rider does not have to give up a pickup on their doorstep to someone
   * twice as far away. Reclaimed automatically if held too long.
   */
  holdOffer: async (jobId: string): Promise<ApiResponse<RiderJob>> => {
    const response = await apiClient.post(`/api/rider/offers/${jobId}/hold`);
    return response.data;
  },

  declineOffer: async (jobId: string): Promise<ApiResponse<null>> => {
    const response = await apiClient.post(`/api/rider/offers/${jobId}/decline`);
    return response.data;
  },

  // ---- held queue ----

  getHeldJobs: async (): Promise<ApiResponse<HeldJob[]>> => {
    const response = await apiClient.get('/api/rider/held');
    return response.data;
  },

  startHeldJob: async (jobId: string): Promise<ApiResponse<RiderJobDetail>> => {
    const response = await apiClient.post(`/api/rider/held/${jobId}/start`);
    return response.data;
  },

  releaseHeldJob: async (jobId: string): Promise<ApiResponse<null>> => {
    const response = await apiClient.post(`/api/rider/held/${jobId}/release`);
    return response.data;
  },

  /**
   * The bags reach the facility and come off the bike.
   *
   * This is what ENDS a pickup — the handover only put it on the bike. With
   * no ids everything the rider is carrying is dropped, which is the usual
   * case: a rider empties the bike in one go.
   */
  dropAtFacility: async (
    jobIds?: string[]
  ): Promise<ApiResponse<{ dropped: number; still_carrying: number }>> => {
    const response = await apiClient.post('/api/rider/drop-off', { job_ids: jobIds });
    return response.data;
  },

  // ---- jobs ----

  getJobs: async (scope: 'active' | 'completed' = 'active'): Promise<ApiResponse<RiderJob[]>> => {
    const response = await apiClient.get('/api/rider/jobs', { params: { scope } });
    return response.data;
  },

  getJob: async (jobId: string): Promise<ApiResponse<RiderJobDetail>> => {
    const response = await apiClient.get(`/api/rider/jobs/${jobId}`);
    return response.data;
  },

  /** ASSIGNED -> EN_ROUTE -> ARRIVED. Completing needs the handover code. */
  setJobStatus: async (
    jobId: string,
    status: 'EN_ROUTE' | 'ARRIVED'
  ): Promise<ApiResponse<RiderJobDetail>> => {
    const response = await apiClient.patch(`/api/rider/jobs/${jobId}/status`, { status });
    return response.data;
  },

  /** The code the customer or establishment reads out closes the job. */
  completeJob: async (
    jobId: string,
    handoverCode: string,
    notes?: string
  ): Promise<ApiResponse<RiderJobDetail>> => {
    const response = await apiClient.post(`/api/rider/jobs/${jobId}/complete`, {
      handover_code: handoverCode,
      notes,
    });
    return response.data;
  },

  releaseJob: async (jobId: string, reason?: string): Promise<ApiResponse<null>> => {
    const response = await apiClient.post(`/api/rider/jobs/${jobId}/release`, { reason });
    return response.data;
  },

  // ---- dashboard ----

  getSummary: async (): Promise<ApiResponse<RiderSummary>> => {
    const response = await apiClient.get('/api/rider/summary');
    return response.data;
  },
};

export default riderApi;
