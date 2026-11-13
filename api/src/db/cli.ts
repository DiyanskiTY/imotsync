import type { Knex } from 'knex';
import { loadConfig, type Config } from '../config.js';
import { createLogger, type Logger } from '../logger.js';
import { createDb } from './knex.js';

export interface CliContext {
  config: Config;
  logger: Logger;
  db: Knex;
}

/**
 * Shared runner for the database command-line tools (migrate, seed): loads the config,
 * opens the pool, always closes it again, and turns failures into a non-zero exit code.
 */
export function runDbCli(task: (context: CliContext) => Promise<void>): void {
  let config: Config;
  try {
    config = loadConfig();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
    return;
  }

  const logger = createLogger(config);
  const db = createDb(config);

  task({ config, logger, db })
    .catch((error: unknown) => {
      logger.error({ err: error }, error instanceof Error ? error.message : 'Command failed');
      process.exitCode = 1;
    })
    .finally(() => db.destroy());
}

/**
 * Destructive demo operations (seed, reset) are refused in production unless the
 * deployment is explicitly a demo (ALLOW_DEMO_SEED=true).
 */
export function assertDemoDataAllowed(config: Config, action: string): void {
  if (config.isProduction && !config.seed.allowInProduction) {
    throw new Error(
      `Refusing to ${action} with NODE_ENV=production. ` +
        'Set ALLOW_DEMO_SEED=true only on a demo deployment with made-up data.',
    );
  }
}
