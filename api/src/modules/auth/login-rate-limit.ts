import { rateLimit, type RateLimitRequestHandler } from 'express-rate-limit';
import { HttpError } from '../../lib/http-error.js';

export interface LoginRateLimitOptions {
  /** Length of the counting window in milliseconds (default 15 minutes). */
  windowMs?: number;
  /** Attempts allowed per client IP in one window (default 10). */
  limit?: number;
}

export const LOGIN_RATE_LIMIT_DEFAULTS = { windowMs: 15 * 60 * 1000, limit: 10 } as const;

/**
 * Limits login attempts per client IP (IPv6 clients are grouped by /56 subnet), counting
 * successful and failed attempts alike. Sends the IETF RateLimit / RateLimit-Policy
 * headers and, once the limit is hit, Retry-After plus a 429 TOO_MANY_REQUESTS error.
 *
 * The counters live in memory, per API process. Behind a reverse proxy, TRUST_PROXY must
 * be set or every client shares the proxy's address.
 */
export function createLoginRateLimiter(
  options: LoginRateLimitOptions = {},
): RateLimitRequestHandler {
  const { windowMs, limit } = { ...LOGIN_RATE_LIMIT_DEFAULTS, ...options };
  const minutes = Math.max(1, Math.ceil(windowMs / 60_000));

  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    identifier: 'login',
    handler: (_req, _res, next) => {
      next(
        new HttpError(
          429,
          'TOO_MANY_REQUESTS',
          `Too many login attempts. Try again in up to ${minutes} minute${minutes === 1 ? '' : 's'}.`,
        ),
      );
    },
  });
}
