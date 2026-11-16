/**
 * Demo data CLI: wipes all tables and loads made-up users, properties, photos, portal
 * listings (with the feed payloads of the registered adapters) and jobs. Running it again
 * gives the same data.
 *   npm run db:seed            (tsx, from api/)
 *   node dist/db/seed.js       (compiled, e.g. in Docker)
 *
 * Refused when NODE_ENV=production unless ALLOW_DEMO_SEED=true.
 */
import { createPortalRegistry } from '../portals/registry.js';
import { assertDemoDataAllowed, runDbCli } from './cli.js';
import { runDemoSeed } from './seeds/demo-seed.js';

runDbCli(async ({ config, db, logger }) => {
  assertDemoDataAllowed(config, 'load demo data');

  const summary = await runDemoSeed(db, {
    uploadDir: config.uploadDir,
    demoPassword: config.seed.demoPassword,
    // Feed portals get the payloads their adapters build, so the feeds have content at once.
    registry: createPortalRegistry(config),
    publicBaseUrl: config.publicBaseUrl,
  });
  logger.info(
    { ...summary, database: config.db.database, uploadDir: config.uploadDir },
    'Demo data loaded',
  );
});
