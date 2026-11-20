import type { RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';
import { HttpError } from '../../lib/http-error.js';
import { DEFAULT_UPLOAD_LIMITS, type UploadLimits } from '../images/image-processing.js';

/*
 * What differs between a normal deployment and the public demo (DEMO_MODE=true), decided in one
 * place. The demo is one shared database that anyone can sign in to with "Try the demo"; these
 * limits keep one visitor from filling it or the server's memory, and the nightly reset
 * (deploy/demo-reset.sh) brings the made-up data back. src/app.ts assembles the app from the
 * profile without asking which kind of deployment it is.
 */

const MB = 1024 * 1024;

/** The demo's photo uploads: enough to try the photo manager, little to abuse. */
export const DEMO_UPLOAD_LIMITS: Readonly<UploadLimits> = Object.freeze({
  maxFileBytes: 5 * MB,
  maxFilesPerRequest: 5,
  maxPerProperty: 12,
});

/** Properties (not waiting to be deleted) the demo may hold before a create answers 409. */
export const DEMO_MAX_PROPERTIES = 50;

export interface DemoRateLimitOptions {
  /** Length of the counting window in milliseconds (default 15 minutes). */
  windowMs?: number;
  /** /api requests per client IP and window, reads included (default 900). */
  requests?: number;
  /** Requests that change something (not GET, HEAD or OPTIONS) per IP and window (default 120). */
  writes?: number;
  /** "Try the demo" sign-ins per IP and window (default 20). */
  logins?: number;
  /** New properties per IP and hour (default 10), so one visitor cannot fill the demo. */
  createsPerHour?: number;
}

/**
 * The defaults allow an hour-long visit at the admin panel's polling rate (a request every few
 * seconds while jobs are in flight) and a few dozen edits, but not a script.
 */
export const DEMO_RATE_LIMIT_DEFAULTS = {
  windowMs: 15 * 60 * 1000,
  requests: 900,
  writes: 120,
  logins: 20,
  createsPerHour: 10,
} as const;

const HOUR_MS = 60 * 60 * 1000;
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface DeploymentProfile {
  /** The public demo: GET /api/client-config tells the admin panel to show the banner. */
  demoMode: boolean;
  uploadLimits: Readonly<UploadLimits>;
  /** Properties the database may hold (null: no limit). */
  maxProperties: number | null;
  /** Whether /feeds serves the feeds; closed on the demo, so no portal can import its listings. */
  feedsOpen: boolean;
  /** Middleware in front of every /api route: the demo's per-IP limits. */
  apiGuards: RequestHandler[];
  /** The rate limit of POST /api/auth/demo, or null where there is no demo sign-in. */
  demoLoginGuard: RequestHandler | null;
}

/** A normal deployment: the API's own limits, open feeds, no demo sign-in. */
export const STANDARD_PROFILE: DeploymentProfile = Object.freeze({
  demoMode: false,
  uploadLimits: DEFAULT_UPLOAD_LIMITS,
  maxProperties: null,
  feedsOpen: true,
  apiGuards: [],
  demoLoginGuard: null,
});

/** The profile for DEMO_MODE (or not); the rate limits are fresh counters each call. */
export function deploymentProfile(
  demoMode: boolean,
  rateLimit: DemoRateLimitOptions = {},
): DeploymentProfile {
  if (!demoMode) return STANDARD_PROFILE;
  const limits = { ...DEMO_RATE_LIMIT_DEFAULTS, ...rateLimit };
  const { windowMs } = limits;
  return {
    demoMode: true,
    uploadLimits: DEMO_UPLOAD_LIMITS,
    maxProperties: DEMO_MAX_PROPERTIES,
    feedsOpen: false,
    apiGuards: [
      // Every request except the health check (Docker's and uptime monitors' checks).
      perIpLimit('demo', windowMs, limits.requests, 'requests', (req) => req.path === '/health'),
      perIpLimit('demo-writes', windowMs, limits.writes, 'changes', (req) =>
        READ_METHODS.has(req.method),
      ),
      perIpLimit(
        'demo-creates',
        HOUR_MS,
        limits.createsPerHour,
        'new properties',
        (req) => !(req.method === 'POST' && req.path === '/properties'),
      ),
    ],
    demoLoginGuard: perIpLimit('demo-login', windowMs, limits.logins, 'demo sign-ins', () => false),
  };
}

/**
 * A per-IP limit, counted in memory by this API process (the demo runs one). Behind the reverse
 * proxy, TRUST_PROXY must name it, or every visitor shares the proxy's address.
 */
function perIpLimit(
  identifier: string,
  windowMs: number,
  limit: number,
  what: string,
  skip: (req: { method: string; path: string }) => boolean,
): RequestHandler {
  const minutes = Math.max(1, Math.ceil(windowMs / 60_000));
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    identifier,
    skip,
    handler: (_req, _res, next) => {
      next(
        new HttpError(
          429,
          'TOO_MANY_REQUESTS',
          `Too many ${what} from your address in this demo. Try again in up to ${minutes} minute${minutes === 1 ? '' : 's'}.`,
        ),
      );
    },
  });
}
