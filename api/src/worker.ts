/**
 * The publishing worker: claims due jobs and calls the portal adapters.
 *   npm run worker             (node dist/worker.js)
 *   npm run dev:worker         (tsx watch src/worker.ts)
 *   npm run worker:once        (tsx src/worker.ts --once: runs until no job is due, then exits)
 *
 * Several workers (on one machine or several) may run against the same database: jobs are
 * claimed with row locks, see docs/architecture.md ("Claiming jobs safely").
 *
 * Besides the jobs, every worker runs its housekeeping (finishing requested property
 * deletions, deleting unused photo files) and, with REALISTIMO_API_KEY set, the Realistimo
 * import sync every REALISTIMO_SYNC_INTERVAL_SECONDS (with --once: each once, after the jobs).
 * The worker never reads JWT_SECRET or FEED_TOKEN (loadConfig('worker')).
 */
import { loadConfig, type Config } from './config.js';
import { createDb } from './db/knex.js';
import { createRealistimoSyncTask } from './jobs/realistimo-sync.js';
import { createWorker, MAINTENANCE_TASK_NAME, type PeriodicTask } from './jobs/worker.js';
import { LocalFileStorage } from './lib/storage.js';
import { createLogger } from './logger.js';
import { createRealistimoClient, REALISTIMO_KEY } from './portals/realistimo/index.js';
import { createPortalRegistry } from './portals/registry.js';
import { APP_VERSION } from './version.js';

let config: Config;
try {
  config = loadConfig('worker');
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

const once = process.argv.slice(2).includes('--once');
const logger = createLogger(config).child({ component: 'worker' });
const db = createDb(config);
const registry = createPortalRegistry(config);

// The optional Realistimo import sync: only with REALISTIMO_API_KEY (and the adapter).
const periodicTasks: PeriodicTask[] = [];
const realistimo = config.portals.realistimo;
if (realistimo.apiKey !== null && registry.has(REALISTIMO_KEY)) {
  periodicTasks.push(
    createRealistimoSyncTask({
      db,
      client: createRealistimoClient({ apiKey: realistimo.apiKey, baseUrl: realistimo.apiBaseUrl }),
      intervalMs: realistimo.syncIntervalSeconds * 1000,
    }),
  );
}

const worker = createWorker({
  db,
  registry,
  storage: new LocalFileStorage(config.uploadDir),
  logger,
  config,
  periodicTasks,
});

logger.info(
  {
    version: APP_VERSION,
    workerId: worker.id,
    env: config.nodeEnv,
    periodicTasks: [MAINTENANCE_TASK_NAME, ...periodicTasks.map((task) => task.name)],
  },
  'Worker starting',
);

let stopping = false;
function shutdown(signal: NodeJS.Signals): void {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, 'Shutting down');
  worker.stop().catch((error: unknown) => {
    logger.error({ err: error }, 'Error while stopping the worker');
  });
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

(once ? worker.runOnce() : worker.run())
  .then(() => db.destroy())
  .then(() => {
    process.exitCode = 0;
  })
  .catch(async (error: unknown) => {
    logger.fatal({ err: error }, 'Worker failed');
    process.exitCode = 1;
    await db.destroy().catch(() => undefined);
  })
  .finally(() => {
    process.removeListener('SIGINT', shutdown);
    process.removeListener('SIGTERM', shutdown);
  });
