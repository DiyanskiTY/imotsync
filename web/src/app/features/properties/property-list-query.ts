import {
  DEAL_TYPES,
  LISTING_STATUSES,
  PORTAL_KEYS,
  PROPERTY_SORTS,
  PROPERTY_STATUSES,
  PROPERTY_TYPES,
  type PropertyListQuery,
} from '../../core/api/models';
import { QueryField, QueryState, UrlQuery } from '../../shared/url-query';

const MAX_PRICE = 9_999_999_999.99;

/**
 * The property list's filters, sort and page. The field list must match GET /api/properties
 * exactly (`satisfies` fails the build on a missing or unknown field), because the API answers
 * 400 for a query parameter it does not know.
 */
export const PROPERTY_LIST_QUERY = new UrlQuery(
  {
    page: { type: 'integer', min: 1, max: 1_000_000 },
    pageSize: { type: 'integer', min: 1, max: 100 },
    q: { type: 'text', maxLength: 100 },
    status: { type: 'many', values: PROPERTY_STATUSES },
    type: { type: 'many', values: PROPERTY_TYPES },
    dealType: { type: 'many', values: DEAL_TYPES },
    city: { type: 'text', maxLength: 100 },
    priceMin: { type: 'number', min: 0, max: MAX_PRICE },
    priceMax: { type: 'number', min: 0, max: MAX_PRICE },
    portal: { type: 'one', values: PORTAL_KEYS },
    portalStatus: { type: 'many', values: LISTING_STATUSES },
    sort: { type: 'one', values: PROPERTY_SORTS },
  } as const satisfies Record<keyof PropertyListQuery, QueryField>,
  { page: 1, pageSize: 20, sort: '-updatedAt' },
  // A maximum price below the minimum is dropped (the API refuses it), in the URL and in requests.
  (state) => {
    const { priceMin, priceMax } = state;
    return priceMin !== undefined && priceMax !== undefined && priceMax < priceMin
      ? { ...state, priceMax: undefined }
      : state;
  },
);

export type PropertyListState = QueryState<typeof PROPERTY_LIST_QUERY.fields>;
