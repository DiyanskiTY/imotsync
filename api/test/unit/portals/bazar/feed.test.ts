import { XMLParser } from 'fast-xml-parser';
import { describe, expect, it } from 'vitest';
import { createBazarAdapter } from '../../../../src/portals/bazar/adapter.js';
import {
  BAZAR_FEED_CONTENT_TYPE,
  GOOGLE_MERCHANT_NAMESPACE,
  createBazarFeedRenderer,
} from '../../../../src/portals/bazar/feed.js';
import type { BazarItemPayload } from '../../../../src/portals/bazar/payload.js';
import type { FeedItem } from '../../../../src/portals/types.js';
import { BASE_URL, adapterContext, feedItem, listingInfo, readyProperty } from './fixtures.js';

const NOW = new Date('2026-11-16T10:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY_MS);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  isArray: (name) => name === 'item' || name === 'g:additional_image_link',
});

interface ParsedFeed {
  '?xml': Record<string, string>;
  rss: {
    '@_version': string;
    '@_xmlns:g': string;
    channel: {
      title: string;
      link: string;
      description: string;
      lastBuildDate?: string;
      item?: Record<string, string | string[]>[];
    };
  };
}

function payload(overrides: Partial<BazarItemPayload> = {}): BazarItemPayload {
  return {
    id: 'IS-00001',
    title: 'Тристаен апартамент в Лозенец',
    description: 'Светъл тристаен апартамент на четвърти етаж.',
    link: 'https://agency.example/properties/IS-00001',
    imageLink: `${BASE_URL}/uploads/properties/1/a.jpg`,
    additionalImageLinks: [
      `${BASE_URL}/uploads/properties/1/b.jpg`,
      `${BASE_URL}/uploads/properties/1/c.jpg`,
    ],
    price: '245000.00 EUR',
    availability: 'in_stock',
    productType: 'Имоти > Продажби > Апартаменти',
    customLabel0: 'София',
    customLabel1: 'Lozenets',
    customLabel2: '98 м²',
    customLabel3: '3',
    ...overrides,
  };
}

function render(items: FeedItem[], removedRetentionDays = 30, publicBaseUrl = BASE_URL) {
  const renderer = createBazarFeedRenderer({ publicBaseUrl, removedRetentionDays });
  const xml = renderer.render(items, { now: NOW, publicBaseUrl });
  return { xml, feed: parser.parse(xml) as ParsedFeed };
}

const itemIds = (feed: ParsedFeed) => (feed.rss.channel.item ?? []).map((item) => item['g:id']);

describe('createBazarFeedRenderer', () => {
  it('serves XML in UTF-8', () => {
    const renderer = createBazarFeedRenderer({ publicBaseUrl: BASE_URL, removedRetentionDays: 30 });
    expect(renderer.contentType).toBe(BAZAR_FEED_CONTENT_TYPE);
    expect(renderer.contentType).toBe('application/xml; charset=utf-8');
  });

  it('refuses a negative retention period', () => {
    expect(() =>
      createBazarFeedRenderer({ publicBaseUrl: BASE_URL, removedRetentionDays: -1 }),
    ).toThrow(RangeError);
  });

  it('renders a Google Merchant RSS 2.0 document', () => {
    const { xml, feed } = render([feedItem(payload())]);

    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(feed.rss['@_version']).toBe('2.0');
    expect(feed.rss['@_xmlns:g']).toBe(GOOGLE_MERCHANT_NAMESPACE);
    expect(GOOGLE_MERCHANT_NAMESPACE).toBe('http://base.google.com/ns/1.0');
    expect(feed.rss.channel).toMatchObject({
      title: 'ImotSync – обяви за имоти',
      link: BASE_URL,
      description: 'Real estate listings published through ImotSync (Google Merchant feed).',
      lastBuildDate: 'Sun, 15 Nov 2026 09:00:00 GMT',
    });
  });

  it('renders every field of an item, in the documented order', () => {
    const { xml, feed } = render([feedItem(payload())]);

    expect(feed.rss.channel.item).toEqual([
      {
        'g:id': 'IS-00001',
        title: 'Тристаен апартамент в Лозенец',
        description: 'Светъл тристаен апартамент на четвърти етаж.',
        link: 'https://agency.example/properties/IS-00001',
        'g:image_link': `${BASE_URL}/uploads/properties/1/a.jpg`,
        'g:additional_image_link': [
          `${BASE_URL}/uploads/properties/1/b.jpg`,
          `${BASE_URL}/uploads/properties/1/c.jpg`,
        ],
        'g:price': '245000.00 EUR',
        'g:availability': 'in_stock',
        'g:product_type': 'Имоти > Продажби > Апартаменти',
        'g:custom_label_0': 'София',
        'g:custom_label_1': 'Lozenets',
        'g:custom_label_2': '98 м²',
        'g:custom_label_3': '3',
      },
    ]);

    const order = [...xml.matchAll(/^ {6}<([\w:]+)>/gm)].map((match) => match[1]);
    expect(order).toEqual([
      'g:id',
      'title',
      'description',
      'link',
      'g:image_link',
      'g:additional_image_link',
      'g:additional_image_link',
      'g:price',
      'g:availability',
      'g:product_type',
      'g:custom_label_0',
      'g:custom_label_1',
      'g:custom_label_2',
      'g:custom_label_3',
    ]);
  });

  it('leaves out the link, extra photos and labels that are not set', () => {
    const { feed } = render([
      feedItem(
        payload({
          link: null,
          additionalImageLinks: [],
          customLabel1: null,
          customLabel2: null,
          customLabel3: null,
        }),
      ),
    ]);
    const [item] = feed.rss.channel.item ?? [];
    expect(Object.keys(item ?? {})).toEqual([
      'g:id',
      'title',
      'description',
      'g:image_link',
      'g:price',
      'g:availability',
      'g:product_type',
      'g:custom_label_0',
    ]);
  });

  it('escapes &, <, > and quotes, and keeps Cyrillic text as it is', () => {
    const title = 'Къща "Слънце" & двор <600 кв.м> \'ново\'';
    const description = 'Цена < 300 000 € & > 250 000 €.\nВтори ред: "кавички".';
    const link = 'https://agency.example/o?id=IS-00001&lang=bg';
    const { xml, feed } = render([feedItem(payload({ title, description, link }))]);

    expect(xml).toContain('&amp;');
    expect(xml).toContain('&lt;600 кв.м&gt;');
    expect(xml).toContain('&quot;Слънце&quot;');
    expect(xml).toContain('?id=IS-00001&amp;lang=bg');
    expect(xml).not.toContain('<600');
    expect(xml).toContain('Къща');
    expect(xml).not.toMatch(/&#\d+;/);

    const [item] = feed.rss.channel.item ?? [];
    expect(item?.title).toBe(title);
    expect(item?.description).toBe(description);
    expect(item?.link).toBe(link);
  });

  it('drops characters XML cannot carry, even from a stored payload', () => {
    const { xml, feed } = render([feedItem(payload({ title: 'Тристаен\u0001 апартамент\uFFFF' }))]);
    // eslint-disable-next-line no-control-regex -- checking that control characters are gone.
    expect(xml).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFF]/);
    expect(feed.rss.channel.item?.[0]?.title).toBe('Тристаен апартамент');
  });

  describe('which listings are served', () => {
    it('serves published listings as in stock', () => {
      const { feed } = render([feedItem(payload())]);
      expect(feed.rss.channel.item?.[0]?.['g:availability']).toBe('in_stock');
    });

    it('serves recently removed listings as out of stock, so Bazar archives them', () => {
      const { feed } = render([
        feedItem(payload({ availability: 'out_of_stock' }), {
          status: 'removed',
          payloadUpdatedAt: daysAgo(29),
        }),
      ]);
      expect(feed.rss.channel.item?.[0]?.['g:availability']).toBe('out_of_stock');
    });

    it('lets the listing status decide availability over the stored value', () => {
      const { feed } = render([
        feedItem(payload({ id: 'IS-00001', availability: 'out_of_stock' })),
        feedItem(payload({ id: 'IS-00002', availability: 'in_stock' }), {
          status: 'removed',
          payloadUpdatedAt: daysAgo(1),
        }),
      ]);
      expect(feed.rss.channel.item?.map((item) => item['g:availability'])).toEqual([
        'in_stock',
        'out_of_stock',
      ]);
    });

    it('drops removed listings once the retention period is over', () => {
      const items = [
        feedItem(payload({ id: 'IS-00001' })),
        feedItem(payload({ id: 'IS-00002' }), { status: 'removed', payloadUpdatedAt: daysAgo(30) }),
        feedItem(payload({ id: 'IS-00003' }), {
          status: 'removed',
          payloadUpdatedAt: new Date(daysAgo(30).getTime() - 1),
        }),
      ];
      expect(itemIds(render(items, 30).feed)).toEqual(['IS-00001', 'IS-00002']);
      expect(itemIds(render(items, 7).feed)).toEqual(['IS-00001']);
      expect(itemIds(render(items, 0).feed)).toEqual(['IS-00001']);
    });

    it('skips stored payloads that are not Bazar items', () => {
      const { feed } = render([
        feedItem({ offer_uid: 'IS-00009', title: 'Друг портал' }),
        feedItem({ ...payload({ id: 'IS-00002' }), price: 245000 }),
        feedItem(payload({ id: 'IS-00001' })),
      ]);
      expect(itemIds(feed)).toEqual(['IS-00001']);
    });

    it('sorts items by id, so the same listings always give the same document', () => {
      const a = feedItem(payload({ id: 'IS-00003' }));
      const b = feedItem(payload({ id: 'IS-00001' }));
      const c = feedItem(payload({ id: 'IS-00002' }), {
        status: 'removed',
        payloadUpdatedAt: daysAgo(2),
      });
      const first = render([a, b, c]);
      expect(itemIds(first.feed)).toEqual(['IS-00001', 'IS-00002', 'IS-00003']);
      expect(render([c, a, b]).xml).toBe(first.xml);
    });
  });

  it('renders an empty channel when nothing is published', () => {
    const { feed } = render([
      feedItem(payload(), { status: 'removed', payloadUpdatedAt: daysAgo(60) }),
    ]);
    expect(feed.rss.channel.item).toBeUndefined();
    expect(feed.rss.channel.lastBuildDate).toBeUndefined();
    expect(feed.rss.channel.link).toBe(BASE_URL);
  });

  it('uses the newest served change as lastBuildDate', () => {
    const { feed } = render([
      feedItem(payload({ id: 'IS-00001' }), { payloadUpdatedAt: daysAgo(3) }),
      feedItem(payload({ id: 'IS-00002' }), { payloadUpdatedAt: new Date('2026-11-16T08:15:00Z') }),
    ]);
    expect(feed.rss.channel.lastBuildDate).toBe('Mon, 16 Nov 2026 08:15:00 GMT');
  });

  it('takes the channel link from the render context, without a trailing slash', () => {
    const renderer = createBazarFeedRenderer({
      publicBaseUrl: 'https://fallback.example',
      removedRetentionDays: 30,
    });
    const fromContext = parser.parse(
      renderer.render([], { now: NOW, publicBaseUrl: 'https://imotsync.example/' }),
    ) as ParsedFeed;
    const fromOptions = parser.parse(
      renderer.render([], { now: NOW, publicBaseUrl: '' }),
    ) as ParsedFeed;
    expect(fromContext.rss.channel.link).toBe('https://imotsync.example');
    expect(fromOptions.rss.channel.link).toBe('https://fallback.example');
  });

  it('serves what the adapter stored: publish, then remove', async () => {
    const adapter = createBazarAdapter({
      listingUrlTemplate: 'https://agency.example/properties/{refCode}',
    });
    const property = readyProperty({ title: 'Двустаен апартамент & паркомясто' });
    const published = await adapter.publish(property, listingInfo(), adapterContext());
    const removed = await adapter.remove(
      listingInfo({ status: 'published', payload: published.payload ?? null }),
      property,
      adapterContext(),
    );

    const live = render([
      feedItem(published.payload ?? {}, { refCode: property.refCode, payloadUpdatedAt: NOW }),
    ]);
    expect(live.feed.rss.channel.item?.[0]).toMatchObject({
      'g:id': 'IS-00012',
      title: 'Двустаен апартамент & паркомясто',
      link: 'https://agency.example/properties/IS-00012',
      'g:price': '245000.00 EUR',
      'g:availability': 'in_stock',
      'g:custom_label_0': 'София',
    });

    const archived = render([
      feedItem(removed.payload ?? {}, {
        refCode: property.refCode,
        status: 'removed',
        payloadUpdatedAt: NOW,
      }),
    ]);
    expect(archived.feed.rss.channel.item?.[0]).toMatchObject({
      'g:id': 'IS-00012',
      'g:availability': 'out_of_stock',
    });
  });
});

describe('Last-Modified of the Bazar feed', () => {
  const renderer = createBazarFeedRenderer({ publicBaseUrl: BASE_URL, removedRetentionDays: 30 });
  const lastModified = (items: FeedItem[], now = NOW, lastChangedAt: Date | null = null) =>
    renderer
      .lastModified?.(items, { now, publicBaseUrl: BASE_URL, lastChangedAt })
      ?.toISOString() ?? null;

  it('is the newest stored change, or ctx.lastChangedAt when that is later', () => {
    const items = [
      feedItem(payload({ id: 'IS-00001' }), { payloadUpdatedAt: daysAgo(3) }),
      feedItem(payload({ id: 'IS-00002' }), { status: 'removed', payloadUpdatedAt: daysAgo(2) }),
    ];

    expect(lastModified(items)).toBe(daysAgo(2).toISOString());
    expect(lastModified(items, NOW, daysAgo(1))).toBe(daysAgo(1).toISOString());
    expect(lastModified([])).toBeNull();
    expect(lastModified([], NOW, daysAgo(1))).toBe(daysAgo(1).toISOString());
  });

  it('moves when a removed listing drops out after the retention period', () => {
    const removedAt = daysAgo(31);
    const items = [
      feedItem(payload({ id: 'IS-00001' }), { payloadUpdatedAt: daysAgo(40) }),
      feedItem(payload({ id: 'IS-00002' }), { status: 'removed', payloadUpdatedAt: removedAt }),
    ];
    const droppedAt = new Date(removedAt.getTime() + 30 * DAY_MS);
    const justBefore = new Date(droppedAt.getTime() - 1000);

    // Before the drop the listing is served and the document is unchanged since its removal.
    expect(
      itemIds(
        parser.parse(
          renderer.render(items, { now: justBefore, publicBaseUrl: BASE_URL }),
        ) as ParsedFeed,
      ),
    ).toEqual(['IS-00001', 'IS-00002']);
    expect(lastModified(items, justBefore)).toBe(removedAt.toISOString());
    // Afterwards it is gone, and Last-Modified says when that happened.
    expect(itemIds(render(items).feed)).toEqual(['IS-00001']);
    expect(lastModified(items)).toBe(droppedAt.toISOString());
  });
});
