import { Router, Response, NextFunction } from 'express';
import {
  getOrCreateProfile,
  updateProfile,
  setOnlineStatus,
  updateLocation,
  listOffers,
  listJobs,
  getJobDetail,
  updateJobStatus,
  completeJob,
  dropAtFacility,
  listHeldJobs,
  startHeldJob,
  releaseHeldJob,
  releaseJob,
  getSummary,
} from '../services/rider.service';
import { acceptJob, declineJob, holdJob } from '../services/dispatch.service';
import { sendSuccess } from '../utils/response';
import { authenticate, authorize, AuthenticatedRequest } from '../middleware/auth';
import { AppError } from '../utils/appError';

/**
 * Rider endpoints.
 *
 * Authentication and the RIDER role are applied once at router level, exactly
 * as the Sorter module does: no token is a 401, any other role a 403. Nothing
 * here relies on the app hiding a screen.
 *
 * Every route derives the rider from the token — `req.user.id` — and never
 * from the body or a path parameter. A rider therefore cannot read or move
 * another rider's job by naming their id, because there is nowhere to name it.
 */
const router = Router();
router.use(authenticate);
router.use(authorize('RIDER'));

/** The signed-in rider, from the token alone. */
function riderId(req: AuthenticatedRequest): string {
  const id = req.user?.id;
  if (!id) throw new AppError('Rider session missing', 401);
  return String(id);
}

// ======================================================
// PROFILE AND DUTY STATE
// ======================================================

router.get('/me', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    return sendSuccess(res, await getOrCreateProfile(riderId(req)), 'Rider profile');
  } catch (error) {
    return next(error);
  }
});

router.put('/me', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const updated = await updateProfile(riderId(req), {
      vehicle_type: req.body?.vehicle_type,
      vehicle_number: req.body?.vehicle_number,
      license_number: req.body?.license_number,
    });
    return sendSuccess(res, updated, 'Profile updated');
  } catch (error) {
    return next(error);
  }
});

/**
 * Go on or off duty.
 *
 * Going online carries the rider's position in the same request — see
 * `setOnlineStatus` for why a fix is required rather than optional.
 */
router.post('/duty', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const online = req.body?.online;
    if (typeof online !== 'boolean') {
      throw new AppError('online must be true or false', 400);
    }

    const profile = await setOnlineStatus(
      riderId(req),
      online,
      online
        ? {
            latitude: Number(req.body?.latitude),
            longitude: Number(req.body?.longitude),
            accuracy: Number(req.body?.accuracy),
          }
        : undefined
    );

    return sendSuccess(res, profile, online ? 'You are now online' : 'You are now offline');
  } catch (error) {
    return next(error);
  }
});

/** A position ping while on duty. */
router.post('/location', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const result = await updateLocation(
      riderId(req),
      Number(req.body?.latitude),
      Number(req.body?.longitude),
      req.body?.accuracy === undefined ? undefined : Number(req.body.accuracy)
    );
    return sendSuccess(res, result, 'Location updated');
  } catch (error) {
    return next(error);
  }
});

// ======================================================
// OFFERS — jobs waiting for an answer
// ======================================================

router.get('/offers', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    return sendSuccess(res, await listOffers(riderId(req)), 'Open offers');
  } catch (error) {
    return next(error);
  }
});

/**
 * Take the job. First rider to get here wins; everyone else gets a 409.
 */
router.post(
  '/offers/:jobId/accept',
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const job = await acceptJob(String(req.params.jobId), riderId(req));
      return sendSuccess(res, job, 'Job accepted');
    } catch (error) {
      return next(error);
    }
  }
);

/**
 * The third answer: "I want this, but I am full."
 *
 * Reserves the job for this rider instead of passing it on, so a loaded
 * rider ten minutes from the facility does not have to give up the pickup on
 * their own doorstep to someone twice as far away.
 */
router.post(
  '/offers/:jobId/hold',
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const job = await holdJob(String(req.params.jobId), riderId(req));
      return sendSuccess(res, job, 'Job held for you');
    } catch (error) {
      return next(error);
    }
  }
);

router.post(
  '/offers/:jobId/decline',
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      await declineJob(String(req.params.jobId), riderId(req));
      return sendSuccess(res, null, 'Offer declined');
    } catch (error) {
      return next(error);
    }
  }
);

// ======================================================
// JOBS — work the rider is carrying
// ======================================================

router.get('/jobs', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const scope = req.query.scope === 'completed' ? 'completed' : 'active';
    return sendSuccess(res, await listJobs(riderId(req), scope), 'Rider jobs');
  } catch (error) {
    return next(error);
  }
});

router.get('/jobs/:jobId', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    return sendSuccess(
      res,
      await getJobDetail(riderId(req), String(req.params.jobId)),
      'Job detail'
    );
  } catch (error) {
    return next(error);
  }
});

/** ASSIGNED -> EN_ROUTE -> ARRIVED. Completing needs the handover code. */
router.patch(
  '/jobs/:jobId/status',
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const status = String(req.body?.status || '').toUpperCase();
      const job = await updateJobStatus(riderId(req), String(req.params.jobId), status);
      return sendSuccess(res, job, `Job marked ${status}`);
    } catch (error) {
      return next(error);
    }
  }
);

/**
 * Close the handover with the code the customer or establishment reads out.
 */
router.post(
  '/jobs/:jobId/complete',
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const job = await completeJob(
        riderId(req),
        String(req.params.jobId),
        String(req.body?.handover_code || ''),
        req.body?.notes
      );
      return sendSuccess(res, job, 'Handover confirmed');
    } catch (error) {
      return next(error);
    }
  }
);

/** Give the job back so someone else can take it. */
router.post(
  '/jobs/:jobId/release',
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      await releaseJob(riderId(req), String(req.params.jobId), req.body?.reason);
      return sendSuccess(res, null, 'Job released and re-offered');
    } catch (error) {
      return next(error);
    }
  }
);

// ======================================================
// HELD JOBS — parked until the rider has room
// ======================================================

router.get('/held', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    return sendSuccess(res, await listHeldJobs(riderId(req)), 'Jobs on hold');
  } catch (error) {
    return next(error);
  }
});

/** Unloaded and coming back for it. */
router.post(
  '/held/:jobId/start',
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const job = await startHeldJob(riderId(req), String(req.params.jobId));
      return sendSuccess(res, job, 'Job started');
    } catch (error) {
      return next(error);
    }
  }
);

/** Give it up rather than wait for the reclaim timer. */
router.post(
  '/held/:jobId/release',
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      await releaseHeldJob(riderId(req), String(req.params.jobId));
      return sendSuccess(res, null, 'Job released to other riders');
    } catch (error) {
      return next(error);
    }
  }
);

// ======================================================
// FACILITY DROP — what actually ends a pickup
// ======================================================

/**
 * The bags reach the facility and come off the bike.
 *
 * Optional `job_ids` drops a subset; with none, everything the rider is
 * carrying is dropped, which is the usual case — a rider empties the bike in
 * one go at the end of a round.
 */
router.post('/drop-off', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const ids = Array.isArray(req.body?.job_ids) ? req.body.job_ids.map(String) : undefined;
    const result = await dropAtFacility(riderId(req), ids);
    return sendSuccess(res, result, `Dropped ${result.dropped} pickup(s) at the facility`);
  } catch (error) {
    return next(error);
  }
});

// ======================================================
// DASHBOARD
// ======================================================

router.get('/summary', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    return sendSuccess(res, await getSummary(riderId(req)), 'Rider summary');
  } catch (error) {
    return next(error);
  }
});

export default router;
