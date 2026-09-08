import { create } from 'zustand';
import * as Location from 'expo-location';
import { getNotifications } from '../services/expoNotifications';
import riderApi, {
  DoorTicket,
  HeldJob,
  JobOffer,
  RiderJob,
  RiderProfile,
  RiderSummary,
} from '../services/riderApi';
import { extractErrorMessage } from '../services/api';

/**
 * ===================================================================
 * RIDER STORE — duty state, position pings, and the offer watch
 * ===================================================================
 *
 * WHY THIS POLLS INSTEAD OF LISTENING
 *
 * The backend already emits every rider event over Socket.IO
 * (`rider:job-offer`, `rider:job-taken`, `rider:nearby-order`), but the
 * mobile app has no socket client — `socket.io-client` is not a
 * dependency of this project, and adding one is a bundling decision
 * that belongs to whoever owns the app's dependency list rather than
 * something to slip in with a feature.
 *
 * So the app polls while the rider is on duty. With a 90-second offer
 * TTL a 10-second poll is comfortably inside the window, and a rider
 * never sees an offer they cannot still accept. When a socket client is
 * added, `startWatch` is the one place that changes: the emits are
 * already there, waiting for a listener.
 *
 * POLLING ONLY WHILE ONLINE. An off-duty rider makes no requests at
 * all — no position, no offers. Duty is a real switch, not a label.
 */

/** How often the rider's position is sent while on duty. */
const LOCATION_PING_MS = 20_000;

/** How often the offer list is refreshed while on duty. */
const OFFER_POLL_MS = 10_000;

/**
 * A FIXED POSITION FOR TESTING, instead of the device's real GPS.
 *
 * A rider's position is pinged every twenty seconds, so a coordinate set by
 * hand in the database is overwritten before anyone can use it. That makes it
 * impossible to test dispatch against a chosen location from a phone that is
 * somewhere else — the phone always wins.
 *
 * Set EXPO_PUBLIC_RIDER_MOCK_LAT and EXPO_PUBLIC_RIDER_MOCK_LNG in
 * mobile/.env and the rider app reports that point instead, for going on duty
 * and for every ping after it.
 *
 * Guarded by __DEV__ for the same reason the service-area bypass is: Expo
 * inlines EXPO_PUBLIC_* at BUILD time, so a stray value in a build
 * environment would otherwise ship a release where every rider claims to be
 * standing in the same place. In a production build this is always null.
 */
const MOCK_POSITION: { latitude: number; longitude: number } | null = (() => {
  if (!__DEV__) return null;

  const lat = Number(process.env.EXPO_PUBLIC_RIDER_MOCK_LAT);
  const lng = Number(process.env.EXPO_PUBLIC_RIDER_MOCK_LNG);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  // 0,0 is in the Atlantic and is what an empty variable parses to.
  if (lat === 0 && lng === 0) return null;

  return { latitude: lat, longitude: lng };
})();

if (MOCK_POSITION) {
  // Loud on purpose: an app reporting a position it is not at should say so.
  console.warn(
    `[Rider] MOCK POSITION ACTIVE - reporting ${MOCK_POSITION.latitude}, ` +
      `${MOCK_POSITION.longitude} instead of real GPS. Never ship a build with this set.`
  );
}

export interface RiderState {
  profile: RiderProfile | null;
  summary: RiderSummary | null;
  offers: JobOffer[];
  activeJobs: RiderJob[];
  /** Jobs parked until the rider has room on the bike. */
  heldJobs: HeldJob[];

  isLoading: boolean;
  isTogglingDuty: boolean;
  error: string | null;

  /** True while the ping/poll timers are running. */
  isWatching: boolean;

  /**
   * The ticket the rider is currently held by, or null when free to proceed.
   *
   * Set when a job is accepted WITHOUT counting, and cleared when the
   * business accepts it. While it is set the dashboard shows a waiting card
   * instead of letting the rider move on — that is the gate the brief calls
   * "the rider must remain waiting".
   *
   * ONE AT A TIME on purpose. A rider is at one door; holding a list here
   * would raise the question of which one the screen is waiting on.
   */
  awaitingTicket: DoorTicket | null;

  /** True only for the moment a door choice is in flight. */
  isSubmittingDoorChoice: boolean;

  loadDashboard: () => Promise<void>;
  goOnline: () => Promise<{ ok: boolean; message?: string }>;
  goOffline: () => Promise<void>;
  refreshOffers: () => Promise<void>;
  refreshJobs: () => Promise<void>;
  acceptOffer: (jobId: string) => Promise<{ ok: boolean; message: string }>;
  /** "With Counting & Checked" — accept and tell the business. */
  acceptOfferWithCounting: (jobId: string) => Promise<{ ok: boolean; message: string }>;
  /** "Without Counting & Checked" — accept, raise a ticket, then wait. */
  acceptOfferWithoutCounting: (jobId: string) => Promise<{ ok: boolean; message: string }>;
  /** One poll of the ticket the rider is waiting on. */
  pollAwaitingTicket: () => Promise<{ accepted: boolean }>;
  /** Restores a wait that outlived the app being closed. */
  refreshDoorTickets: () => Promise<void>;
  /** Drops the waiting card once the rider has been shown the outcome. */
  clearAwaitingTicket: () => void;
  holdOffer: (jobId: string) => Promise<{ ok: boolean; message: string }>;
  declineOffer: (jobId: string) => Promise<void>;
  refreshHeld: () => Promise<void>;
  startHeldJob: (jobId: string) => Promise<{ ok: boolean; message: string }>;
  dropAtFacility: () => Promise<{ ok: boolean; message: string }>;
  startWatch: () => void;
  stopWatch: () => void;
  reset: () => void;
}

/*
 * Timers live outside the store.
 *
 * Zustand state is for what the UI renders; an interval handle is neither
 * rendered nor comparable, and keeping it in state would re-render every
 * subscriber each time it changed.
 */
let locationTimer: ReturnType<typeof setInterval> | null = null;
let offerTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Offer ids already announced on this device.
 *
 * Without this the poll would fire a fresh notification for the same offer
 * every ten seconds until it expired.
 */
let announcedOffers = new Set<string>();

/** One position fix, or null. Never throws into the caller. */
async function currentPosition(): Promise<Location.LocationObject | null> {
  /*
   * The testing override short-circuits everything, including the permission
   * request: a fixed position does not need a GPS the tester may not have.
   */
  if (MOCK_POSITION) {
    return {
      coords: {
        latitude: MOCK_POSITION.latitude,
        longitude: MOCK_POSITION.longitude,
        accuracy: 10,
        altitude: null,
        altitudeAccuracy: null,
        heading: null,
        speed: null,
      },
      timestamp: Date.now(),
    } as Location.LocationObject;
  }

  try {
    const permission = await Location.getForegroundPermissionsAsync();
    if (permission.status !== Location.PermissionStatus.GRANTED) {
      const asked = await Location.requestForegroundPermissionsAsync();
      if (asked.status !== Location.PermissionStatus.GRANTED) return null;
    }
    return await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
  } catch {
    return null;
  }
}

/**
 * A local heads-up for a new offer.
 *
 * Best-effort on purpose: notification permission is optional in this app, and
 * a rider who declined it still sees the card in the UI. A failure here must
 * never break the poll that found the offer.
 */
async function announceOffer(offer: JobOffer): Promise<void> {
  // Null in Expo Go on Android, where the module cannot be imported at all.
  const Notifications = getNotifications();
  if (!Notifications) return;

  try {
    await Notifications.scheduleNotificationAsync({
      content: {
        title: offer.job_type === 'PICKUP' ? 'New pickup nearby' : 'New delivery nearby',
        body: `${offer.address_text || 'Tap to view'} — ${offer.distance_label} away`,
        data: { jobId: offer.job_id, orderId: offer.order_id },
      },
      trigger: null,
    });
  } catch {
    // Ignored: the card is the source of truth, the notification is a nudge.
  }
}

export const useRiderStore = create<RiderState>((set, get) => ({
  profile: null,
  summary: null,
  offers: [],
  activeJobs: [],
  heldJobs: [],
  isLoading: false,
  isTogglingDuty: false,
  error: null,
  isWatching: false,
  awaitingTicket: null,
  isSubmittingDoorChoice: false,

  loadDashboard: async () => {
    set({ isLoading: true, error: null });
    try {
      const [summary, jobs, held] = await Promise.all([
        riderApi.getSummary(),
        riderApi.getJobs('active'),
        riderApi.getHeldJobs(),
      ]);

      // Best-effort and separate: a rider whose wait cannot be restored still
      // gets a working dashboard.
      void get().refreshDoorTickets();
      set({
        summary: summary.data,
        profile: summary.data.profile,
        activeJobs: jobs.data,
        heldJobs: held.data,
        isLoading: false,
      });

      // Resume the watch across an app restart if the rider is still on duty.
      if (summary.data.profile.is_online) get().startWatch();
    } catch (error: any) {
      set({
        isLoading: false,
        error: extractErrorMessage(error, 'Could not load your dashboard.'),
      });
    }
  },

  goOnline: async () => {
    set({ isTogglingDuty: true, error: null });
    try {
      const position = await currentPosition();
      if (!position) {
        const message =
          'Location permission is needed to go online, so pickups near you can be offered.';
        set({ isTogglingDuty: false, error: message });
        return { ok: false, message };
      }

      const { latitude, longitude, accuracy } = position.coords;
      const response = await riderApi.setDuty(true, {
        latitude,
        longitude,
        accuracy: typeof accuracy === 'number' ? accuracy : undefined,
      });

      set({ profile: response.data, isTogglingDuty: false });
      get().startWatch();
      await get().refreshOffers();
      return { ok: true };
    } catch (error: any) {
      const message = extractErrorMessage(error, 'Could not go online.');
      set({ isTogglingDuty: false, error: message });
      return { ok: false, message };
    }
  },

  goOffline: async () => {
    set({ isTogglingDuty: true, error: null });
    try {
      const response = await riderApi.setDuty(false);
      get().stopWatch();
      set({ profile: response.data, offers: [], isTogglingDuty: false });
    } catch (error: any) {
      set({
        isTogglingDuty: false,
        error: extractErrorMessage(error, 'Could not go offline.'),
      });
    }
  },

  refreshOffers: async () => {
    try {
      const response = await riderApi.getOffers();
      const offers = response.data || [];

      for (const offer of offers) {
        if (!announcedOffers.has(offer.offer_id)) {
          announcedOffers.add(offer.offer_id);
          void announceOffer(offer);
        }
      }

      // Forget ids that are no longer open, so the set cannot grow all shift.
      const live = new Set(offers.map((o) => o.offer_id));
      announcedOffers = new Set([...announcedOffers].filter((id) => live.has(id)));

      set({ offers });
    } catch (error: any) {
      // A failed poll is not worth a banner; the next one is ten seconds away.
      set({ error: null });
    }
  },

  refreshJobs: async () => {
    try {
      const response = await riderApi.getJobs('active');
      set({ activeJobs: response.data || [] });
    } catch {
      // Same reasoning as refreshOffers.
    }
  },

  acceptOffer: async (jobId: string) => {
    try {
      await riderApi.acceptOffer(jobId);
      // Drop the card immediately, then reconcile with the server.
      set({ offers: get().offers.filter((o) => o.job_id !== jobId) });
      await Promise.all([get().refreshJobs(), get().refreshOffers()]);
      return { ok: true, message: 'Job accepted' };
    } catch (error: any) {
      /*
       * 409 is the ordinary outcome of losing a race, not a fault. The card
       * is removed either way, because the job is genuinely gone.
       */
      const lost = error?.response?.status === 409 || error?.response?.status === 410;
      set({ offers: get().offers.filter((o) => o.job_id !== jobId) });
      return {
        ok: false,
        message: lost
          ? 'Another rider took this one.'
          : extractErrorMessage(error, 'Could not accept this job.'),
      };
    }
  },

  /**
   * "With Counting & Checked."
   *
   * The job is accepted and the business is told it was checked at the door.
   * The rider is not held: this path has nothing to wait for.
   */
  acceptOfferWithCounting: async (jobId: string) => {
    set({ isSubmittingDoorChoice: true });
    try {
      const response = await riderApi.acceptOfferWithCounting(jobId);
      set({ offers: get().offers.filter((o) => o.job_id !== jobId) });
      await Promise.all([get().refreshJobs(), get().refreshOffers()]);

      /*
       * `messaged` false means the order had no business behind it, or the
       * message could not be written. The job is accepted either way, so this
       * changes the wording and never the outcome.
       */
      const messaged = Boolean(response.data?.messaged);
      return {
        ok: true,
        message: messaged
          ? 'Accepted. The business has been told the order was checked at the door.'
          : 'Accepted.',
      };
    } catch (error: any) {
      const lost = error?.response?.status === 409 || error?.response?.status === 410;
      set({ offers: get().offers.filter((o) => o.job_id !== jobId) });
      return {
        ok: false,
        message: lost
          ? 'Another rider took this one.'
          : extractErrorMessage(error, 'Could not accept this job.'),
      };
    } finally {
      set({ isSubmittingDoorChoice: false });
    }
  },

  /**
   * "Without Counting & Checked."
   *
   * Claims the job and raises the ticket, then puts the rider into the
   * waiting state. `awaitingTicket` is what the dashboard renders the waiting
   * card from, so setting it IS the gate.
   */
  acceptOfferWithoutCounting: async (jobId: string) => {
    set({ isSubmittingDoorChoice: true });
    try {
      const response = await riderApi.acceptOfferWithoutCounting(jobId);
      const ticket = response.data?.ticket || null;

      set({
        offers: get().offers.filter((o) => o.job_id !== jobId),
        awaitingTicket: ticket,
      });
      await Promise.all([get().refreshJobs(), get().refreshOffers()]);

      return {
        ok: true,
        message: 'Ticket raised. Waiting for the business to accept.',
      };
    } catch (error: any) {
      const lost = error?.response?.status === 409 || error?.response?.status === 410;
      set({ offers: get().offers.filter((o) => o.job_id !== jobId) });
      return {
        ok: false,
        message: lost
          ? 'Another rider took this one.'
          : extractErrorMessage(error, 'Could not raise a ticket for this job.'),
      };
    } finally {
      set({ isSubmittingDoorChoice: false });
    }
  },

  /**
   * One poll of the ticket being waited on.
   *
   * Deliberately silent on failure: this runs on a timer, and a dropped
   * request on a moving phone is ordinary. The next tick tries again rather
   * than putting an error in front of a rider who can do nothing about it.
   */
  pollAwaitingTicket: async () => {
    const current = get().awaitingTicket;
    if (!current) return { accepted: false };

    try {
      const response = await riderApi.getDoorTicket(current.ticket_id);
      const ticket = response.data;
      if (!ticket) return { accepted: false };

      if (ticket.status === 'ACCEPTED') {
        set({ awaitingTicket: { ...ticket } });
        return { accepted: true };
      }

      return { accepted: false };
    } catch {
      return { accepted: false };
    }
  },

  refreshDoorTickets: async () => {
    try {
      const response = await riderApi.getPendingDoorTickets();
      const pending = response.data || [];

      /*
       * Only ADOPTS a ticket; never clears one. Clearing here would race the
       * acceptance poll — a ticket that has just been accepted is no longer
       * pending, and dropping it would take the rider's "accepted" card away
       * before they saw it.
       */
      if (!get().awaitingTicket && pending.length > 0) {
        set({ awaitingTicket: pending[0] });
      }
    } catch {
      // Silent: the dashboard is still usable without the wait restored.
    }
  },

  clearAwaitingTicket: () => set({ awaitingTicket: null }),

  /**
   * Park the offer instead of answering yes or no.
   *
   * The card leaves the offers list and reappears under "On hold", so the
   * rider can see they still owe it once the bike is empty.
   */
  holdOffer: async (jobId: string) => {
    set({ offers: get().offers.filter((o) => o.job_id !== jobId) });
    try {
      await riderApi.holdOffer(jobId);
      await get().refreshHeld();
      return { ok: true, message: 'Held for you' };
    } catch (error: any) {
      const lost = error?.response?.status === 409 || error?.response?.status === 410;
      return {
        ok: false,
        message: lost
          ? 'Another rider took this one.'
          : extractErrorMessage(error, 'Could not hold this job.'),
      };
    }
  },

  refreshHeld: async () => {
    try {
      const response = await riderApi.getHeldJobs();
      set({ heldJobs: response.data || [] });
    } catch {
      // Same reasoning as refreshOffers: the next poll is seconds away.
    }
  },

  startHeldJob: async (jobId: string) => {
    try {
      await riderApi.startHeldJob(jobId);
      await Promise.all([get().refreshHeld(), get().refreshJobs()]);
      return { ok: true, message: 'Job started' };
    } catch (error: any) {
      return { ok: false, message: extractErrorMessage(error, 'Could not start this job.') };
    }
  },

  /** Empties the bike: every collected pickup is dropped at the facility. */
  dropAtFacility: async () => {
    try {
      const response = await riderApi.dropAtFacility();
      await get().loadDashboard();
      return {
        ok: true,
        message: `Dropped ${response.data.dropped} pickup(s) at the facility`,
      };
    } catch (error: any) {
      return { ok: false, message: extractErrorMessage(error, 'Could not record the drop-off.') };
    }
  },

  declineOffer: async (jobId: string) => {
    set({ offers: get().offers.filter((o) => o.job_id !== jobId) });
    try {
      await riderApi.declineOffer(jobId);
    } catch {
      // The card is gone from this phone either way.
    }
  },

  startWatch: () => {
    if (get().isWatching) return;

    locationTimer = setInterval(async () => {
      const position = await currentPosition();
      if (!position) return;
      try {
        const { latitude, longitude, accuracy } = position.coords;
        await riderApi.pingLocation(
          latitude,
          longitude,
          typeof accuracy === 'number' ? accuracy : undefined
        );
      } catch {
        // A dropped ping is recoverable; the next one is twenty seconds away.
      }
    }, LOCATION_PING_MS);

    offerTimer = setInterval(() => {
      void get().refreshOffers();
    }, OFFER_POLL_MS);

    set({ isWatching: true });
  },

  stopWatch: () => {
    if (locationTimer) clearInterval(locationTimer);
    if (offerTimer) clearInterval(offerTimer);
    locationTimer = null;
    offerTimer = null;
    announcedOffers = new Set();
    set({ isWatching: false });
  },

  reset: () => {
    get().stopWatch();
    set({
      profile: null,
      summary: null,
      offers: [],
      activeJobs: [],
      heldJobs: [],
      isLoading: false,
      isTogglingDuty: false,
      error: null,
      awaitingTicket: null,
      isSubmittingDoorChoice: false,
    });
  },
}));

export default useRiderStore;
