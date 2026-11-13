import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import type { Knex } from 'knex';
import type { Config } from './config.js';
import type { Logger } from './logger.js';
import { createErrorHandler } from './middleware/error-handler.js';
import { notFoundHandler } from './middleware/not-found.js';
import { createRequestLogger } from './middleware/request-logger.js';
import { createHealthRouter } from './routes/health.js';

export interface AppDeps {
  config: Config;
  db: Knex;
  logger: Logger;
  /** Database check timeout for GET /api/health (default 2000 ms). */
  healthCheckTimeoutMs?: number;
}

/**
 * Builds the Express application. Everything with side effects (database, logger,
 * configuration) is passed in, so tests can run the app without a database.
 */
export function createApp({ config, db, logger, healthCheckTimeoutMs = 2000 }: AppDeps): Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(createRequestLogger(logger));
  // Helmet's default Cross-Origin-Resource-Policy (same-origin) stays on the API's own
  // responses; /uploads overrides it below.
  app.use(helmet());
  app.use(cors({ origin: config.corsOrigins }));
  app.use(express.json({ limit: '1mb' }));

  app.use('/api', createHealthRouter({ db, timeoutMs: healthCheckTimeoutMs }));

  // Property photos. No directory listing, no index.html, no redirect for folder paths.
  // The photos are public by design (portals download them by URL), and the admin panel
  // may run on another site (CORS_ORIGIN accepts several origins), so <img> tags on any
  // origin may load them.
  app.use(
    '/uploads',
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
