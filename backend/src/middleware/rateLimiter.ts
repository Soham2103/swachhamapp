import rateLimit from 'express-rate-limit';

/**
 * The auth limiter's ceiling, overridable by environment.
 *
 * The DEFAULT IS UNCHANGED at 10 attempts per 15 minutes, so a deployment
 * that sets nothing behaves exactly as it did. The variable exists so an
 * end-to-end test can drive dozens of sign-ins in a row against a throwaway
 * server without the limiter — which is doing its job — masking the result.
 *
 * It is read once at startup and never from a request, so nothing a caller
 * sends can raise its own limit.
 */
const AUTH_MAX_ATTEMPTS = Math.max(
  1,
  parseInt(process.env.AUTH_RATE_LIMIT_MAX || '10', 10) || 10
);

/** The general limiter's ceiling. Default unchanged at 100 per 15 minutes. */
const GENERAL_MAX_REQUESTS = Math.max(
  1,
  parseInt(process.env.RATE_LIMIT_MAX || '100', 10) || 100
);

const rateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: GENERAL_MAX_REQUESTS,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many requests, please try again after 15 minutes',
  },
  skipSuccessfulRequests: false,
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: AUTH_MAX_ATTEMPTS,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many authentication attempts, please try again after 15 minutes',
  },
  skipSuccessfulRequests: false,
});

export { rateLimiter, authLimiter };
