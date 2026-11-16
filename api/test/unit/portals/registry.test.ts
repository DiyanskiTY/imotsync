import { describe, expect, it } from 'vitest';
import type { PortalListingRow, PropertyImageRow } from '../../../src/db/types.js';
import {
  absoluteUrl,
  toPortalListingInfo,
  toPortalProperty,
  type PropertyWithBrokerRow,
} from '../../../src/portals/property-loader.js';
import {
  createPortalRegistry,
  PORTAL_FACTORIES,
  registryFrom,
  type PortalRegistration,
} from '../../../src/portals/registry.js';
import type { PortalAdapter, PortalMode } from '../../../src/portals/types.js';
import { makeConfig } from '../helpers.js';

function fakeAdapter(key: string, mode: PortalMode = 'push'): PortalAdapter {
  const outcome = () => Promise.resolve({ message: 'ok' });
  return {
    key,
    displayName: `Fake ${key}`,
    mode,
    validate: () => [],
    publish: outcome,
    update: outcome,
    remove: outcome,
  };
}

const renderer = { contentType: 'application/xml; charset=utf-8', render: () => '<feed/>' };

describe('portal registry', () => {
  it('registers the demo portal from the configuration', () => {
    const registry = createPortalRegistry(makeConfig());

    expect(registry.keys()).toContain('demo');
    expect(registry.get('demo')).toMatchObject({ key: 'demo', mode: 'push' });
    expect(registry.has('demo')).toBe(true);
    expect(registry.has('nope')).toBe(false);
    expect(registry.get('nope')).toBeUndefined();
    expect(PORTAL_FACTORIES.length).toBe(registry.keys().length);
    // Every feed portal comes with its renderer, and only feed portals have one.
    for (const [key, adapter] of registry.adapters) {
      expect(registry.feedRenderers.has(key), key).toBe(adapter.mode === 'feed');
    }
  });

  it('knows how long each feed keeps serving a removed listing', () => {
    const registry = createPortalRegistry(makeConfig({ BAZAR_REMOVED_RETENTION_DAYS: '14' }));

    expect([...registry.removedRetentionDays]).toEqual([
      ['realistimo', 0],
      ['bazar', 14],
    ]);
    expect(() =>
      registryFrom([
        { adapter: fakeAdapter('f', 'feed'), feedRenderer: renderer, removedRetentionDays: -1 },
      ]),
    ).toThrow(/removedRetentionDays must be 0 or more/);
  });

  it('registers Realistimo and Bazar.bg as feed portals and the demo portal, in that order', () => {
    const config = makeConfig({
      REALISTIMO_AGENCY_UID: 'agency-42',
      PUBLIC_LISTING_URL_TEMPLATE: 'https://agency.example/properties/{refCode}',
    });
    const registry = createPortalRegistry(config);

    expect(registry.keys()).toEqual(['realistimo', 'bazar', 'demo']);
    expect(
      [...registry.adapters.values()].map(({ key, displayName, mode }) => [key, displayName, mode]),
    ).toEqual([
      ['realistimo', 'Realistimo', 'feed'],
      ['bazar', 'Bazar.bg', 'feed'],
      ['demo', 'Demo portal', 'push'],
    ]);
    expect([...registry.feedRenderers.keys()]).toEqual(['realistimo', 'bazar']);
    // The configuration reaches the renderers.
    const realistimoXml = registry.feedRenderers
      .get('realistimo')
      ?.render([], { now: new Date('2026-11-16T10:00:00Z'), publicBaseUrl: '' });
    expect(realistimoXml).toContain('<agency_uid>agency-42</agency_uid>');
  });

  it('builds a registry from factories, in their order', () => {
    const registrations: PortalRegistration[] = [
      { adapter: fakeAdapter('zeta') },
      { adapter: fakeAdapter('alpha', 'feed'), feedRenderer: renderer },
    ];
    const registry = createPortalRegistry(
      makeConfig(),
      registrations.map((registration) => () => registration),
    );

    expect(registry.keys()).toEqual(['zeta', 'alpha']);
    expect([...registry.feedRenderers.keys()]).toEqual(['alpha']);
    expect(registry.feedRenderers.get('alpha')).toBe(renderer);
  });

  it('ignores a renderer given to a push portal', () => {
    const registry = registryFrom([{ adapter: fakeAdapter('push'), feedRenderer: renderer }]);

    expect(registry.feedRenderers.size).toBe(0);
  });

  it('refuses a feed portal without a renderer, a key used twice and a malformed key', () => {
    expect(() => registryFrom([{ adapter: fakeAdapter('feedy', 'feed') }])).toThrow(
      'Feed portal "feedy" needs a feed renderer',
    );
    expect(() =>
      registryFrom([{ adapter: fakeAdapter('demo') }, { adapter: fakeAdapter('demo') }]),
    ).toThrow('registered twice');
    for (const key of ['', 'Demo', '1portal', 'with space', 'a/b', 'x'.repeat(33)]) {
      expect(() => registryFrom([{ adapter: fakeAdapter(key) }]), key).toThrow(/Portal key/);
    }
  });
});

const AT = new Date('2026-11-10T09:30:00Z');

const propertyRow = (overrides: Partial<PropertyWithBrokerRow> = {}): PropertyWithBrokerRow => ({
  id: 12,
  ref_code: 'IS-00012',
  title: 'Апартамент',
  type: 'apartment',
  deal_type: 'sale',
  city: 'Bansko',
  district: null,
  price: 89_000,
  currency: 'EUR',
  area_m2: 72,
  rooms: 2,
  floor: 3,
  total_floors: 5,
  description: 'Описание',
  status: 'active',
  delete_requested_at: null,
  created_by: 2,
  created_at: AT,
  updated_at: AT,
  broker_name: 'Demo Broker',
  broker_email: 'broker@imotsync.local',
  ...overrides,
});

const image = (id: number, url: string, overrides: Partial<PropertyImageRow> = {}) => ({
  id,
  property_id: 12,
  url,
  sort_order: id,
  width: 1600,
  height: 1067,
  size_bytes: 1000 + id,
  created_at: AT,
  ...overrides,
});

describe('property loader mapping', () => {
  it('turns stored photo URLs into absolute ones under PUBLIC_BASE_URL', () => {
    expect(absoluteUrl('https://imotsync.example', '/uploads/a.jpg')).toBe(
      'https://imotsync.example/uploads/a.jpg',
    );
    expect(absoluteUrl('https://imotsync.example/', 'uploads/a.jpg')).toBe(
      'https://imotsync.example/uploads/a.jpg',
    );
    expect(absoluteUrl('https://imotsync.example', 'https://cdn.example/b.jpg')).toBe(
      'https://cdn.example/b.jpg',
    );
  });

  it('maps a property with its creator as the broker and its photos in display order', () => {
    const property = toPortalProperty(
      propertyRow(),
      [image(5, '/uploads/demo/b.jpg'), image(9, '/uploads/demo/a.jpg', { width: null })],
      'http://localhost:3000',
    );

    expect(property).toEqual({
      id: 12,
      refCode: 'IS-00012',
      title: 'Апартамент',
      type: 'apartment',
      dealType: 'sale',
      city: 'Bansko',
      district: null,
      price: 89_000,
      currency: 'EUR',
      areaM2: 72,
      rooms: 2,
      floor: 3,
      totalFloors: 5,
      description: 'Описание',
      status: 'active',
      broker: { id: 2, fullName: 'Demo Broker', email: 'broker@imotsync.local' },
      updatedAt: AT,
      images: [
        {
          url: 'http://localhost:3000/uploads/demo/b.jpg',
          width: 1600,
          height: 1067,
          sizeBytes: 1005,
          sortOrder: 0,
        },
        {
          url: 'http://localhost:3000/uploads/demo/a.jpg',
          width: null,
          height: 1067,
          sizeBytes: 1009,
          sortOrder: 1,
        },
      ],
    });
  });

  it('has no broker when the creator is gone', () => {
    const property = toPortalProperty(
      propertyRow({ created_by: null, broker_name: null, broker_email: null }),
      [],
      'http://localhost:3000',
    );

    expect(property.broker).toBeNull();
    expect(property.images).toEqual([]);
  });

  it('maps a listing row to what adapters see of it', () => {
    const row: PortalListingRow = {
      id: 3,
      property_id: 12,
      portal: 'bazar',
      external_id: null,
      status: 'published',
      last_error: null,
      published_at: AT,
      payload: { id: 'IS-00012' },
      payload_updated_at: AT,
      removed_at: null,
      created_at: AT,
      updated_at: AT,
    };

    expect(toPortalListingInfo(row)).toEqual({
      id: 3,
      portal: 'bazar',
      status: 'published',
      externalId: null,
      publishedAt: AT,
      payload: { id: 'IS-00012' },
      payloadUpdatedAt: AT,
    });
  });
});
