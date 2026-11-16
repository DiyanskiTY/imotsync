import { XMLParser, XMLValidator } from 'fast-xml-parser';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PortalListingRow } from '../../src/db/types.js';
import { runDemoSeed } from '../../src/db/seeds/demo-seed.js';
import { feedLastChanged } from '../../src/portals/feed-items.js';
import { createPortalRegistry } from '../../src/portals/registry.js';
import { formatSofiaDateTime } from '../../src/portals/realistimo/time.js';
import { expectDocumented } from '../support/openapi.js';
import {
  authHeader,
  closeApiFixture,
  DEMO_PASSWORD,
  startApiFixture,
  type ApiFixture,
} from './api-fixture.js';
import { insertListing, insertProperty } from './publishing-fixture.js';

/*
 * GET /feeds/<portal>/<token>.xml against the database: the demo data loaded with the real
 * adapters (what `npm run db:reset` leaves), the token, removed listings and deleted ones.
 */

let fx: ApiFixture;
let token: string;
const FEED_PATH = '/feeds/{portal}/{token}.xml';
const DAY_MS = 24 * 60 * 60 * 1000;

const parser = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: false,
  isArray: (name) => ['offer', 'Broker', 'item', 'g:additional_image_link'].includes(name),
});

interface RealistimoFeed {
  feed: {
    updated: string;
    Brokers: '' | { Broker: Record<string, string>[] };
    offers: '' | { offer: Record<string, string>[] };
  };
}
interface BazarFeed {
  rss: { channel: { item?: Record<string, string | string[]>[] } };
}

beforeAll(async () => {
  fx = await startApiFixture();
  token = fx.config.feeds.token;
  // What `npm run db:reset` does: the demo data with the payloads of the registered adapters.
  await runDemoSeed(fx.db, {
    uploadDir: fx.uploadDir,
    demoPassword: DEMO_PASSWORD,
    registry: createPortalRegistry(fx.config),
    publicBaseUrl: fx.config.publicBaseUrl,
  });
});

afterAll(async () => {
  await closeApiFixture(fx);
});

const getFeed = (portal: string, feedToken = token) =>
  request(fx.app).get(`/feeds/${portal}/${feedToken}.xml`);

async function realistimoOffers() {
  const res = await getFeed('realistimo');
  expect(res.status).toBe(200);
  const { feed } = parser.parse(res.text) as RealistimoFeed;
  return { res, feed, offers: feed.offers === '' ? [] : feed.offers.offer };
}

async function bazarItems() {
  const res = await getFeed('bazar');
  expect(res.status).toBe(200);
  return { res, items: (parser.parse(res.text) as BazarFeed).rss.channel.item ?? [] };
}

/** Listings with a payload, with their reference codes. */
async function listingsWithPayload(portal: string) {
  return fx
    .db('portal_listings')
    .join('properties', 'properties.id', 'portal_listings.property_id')
    .where('portal_listings.portal', portal)
    .whereNotNull('portal_listings.payload')
    .orderBy('properties.ref_code')
    .select<(PortalListingRow & { ref_code: string })[]>(
      'portal_listings.*',
      'properties.ref_code',
    );
}

describe('the feeds after the demo data is loaded', () => {
  it('lists every seeded Realistimo offer that is online, as valid XML', async () => {
    const { res, feed, offers } = await realistimoOffers();

    expectDocumented(res, 'get', FEED_PATH);
    expect(XMLValidator.validate(res.text)).toBe(true);
    const online = (await listingsWithPayload('realistimo')).filter((l) => l.removed_at === null);
    expect(online.length).toBeGreaterThan(3);
    expect(offers.map((offer) => offer.offer_uid)).toEqual(online.map((l) => l.ref_code));
    for (const offer of offers) {
      expect(offer.internal_id, offer.offer_uid).toMatch(/^\d+$/);
      // The seed builds the photo URLs from PUBLIC_BASE_URL, whatever the developer's .env says.
      expect(
        offer.images?.startsWith(`${fx.config.publicBaseUrl}/uploads/demo/`),
        offer.offer_uid,
      ).toBe(true);
    }
    expect(feed.Brokers === '' ? [] : feed.Brokers.Broker).not.toEqual([]);
  });

  it('lists the seeded Bazar listings, the removed ones as out of stock', async () => {
    const { res, items } = await bazarItems();

    expectDocumented(res, 'get', FEED_PATH);
    expect(XMLValidator.validate(res.text)).toBe(true);
    const listings = await listingsWithPayload('bazar');
    expect(listings.some((l) => l.removed_at === null)).toBe(true);
    expect(listings.some((l) => l.removed_at !== null)).toBe(true);
    expect(items.map((item) => [item['g:id'], item['g:availability']])).toEqual(
      listings.map((l) => [l.ref_code, l.removed_at === null ? 'in_stock' : 'out_of_stock']),
    );
  });

  it('serves nothing for a wrong token, an unknown portal or the push portal', async () => {
    for (const res of [
      await getFeed('realistimo', `${token}x`),
      await getFeed('bazar', 'another-token-123'),
      await getFeed('imotbg'),
      await getFeed('demo'),
    ]) {
      expect(res.status).toBe(404);
      expect(res.text).toBe('Not Found');
      expectDocumented(res, 'get', FEED_PATH);
    }
  });

  it('is listed with its URL in GET /api/portals', async () => {
    const res = await request(fx.app)
      .get('/api/portals')
      .set(await authHeader(fx.app));

    expect(res.body).toMatchObject({
      data: [
        {
          key: 'realistimo',
          mode: 'feed',
          feedUrl: `${fx.config.publicBaseUrl}/feeds/realistimo/${token}.xml`,
        },
        {
          key: 'bazar',
          mode: 'feed',
          feedUrl: `${fx.config.publicBaseUrl}/feeds/bazar/${token}.xml`,
        },
        { key: 'demo', mode: 'push', feedUrl: null },
      ],
    });
  });
});

describe('removed and deleted listings', () => {
  it('drops a removed Bazar listing after BAZAR_REMOVED_RETENTION_DAYS', async () => {
    const retention = fx.config.portals.bazar.removedRetentionDays;
    const propertyId = await insertProperty(fx);
    const refCode = (await fx.db('properties').where({ id: propertyId }).first())?.ref_code;
    const removedAt = new Date(Date.now() - (retention + 1) * DAY_MS);
    const listingId = await insertListing(fx, propertyId, 'bazar', {
      status: 'removed',
      published_at: new Date(removedAt.getTime() - DAY_MS),
      removed_at: removedAt,
      payload: JSON.stringify({
        id: refCode,
        title: 'Стар имот',
        description: 'Свален от продажба.',
        link: null,
        imageLink: 'http://localhost:3000/uploads/x.jpg',
        additionalImageLinks: [],
        price: '1000.00 EUR',
        availability: 'out_of_stock',
        productType: 'Имоти > Продажби > Апартаменти',
        customLabel0: 'София',
        customLabel1: null,
        customLabel2: null,
        customLabel3: null,
      }),
      payload_updated_at: removedAt,
    });

    const ids = (await bazarItems()).items.map((item) => item['g:id']);
    expect(ids).not.toContain(refCode);

    // Within the retention period it is served, out of stock.
    await fx
      .db('portal_listings')
      .where({ id: listingId })
      .update({ payload_updated_at: new Date(Date.now() - (retention - 1) * DAY_MS) });
    const item = (await bazarItems()).items.find((entry) => entry['g:id'] === refCode);
    expect(item?.['g:availability']).toBe('out_of_stock');
  });

  it('keeps the last change of the feed when a property with a removed offer is deleted', async () => {
    const auth = await authHeader(fx.app);
    // A removed Realistimo offer has no payload (it is left out of the feed), but the removal
    // is dated: it moved <updated>, so Realistimo imported the feed that drops the offer.
    const removed = await fx
      .db('portal_listings')
      .where({ portal: 'realistimo' })
      .whereNotNull('removed_at')
      .whereNotNull('payload_updated_at')
      .first();
    if (!removed) throw new Error('The demo data has no removed Realistimo listing');
    expect(removed.payload).toBeNull();
    const others = await fx
      .db('portal_listings')
      .where({ property_id: removed.property_id })
      .whereNot({ id: removed.id });
    // DELETE is refused (or deferred) while another portal still shows the property.
    await fx
      .db('portal_listings')
      .whereIn(
        'id',
        others.map((l) => l.id),
      )
      .delete();
    // Every other change two days back: the removal, a day ago, is the newest one.
    const twoDaysAgo = new Date(Math.floor((Date.now() - 2 * DAY_MS) / 1000) * 1000);
    const oneDayAgo = new Date(twoDaysAgo.getTime() + DAY_MS);
    await fx
      .db('portal_listings')
      .where({ portal: 'realistimo' })
      .whereNotNull('payload_updated_at')
      .update({ payload_updated_at: twoDaysAgo });
    await fx
      .db('portal_listings')
      .where({ id: removed.id })
      .update({ payload_updated_at: oneDayAgo });
    const before = await realistimoOffers();
    expect(before.feed.updated).toBe(formatSofiaDateTime(oneDayAgo));

    const res = await request(fx.app).delete(`/api/properties/${removed.property_id}`).set(auth);
    expect(res.status).toBe(204);

    // The listing row is gone, but its removal date is kept: <updated> does not fall back to
    // two days ago (Realistimo would take that as an older feed).
    const state = await fx.db('portal_sync_state').where({ portal: 'realistimo' }).first();
    expect(state?.feed_changed_at).toEqual(oneDayAgo);
    expect(await feedLastChanged(fx.db, 'realistimo')).toEqual(oneDayAgo);
    const after = await realistimoOffers();
    expect(after.feed.updated).toBe(formatSofiaDateTime(oneDayAgo));
    expect(after.res.headers['last-modified']).toBe(oneDayAgo.toUTCString());
    // The feed itself did not change: the offer had already left it.
    expect(after.res.text).toBe(before.res.text);
    const conditional = await getFeed('realistimo').set(
      'If-Modified-Since',
      String(before.res.headers['last-modified']),
    );
    expect(conditional.status).toBe(304);
  });
});
