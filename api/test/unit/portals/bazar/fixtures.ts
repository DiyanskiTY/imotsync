import type {
  AdapterContext,
  FeedItem,
  PortalImage,
  PortalListingInfo,
  PortalProperty,
} from '../../../../src/portals/types.js';

export const BASE_URL = 'https://imotsync.example';

export function photo(sortOrder: number, overrides: Partial<PortalImage> = {}): PortalImage {
  return {
    url: `${BASE_URL}/uploads/properties/12/photo-${sortOrder + 1}.jpg`,
    width: 1600,
    height: 1067,
    sizeBytes: 280_000,
    sortOrder,
    ...overrides,
  };
}

/** A property that meets every Bazar rule. */
export function readyProperty(overrides: Partial<PortalProperty> = {}): PortalProperty {
  return {
    id: 12,
    refCode: 'IS-00012',
    title: 'Тристаен апартамент в Лозенец с гледка към Витоша',
    type: 'apartment',
    dealType: 'sale',
    city: 'Sofia',
    district: 'Lozenets',
    price: 245_000,
    currency: 'EUR',
    areaM2: 98,
    rooms: 3,
    floor: 4,
    totalFloors: 6,
    description:
      'Светъл тристаен апартамент на четвърти етаж в нова сграда с асансьор. Площ 98 кв.м, ' +
      'построена през 2019 г., цена 245 000 €.',
    status: 'active',
    broker: { id: 2, fullName: 'Demo Broker', email: 'broker@imotsync.local' },
    updatedAt: new Date('2026-11-10T08:30:00Z'),
    images: [photo(0), photo(1), photo(2)],
    ...overrides,
  };
}

export function listingInfo(overrides: Partial<PortalListingInfo> = {}): PortalListingInfo {
  return {
    id: 7,
    portal: 'bazar',
    status: 'pending',
    externalId: null,
    publishedAt: null,
    payload: null,
    payloadUpdatedAt: null,
    ...overrides,
  };
}

export function adapterContext(overrides: Partial<AdapterContext> = {}): AdapterContext {
  return {
    now: new Date('2026-11-16T10:00:00Z'),
    signal: new AbortController().signal,
    attempt: 1,
    ...overrides,
  };
}

export function feedItem(
  payload: Record<string, unknown>,
  overrides: Partial<Omit<FeedItem, 'payload'>> = {},
): FeedItem {
  return {
    refCode: typeof payload.id === 'string' ? payload.id : 'IS-00000',
    status: 'published',
    payload,
    payloadUpdatedAt: new Date('2026-11-15T09:00:00Z'),
    ...overrides,
  };
}
