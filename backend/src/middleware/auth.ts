import {
  Request,
  Response,
  NextFunction,
} from 'express';

import {
  verifyAccessToken,
  TokenPayload,
} from '../utils/jwt';

import {
  sendError,
} from '../utils/response';

import {
  logger,
} from '../utils/logger';


export interface AuthenticatedRequest
  extends Request {
  user?: TokenPayload;
}


/**
 * =====================================================
 * AUTHENTICATE
 * =====================================================
 *
 * Verifies the JWT access token and attaches
 * the authenticated user to req.user.
 */
function authenticate(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  try {

    const authHeader =
      req.headers.authorization;

    if (
      !authHeader ||
      !authHeader.startsWith('Bearer ')
    ) {
      sendError(
        res,
        'Authorization header missing or malformed',
        401
      );

      return;
    }


    const token =
      authHeader.split(' ')[1];

    if (!token) {
      sendError(
        res,
        'Bearer token not provided',
        401
      );

      return;
    }


    const decoded =
      verifyAccessToken(token);


    req.user = {
      id: decoded.id,
      email: decoded.email,
      role: decoded.role,
      /*
       * THE NUMBER THIS SESSION WAS PROVEN ON, carried through.
       *
       * The token has always carried it -- it is set from the number that
       * actually passed the OTP, which for a business is whichever contact
       * signed in and not necessarily the account's own. Dropping it here
       * meant every consumer saw `undefined`, and an order stamped with it
       * recorded NULL. It is copied across so `orders.placed_by_mobile` can
       * be taken from the session rather than from the request body.
       *
       * Absent on sessions minted before the claim existed, and on the
       * password-only logins that never prove a number; readers must treat
       * it as optional rather than assuming one is always present.
       */
      mobile: decoded.mobile,
    };


    logger.debug(
      `[Auth] Authenticated user: ${decoded.id} (${decoded.role})`
    );


    next();

  } catch (error) {

    const message =
      (error as Error).message ||
      'Authentication failed';


    logger.warn(
      `[Auth] Authentication failed: ${message}`
    );


    sendError(
      res,
      message,
      401
    );
  }
}


/**
 * =====================================================
 * AUTHORIZE
 * =====================================================
 *
 * Supports both:
 *
 * authorize('ADMIN')
 *
 * and:
 *
 * authorize('ADMIN', 'BUSINESS')
 *
 * and:
 *
 * authorize(['ADMIN', 'BUSINESS'])
 */
function authorize(
  ...roles: (string | string[])[]
) {

  // Flatten the arguments so all of these work:
  //
  // authorize('ADMIN')
  // authorize('ADMIN', 'BUSINESS')
  // authorize(['ADMIN', 'BUSINESS'])

  const allowedRoles =
    roles.flat();


  return (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): void => {

    if (!req.user) {

      sendError(
        res,
        'Unauthorized: user not authenticated',
        401
      );

      return;
    }


    if (
      !allowedRoles.includes(
        req.user.role
      )
    ) {

      logger.warn(
        `[Auth] Access denied for user ${req.user.id} with role ${req.user.role}. Required: ${allowedRoles.join(', ')}`
      );


      sendError(
        res,
        `Forbidden: requires one of roles [${allowedRoles.join(', ')}]`,
        403
      );

      return;
    }


    next();
  };
}


/**
 * =====================================================
 * EXPORTS
 * =====================================================
 */

export {
  authenticate,
  authorize,
  authorize as requireRole,
};