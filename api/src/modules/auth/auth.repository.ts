import type { Knex } from 'knex';
import type { UserRow } from '../../db/types.js';

export interface UserRepository {
  /** Expects a trimmed, lower-case address; the column's collation is case-insensitive too. */
  findByEmail(email: string): Promise<UserRow | undefined>;
  findById(id: number): Promise<UserRow | undefined>;
}

export function createUserRepository(db: Knex): UserRepository {
  return {
    findByEmail: (email) => db('users').where({ email }).first(),
    findById: (id) => db('users').where({ id }).first(),
  };
}
