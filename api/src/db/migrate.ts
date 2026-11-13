/**
 * Migration CLI.
 *   npm run db:migrate | db:rollback | db:status        (tsx, from api/)
 *   node dist/db/migrate.js latest|rollback|status|reset (compiled, e.g. in Docker)
 *
 * reset = roll back every batch, then migrate to latest (refused in production unless
 * ALLOW_DEMO_SEED=true). `npm run db:reset` also reloads the demo data afterwards.
 */
import { assertDemoDataAllowed, runDbCli } from './cli.js';
import { migratorConfig } from './migrations/index.js';

const COMMANDS = ['latest', 'rollback', 'status', 'reset'] as const;
type Command = (typeof COMMANDS)[number];

const isCommand = (value: string): value is Command =>
  (COMMANDS as readonly string[]).includes(value);

/** knex returns [batchNo, migrationNames] from latest() and rollback(). */
type MigrateResult = [batch: number, names: string[]];

/** knex returns [completed, pending] from list(); completed entries are { name } objects. */
type ListResult = [completed: ({ name: string } | string)[], pending: string[]];

const command = process.argv[2] ?? 'latest';

if (!isCommand(command)) {
  process.stderr.write(`Unknown command "${command}". Usage: migrate <${COMMANDS.join('|')}>\n`);
  process.exitCode = 2;
} else {
  runDbCli(async ({ config, db, logger }) => {
    const target = `${config.db.database} on ${config.db.host}:${config.db.port}`;

    switch (command) {
      case 'latest': {
        const [batch, names] = (await db.migrate.latest(migratorConfig)) as MigrateResult;
        if (names.length === 0) logger.info(`${target}: already up to date`);
        else logger.info({ batch, migrations: names }, `${target}: applied ${names.length}`);
        break;
      }
      case 'rollback': {
        const [batch, names] = (await db.migrate.rollback(migratorConfig)) as MigrateResult;
        if (names.length === 0) logger.info(`${target}: nothing to roll back`);
        else logger.info({ batch, migrations: names }, `${target}: rolled back ${names.length}`);
        break;
      }
      case 'status': {
        const [completed, pending] = (await db.migrate.list(migratorConfig)) as ListResult;
        const lines = [
          `Migrations for ${target}`,
          ...completed.map((entry) => `  [x] ${typeof entry === 'string' ? entry : entry.name}`),
          ...pending.map((name) => `  [ ] ${name}`),
          `${completed.length} applied, ${pending.length} pending`,
        ];
        process.stdout.write(`${lines.join('\n')}\n`);
        break;
      }
      case 'reset': {
        assertDemoDataAllowed(config, 'reset the database');
        const [, rolledBack] = (await db.migrate.rollback(migratorConfig, true)) as MigrateResult;
        const [, applied] = (await db.migrate.latest(migratorConfig)) as MigrateResult;
        logger.info(
          `${target}: rolled back ${rolledBack.length}, applied ${applied.length} migrations`,
        );
        break;
      }
    }
  });
}
