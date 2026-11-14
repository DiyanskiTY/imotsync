import type { Knex } from 'knex';
import type {
  DealType,
  Portal,
  PortalListingStatus,
  PropertyStatus,
  PropertyType,
} from '../../db/types.js';

/*
 * Filters and sorting for GET /properties. Only the columns named here ever reach SQL:
 * user input selects a key of these maps and is otherwise passed as a bound value.
 */

/** Sort keys of the API and the column each one sorts by. */
export const SORT_COLUMNS = {
  createdAt: 'properties.created_at',
  updatedAt: 'properties.updated_at',
  price: 'properties.price',
  areaM2: 'properties.area_m2',
  refCode: 'properties.ref_code',
  city: 'properties.city',
} as const;

export type SortField = keyof typeof SORT_COLUMNS;
export type SortDirection = 'asc' | 'desc';

export interface PropertySort {
  field: SortField;
  direction: SortDirection;
}

export const DEFAULT_SORT = '-updatedAt';
export const DEFAULT_PAGE_SIZE = 20;

/** Every accepted value of the sort parameter: "price" ascending, "-price" descending. */
export const SORT_VALUES: readonly string[] = Object.keys(SORT_COLUMNS).flatMap((field) => [
  field,
  `-${field}`,
]);

/** "-price" -> {field: "price", direction: "desc"}; anything unknown -> null. */
export function parseSort(value: string): PropertySort | null {
  const direction: SortDirection = value.startsWith('-') ? 'desc' : 'asc';
  const field = direction === 'desc' ? value.slice(1) : value;
  return Object.hasOwn(SORT_COLUMNS, field) ? { field: field as SortField, direction } : null;
}

export interface PropertyFilters {
  /** Free text, matched as a substring of ref code, title, city and district. */
  q?: string;
  status?: PropertyStatus[];
  type?: PropertyType[];
  dealType?: DealType[];
  /** Exact city name (the column's collation makes it case-insensitive). */
  city?: string;
  priceMin?: number;
  priceMax?: number;
  /** Only properties with a listing on this portal ... */
  portal?: Portal;
  /** ... in one of these listing statuses (on `portal`, or on any portal without it). */
  portalStatus?: PortalListingStatus[];
}

const SEARCH_COLUMNS = [
  'properties.ref_code',
  'properties.title',
  'properties.city',
  'properties.district',
] as const;

/** The escape character for LIKE patterns ('!' avoids backslash-escaping rules). */
const LIKE_ESCAPE = '!';

/** Escapes LIKE wildcards in user input, so "50%" matches the text "50%" only. */
export function escapeLike(text: string): string {
  return text.replace(/[!%_]/g, (char) => `${LIKE_ESCAPE}${char}`);
}

/**
 * Adds the WHERE conditions for the filters to a query on `properties`. (Knex builders are
 * thenables, so every step is assigned back instead of being left as a bare statement.)
 */
export function applyPropertyFilters(
  db: Knex,
  query: Knex.QueryBuilder,
  filters: PropertyFilters,
): Knex.QueryBuilder {
  const { q, status, type, dealType, city, priceMin, priceMax, portal, portalStatus } = filters;
  let builder = query;

  if (q) {
    const pattern = `%${escapeLike(q)}%`;
    builder = builder.where((where) => {
      for (const column of SEARCH_COLUMNS) {
        // Adds to the grouped WHERE in place; nothing to await.
        void where.orWhereRaw('?? LIKE ? ESCAPE ?', [column, pattern, LIKE_ESCAPE]);
      }
    });
  }
  if (status?.length) builder = builder.whereIn('properties.status', status);
  if (type?.length) builder = builder.whereIn('properties.type', type);
  if (dealType?.length) builder = builder.whereIn('properties.deal_type', dealType);
  if (city) builder = builder.where('properties.city', city);
  if (priceMin !== undefined) builder = builder.where('properties.price', '>=', priceMin);
  if (priceMax !== undefined) builder = builder.where('properties.price', '<=', priceMax);

  if (portal || portalStatus?.length) {
    let listings = db('portal_listings')
      .select(db.raw('1'))
      .whereRaw('portal_listings.property_id = properties.id');
    if (portal) listings = listings.where('portal_listings.portal', portal);
    if (portalStatus?.length) listings = listings.whereIn('portal_listings.status', portalStatus);
    builder = builder.whereExists(listings);
  }
  return builder;
}

/** ORDER BY for the sort, with the id as tie-breaker so pages never overlap. */
export function sortOrder(sort: PropertySort): { column: string; order: SortDirection }[] {
  return [
    { column: SORT_COLUMNS[sort.field], order: sort.direction },
    { column: 'properties.id', order: sort.direction },
  ];
}
