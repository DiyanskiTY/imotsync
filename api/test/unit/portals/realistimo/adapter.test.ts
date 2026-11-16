import { describe, expect, it } from 'vitest';
import type { PropertyType } from '../../../../src/db/types.js';
import {
  createRealistimoAdapter,
  REALISTIMO_KEY,
  validateForRealistimo,
} from '../../../../src/portals/realistimo/adapter.js';
import {
  buildRealistimoOffer,
  REALISTIMO_OFFER_FIELDS,
  realistimoSubcategory,
} from '../../../../src/portals/realistimo/offer.js';
import { PortalError } from '../../../../src/portals/types.js';
import { makeContext, makeListing, makeProperty, subsetGeo } from './fixtures.js';

const adapter = createRealistimoAdapter({ agencyUid: 'imotsync-demo', geo: subsetGeo });

const fields = (property = makeProperty()) =>
  validateForRealistimo(property, subsetGeo).map((issue) => issue.field);

describe('Realistimo adapter identity', () => {
  it('is the feed adapter for the realistimo key', () => {
    expect(adapter.key).toBe(REALISTIMO_KEY);
    expect(adapter.key).toBe('realistimo');
    expect(adapter.displayName).toBe('Realistimo');
    expect(adapter.mode).toBe('feed');
  });
});

describe('Realistimo validate()', () => {
  it('accepts a complete property', () => {
    expect(adapter.validate(makeProperty())).toEqual([]);
  });

  it('needs a price above 0', () => {
    expect(fields(makeProperty({ price: null }))).toEqual(['price']);
    expect(fields(makeProperty({ price: 0 }))).toEqual(['price']);
    expect(fields(makeProperty({ price: -5 }))).toEqual(['price']);
    expect(adapter.validate(makeProperty({ price: null }))[0]?.message).toBe(
      'Realistimo needs a price above 0.',
    );
  });

  it('refuses a price Realistimo would show as "price on request"', () => {
    const [issue] = adapter.validate(makeProperty({ price: 1.2 }));
    expect(issue?.field).toBe('price');
    expect(issue?.message).toMatch(/price on request/);
    expect(fields(makeProperty({ price: 1.6 }))).toEqual([]);
  });

  it('needs euros', () => {
    expect(adapter.validate(makeProperty({ currency: 'BGN' }))).toEqual([
      { field: 'currency', message: 'Realistimo accepts prices in euros (EUR) only.' },
    ]);
  });

  it('needs the floor area, except for a garage', () => {
    expect(adapter.validate(makeProperty({ areaM2: null }))).toEqual([
      { field: 'areaM2', message: 'Realistimo needs the floor area (m²).' },
    ]);
    expect(fields(makeProperty({ areaM2: 0 }))).toEqual(['areaM2']);
    expect(fields(makeProperty({ type: 'garage', rooms: null, areaM2: null }))).toEqual([]);
  });

  it('refuses a land area Realistimo would read as decares', () => {
    const land = { type: 'land', rooms: null, floor: null, totalFloors: null } as const;
    const [issue] = adapter.validate(makeProperty({ ...land, areaM2: 0.8 }));
    expect(issue?.field).toBe('areaM2');
    expect(issue?.message).toMatch(/^Realistimo reads a land area below 1 as decares/);
    expect(fields(makeProperty({ ...land, areaM2: 800 }))).toEqual([]);
    // Only land surfaces are read as decares.
    expect(fields(makeProperty({ type: 'garage', rooms: null, areaM2: 0.8 }))).toEqual([]);
  });

  it('needs a location Realistimo knows, and names the problem', () => {
    const [unknown] = adapter.validate(makeProperty({ city: 'Atlantis', district: null }));
    expect(unknown).toEqual({
      field: 'city',
      message: 'Realistimo cannot find "Atlantis" in its list of locations; check the city name.',
    });

    const [ambiguous] = adapter.validate(makeProperty({ city: 'Byala', district: null }));
    expect(ambiguous?.field).toBe('city');
    expect(ambiguous?.message).toMatch(
      /several places named "Byala" \(Бяла \(Варна\), Бяла \(Русе\)\)/,
    );
  });

  it('accepts an unknown district (the city id is used)', () => {
    expect(fields(makeProperty({ district: 'Somewhere New' }))).toEqual([]);
  });

  it('needs at least one photo', () => {
    expect(adapter.validate(makeProperty({ images: [] }))).toEqual([
      { field: 'images', message: 'Realistimo needs at least one photo.' },
    ]);
  });

  it('needs a broker', () => {
    expect(fields(makeProperty({ broker: null }))).toEqual(['createdBy']);
  });

  it('needs a description and a title', () => {
    expect(fields(makeProperty({ description: null }))).toEqual(['description']);
    expect(fields(makeProperty({ description: '   ' }))).toEqual(['description']);
    expect(adapter.validate(makeProperty({ description: null }))[0]?.message).toMatch(
      /strongly recommended/,
    );
    expect(fields(makeProperty({ title: null }))).toEqual(['title']);
  });

  it('lists every problem at once, each message naming Realistimo', () => {
    const issues = adapter.validate(
      makeProperty({
        title: null,
        description: null,
        price: null,
        currency: 'USD',
        areaM2: null,
        city: 'Nowhere',
        images: [],
        broker: null,
      }),
    );

    expect(issues.map((issue) => issue.field)).toEqual([
      'title',
      'description',
      'price',
      'currency',
      'areaM2',
      'city',
      'images',
      'createdBy',
    ]);
    for (const issue of issues) expect(issue.message).toMatch(/^Realistimo /);
  });
});

describe('Realistimo offer mapping', () => {
  it.each<[PropertyType, number | null, string]>([
    ['apartment', 1, '1-СТАЕН'],
    ['apartment', 2, '2-СТАЕН'],
    ['apartment', 3, '3-СТАЕН'],
    ['apartment', 4, '4-СТАЕН'],
    ['apartment', 5, 'МНОГОСТАЕН'],
    ['apartment', 8, 'МНОГОСТАЕН'],
    ['apartment', null, 'АПАРТАМЕНТ'],
    ['apartment', 0, 'АПАРТАМЕНТ'],
    ['house', 5, 'КЪЩА'],
    ['office', 4, 'ОФИС'],
    ['shop', 1, 'МАГАЗИН'],
    ['land', null, 'ПАРЦЕЛ'],
    ['garage', null, 'ГАРАЖ'],
    ['other', 2, 'ДРУГО'],
  ])('%s with %s rooms -> %s', (type, rooms, subcategory) => {
    expect(realistimoSubcategory(type, rooms)).toBe(subcategory);
  });

  it('builds the documented offer elements', () => {
    expect(buildRealistimoOffer(makeProperty(), 8621)).toEqual({
      offer_uid: 'IS-00001',
      last_update: '2026-01-15 12:30:00',
      offer_code: 'IS-00001',
      title: 'Тристаен апартамент в Лозенец',
      description: 'Светъл тристаен апартамент с гледка към Витоша.',
      images:
        'http://localhost:3000/uploads/properties/1/a.jpg;http://localhost:3000/uploads/properties/1/b.jpg',
      price: '245000',
      surface: '98',
      currency: 'eur',
      category: 'продажби',
      subcategory: '3-СТАЕН',
      internal_id: '8621',
      floor: '4',
      floorAll: '6',
      rooms_count: '3',
      broker_id: 'imotsync-2',
      broker: {
        BrokerID: 'imotsync-2',
        BrokerName: 'Demo Broker',
        BrokerEmail: 'broker@imotsync.local',
      },
    });
  });

  it('keeps the elements in the documented order', () => {
    const offer = buildRealistimoOffer(makeProperty(), 8621);
    const keys = Object.keys(offer).filter((key) => key !== 'broker');

    expect(keys).toEqual(REALISTIMO_OFFER_FIELDS.filter((field) => field in offer));
  });

  it('maps rentals and rounds prices to whole euros', () => {
    const offer = buildRealistimoOffer(makeProperty({ dealType: 'rent', price: 749.5 }), 8621);

    expect(offer.category).toBe('наеми');
    expect(offer.price).toBe('750');
    expect(buildRealistimoOffer(makeProperty({ price: 1_234_567.49 }), 1).price).toBe('1234567');
  });

  it('writes the area with a dot decimal', () => {
    expect(buildRealistimoOffer(makeProperty({ areaM2: 98.5 }), 1).surface).toBe('98.5');
    expect(buildRealistimoOffer(makeProperty({ areaM2: 64.25 }), 1).surface).toBe('64.25');
  });

  it('leaves out a garage area that is unknown, floor 0 and unknown floors', () => {
    const offer = buildRealistimoOffer(
      makeProperty({ type: 'garage', areaM2: null, rooms: null, floor: 0, totalFloors: null }),
      1,
    );

    expect(offer).not.toHaveProperty('surface');
    expect(offer).not.toHaveProperty('floor');
    expect(offer).not.toHaveProperty('floorAll');
    expect(offer.subcategory).toBe('ГАРАЖ');
  });

  it('keeps a basement floor', () => {
    expect(buildRealistimoOffer(makeProperty({ floor: -1 }), 1).floor).toBe('-1');
  });

  it('sends rooms_count only for apartments, houses and offices', () => {
    expect(buildRealistimoOffer(makeProperty({ type: 'house', rooms: 5 }), 1).rooms_count).toBe(
      '5',
    );
    expect(buildRealistimoOffer(makeProperty({ type: 'office', rooms: 4 }), 1).rooms_count).toBe(
      '4',
    );
    expect(buildRealistimoOffer(makeProperty({ type: 'shop', rooms: 1 }), 1)).not.toHaveProperty(
      'rooms_count',
    );
    expect(buildRealistimoOffer(makeProperty({ type: 'land', rooms: 2 }), 1)).not.toHaveProperty(
      'rooms_count',
    );
    expect(buildRealistimoOffer(makeProperty({ rooms: null }), 1)).not.toHaveProperty(
      'rooms_count',
    );
  });

  it('percent-encodes a ";" inside a photo URL', () => {
    const offer = buildRealistimoOffer(
      makeProperty({
        images: [
          {
            url: 'https://cdn.example/a;b.jpg',
            width: null,
            height: null,
            sizeBytes: null,
            sortOrder: 0,
          },
        ],
      }),
      1,
    );

    expect(offer.images).toBe('https://cdn.example/a%3Bb.jpg');
  });

  it('writes last_update in Bulgarian summer time', () => {
    const offer = buildRealistimoOffer(
      makeProperty({ updatedAt: new Date('2026-07-01T21:15:00Z') }),
      1,
    );

    expect(offer.last_update).toBe('2026-07-02 00:15:00');
  });

  it('leaves out an empty broker e-mail', () => {
    const offer = buildRealistimoOffer(
      makeProperty({ broker: { id: 7, fullName: 'Ива Петрова', email: '' } }),
      1,
    );

    expect(offer.broker).toEqual({ BrokerID: 'imotsync-7', BrokerName: 'Ива Петрова' });
  });
});

describe('Realistimo publish / update / remove', () => {
  it('publish returns the offer as the feed payload, dated with the job time', async () => {
    const outcome = await adapter.publish(makeProperty(), makeListing(), makeContext());

    expect(outcome.message).toBe('Added to the Realistimo feed (next import picks it up)');
    // makeContext().now is 2026-01-15 11:00 UTC: 13:00 in Sofia.
    expect(outcome.payload).toEqual({
      ...buildRealistimoOffer(makeProperty(), 8621),
      last_update: '2026-01-15 13:00:00',
    });
    expect(outcome.externalId).toBeUndefined();
    expect(outcome.details).toEqual({
      agencyUid: 'imotsync-demo',
      offerUid: 'IS-00001',
      internalId: 8621,
      location: 'София, Лозенец',
      locationLevel: 'neighborhood',
    });
  });

  it('update returns the current data with its own message', async () => {
    const property = makeProperty({ price: 239_000, updatedAt: new Date('2026-02-01T08:00:00Z') });

    const outcome = await adapter.update(
      property,
      makeListing({ status: 'published' }),
      makeContext(),
    );

    expect(outcome.message).toBe('Updated in the Realistimo feed (next import picks it up)');
    expect(outcome.payload).toMatchObject({ price: '239000', last_update: '2026-01-15 13:00:00' });
  });

  it('last_update: the job time when the offer changed, else the date it already had', async () => {
    const property = makeProperty();
    const first = await adapter.publish(property, makeListing(), makeContext());
    const stored = first.payload ?? null;
    const later = makeContext({ now: new Date('2026-03-10T09:30:00Z') });

    // Nothing in the offer changed (e.g. a status change, or the same data sent again).
    const same = await adapter.update(property, makeListing({ payload: stored }), later);
    expect(same.payload).toMatchObject({ last_update: '2026-01-15 13:00:00' });
    expect(same.payload).toEqual(stored);

    // The content changed without an edit of the property (here: new photo URLs, as after a
    // change of PUBLIC_BASE_URL): the job time, not the property's updatedAt.
    const moved = makeProperty({
      images: property.images.map((image) => ({
        ...image,
        url: image.url.replace(/^https?:\/\/[^/]+/, 'https://new-host.example'),
      })),
    });
    const changed = await adapter.update(moved, makeListing({ payload: stored }), later);
    expect(changed.payload).toMatchObject({ last_update: '2026-03-10 11:30:00' });
    expect(property.updatedAt.getTime()).toBeLessThan(later.now.getTime());
  });

  it('uses the city id when the district is unknown', async () => {
    const outcome = await adapter.publish(
      makeProperty({ city: 'Bansko', district: null }),
      makeListing(),
      makeContext(),
    );

    expect(outcome.payload).toMatchObject({ internal_id: '25444' });
    expect(outcome.details).toMatchObject({ location: 'Банско', locationLevel: 'city' });
  });

  it('rejects a property that fails validation with a permanent error', async () => {
    const result = adapter.publish(makeProperty({ images: [] }), makeListing(), makeContext());

    await expect(result).rejects.toBeInstanceOf(PortalError);
    await expect(result).rejects.toMatchObject({
      retryable: false,
      message: 'Realistimo cannot take this property: images: Realistimo needs at least one photo.',
    });
  });

  it('stops when the job is cancelled', async () => {
    const controller = new AbortController();
    controller.abort(new Error('shutting down'));

    await expect(
      adapter.publish(makeProperty(), makeListing(), makeContext({ signal: controller.signal })),
    ).rejects.toThrow('shutting down');
  });

  it('remove drops the offer from the feed: payload null (the contract)', async () => {
    const published = makeListing({
      status: 'published',
      payload: buildRealistimoOffer(makeProperty(), 8621),
    });

    const outcome = await adapter.remove(published, makeProperty(), makeContext());

    // Left out of <offers>; the worker still dates the change (payload_updated_at), which
    // moves the feed's <updated> (FeedRenderContext.lastChangedAt).
    expect(outcome.payload).toBeNull();
    expect(outcome.message).toBe(
      'Removed from the Realistimo feed (next import takes the offer down)',
    );
    expect(outcome.details).toEqual({ agencyUid: 'imotsync-demo', offerUid: 'IS-00001' });
  });

  it('remove works after the property is gone', async () => {
    const published = makeListing({ payload: buildRealistimoOffer(makeProperty(), 8621) });

    const outcome = await adapter.remove(published, null, makeContext());

    expect(outcome.payload).toBeNull();
    expect(outcome.details).toEqual({ agencyUid: 'imotsync-demo', offerUid: 'IS-00001' });
  });

  it('remove of a listing that never reached the feed drops nothing and keeps no payload', async () => {
    const outcome = await adapter.remove(makeListing(), makeProperty(), makeContext());
    expect(outcome.payload).toBeNull();
    expect(outcome.message).toBe('Not in the Realistimo feed; nothing to remove');
    expect((await adapter.remove(makeListing(), null, makeContext())).payload).toBeNull();
  });

  it('remove uses the ref code when the stored payload lacks an offer_uid', async () => {
    const odd = makeListing({ payload: { title: 'x' } });
    const outcome = await adapter.remove(odd, makeProperty(), makeContext());
    expect(outcome.payload).toBeNull();
    expect(outcome.details).toMatchObject({ offerUid: 'IS-00001' });
    expect((await adapter.remove(odd, null, makeContext())).details).toMatchObject({
      offerUid: null,
    });
  });
});
