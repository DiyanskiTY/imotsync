import knex from 'knex';
import { afterAll, describe, expect, it } from 'vitest';
import {
  applyPropertyFilters,
  escapeLike,
  parseSort,
  SORT_COLUMNS,
  SORT_VALUES,
  sortOrder,
} from '../../src/modules/properties/list-query.js';

// Builds SQL only; a query is never sent, so no database is needed. (Knex writes keywords
// in lower case; LIKE and ESCAPE come from the raw condition.)
const db = knex({ client: 'mysql2' });

afterAll(async () => {
  await db.destroy();
});

const sqlFor = (filters: Parameters<typeof applyPropertyFilters>[2]) =>
  applyPropertyFilters(db, db('properties').select('properties.id'), filters).toSQL().toNative();

describe('parseSort', () => {
  it('reads ascending and descending sort keys', () => {
    expect(parseSort('price')).toEqual({ field: 'price', direction: 'asc' });
    expect(parseSort('-updatedAt')).toEqual({ field: 'updatedAt', direction: 'desc' });
  });

  it.each([
    '',
    '-',
    'description',
    'created_at',
    '--price',
    'price desc',
    'constructor',
    '__proto__',
  ])('refuses %j', (value) => {
    expect(parseSort(value)).toBeNull();
  });

  it('offers both directions of every whitelisted column', () => {
    expect(SORT_VALUES).toHaveLength(Object.keys(SORT_COLUMNS).length * 2);
    for (const value of SORT_VALUES) expect(parseSort(value)).not.toBeNull();
  });

  it('always breaks ties by id in the same direction', () => {
    expect(sortOrder({ field: 'price', direction: 'desc' })).toEqual([
      { column: 'properties.price', order: 'desc' },
      { column: 'properties.id', order: 'desc' },
    ]);
  });
});

describe('escapeLike', () => {
  it('escapes LIKE wildcards and the escape character', () => {
    expect(escapeLike('50% off_now!')).toBe('50!% off!_now!!');
    expect(escapeLike('Лозенец')).toBe('Лозенец');
  });
});

describe('applyPropertyFilters', () => {
  it('adds nothing without filters', () => {
    expect(sqlFor({}).sql).toBe('select `properties`.`id` from `properties`');
  });

  it('searches four columns with an escaped, bound pattern', () => {
    const { sql, bindings } = sqlFor({ q: "100%_'; DROP TABLE users; --" });

    expect(sql).toBe(
      'select `properties`.`id` from `properties` where (`properties`.`ref_code` LIKE ? ESCAPE ? or `properties`.`title` LIKE ? ESCAPE ? or `properties`.`city` LIKE ? ESCAPE ? or `properties`.`district` LIKE ? ESCAPE ?)',
    );
    expect(bindings).toEqual(
      Array.from({ length: 4 }, () => ["%100!%!_'; DROP TABLE users; --%", '!']).flat(),
    );
  });

  it('turns list filters into IN conditions with bound values', () => {
    const { sql, bindings } = sqlFor({
      status: ['active', 'draft'],
      type: ['house'],
      dealType: ['sale'],
      city: 'Sofia',
      priceMin: 100,
      priceMax: 200.5,
    });

    expect(sql).toBe(
      'select `properties`.`id` from `properties` where `properties`.`status` in (?, ?) and `properties`.`type` in (?) and `properties`.`deal_type` in (?) and `properties`.`city` = ? and `properties`.`price` >= ? and `properties`.`price` <= ?',
    );
    expect(bindings).toEqual(['active', 'draft', 'house', 'sale', 'Sofia', 100, 200.5]);
  });

  it('ignores empty lists', () => {
    expect(sqlFor({ status: [], portalStatus: [] }).sql).toBe(
      'select `properties`.`id` from `properties`',
    );
  });

  it('filters by portal and listing status with one EXISTS subquery', () => {
    const { sql, bindings } = sqlFor({ portal: 'bazar', portalStatus: ['published', 'error'] });

    expect(sql).toBe(
      'select `properties`.`id` from `properties` where exists (select 1 from `portal_listings` where portal_listings.property_id = properties.id and `portal_listings`.`portal` = ? and `portal_listings`.`status` in (?, ?))',
    );
    expect(bindings).toEqual(['bazar', 'published', 'error']);
  });

  it('applies a listing status to any portal when no portal is given', () => {
    const { sql, bindings } = sqlFor({ portalStatus: ['pending'] });

    expect(sql).toContain('where exists (select 1 from `portal_listings`');
    expect(sql).not.toContain('`portal_listings`.`portal` =');
    expect(bindings).toEqual(['pending']);
  });
});
