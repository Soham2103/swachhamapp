import { Router, Response, NextFunction } from 'express';
import { authenticate, AuthenticatedRequest } from '../middleware/auth';
import { sendSuccess } from '../utils/response';
import { AppError } from '../utils/appError';
import { registerToken, unregisterToken, isPushConfigured } from '../services/push.service';

const router = Router();

/**
 * Device registration for push notifications.
 *
 * WHOSE DEVICE IT IS COMES FROM THE TOKEN, NEVER FROM THE BODY. A caller
 * cannot register a handset against somebody else's account, because the
 * account is taken from the verified JWT: a BUSINESS session's `id` is the
 * `business_users` row it signed in as, and every other role's is a `users`
 * row. That is the same split `push_tokens` stores.
 */
router.use(authenticate);

/** A BUSINESS session's subject is a business_users row, not a users row. */
function ownerFor(req: AuthenticatedRequest) {
  if (!req.user) throw new AppError('Not authenticated', 401);
  return req.user.role === 'BUSINESS'
    ? { businessUserId: String(req.user.id) }
    : { userId: String(req.user.id) };
}

/**
 * POST /api/push/token
 *   { token, platform?, deviceName? }
 *
 * Called after sign-in and whenever FCM rotates the token. Registering the
 * same token again is normal and simply refreshes it.
 */
router.post('/token', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const token = String(req.body?.token || '').trim();
    if (!token) throw new AppError('A device token is required', 400);
    if (token.length > 512) throw new AppError('That device token is not a valid FCM token', 400);

    await registerToken({
      owner: ownerFor(req),
      token,
      platform: req.body?.platform,
      deviceName: req.body?.deviceName ?? req.body?.device_name ?? null,
    });

    /*
     * `pushConfigured` tells the app whether the SERVER can send at all, so a
     * developer can see "registered, but push is off" instead of wondering
     * why nothing arrives. It is a boolean and nothing more — no project id,
     * no key, nothing that would leak the credential.
     */
    sendSuccess(
      res,
      { registered: true, pushConfigured: isPushConfigured() },
      'Device registered for notifications'
    );
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/push/token
 *   { token }
 *
 * Called on sign-out, so a shared handset stops receiving the previous
 * account's notifications.
 */
router.delete('/token', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const token = String(req.body?.token || '').trim();
    if (!token) throw new AppError('A device token is required', 400);
    await unregisterToken(token);
    sendSuccess(res, { registered: false }, 'Device removed from notifications');
  } catch (error) {
    next(error);
  }
});

export default router;
