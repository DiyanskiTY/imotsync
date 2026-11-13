import { createApp } from './app.js';
import { loadConfig, type Config } from './config.js';
import { createDb } from './db/knex.js';
import { withTimeout } from './lib/with-timeout.js';
import { createLogger } from './logger.js';
import { APP_VERSION } from './version.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;

let config: Config;
try {
  config = loadConfig();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

const logger = createLogger(config);
const db = createDb(config);
const app = createApp({ config, db, logger });

const server = app.listen(config.port, (error?: Error) => {
  if (error) {
    logger.fatal({ err: error }, `Could not listen on port ${config.port}`);
    process.exit(1);
  }
  logger.info({ port: config.port, env: config.nodeEnv, version: APP_VERSION }, 'API listening');

  // Not fatal: the API starts without a database and reports "degraded" on /api/health.
  withTimeout(db.raw('SELECT 1'), 5_000, 'Database connection check').then(
    () => {
      logger.info(
        { host: config.db.host, port: config.db.port, database: config.db.database },
        'Database reachable',
      );
    },
    (dbError: unknown) => {
      logger.warn({ err: dbError }, 'Database not reachable yet');
    },
  );
});

let shuttingDown = false;

function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Shutting down');

  // Last resort if open connections keep the server from closing.
  setTimeout(() => {
    logger.error('Graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();

  // Stop accepting connections, let in-flight requests finish, then close the pool.
  server.close((closeError) => {
    db.destroy()
      .then(() => {
        logger.info('Stopped');
        process.exit(closeError ? 1 : 0);
      })
      .catch((dbError: unknown) => {
        logger.error({ err: dbError }, 'Error while closing the database pool');
        process.exit(1);
      });
  });
  server.closeIdleConnections();
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
