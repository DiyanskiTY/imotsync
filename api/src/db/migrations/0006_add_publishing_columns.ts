import type { Knex } from 'knex';

// Migrations are frozen once released: never edit one, add a new migration instead.

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('portal_listings', (t) => {
    // Feed portals: what the feed serves for this listing (the adapter's portal-specific
    // representation), written when a job succeeds. NULL: not in the feed.
    t.json('payload').nullable().after('published_at');
    t.dateTime('payload_updated_at').nullable().after('payload');
    // When the last successful remove went through; cleared by a later publish or update.
    t.dateTime('removed_at').nullable().after('payload_updated_at');
  });

  await knex.schema.alterTable('properties', (t) => {
    // Bulk delete: the property is deleted by the worker once every portal has removed it.
    t.dateTime('delete_requested_at').nullable().after('status');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('properties', (t) => {
    t.dropColumn('delete_requested_at');
  });
  await knex.schema.alterTable('portal_listings', (t) => {
    t.dropColumn('removed_at');
    t.dropColumn('payload_updated_at');
    t.dropColumn('payload');
  });
}
