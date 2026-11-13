import type { Knex } from 'knex';

// Migrations are frozen once released: never edit one, add a new migration instead.

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('portal_listings', (t) => {
    t.engine('InnoDB');
    t.charset('utf8mb4');
    t.collate('utf8mb4_unicode_ci');

    t.increments('id'); // INT UNSIGNED AUTO_INCREMENT PRIMARY KEY
    t.integer('property_id').unsigned().notNullable();
    // Adapter key ('realistimo', 'bazar', 'demo'). VARCHAR, not ENUM: a new adapter
    // must not need a migration.
    t.string('portal', 32).notNullable();
    t.string('external_id', 100).nullable();
    t.enu('status', ['draft', 'pending', 'published', 'error', 'removed'])
      .notNullable()
      .defaultTo('draft');
    t.text('last_error').nullable();
    t.dateTime('published_at').nullable();
    t.dateTime('created_at').notNullable().defaultTo(knex.fn.now());
    t.dateTime('updated_at')
      .notNullable()
      .defaultTo(knex.raw('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'));

    // One listing per property and portal; also serves the foreign key on property_id.
    t.unique(['property_id', 'portal'], { indexName: 'portal_listings_property_id_portal_unique' });
    t.index(['portal', 'status'], 'portal_listings_portal_status_index');
    t.foreign('property_id', 'portal_listings_property_id_foreign')
      .references('id')
      .inTable('properties')
      .onDelete('CASCADE');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable('portal_listings');
}
