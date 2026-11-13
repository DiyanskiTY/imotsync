import type { Knex } from 'knex';

// Migrations are frozen once released: never edit one, add a new migration instead.

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('property_images', (t) => {
    t.engine('InnoDB');
    t.charset('utf8mb4');
    t.collate('utf8mb4_unicode_ci');

    t.increments('id'); // INT UNSIGNED AUTO_INCREMENT PRIMARY KEY
    t.integer('property_id').unsigned().notNullable();
    t.string('url', 500).notNullable();
    t.integer('sort_order').unsigned().notNullable().defaultTo(0);
    t.smallint('width').unsigned().nullable();
    t.smallint('height').unsigned().nullable();
    t.integer('size_bytes').unsigned().nullable();
    t.dateTime('created_at').notNullable().defaultTo(knex.fn.now());

    // Also serves the foreign key on property_id.
    t.index(['property_id', 'sort_order'], 'property_images_property_id_sort_order_index');
    t.foreign('property_id', 'property_images_property_id_foreign')
      .references('id')
      .inTable('properties')
      .onDelete('CASCADE');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable('property_images');
}
