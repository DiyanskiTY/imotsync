import type { Knex } from 'knex';

// Migrations are frozen once released: never edit one, add a new migration instead.

export async function up(knex: Knex): Promise<void> {
  // One row per portal with state that belongs to the portal rather than to a listing,
  // e.g. when the worker last asked Realistimo to import the feed and what the import log said.
  await knex.schema.createTable('portal_sync_state', (t) => {
    t.engine('InnoDB');
    t.charset('utf8mb4');
    t.collate('utf8mb4_unicode_ci');

    // Adapter key, as in portal_listings.portal.
    t.string('portal', 32).primary();
    t.dateTime('last_triggered_at').nullable();
    t.string('last_trigger_message', 100).nullable();
    t.dateTime('last_log_date').nullable();
    t.json('last_result').nullable();
    t.dateTime('created_at').notNullable().defaultTo(knex.fn.now());
    t.dateTime('updated_at')
      .notNullable()
      .defaultTo(knex.raw('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'));
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable('portal_sync_state');
}
