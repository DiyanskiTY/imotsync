import type { Knex } from 'knex';

// Migrations are frozen once released: never edit one, add a new migration instead.

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('jobs', (t) => {
    t.engine('InnoDB');
    t.charset('utf8mb4');
    t.collate('utf8mb4_unicode_ci');

    // The publishing queue and the log of attempts (one row per portal action).
    t.bigIncrements('id'); // BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY
    t.integer('portal_listing_id').unsigned().notNullable();
    t.enu('action', ['publish', 'update', 'remove']).notNullable();
    t.enu('status', ['queued', 'running', 'succeeded', 'failed']).notNullable().defaultTo('queued');
    t.integer('attempts').unsigned().notNullable().defaultTo(0);
    t.integer('max_attempts').unsigned().notNullable().defaultTo(5);
    // The worker only picks up a job once run_after has passed (used for retry back-off).
    t.dateTime('run_after').notNullable().defaultTo(knex.fn.now());
    t.dateTime('locked_at').nullable();
    t.string('locked_by', 64).nullable();
    // Outcome of the last attempt.
    t.json('result').nullable();
    t.text('last_error').nullable();
    t.dateTime('finished_at').nullable();
    t.dateTime('created_at').notNullable().defaultTo(knex.fn.now());
    t.dateTime('updated_at')
      .notNullable()
      .defaultTo(knex.raw('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'));

    t.index(['status', 'run_after'], 'jobs_status_run_after_index');
    t.index(['portal_listing_id'], 'jobs_portal_listing_id_index');
    t.foreign('portal_listing_id', 'jobs_portal_listing_id_foreign')
      .references('id')
      .inTable('portal_listings')
      .onDelete('CASCADE');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable('jobs');
}
