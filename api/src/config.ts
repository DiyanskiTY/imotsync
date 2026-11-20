import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { isIP } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/** Absolute path of the api/ folder. Works from src/ (tsx, Vitest) and from dist/ (compiled). */
export const API_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** The project keeps a single .env file at the repository root, next to docker-compose.yml. */
export const ROOT_ENV_FILE = path.resolve(API_ROOT, '..', '.env');

/** Minimum JWT_SECRET length enforced when NODE_ENV=production. */
export const MIN_PRODUCTION_SECRET_LENGTH = 32;

/** Prefix of the public JWT_SECRET placeholders (.env.example); rejected when NODE_ENV=production. */
export const PUBLIC_SECRET_PREFIX = 'dev-only';

const port = z.coerce.number().int().min(1).max(65_535);

const origin = z
  .string()
  .regex(/^https?:\/\/[^/\s]+$/, 'must be an origin such as http://localhost:4200 (no path)');

/** JOB_LOCK_TIMEOUT_SECONDS must exceed JOB_TIMEOUT_SECONDS by at least this much. */
export const JOB_LOCK_MARGIN_SECONDS = 60;

/** Host names that only reach the machine itself. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '0.0.0.0']);

/** Whether an origin (scheme://host[:port]) points at this machine only. */
function isLoopbackOrigin(value: string): boolean {
  const host = new URL(value).hostname.toLowerCase();
  return LOOPBACK_HOSTS.has(host) || host.endsWith('.localhost') || host.startsWith('127.');
}

/** An integer environment variable within a range, with a default. */
const intIn = (min: number, max: number, fallback: number) =>
  z.coerce.number().int().min(min).max(max).default(fallback);

/** FEED_TOKEN is a path segment of the public feed URLs, so it is limited to URL-safe characters. */
const FEED_TOKEN_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

/** Public placeholder for FEED_TOKEN (like the JWT_SECRET one); refused when NODE_ENV=production. */
export const DEFAULT_FEED_TOKEN = 'dev-only-feed-token';

/** What PUBLIC_LISTING_URL_TEMPLATE replaces with the property's reference code. */
export const REF_CODE_PLACEHOLDER = '{refCode}';

/** An http(s) URL with a path, e.g. https://agency.example/properties/{refCode}. */
const LISTING_URL_PATTERN = /^https?:\/\/[^/\s]+\/\S*$/;

/** Default lifetime of a login token: 8 hours, one working day. */
export const DEFAULT_JWT_TTL_SECONDS = 8 * 60 * 60;

/**
 * Express' 'trust proxy' setting, in the forms an environment variable can express:
 * false (no proxy), true (trust every hop; refused when NODE_ENV=production), the number
 * of proxies in front of the API, or a list of proxy addresses / subnets / presets
 * ('loopback', 'uniquelocal', ...).
 */
export type TrustProxy = boolean | number | string[];

const PROXY_PRESETS = new Set(['loopback', 'linklocal', 'uniquelocal']);

/** "loopback", "10.0.0.1", "10.0.0.0/8" or "fd00::/8". */
function isProxyAddress(value: string): boolean {
  if (PROXY_PRESETS.has(value)) return true;
  const [address = '', prefix, ...rest] = value.split('/');
  const version = isIP(address);
  if (version === 0 || rest.length > 0) return false;
  if (prefix === undefined) return true;
  return /^\d{1,3}$/.test(prefix) && Number(prefix) <= (version === 4 ? 32 : 128);
}

const trustProxy = z
  .string()
  .default('false')
  .transform((raw, ctx): TrustProxy => {
    const value = raw.trim();
    const lower = value.toLowerCase();
    if (lower === 'false' || lower === '') return false;
    if (lower === 'true') return true;
    if (/^\d{1,2}$/.test(value)) return Number(value);
    const items = value
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    if (items.length > 0 && items.every(isProxyAddress)) return items;
    ctx.addIssue({
      code: 'custom',
      input: raw,
      message:
        "must be false, true, a number of proxy hops (e.g. 1), or a comma-separated list of proxy addresses or subnets (e.g. 'loopback' or '10.0.0.0/8')",
    });
    return z.NEVER;
  });

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    API_PORT: port.default(3000),
    // Comma-separated list of browser origins allowed to call the API.
    CORS_ORIGIN: z
      .string()
      .default('http://localhost:4200')
      .transform((value) =>
        value
          .split(',')
          .map((item) => item.trim())
          .filter((item) => item.length > 0),
      )
      .pipe(z.array(origin).min(1, 'must list at least one origin')),
    JWT_SECRET: z.string({ error: 'is required' }).min(1, 'is required'),
    // Lifetime of a login token in seconds (1 minute to 30 days).
    JWT_TTL_SECONDS: z.coerce
      .number()
      .int()
      .min(60)
      .max(30 * 24 * 60 * 60)
      .default(DEFAULT_JWT_TTL_SECONDS),
    // Set when the API runs behind a reverse proxy, so req.ip (and the login rate limit)
    // sees the client's address instead of the proxy's.
    TRUST_PROXY: trustProxy,
    UPLOAD_DIR: z.string().min(1).default('./uploads'),
    DB_HOST: z.string().min(1).default('127.0.0.1'),
    DB_PORT: port.default(3307),
    DB_NAME: z.string().min(1).default('imotsync'),
    DB_USER: z.string({ error: 'is required' }).min(1, 'is required'),
    DB_PASSWORD: z.string({ error: 'is required' }),
    SEED_DEMO_PASSWORD: z.string().min(8).default('demo1234'),
    ALLOW_DEMO_SEED: z.stringbool().default(false),
    // Lets NODE_ENV=production run with an http:// or local PUBLIC_BASE_URL: only for local
    // runs of the production build (the Docker Compose stack, CI), never for a real server.
    ALLOW_INSECURE_PUBLIC_BASE_URL: z.stringbool().default(false),
    // The public demo: a shared demo login, lower limits and no feeds (README, Demo mode).
    DEMO_MODE: z.stringbool().default(false),

    // --- Publishing ---
    // The origin portals reach this server at: photo URLs in feeds are PUBLIC_BASE_URL + /uploads/...
    PUBLIC_BASE_URL: origin.default('http://localhost:3000'),
    // Secret path segment of the public feed URLs (/feeds/<portal>/<FEED_TOKEN>.xml).
    FEED_TOKEN: z
      .string()
      .regex(FEED_TOKEN_PATTERN, 'must be 8 to 128 characters: letters, digits, "-" or "_"')
      .default(DEFAULT_FEED_TOKEN),
    WORKER_CONCURRENCY: intIn(1, 16, 2),
    WORKER_POLL_INTERVAL_MS: intIn(100, 60_000, 1000),
    // Time budget for one adapter call.
    JOB_TIMEOUT_SECONDS: intIn(1, 3600, 60),
    // A running job locked longer than this is considered abandoned (its worker crashed).
    JOB_LOCK_TIMEOUT_SECONDS: intIn(2, 86_400, 300),
    RETRY_BASE_SECONDS: intIn(1, 86_400, 30),
    RETRY_CAP_SECONDS: intIn(1, 7 * 86_400, 3600),
    DEMO_PORTAL_FAILURE_RATE: z.coerce.number().min(0).max(1).default(0.3),
    DEMO_PORTAL_LATENCY_MS: intIn(0, 60_000, 400),
    REALISTIMO_AGENCY_UID: z
      .string()
      .trim()
      .min(1, 'must not be empty')
      .max(100)
      .default('imotsync-demo'),
    // Empty: the optional Realistimo REST sync (import trigger and import log) is off.
    REALISTIMO_API_KEY: z.string().trim().default(''),
    REALISTIMO_API_BASE_URL: origin.default('https://realistimo.com'),
    REALISTIMO_SYNC_INTERVAL_SECONDS: intIn(60, 86_400, 900),
    // How long a removed listing stays in the Bazar feed, marked out of stock.
    BAZAR_REMOVED_RETENTION_DAYS: intIn(1, 365, 30),
    // Optional public page of a listing, e.g. https://agency.example/properties/{refCode}.
    PUBLIC_LISTING_URL_TEMPLATE: z
      .string()
      .trim()
      .default('')
      .refine(
        (value) =>
          value === '' || (LISTING_URL_PATTERN.test(value) && value.includes(REF_CODE_PLACEHOLDER)),
        `must be empty or an http(s) URL that contains ${REF_CODE_PLACEHOLDER}`,
      ),
  })
  .superRefine((env, ctx) => {
    if (env.RETRY_CAP_SECONDS < env.RETRY_BASE_SECONDS) {
      ctx.addIssue({
        code: 'custom',
        path: ['RETRY_CAP_SECONDS'],
        message: `must not be less than RETRY_BASE_SECONDS (${env.RETRY_BASE_SECONDS})`,
      });
    }
    // Otherwise the stale-lock sweep could hand a job that is still running to a second
    // worker: a job holds its lock for the adapter call (JOB_TIMEOUT_SECONDS) plus the time
    // to load the property, record the outcome (lock waits, retried transactions) and, on a
    // stop, the grace period.
    if (env.JOB_LOCK_TIMEOUT_SECONDS < env.JOB_TIMEOUT_SECONDS + JOB_LOCK_MARGIN_SECONDS) {
      ctx.addIssue({
        code: 'custom',
        path: ['JOB_LOCK_TIMEOUT_SECONDS'],
        message: `must be at least JOB_TIMEOUT_SECONDS + ${JOB_LOCK_MARGIN_SECONDS} (${
          env.JOB_TIMEOUT_SECONDS + JOB_LOCK_MARGIN_SECONDS
        })`,
      });
    }

    // The demo's listings are made up: the one outbound portal call (the Realistimo import
    // sync) must stay off, whatever else the environment says.
    if (env.DEMO_MODE && env.REALISTIMO_API_KEY !== '') {
      ctx.addIssue({
        code: 'custom',
        path: ['REALISTIMO_API_KEY'],
        message: 'must be empty when DEMO_MODE=true: the demo never talks to a real portal',
      });
    }

    if (env.NODE_ENV !== 'production') return;
    // Portals download the feeds and the photos from PUBLIC_BASE_URL: it must be a public
    // HTTPS origin (the feed URL carries FEED_TOKEN, and Realistimo requires HTTPS).
    if (
      !env.ALLOW_INSECURE_PUBLIC_BASE_URL &&
      (!env.PUBLIC_BASE_URL.startsWith('https://') || isLoopbackOrigin(env.PUBLIC_BASE_URL))
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['PUBLIC_BASE_URL'],
        message:
          'must be the public https:// origin of the API when NODE_ENV=production (not http://, localhost or 127.0.0.1); for a local run of the production build only, set ALLOW_INSECURE_PUBLIC_BASE_URL=true',
      });
    }
    // The API key goes in a request header: never in clear text.
    if (!env.REALISTIMO_API_BASE_URL.startsWith('https://')) {
      ctx.addIssue({
        code: 'custom',
        path: ['REALISTIMO_API_BASE_URL'],
        message: 'must be an https:// origin when NODE_ENV=production',
      });
    }
    if (env.JWT_SECRET.length < MIN_PRODUCTION_SECRET_LENGTH) {
      ctx.addIssue({
        code: 'custom',
        path: ['JWT_SECRET'],
        message: `must be at least ${MIN_PRODUCTION_SECRET_LENGTH} characters when NODE_ENV=production`,
      });
    }
    // The placeholder in .env.example is public, so it must never sign real tokens.
    if (env.JWT_SECRET.startsWith(PUBLIC_SECRET_PREFIX)) {
      ctx.addIssue({
        code: 'custom',
        path: ['JWT_SECRET'],
        message: `is the public '${PUBLIC_SECRET_PREFIX}...' placeholder; generate a real one with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`,
      });
    }
    // The feeds are public URLs: whoever knows the token can read every listing in them.
    if (env.FEED_TOKEN.length < MIN_PRODUCTION_SECRET_LENGTH) {
      ctx.addIssue({
        code: 'custom',
        path: ['FEED_TOKEN'],
        message: `must be at least ${MIN_PRODUCTION_SECRET_LENGTH} characters when NODE_ENV=production`,
      });
    }
    if (env.FEED_TOKEN.startsWith(PUBLIC_SECRET_PREFIX)) {
      ctx.addIssue({
        code: 'custom',
        path: ['FEED_TOKEN'],
        message: `is the public '${PUBLIC_SECRET_PREFIX}...' placeholder; generate a real one with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`,
      });
    }
    // With true, req.ip is the left-most X-Forwarded-For entry, which the client writes
    // itself: a new value per request would give every login attempt a fresh rate limit.
    if (env.TRUST_PROXY === true) {
      ctx.addIssue({
        code: 'custom',
        path: ['TRUST_PROXY'],
        message:
          "must not be true when NODE_ENV=production; set the number of proxies in front of the API (e.g. 1) or their addresses or subnets (e.g. 'loopback' or '10.0.0.0/8')",
      });
    }
  });

export type NodeEnv = 'development' | 'test' | 'production';

export interface DbConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

export interface WorkerConfig {
  /** Jobs one worker process runs at the same time (WORKER_CONCURRENCY). */
  concurrency: number;
  /** Pause between polls while no job is due (WORKER_POLL_INTERVAL_MS). */
  pollIntervalMs: number;
  /** Time budget for one adapter call (JOB_TIMEOUT_SECONDS). */
  jobTimeoutSeconds: number;
  /** A job running longer than this is abandoned and swept (JOB_LOCK_TIMEOUT_SECONDS). */
  lockTimeoutSeconds: number;
}

export interface RetryConfig {
  /** Delay before the second attempt, before jitter (RETRY_BASE_SECONDS). */
  baseSeconds: number;
  /** Longest delay between two attempts, before jitter (RETRY_CAP_SECONDS). */
  capSeconds: number;
}

export interface PortalsConfig {
  /** PUBLIC_LISTING_URL_TEMPLATE, or null; '{refCode}' stands for the reference code. */
  publicListingUrlTemplate: string | null;
  demo: {
    /** Share of calls the demo portal fails, 0 to 1 (DEMO_PORTAL_FAILURE_RATE). */
    failureRate: number;
    /** Simulated response time of the demo portal (DEMO_PORTAL_LATENCY_MS). */
    latencyMs: number;
  };
  realistimo: {
    /** The agency's identifier in the feed (REALISTIMO_AGENCY_UID). */
    agencyUid: string;
    /** REALISTIMO_API_KEY, or null when it is empty, which turns the REST sync off. */
    apiKey: string | null;
    /** REALISTIMO_API_BASE_URL, an origin without a trailing slash. */
    apiBaseUrl: string;
    /** How often the worker runs the REST sync (REALISTIMO_SYNC_INTERVAL_SECONDS). */
    syncIntervalSeconds: number;
  };
  bazar: {
    /** Days a removed listing stays in the feed as out of stock (BAZAR_REMOVED_RETENTION_DAYS). */
    removedRetentionDays: number;
  };
}

export interface Config {
  nodeEnv: NodeEnv;
  isProduction: boolean;
  port: number;
  corsOrigins: string[];
  jwtSecret: string;
  /** Lifetime of a login token, in seconds. */
  jwtTtlSeconds: number;
  /** Passed to app.set('trust proxy'). */
  trustProxy: TrustProxy;
  /** Absolute path; a relative UPLOAD_DIR is resolved from the api/ folder. */
  uploadDir: string;
  db: DbConfig;
  seed: {
    demoPassword: string;
    /** ALLOW_DEMO_SEED: lets the demo seed (and reset) run when NODE_ENV=production. */
    allowInProduction: boolean;
  };
  /**
   * DEMO_MODE: the public demo. Adds the shared demo login, lowers the upload and request
   * limits and closes the feeds, so the made-up listings never reach a portal.
   */
  demoMode: boolean;
  /** PUBLIC_BASE_URL: the origin portals reach this server at, without a trailing slash. */
  publicBaseUrl: string;
  feeds: {
    /** FEED_TOKEN: the secret path segment of /feeds/<portal>/<token>.xml. */
    token: string;
  };
  worker: WorkerConfig;
  retry: RetryConfig;
  portals: PortalsConfig;
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

/**
 * Which process reads the configuration. The worker signs no login tokens and serves no
 * feeds, so it neither needs nor reads JWT_SECRET and FEED_TOKEN: its config gets random
 * values of its own that nothing uses, and it starts without the real secrets.
 */
export type ConfigRole = 'api' | 'worker';

/** A value that passes the production checks and is known to nobody. */
const unusedSecret = () => `unused-${randomBytes(32).toString('hex')}`;

/** Validates environment variables and maps them to a typed config. Pure: no I/O. */
export function parseConfig(
  env: Record<string, string | undefined>,
  role: ConfigRole = 'api',
): Config {
  const input =
    role === 'worker' ? { ...env, JWT_SECRET: unusedSecret(), FEED_TOKEN: unusedSecret() } : env;
  const result = envSchema.safeParse(input);
  if (!result.success) {
    throw new ConfigError(`Invalid environment configuration:\n${z.prettifyError(result.error)}`);
  }
  const e = result.data;
  return {
    nodeEnv: e.NODE_ENV,
    isProduction: e.NODE_ENV === 'production',
    port: e.API_PORT,
    corsOrigins: e.CORS_ORIGIN,
    jwtSecret: e.JWT_SECRET,
    jwtTtlSeconds: e.JWT_TTL_SECONDS,
    trustProxy: e.TRUST_PROXY,
    uploadDir: path.resolve(API_ROOT, e.UPLOAD_DIR),
    db: {
      host: e.DB_HOST,
      port: e.DB_PORT,
      database: e.DB_NAME,
      user: e.DB_USER,
      password: e.DB_PASSWORD,
    },
    seed: {
      demoPassword: e.SEED_DEMO_PASSWORD,
      allowInProduction: e.ALLOW_DEMO_SEED,
    },
    demoMode: e.DEMO_MODE,
    publicBaseUrl: e.PUBLIC_BASE_URL,
    feeds: { token: e.FEED_TOKEN },
    worker: {
      concurrency: e.WORKER_CONCURRENCY,
      pollIntervalMs: e.WORKER_POLL_INTERVAL_MS,
      jobTimeoutSeconds: e.JOB_TIMEOUT_SECONDS,
      lockTimeoutSeconds: e.JOB_LOCK_TIMEOUT_SECONDS,
    },
    retry: { baseSeconds: e.RETRY_BASE_SECONDS, capSeconds: e.RETRY_CAP_SECONDS },
    portals: {
      publicListingUrlTemplate: e.PUBLIC_LISTING_URL_TEMPLATE || null,
      demo: { failureRate: e.DEMO_PORTAL_FAILURE_RATE, latencyMs: e.DEMO_PORTAL_LATENCY_MS },
      realistimo: {
        agencyUid: e.REALISTIMO_AGENCY_UID,
        apiKey: e.REALISTIMO_API_KEY || null,
        apiBaseUrl: e.REALISTIMO_API_BASE_URL,
        syncIntervalSeconds: e.REALISTIMO_SYNC_INTERVAL_SECONDS,
      },
      bazar: { removedRetentionDays: e.BAZAR_REMOVED_RETENTION_DAYS },
    },
  };
}

/**
 * Loads the repository-root .env file into process.env when it exists.
 * Variables that are already set (shell, Docker, CI) always win over the file.
 */
export function loadRootEnvFile(file: string = ROOT_ENV_FILE): void {
  if (existsSync(file)) {
    process.loadEnvFile(file);
  }
}

/** Reads the root .env file (if any) and returns the validated config. */
export function loadConfig(role: ConfigRole = 'api'): Config {
  loadRootEnvFile();
  return parseConfig(process.env, role);
}
