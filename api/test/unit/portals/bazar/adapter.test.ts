import { describe, expect, it } from 'vitest';
import { DEAL_TYPES, PROPERTY_TYPES } from '../../../../src/db/types.js';
import { createBazarAdapter } from '../../../../src/portals/bazar/adapter.js';
import { toBulgarianCityName } from '../../../../src/portals/bazar/cities.js';
import {
  bazarProductType,
  buildBazarItem,
  formatBazarPrice,
} from '../../../../src/portals/bazar/mapping.js';
import {
  bazarItemPayloadSchema,
  type BazarItemPayload,
} from '../../../../src/portals/bazar/payload.js';
import { createGeoResolver } from '../../../../src/portals/realistimo/geo.js';
import { placeNamesFrom } from '../../../../src/portals/registry.js';
import { PortalError } from '../../../../src/portals/types.js';
import { BASE_URL, adapterContext, listingInfo, photo, readyProperty } from './fixtures.js';

const TEMPLATE = 'https://agency.example/properties/{refCode}';

async function publishedPayload(
  overrides: Parameters<typeof readyProperty>[0] = {},
  listingUrlTemplate?: string | null,
): Promise<BazarItemPayload> {
  const adapter = createBazarAdapter({ listingUrlTemplate });
  const outcome = await adapter.publish(readyProperty(overrides), listingInfo(), adapterContext());
  return bazarItemPayloadSchema.parse(outcome.payload);
}

describe('createBazarAdapter', () => {
  it('is the Bazar feed portal', () => {
    const adapter = createBazarAdapter();
    expect(adapter.key).toBe('bazar');
    expect(adapter.displayName).toBe('Bazar.bg');
    expect(adapter.mode).toBe('feed');
  });

  describe('publish', () => {
    it('stores the complete feed item as the payload', async () => {
      const adapter = createBazarAdapter({ listingUrlTemplate: TEMPLATE });
      const outcome = await adapter.publish(readyProperty(), listingInfo(), adapterContext());

      expect(outcome).toEqual({
        payload: {
          id: 'IS-00012',
          title: 'Тристаен апартамент в Лозенец с гледка към Витоша',
          description:
            'Светъл тристаен апартамент на четвърти етаж в нова сграда с асансьор. Площ 98 кв.м, ' +
            'построена през 2019 г., цена 245 000 €.',
          link: 'https://agency.example/properties/IS-00012',
          imageLink: `${BASE_URL}/uploads/properties/12/photo-1.jpg`,
          additionalImageLinks: [
            `${BASE_URL}/uploads/properties/12/photo-2.jpg`,
            `${BASE_URL}/uploads/properties/12/photo-3.jpg`,
          ],
          price: '245000.00 EUR',
          availability: 'in_stock',
          productType: 'Имоти > Продажби > Апартаменти',
          customLabel0: 'София',
          customLabel1: 'Lozenets',
          customLabel2: '98 м²',
          customLabel3: '3',
        },
        message: 'Added to the Bazar feed (Bazar picks it up on its next scheduled download)',
        details: { feedItemId: 'IS-00012', availability: 'in_stock', imageCount: 3 },
      });
      // Feed portals have no portal-side id to report.
      expect(outcome.externalId).toBeUndefined();
    });

    it('stores a payload that survives a JSON round trip (the JSON column)', async () => {
      const adapter = createBazarAdapter({ listingUrlTemplate: TEMPLATE });
      const { payload } = await adapter.publish(readyProperty(), listingInfo(), adapterContext());
      expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
      expect(bazarItemPayloadSchema.safeParse(payload).success).toBe(true);
    });

    it('fails permanently, without retries, when the property breaks a rule', async () => {
      const adapter = createBazarAdapter();
      const property = readyProperty({ title: null, price: null });
      const failure = adapter.publish(property, listingInfo(), adapterContext());

      await expect(failure).rejects.toBeInstanceOf(PortalError);
      await expect(failure).rejects.toMatchObject({
        retryable: false,
        message:
          'Validation failed: title: Bazar needs a title.; price: Bazar requires a concrete price in euro.',
      });
    });

    it('stops when the job was cancelled', async () => {
      const controller = new AbortController();
      controller.abort();
      const adapter = createBazarAdapter();
      await expect(
        adapter.publish(
          readyProperty(),
          listingInfo(),
          adapterContext({ signal: controller.signal }),
        ),
      ).rejects.toMatchObject({ name: 'AbortError' });
    });
  });

  describe('update', () => {
    it('stores the current data and says it was updated', async () => {
      const adapter = createBazarAdapter();
      const outcome = await adapter.update(
        readyProperty({ price: 239_000 }),
        listingInfo({ status: 'published' }),
        adapterContext(),
      );
      expect(outcome.message).toBe(
        'Updated in the Bazar feed (Bazar applies it on its next scheduled download)',
      );
      expect(outcome.payload).toMatchObject({ price: '239000.00 EUR', availability: 'in_stock' });
    });
  });

  describe('remove', () => {
    it('keeps the previous item, marked out of stock, so Bazar archives the listing', async () => {
      const previous = await publishedPayload({}, TEMPLATE);
      const adapter = createBazarAdapter({ listingUrlTemplate: TEMPLATE });
      const outcome = await adapter.remove(
        listingInfo({ status: 'published', payload: previous }),
        // The property may already be gone (bulk delete).
        null,
        adapterContext(),
      );

      expect(outcome).toEqual({
        payload: { ...previous, availability: 'out_of_stock' },
        message:
          'Marked out of stock in the Bazar feed (Bazar archives the listing on its next scheduled download)',
        details: { feedItemId: 'IS-00012', availability: 'out_of_stock' },
      });
    });

    it('keeps the data Bazar last received, not later edits', async () => {
      const previous = await publishedPayload();
      const adapter = createBazarAdapter();
      const outcome = await adapter.remove(
        listingInfo({ status: 'published', payload: previous }),
        readyProperty({ price: 1, title: 'Друго заглавие' }),
        adapterContext(),
      );
      expect(outcome.payload).toMatchObject({ title: previous.title, price: previous.price });
    });

    it.each([
      ['no payload', null],
      ['a payload that is not a Bazar item', { offer_uid: 'IS-00012' }],
    ])('has nothing to remove when the listing has %s', async (_name, payload) => {
      const adapter = createBazarAdapter();
      const outcome = await adapter.remove(
        listingInfo({ status: 'error', payload }),
        readyProperty(),
        adapterContext(),
      );
      expect(outcome).toEqual({
        payload: null,
        message: 'Not in the Bazar feed, nothing to remove',
      });
    });
  });
});

describe('Bazar item mapping', () => {
  it('links to the listing only when a template is configured', async () => {
    expect((await publishedPayload()).link).toBeNull();
    expect((await publishedPayload({}, null)).link).toBeNull();
    expect((await publishedPayload({}, '  ')).link).toBeNull();
    expect(
      (
        await publishedPayload(
          { refCode: 'AG 7/1' },
          'https://agency.example/o/{refCode}?ref={refCode}',
        )
      ).link,
    ).toBe('https://agency.example/o/AG%207%2F1?ref=AG%207%2F1');
  });

  it('orders photos by sortOrder and sends at most 10 additional photos', async () => {
    const images = Array.from({ length: 13 }, (_, index) => photo(12 - index));
    const payload = await publishedPayload({ images });
    expect(payload.imageLink).toBe(`${BASE_URL}/uploads/properties/12/photo-1.jpg`);
    expect(payload.additionalImageLinks).toEqual(
      Array.from(
        { length: 10 },
        (_, index) => `${BASE_URL}/uploads/properties/12/photo-${index + 2}.jpg`,
      ),
    );
  });

  it.each([
    [245_000, '245000.00 EUR'],
    [750.5, '750.50 EUR'],
    [1_299.999, '1300.00 EUR'],
    [0.1 + 0.2, '0.30 EUR'],
  ])('formats the price %d as %j', (price, expected) => {
    expect(formatBazarPrice(price)).toBe(expected);
  });

  it.each([
    ['apartment', 'sale', 'Имоти > Продажби > Апартаменти'],
    ['apartment', 'rent', 'Имоти > Наеми > Апартаменти'],
    ['house', 'sale', 'Имоти > Продажби > Къщи'],
    ['office', 'rent', 'Имоти > Наеми > Офиси'],
    ['shop', 'rent', 'Имоти > Наеми > Магазини'],
    ['land', 'sale', 'Имоти > Продажби > Парцели и земя'],
    ['garage', 'sale', 'Имоти > Продажби > Гаражи'],
    ['other', 'rent', 'Имоти > Наеми > Други'],
  ] as const)('maps a %s for %s to %j', (type, dealType, expected) => {
    expect(bazarProductType(type, dealType)).toBe(expected);
  });

  it('gives every type and deal combination its own category path', () => {
    const paths = PROPERTY_TYPES.flatMap((type) =>
      DEAL_TYPES.map((dealType) => bazarProductType(type, dealType)),
    );
    expect(new Set(paths).size).toBe(PROPERTY_TYPES.length * DEAL_TYPES.length);
  });

  it('fills the custom labels with town, district, area and rooms', async () => {
    expect(
      await publishedPayload({ city: 'Plovdiv', district: 'Kapana', areaM2: 58.5, rooms: 2 }),
    ).toMatchObject({
      customLabel0: 'Пловдив',
      customLabel1: 'Kapana',
      customLabel2: '58,5 м²',
      customLabel3: '2',
    });
  });

  it('names the town and the district in Bulgarian when the geo list knows them', async () => {
    // As the registry wires it: Realistimo's geo list (here the committed subset).
    const adapter = createBazarAdapter({
      placeNames: placeNamesFrom(createGeoResolver({ csvPath: null })),
    });
    const labels = async (city: string, district: string | null) =>
      bazarItemPayloadSchema.parse(
        (await adapter.publish(readyProperty({ city, district }), listingInfo(), adapterContext()))
          .payload,
      );

    expect(await labels('Sofia', 'Lozenets')).toMatchObject({
      customLabel0: 'София',
      customLabel1: 'Лозенец',
    });
    expect(await labels('София', 'Лозенец')).toMatchObject({ customLabel1: 'Лозенец' });
    // A district the list does not know is used as entered; so is the town fallback list.
    expect(await labels('Sofia', 'Somewhere New')).toMatchObject({
      customLabel0: 'София',
      customLabel1: 'Somewhere New',
    });
    expect(await labels('Plovdiv', 'Kapana')).toMatchObject({ customLabel0: 'Пловдив' });
  });

  it('leaves out the labels it has no data for', async () => {
    expect(
      await publishedPayload({ type: 'land', district: '  ', areaM2: null, rooms: null }),
    ).toMatchObject({ customLabel1: null, customLabel2: null, customLabel3: null });
  });

  it('cuts a long title and description to the feed limits and says so', async () => {
    const adapter = createBazarAdapter();
    const title = `Тристаен апартамент ${'с гледка '.repeat(20)}`.trim();
    const description = 'Светъл апартамент. '.repeat(300);
    const outcome = await adapter.publish(
      readyProperty({ title, description }),
      listingInfo(),
      adapterContext(),
    );
    const payload = bazarItemPayloadSchema.parse(outcome.payload);

    expect(title.length).toBeGreaterThan(150);
    expect(payload.title.length).toBeLessThanOrEqual(150);
    expect(payload.title.endsWith('…')).toBe(true);
    expect(title.startsWith(payload.title.slice(0, -1))).toBe(true);
    expect(payload.description.length).toBeLessThanOrEqual(5000);
    expect(payload.description.endsWith('…')).toBe(true);
    expect(outcome.details).toMatchObject({ truncated: ['title', 'description'] });
  });

  it('puts the title on one line and strips characters XML cannot carry', () => {
    const { payload, truncated } = buildBazarItem(
      readyProperty({
        title: '  Тристаен\nапартамент\u0007  в Лозенец ',
        description: 'Описание\u0000 с\u000B контролни символи.\nВтори ред.',
      }),
    );
    expect(payload.title).toBe('Тристаен апартамент в Лозенец');
    expect(payload.description).toBe('Описание с контролни символи.\nВтори ред.');
    expect(truncated).toEqual([]);
  });

  it('refuses to build an item for a property that is not ready', () => {
    expect(() => buildBazarItem(readyProperty({ images: [] }))).toThrow(TypeError);
  });
});

describe('toBulgarianCityName', () => {
  it.each([
    ['Sofia', 'София'],
    ['sofiya', 'София'],
    ['  Plovdiv ', 'Пловдив'],
    ['VARNA', 'Варна'],
    ['Bourgas', 'Бургас'],
    ['Veliko Turnovo', 'Велико Търново'],
    ['veliko-tarnovo', 'Велико Търново'],
    ['Stara  Zagora', 'Стара Загора'],
    ['gr. Bansko', 'Банско'],
    ['Sunny Beach', 'Слънчев бряг'],
  ])('maps %j to %j', (city, expected) => {
    expect(toBulgarianCityName(city)).toBe(expected);
  });

  it('keeps Cyrillic names and unknown towns as entered', () => {
    expect(toBulgarianCityName(' Велико  Търново ')).toBe('Велико Търново');
    expect(toBulgarianCityName('Gorno Nanadolnishte')).toBe('Gorno Nanadolnishte');
  });
});
