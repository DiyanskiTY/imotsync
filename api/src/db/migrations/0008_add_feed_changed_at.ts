import type { Knex } from 'knex';

// Migrations are frozen once released: never edit one, add a new migration instead.

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('portal_sync_state', (t) => {
    // When a listing that had a feed payload was deleted together with its property. The
    // listing row (and its payload_updated_at) is gone, but the feed changed: the offer
    // disappeared. Feed dates such as Realistimo's <updated> and Last-Modified use it.
    t.dateTime('feed_changed_at').nullable().after('last_result');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('portal_sync_state', (t) => {
    t.dropColumn('feed_changed_at');
  });
}
