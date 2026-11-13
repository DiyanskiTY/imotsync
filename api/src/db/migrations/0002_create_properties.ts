import type { Knex } from 'knex';

// Migrations are frozen once released: never edit one, add a new migration instead.

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('properties', (t) => {
    t.engine('InnoDB');
    t.charset('utf8mb4');
    t.collate('utf8mb4_unicode_ci');

    t.increments('id'); // INT UNSIGNED AUTO_INCREMENT PRIMARY KEY
    // Agency reference ("IS-00001"). Portals use it to recognise a listing on re-import.
    t.string('ref_code', 32).notNullable().unique({ indexName: 'properties_ref_code_unique' });
    // Most fields are nullable: drafts may be incomplete, and the per-portal
    // pre-publish check reports what is missing.
    t.string('title', 200).nullable();
    t.enu('type', [
      'apartment',
      'house',
      'office',
      'shop',
      'land',
      'garage',
      'other',
    ]).notNullable();
    t.enu('deal_type', ['sale', 'rent']).notNullable();
    t.string('city', 100).notNullable();
    t.string('district', 100).nullable();
    t.decimal('price', 12, 2).unsigned().nullable();
    // Bulgaria uses the euro since 2026-01-01.
    t.specificType('currency', 'CHAR(3)').notNullable().defaultTo('EUR');
    t.decimal('area_m2', 8, 2).unsigned().nullable();
    t.tinyint('rooms').unsigned().nullable();
    // Signed: -1 is a basement or underground garage, 0 the ground floor.
    t.smallint('floor').nullable();
    t.smallint('total_floors').unsigned().nullable();
    t.text('description').nullable();
    t.enu('status', ['draft', 'active', 'archived']).notNullable().defaultTo('draft');
    t.integer('created_by').unsigned().nullable();
    t.dateTime('created_at').notNullable().defaultTo(knex.fn.now());
    t.dateTime('updated_at')
      .notNullable()
      .defaultTo(knex.raw('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'));

    t.index(['status'], 'properties_status_index');
    t.index(['city'], 'properties_city_index');
    t.index(['deal_type', 'type'], 'properties_deal_type_type_index');
    t.index(['created_by'], 'properties_created_by_index');
    t.foreign('created_by', 'properties_created_by_foreign')
      .references('id')
      .inTable('users')
      .onDelete('SET NULL');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable('properties');
}
