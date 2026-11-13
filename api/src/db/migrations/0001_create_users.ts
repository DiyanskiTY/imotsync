import type { Knex } from 'knex';

// Migrations are frozen once released: never edit one, add a new migration instead.

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('users', (t) => {
    t.engine('InnoDB');
    t.charset('utf8mb4');
    t.collate('utf8mb4_unicode_ci');

    t.increments('id'); // INT UNSIGNED AUTO_INCREMENT PRIMARY KEY
    t.string('email', 255).notNullable().unique({ indexName: 'users_email_unique' });
    t.string('password_hash', 255).notNullable();
    t.string('full_name', 120).notNullable();
    t.enu('role', ['admin', 'broker']).notNullable().defaultTo('broker');
    t.dateTime('created_at').notNullable().defaultTo(knex.fn.now());
    t.dateTime('updated_at')
      .notNullable()
      .defaultTo(knex.raw('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'));
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable('users');
}
