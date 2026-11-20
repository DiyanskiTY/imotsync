import cors from 'cors';
import express, { Router, type Express } from 'express';
import helmet from 'helmet';
import type { Knex } from 'knex';
import type { Config } from './config.js';
import { LocalFileStorage, PUBLIC_UPLOADS_PATH, type FileStorage } from './lib/storage.js';
import type { Logger } from './logger.js';
import { createErrorHandler } from './middleware/error-handler.js';
import { notFoundHandler } from './middleware/not-found.js';
import { createRequestLogger } from './middleware/request-logger.js';
import { createUserRepository } from './modules/auth/auth.repository.js';
import { createAuthRouter } from './modules/auth/auth.router.js';
import { createAuthService } from './modules/auth/auth.service.js';
import {
  createLoginRateLimiter,
  type LoginRateLimitOptions,
} from './modules/auth/login-rate-limit.js';
import { createRequireAuth } from './modules/auth/require-auth.js';
import { createTokenService } from './modules/auth/tokens.js';
import {
  createDemoLoginRouter,
  createDemoSessionIssuer,
} from './modules/demo/demo-login.router.js';
import {
  deploymentProfile,
  type DemoRateLimitOptions,
  type DeploymentProfile,
} from './modules/demo/deployment-profile.js';
import {
  createClosedFeedsRouter,
  createFeedsRouter,
  FEEDS_PATH,
} from './modules/feeds/feeds.router.js';
import { createFeedsService } from './modules/feeds/feeds.service.js';
import { createImagesRouter } from './modules/images/images.router.js';
import { createImagesService } from './modules/images/images.service.js';
import { createJobsRouter } from './modules/jobs/jobs.router.js';
import { createJobsService } from './modules/jobs/jobs.service.js';
import { createPropertiesRouter } from './modules/properties/properties.router.js';
import { createPropertiesService } from './modules/properties/properties.service.js';
import { createPublishingRouter } from './modules/publishing/publishing.router.js';
import { createPublishingService } from './modules/publishing/publishing.service.js';
import { createDocsHandlers, createOpenApiRouter } from './openapi/docs.js';
import { buildOpenApiDocument, DOCS_PATH } from './openapi/document.js';
import { createPortalRegistry, type PortalRegistry } from './portals/registry.js';
import { createClientConfigRouter } from './routes/client-config.js';
import { createHealthRouter } from './routes/health.js';

export interface AppDeps {
  config: Config;
  db: Knex;
  logger: Logger;
  /** Database check timeout for GET /api/health (default 2000 ms). */
  healthCheckTimeoutMs?: number;
  /** Photo storage (default: LocalFileStorage in config.uploadDir). */
  storage?: FileStorage;
  /** Login rate limit (default: 10 attempts per 15 minutes per IP). */
  loginRateLimit?: LoginRateLimitOptions;
  /** Photo uploads handled at the same time (default 2); more are answered with 429. */
  maxConcurrentUploads?: number;
  /** Milliseconds a photo upload's body has to arrive in (default 60 s); later, 408. */
  uploadBodyTimeoutMs?: number;
  /** Portal adapters (default: createPortalRegistry(config)). */
  registry?: PortalRegistry;
  /** DEMO_MODE only: the per-IP request limits (default DEMO_RATE_LIMIT_DEFAULTS). */
  demoRateLimit?: DemoRateLimitOptions;
}

/** Response headers browser clients on other origins (the admin panel) may read. */
const EXPOSED_HEADERS = [
  'Location',
  'X-Request-Id',
  'Retry-After',
  'RateLimit',
  'RateLimit-Policy',
];

export interface ApiRouterDeps {
  config: Config;
  db: Knex;
  logger: Logger;
  storage: FileStorage;
  registry: PortalRegistry;
  /** What this kind of deployment (standard or public demo) allows. */
  profile: DeploymentProfile;
  healthCheckTimeoutMs: number;
  loginRateLimit?: LoginRateLimitOptions;
  maxConcurrentUploads?: number;
  uploadBodyTimeoutMs?: number;
}

/**
 * All /api routes, in one router mounted at /api. Public routes come first; everything
 * after the requireAuth line needs a valid token, so a route added there later is
 * protected by default (an unknown /api path also answers 401 until a token is sent).
 */
export function createApiRouter(deps: ApiRouterDeps): Router {
  const { config, db, logger, storage, registry, profile } = deps;

  const tokens = createTokenService({ secret: config.jwtSecret, ttlSeconds: config.jwtTtlSeconds });
  const users = createUserRepository(db);
  const requireAuth = createRequireAuth({ tokens, users });

  const api = Router();
  for (const guard of profile.apiGuards) api.use(guard);
  api.use(createHealthRouter({ db, timeoutMs: deps.healthCheckTimeoutMs }));
  api.use(createOpenApiRouter(buildOpenApiDocument()));
  api.use(
    createClientConfigRouter({ demoMode: profile.demoMode, uploadLimits: profile.uploadLimits }),
  );
  api.use(
    createAuthRouter({
      auth: createAuthService({ users, tokens }),
      requireAuth,
      loginRateLimiter: createLoginRateLimiter(deps.loginRateLimit),
    }),
  );
  api.use(
    createDemoLoginRouter(
      profile.demoLoginGuard && {
        issue: createDemoSessionIssuer({ users, tokens }),
        guard: profile.demoLoginGuard,
      },
    ),
  );

  api.use(requireAuth);
  api.use(
    createPropertiesRouter({
      properties: createPropertiesService({
        db,
        removedRetentionDays: registry.removedRetentionDays,
        maxProperties: profile.maxProperties,
      }),
    }),
  );
  api.use(
    createImagesRouter({
      images: createImagesService({ db, storage, logger, uploadLimits: profile.uploadLimits }),
      maxConcurrentUploads: deps.maxConcurrentUploads,
      uploadBodyTimeoutMs: deps.uploadBodyTimeoutMs,
    }),
  );
  api.use(
    createPublishingRouter({
      publishing: createPublishingService({
        db,
        registry,
        logger,
        publicBaseUrl: config.publicBaseUrl,
        // GET /portals shows no feed URLs where the feeds are closed: none would answer.
        feeds: profile.feedsOpen
          ? { publicBaseUrl: config.publicBaseUrl, token: config.feeds.token }
          : null,
      }),
      portalKeys: registry.keys(),
    }),
  );
  api.use(createJobsRouter({ jobs: createJobsService({ db, registry }) }));
  return api;
}

/**
 * Builds the Express application. Everything with side effects (database, logger,
 * configuration, file storage) is passed in, so tests can run the app without a database.
 */
export function createApp(deps: AppDeps): Express {
  const { config, logger } = deps;
  const storage = deps.storage ?? new LocalFileStorage(config.uploadDir);
  const registry = deps.registry ?? createPortalRegistry(config);
  const healthCheckTimeoutMs = deps.healthCheckTimeoutMs ?? 2000;
  // The public demo (DEMO_MODE) is shared by every visitor: lower limits, closed feeds.
  const profile = deploymentProfile(config.demoMode, deps.demoRateLimit);

  const app = express();

  app.disable('x-powered-by');
  // Behind a reverse proxy, req.ip (used by the login rate limit) must come from
  // X-Forwarded-For, but only for the proxies listed in TRUST_PROXY.
  app.set('trust proxy', config.trustProxy);
  app.use(createRequestLogger(logger));
  // An admin panel's API, photos and feeds belong in no search index (the public demo is
  // linked from other sites, so crawlers do find it). The web server adds the same header to
  // the admin panel's pages.
  app.use((_req, res, next) => {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    next();
  });
  // Helmet's default Cross-Origin-Resource-Policy (same-origin) stays on the API's own
  // responses; /uploads overrides it below.
  app.use(helmet());
  app.use(cors({ origin: config.corsOrigins, exposedHeaders: EXPOSED_HEADERS }));
  app.use(express.json({ limit: '1mb' }));

  // Swagger UI (public, static files only), with its own CSP adjustment.
  app.use(DOCS_PATH, ...createDocsHandlers());
  app.use('/api', createApiRouter({ ...deps, storage, registry, profile, healthCheckTimeoutMs }));

  // The feeds of the feed portals: public (portals send no credentials), outside /api,
  // protected by FEED_TOKEN in the path. The public demo's are closed: its listings are made
  // up and must never be imported by a portal.
  app.use(
    FEEDS_PATH,
    profile.feedsOpen
      ? createFeedsRouter({
          feeds: createFeedsService({
            db: deps.db,
            registry,
            publicBaseUrl: config.publicBaseUrl,
            feedToken: config.feeds.token,
          }),
        })
      : createClosedFeedsRouter(),
  );

  // Property photos. No directory listing, no index.html, no redirect for folder paths.
  // The photos are public by design (portals download them by URL), and the admin panel
  // may run on another site (CORS_ORIGIN accepts several origins), so <img> tags on any
  // origin may load them.
  app.use(
    PUBLIC_UPLOADS_PATH,
    express.static(config.uploadDir, {
      index: false,
      redirect: false,
      dotfiles: 'ignore',
      maxAge: '1h',
      setHeaders: (res) => {
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      },
    }),
  );

  app.use(notFoundHandler);
  app.use(createErrorHandler({ isProduction: config.isProduction }));

  return app;
}
