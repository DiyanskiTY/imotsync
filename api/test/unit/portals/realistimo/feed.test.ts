import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { describe, expect, it } from 'vitest';
import {
  createRealistimoFeedRenderer,
  REALISTIMO_FEED_CONTENT_TYPE,
  realistimoFeedLastModified,
  realistimoFeedUpdated,
} from '../../../../src/portals/realistimo/feed.js';
import { buildRealistimoOffer } from '../../../../src/portals/realistimo/offer.js';
import type { FeedItem, FeedPayload, PortalProperty } from '../../../../src/portals/types.js';
import { makeProperty } from './fixtures.js';

const renderer = createRealistimoFeedRenderer({ agencyUid: 'imotsync-demo' });
const NOW = new Date('2026-01-20T10:00:00Z');
const ctx = { now: NOW, publicBaseUrl: 'http://localhost:3000' };

const parser = new XMLParser({
  parseTagValue: false,
  isArray: (name) => name === 'offer' || name === 'Broker',
});

interface ParsedFeed {
  feed: {
    updated: string;
    agency_uid: string;
    Brokers: '' | { Broker: Record<string, string>[] };
    offers: '' | { offer: Record<string, string>[] };
  };
}

function parse(xml: string): ParsedFeed {
  return parser.parse(xml) as ParsedFeed;
}

function offersOf(xml: string): Record<string, string>[] {
  const { offers } = parse(xml).feed;
  return offers === '' ? [] : offers.offer;
}

function brokersOf(xml: string): Record<string, string>[] {
  const { Brokers } = parse(xml).feed;
  return Brokers === '' ? [] : Brokers.Broker;
}

function item(
  property: Partial<PortalProperty>,
  payloadUpdatedAt = new Date('2026-01-18T08:00:00Z'),
  status: FeedItem['status'] = 'published',
): FeedItem {
  const full = makeProperty(property);
  return {
    refCode: full.refCode,
    status,
    payload: buildRealistimoOffer(full, 8621),
    payloadUpdatedAt,
  };
}

describe('Realistimo feed renderer', () => {
  it('serves UTF-8 XML', () => {
    const xml = renderer.render([item({})], ctx);

    expect(renderer.contentType).toBe(REALISTIMO_FEED_CONTENT_TYPE);
    expect(renderer.contentType).toBe('application/xml; charset=utf-8');
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<feed>')).toBe(true);
    expect(XMLValidator.validate(xml)).toBe(true);
  });

  it('renders feed, Brokers and offers with the documented element names', () => {
    const xml = renderer.render([item({})], ctx);
    const { feed } = parse(xml);

    expect(feed.updated).toBe('2026-01-18 10:00:00');
    expect(feed.agency_uid).toBe('imotsync-demo');
    expect(brokersOf(xml)).toEqual([
      { BrokerID: 'imotsync-2', BrokerName: 'Demo Broker', BrokerEmail: 'broker@imotsync.local' },
    ]);
    expect(offersOf(xml)).toEqual([
      {
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
      },
    ]);
  });

  it('writes the elements in the documented order, feed header first', () => {
    const xml = renderer.render([item({})], ctx);
    const topLevel = [...xml.matchAll(/^ {2}<(\w+)>/gm)].map((match) => match[1]);
    const offerChildren = [...xml.matchAll(/^ {6}<(\w+)>/gm)].map((match) => match[1]);

    expect(topLevel).toEqual(['updated', 'agency_uid', 'Brokers', 'offers']);
    expect(offerChildren).toEqual([
      // <Broker> children come first in the document.
      'BrokerID',
      'BrokerName',
      'BrokerEmail',
      'offer_uid',
      'last_update',
      'offer_code',
      'title',
      'description',
      'images',
      'price',
      'surface',
      'currency',
      'category',
      'subcategory',
      'internal_id',
      'floor',
      'floorAll',
      'rooms_count',
      'broker_id',
    ]);
  });

  it('escapes &, <, > and quotes and keeps Cyrillic as UTF-8 text', () => {
    const tricky = 'Къща "Слънце" & двор <500 м²> за \'семейство\'';
    const xml = renderer.render([item({ title: tricky, description: tricky })], ctx);

    expect(xml).toContain(
      '<title>Къща &quot;Слънце&quot; &amp; двор &lt;500 м²&gt; за &apos;семейство&apos;</title>',
    );
    expect(xml).not.toContain('&#');
    expect(XMLValidator.validate(xml)).toBe(true);
    expect(offersOf(xml)[0]?.title).toBe(tricky);
    expect(offersOf(xml)[0]?.description).toBe(tricky);
  });

  it('cannot be broken out of with markup in the data', () => {
    const xml = renderer.render(
      [item({ title: '</title></offer><offer><offer_uid>evil</offer_uid>' })],
      ctx,
    );

    expect(offersOf(xml)).toHaveLength(1);
    expect(offersOf(xml)[0]?.offer_uid).toBe('IS-00001');
  });

  it('keeps line breaks and drops characters XML cannot carry', () => {
    const xml = renderer.render(
      [item({ description: 'Ред 1\nРед 2\u0000\u0007\u001F\uFFFE край' })],
      ctx,
    );

    expect(XMLValidator.validate(xml)).toBe(true);
    expect(offersOf(xml)[0]?.description).toBe('Ред 1\nРед 2 край');
  });

  it('renders only published listings', () => {
    // A removed listing whose payload was kept (another adapter's choice, or older data):
    // still left out, as is its broker.
    const removedWithOffer = item(
      { refCode: 'IS-00009', broker: { id: 7, fullName: 'Ива Петрова', email: 'iva@example.bg' } },
      NOW,
      'removed',
    );

    const xml = renderer.render([item({}), removedWithOffer], ctx);

    expect(offersOf(xml).map((offer) => offer.offer_uid)).toEqual(['IS-00001']);
    // One <Broker> per distinct broker of the INCLUDED offers only.
    expect(brokersOf(xml).map((broker) => broker.BrokerID)).toEqual(['imotsync-2']);
  });

  it('lists each broker once, with the newest details, sorted by id', () => {
    const admin = { id: 1, fullName: 'Demo Admin', email: 'admin@imotsync.local' };
    const xml = renderer.render(
      [
        item({ refCode: 'IS-00003', broker: admin }, new Date('2026-01-10T08:00:00Z')),
        item(
          { refCode: 'IS-00002', broker: { ...admin, fullName: 'Renamed Admin' } },
          new Date('2026-01-12T08:00:00Z'),
        ),
        item({ refCode: 'IS-00001' }),
      ],
      ctx,
    );

    expect(brokersOf(xml)).toEqual([
      { BrokerID: 'imotsync-1', BrokerName: 'Renamed Admin', BrokerEmail: 'admin@imotsync.local' },
      { BrokerID: 'imotsync-2', BrokerName: 'Demo Broker', BrokerEmail: 'broker@imotsync.local' },
    ]);
    expect(offersOf(xml).map((offer) => offer.offer_uid)).toEqual([
      'IS-00001',
      'IS-00002',
      'IS-00003',
    ]);
  });

  it('is deterministic: the same items give the same document in any order', () => {
    const items = [item({ refCode: 'IS-00002' }), item({ refCode: 'IS-00001' })];

    expect(renderer.render(items, ctx)).toBe(renderer.render([...items].reverse(), ctx));
  });

  it('falls back to the ref code for a payload without offer_uid', () => {
    const payload: FeedPayload = { ...buildRealistimoOffer(makeProperty(), 1) };
    delete payload.offer_uid;

    const xml = renderer.render(
      [{ refCode: 'IS-00077', status: 'published', payload, payloadUpdatedAt: NOW }],
      ctx,
    );

    expect(offersOf(xml)[0]?.offer_uid).toBe('IS-00077');
  });

  it('renders an empty feed with its header', () => {
    const xml = renderer.render([], ctx);

    expect(XMLValidator.validate(xml)).toBe(true);
    expect(parse(xml).feed.agency_uid).toBe('imotsync-demo');
    expect(offersOf(xml)).toEqual([]);
    expect(brokersOf(xml)).toEqual([]);
    expect(xml).toContain('<offers></offers>');
  });
});

describe('the feed <updated> value', () => {
  const at = (iso: string, status: FeedItem['status'] = 'published'): FeedItem => ({
    refCode: iso,
    status,
    payload: {},
    payloadUpdatedAt: new Date(iso),
  });

  it('is the newest payload change, in Bulgarian time', () => {
    expect(
      realistimoFeedUpdated([at('2026-01-18T08:00:00Z'), at('2026-01-19T21:30:15Z')], NOW),
    ).toBe('2026-01-19 23:30:15');
  });

  it('counts removals, so taking an offer out changes <updated>', () => {
    const before = renderer.render([item({})], ctx);
    const after = renderer.render(
      [
        item({}),
        {
          refCode: 'IS-00008',
          status: 'removed',
          payload: { offer_uid: 'IS-00008', removed: true },
          payloadUpdatedAt: new Date('2026-01-19T12:00:00Z'),
        },
      ],
      ctx,
    );

    expect(parse(before).feed.updated).toBe('2026-01-18 10:00:00');
    expect(parse(after).feed.updated).toBe('2026-01-19 14:00:00');
  });

  it('is never more than 7 days old: then it is the start of the current day', () => {
    expect(realistimoFeedUpdated([at('2026-01-13T10:00:00Z')], NOW)).toBe('2026-01-13 12:00:00');
    expect(realistimoFeedUpdated([at('2026-01-13T09:59:59Z')], NOW)).toBe('2026-01-20 00:00:00');
    expect(realistimoFeedUpdated([at('2025-06-01T00:00:00Z')], NOW)).toBe('2026-01-20 00:00:00');
  });

  it('takes a change the items cannot show into account (a deleted listing)', () => {
    const items = [at('2026-01-18T08:00:00Z')];

    expect(realistimoFeedUpdated(items, NOW, new Date('2026-01-19T12:00:00Z'))).toBe(
      '2026-01-19 14:00:00',
    );
    expect(realistimoFeedUpdated(items, NOW, new Date('2026-01-01T12:00:00Z'))).toBe(
      '2026-01-18 10:00:00',
    );
    expect(realistimoFeedUpdated([], NOW, new Date('2026-01-19T12:00:00Z'))).toBe(
      '2026-01-19 14:00:00',
    );
  });

  it('uses the start of the Bulgarian day, which can be ahead of the UTC date', () => {
    const lateEvening = new Date('2026-01-20T22:30:00Z');

    expect(realistimoFeedUpdated([], lateEvening)).toBe('2026-01-21 00:00:00');
  });
});

describe('the renderer and ctx.lastChangedAt (a listing deleted with its property)', () => {
  it('moves <updated> to the deletion, so Realistimo imports the feed without the offer', () => {
    const items = [item({}, new Date('2026-01-18T08:00:00Z'))];
    const deletedAt = new Date('2026-01-19T12:00:00Z');

    expect(parse(renderer.render(items, ctx)).feed.updated).toBe('2026-01-18 10:00:00');
    expect(parse(renderer.render(items, { ...ctx, lastChangedAt: deletedAt })).feed.updated).toBe(
      '2026-01-19 14:00:00',
    );
    expect(parse(renderer.render(items, { ...ctx, lastChangedAt: null })).feed.updated).toBe(
      '2026-01-18 10:00:00',
    );
  });
});

describe('Last-Modified of the Realistimo feed', () => {
  const at = (iso: string): FeedItem => ({
    refCode: iso,
    status: 'published',
    payload: {},
    payloadUpdatedAt: new Date(iso),
  });
  const lastModified = (items: FeedItem[], now: Date, lastChangedAt: Date | null = null) =>
    renderer.lastModified?.(items, { now, publicBaseUrl: '', lastChangedAt })?.toISOString();

  it('is the newest change while <updated> shows it', () => {
    expect(lastModified([at('2026-01-18T08:00:00Z'), at('2026-01-19T21:30:15Z')], NOW)).toBe(
      '2026-01-19T21:30:15.000Z',
    );
    expect(lastModified([at('2026-01-18T08:00:00Z')], NOW, new Date('2026-01-19T12:00:00Z'))).toBe(
      '2026-01-19T12:00:00.000Z',
    );
    expect(
      realistimoFeedLastModified([], NOW, new Date('2026-01-19T12:00:00Z')).toISOString(),
    ).toBe('2026-01-19T12:00:00.000Z');
  });

  it('follows <updated> when it rolls over to the start of the current day', () => {
    // Newest change 2026-01-10 10:00 UTC: 7 days later (2026-01-17 10:00 UTC) <updated>
    // switches to the start of the day, then changes every midnight in Bulgarian time.
    const items = [at('2026-01-10T10:00:00Z')];

    expect(lastModified(items, new Date('2026-01-17T09:00:00Z'))).toBe('2026-01-10T10:00:00.000Z');
    expect(lastModified(items, new Date('2026-01-17T15:00:00Z'))).toBe('2026-01-17T10:00:00.000Z');
    expect(lastModified(items, NOW)).toBe('2026-01-19T22:00:00.000Z');
  });

  it('is the start of the current day for a feed that never changed', () => {
    expect(lastModified([], NOW)).toBe('2026-01-19T22:00:00.000Z');
  });

  it('changes exactly when the rendered document changes', () => {
    const items = [at('2026-01-10T10:00:00Z')];
    const moments = ['2026-01-17T09:59:59Z', '2026-01-17T10:00:01Z', '2026-01-17T21:59:59Z'];
    const render = (iso: string) =>
      renderer.render(items, { now: new Date(iso), publicBaseUrl: '' });

    // Same Last-Modified, same document; a later Last-Modified, a different document.
    expect(render('2026-01-17T10:00:01Z')).toBe(render('2026-01-17T21:59:59Z'));
    expect(lastModified(items, new Date(moments[1] ?? ''))).toBe(
      lastModified(items, new Date(moments[2] ?? '')),
    );
    expect(render('2026-01-17T09:59:59Z')).not.toBe(render('2026-01-17T10:00:01Z'));
    expect(render('2026-01-17T21:59:59Z')).not.toBe(render('2026-01-17T22:00:01Z'));
    expect(lastModified(items, new Date('2026-01-17T22:00:01Z'))).toBe('2026-01-17T22:00:00.000Z');
  });
});
