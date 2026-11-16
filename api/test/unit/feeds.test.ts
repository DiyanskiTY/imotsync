import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import net from 'node:net';
import { Writable } from 'node:stream';
import type { Knex } from 'knex';
import { pino } from 'pino';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { createLogger } from '../../src/logger.js';
import { redactFeedToken } from '../../src/middleware/request-logger.js';
import {
  createFeedsService,
  FEED_CACHE_MAX_AGE_MS,
  FEED_CACHE_SETTLE_MS,
  isNotModified,
} from '../../src/modules/feeds/feeds.service.js';
import { createDemoAdapter } from '../../src/portals/demo/demo-adapter.js';
import { registryFrom } from '../../src/portals/registry.js';
import type {
  FeedItem,
  FeedRenderContext,
  FeedRenderer,
  PortalAdapter,
} from '../../src/portals/types.js';
import { expectDocumented } from '../support/openapi.js';
import { healthyDb, makeConfig } from './helpers.js';

/*
 * GET /feeds/<portal>/<token>.xml without a database: the listing rows come from a fake
 * query chain, so these tests cover the routing, the token check and the HTTP caching rules.
 * The integration tests (feeds.int.test.ts) cover the feeds built from real jobs.
 */

const TOKEN = 'unit-feed-token_123';
const FEED_PATH = '/feeds/{portal}/{token}.xml';

const feedAdapter: PortalAdapter = {
  key: 'feedy',
  displayName: 'Feedy',
  mode: 'feed',
  validate: () => [],
  publish: () => Promise.resolve({ message: 'ok' }),
  update: () => Promise.resolve({ message: 'ok' }),
  remove: () => Promise.resolve({ message: 'ok' }),
};

/** A renderer that lists the items it got and remembers its context. */
function recordingRenderer() {
  const calls: { items: FeedItem[]; ctx: FeedRenderContext }[] = [];
  const renderer: FeedRenderer = {
    contentType: 'application/xml; charset=utf-8',
    render(items, ctx) {
      calls.push({ items, ctx });
      const offers = items.map((item) => `<offer id="${item.refCode}" status="${item.status}"/>`);
      return `<?xml version="1.0" encoding="UTF-8"?>\n<feed>${offers.join('')}</feed>`;
    },
  };
  return { renderer, calls };
}

const LISTINGS = [
  {
    ref_code: 'IS-00001',
    payload: { title: 'Апартамент' },
    payload_updated_at: new Date('2026-11-10T08:00:00.700Z'),
    removed_at: null,
  },
  {
    ref_code: 'IS-00002',
    payload: { title: 'Къща' },
    payload_updated_at: new Date('2026-11-12T09:30:00Z'),
    removed_at: new Date('2026-11-12T09:30:00Z'),
  },
];

function feedApp(
  options: { syncState?: unknown[]; renderer?: FeedRenderer; tables?: string[] } = {},
) {
  const config = makeConfig({ FEED_TOKEN: TOKEN, PUBLIC_BASE_URL: 'https://imotsync.example' });
  const recording = recordingRenderer();
  const base = healthyDb({
    portal_listings: LISTINGS,
    portal_sync_state: options.syncState ?? [],
  });
  const tables = options.tables ?? [];
  const db = Object.assign(
    (table: string) => {
      tables.push(table);
      return (base as unknown as (table: string) => unknown)(table);
    },
    { raw: base.raw.bind(base) },
  ) as unknown as Knex;
  const app = createApp({
    config,
    logger: createLogger(config),
    db,
    registry: registryFrom([
      { adapter: createDemoAdapter({ failureRate: 0, latencyMs: 0 }) },
      { adapter: feedAdapter, feedRenderer: options.renderer ?? recording.renderer },
    ]),
  });
  return { app, calls: recording.calls, tables };
}

describe('GET /feeds/:portal/:token.xml', () => {
  it('serves the rendered feed with its content type and cache headers', async () => {
    const { app, calls } = feedApp();

    const res = await request(app).get(`/feeds/feedy/${TOKEN}.xml`);

    expect(res.status).toBe(200);
    expectDocumented(res, 'get', FEED_PATH);
    expect(res.headers['content-type']).toBe('application/xml; charset=utf-8');
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.headers.etag).toMatch(/^"[A-Za-z0-9_-]{43}"$/);
    // The newest payload change, in whole seconds.
    expect(res.headers['last-modified']).toBe('Thu, 12 Nov 2026 09:30:00 GMT');
    expect(res.text).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\n<feed><offer id="IS-00001" status="published"/>' +
        '<offer id="IS-00002" status="removed"/></feed>',
    );
    expect(calls[0]?.ctx).toMatchObject({ publicBaseUrl: 'https://imotsync.example' });
  });

  it('hands the renderer the feed change time recorded for deleted listings', async () => {
    const deletedAt = new Date('2026-11-14T07:00:00Z');
    const { app, calls } = feedApp({ syncState: [{ feed_changed_at: deletedAt }] });

    const res = await request(app).get(`/feeds/feedy/${TOKEN}.xml`);

    expect(res.status).toBe(200);
    expect(calls[0]?.ctx.lastChangedAt).toEqual(deletedAt);
    expect(res.headers['last-modified']).toBe(deletedAt.toUTCString());
  });

  it('uses the Last-Modified the renderer reports, but never one in the future', async () => {
    const { renderer } = recordingRenderer();
    const later = feedApp({
      renderer: { ...renderer, lastModified: () => new Date('2026-11-15T10:00:00Z') },
    });
    const future = feedApp({
      renderer: { ...renderer, lastModified: () => new Date(Date.now() + 86_400_000) },
    });

    const res = await request(later.app).get(`/feeds/feedy/${TOKEN}.xml`);
    const futureRes = await request(future.app).get(`/feeds/feedy/${TOKEN}.xml`);

    expect(res.headers['last-modified']).toBe('Sun, 15 Nov 2026 10:00:00 GMT');
    const served = Date.parse(String(futureRes.headers['last-modified']));
    expect(served).toBeLessThanOrEqual(Date.now());
  });

  it.each([
    ['a wrong token', `/feeds/feedy/wrong-token-1234.xml`],
    ['a token that differs in one character', `/feeds/feedy/${TOKEN.slice(0, -1)}4.xml`],
    ['an empty-looking token', '/feeds/feedy/.xml'],
    ['an unknown portal', `/feeds/nope/${TOKEN}.xml`],
    ['a push portal, which has no feed', `/feeds/demo/${TOKEN}.xml`],
    ['another file name', `/feeds/feedy/${TOKEN}.json`],
    ['the folder', '/feeds/feedy'],
    ['the feeds root', '/feeds'],
  ])('answers the same plain-text 404 for %s', async (_label, url) => {
    const { app, tables } = feedApp();

    const res = await request(app).get(url);

    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(res.text).toBe('Not Found');
    // Nothing is read from the database before the token is checked.
    expect(tables).toEqual([]);
  });

  it('documents the 404', async () => {
    const res = await request(feedApp().app).get(`/feeds/feedy/wrong-token-1234.xml`);

    expectDocumented(res, 'get', FEED_PATH);
  });

  it('needs no login', async () => {
    const res = await request(feedApp().app)
      .get(`/feeds/feedy/${TOKEN}.xml`)
      .set('Authorization', 'Bearer not-a-token');

    expect(res.status).toBe(200);
  });

  describe('conditional requests', () => {
    async function first() {
      const { app } = feedApp();
      const res = await request(app).get(`/feeds/feedy/${TOKEN}.xml`);
      return {
        app,
        etag: String(res.headers.etag),
        lastModified: String(res.headers['last-modified']),
      };
    }

    it('answers 304 without a body for a matching If-None-Match', async () => {
      const { app, etag, lastModified } = await first();

      for (const value of [etag, `W/${etag}`, `"other", ${etag}`, '*']) {
        const res = await request(app).get(`/feeds/feedy/${TOKEN}.xml`).set('If-None-Match', value);

        expect(res.status, value).toBe(304);
        expectDocumented(res, 'get', FEED_PATH);
        expect(res.headers.etag).toBe(etag);
        expect(res.headers['last-modified']).toBe(lastModified);
        expect(res.headers['cache-control']).toBe('no-cache');
      }
    });

    it('answers 200 for an ETag of another version', async () => {
      const { app } = await first();

      const res = await request(app)
        .get(`/feeds/feedy/${TOKEN}.xml`)
        .set('If-None-Match', '"an-older-version"');

      expect(res.status).toBe(200);
      expect(res.text).toContain('<feed>');
    });

    it('answers 304 for If-Modified-Since at or after Last-Modified, 200 before it', async () => {
      const { app, lastModified } = await first();
      const get = (since: string) =>
        request(app).get(`/feeds/feedy/${TOKEN}.xml`).set('If-Modified-Since', since);

      expect((await get(lastModified)).status).toBe(304);
      expect((await get('Fri, 13 Nov 2026 00:00:00 GMT')).status).toBe(304);
      expect((await get('Thu, 12 Nov 2026 09:29:59 GMT')).status).toBe(200);
      expect((await get('not a date')).status).toBe(200);
    });

    it('lets If-None-Match decide when both are sent', async () => {
      const { app, lastModified } = await first();

      const res = await request(app)
        .get(`/feeds/feedy/${TOKEN}.xml`)
        .set('If-None-Match', '"an-older-version"')
        .set('If-Modified-Since', lastModified);

      expect(res.status).toBe(200);
    });

    it('serves HEAD with the same headers and no body', async () => {
      const { app, etag } = await first();

      const res = await request(app).head(`/feeds/feedy/${TOKEN}.xml`);

      expect(res.status).toBe(200);
      expect(res.headers.etag).toBe(etag);
      expect(res.text ?? '').toBe('');
    });
  });
});

describe('the rendered-feed cache (keyed by the feed version)', () => {
  const NOW = new Date('2026-11-16T10:00:00Z');
  const seconds = (count: number) => new Date(NOW.getTime() + count * 1000);

  function cachedFeeds() {
    // portal_listings answers both queries: the version (first row: latest, items) and the
    // items themselves.
    const rows: Record<string, unknown>[] = [
      { ...LISTINGS[0], latest: new Date('2026-11-12T09:30:00Z'), items: 2 },
      { ...LISTINGS[1] },
    ];
    const syncState: { feed_changed_at: Date }[] = [];
    let clock = NOW;
    const { renderer, calls } = recordingRenderer();
    const feeds = createFeedsService({
      db: healthyDb({ portal_listings: rows, portal_sync_state: syncState }),
      registry: registryFrom([{ adapter: feedAdapter, feedRenderer: renderer }]),
      publicBaseUrl: 'https://imotsync.example',
      feedToken: TOKEN,
      now: () => clock,
    });
    return {
      rows,
      syncState,
      calls,
      render: () => feeds.render('feedy', renderer),
      setClock: (date: Date) => {
        clock = date;
      },
    };
  }

  it('builds the XML once for repeated (and 304) requests of the same version', async () => {
    const fx = cachedFeeds();

    const first = await fx.render();
    const again = await fx.render();

    expect(again).toBe(first);
    expect(fx.calls).toHaveLength(1);
    expect(fx.calls[0]?.ctx.lastChangedAt).toEqual(new Date('2026-11-12T09:30:00Z'));
  });

  it('builds it again when the last change or the number of items changes', async () => {
    const fx = cachedFeeds();
    await fx.render();

    // One more item (a first publish), the same newest date.
    const [head] = fx.rows;
    if (!head) throw new Error('no rows');
    head.items = 3;
    await fx.render();
    expect(fx.calls).toHaveLength(2);

    // A newer change (an update or a removal), long enough ago.
    head.latest = seconds(-60);
    await fx.render();
    await fx.render();
    expect(fx.calls).toHaveLength(3);
    expect(fx.calls[2]?.ctx.lastChangedAt).toEqual(seconds(-60));

    // A property deleted with its listings (portal_sync_state.feed_changed_at).
    fx.syncState.push({ feed_changed_at: seconds(-30) });
    await fx.render();
    expect(fx.calls).toHaveLength(4);
  });

  it('does not reuse a rendering made within seconds of the last change', async () => {
    // payload_updated_at has whole seconds: a second change in the same second would leave
    // the version as it was.
    const fx = cachedFeeds();
    const [head] = fx.rows;
    if (!head) throw new Error('no rows');
    head.latest = seconds(-1);

    await fx.render();
    await fx.render();
    expect(fx.calls).toHaveLength(2);

    fx.setClock(seconds(-1 + FEED_CACHE_SETTLE_MS / 1000));
    await fx.render();
    await fx.render();
    expect(fx.calls).toHaveLength(3);
  });

  it('builds it again after a minute, for changes that come from the time alone', async () => {
    const fx = cachedFeeds();
    await fx.render();

    fx.setClock(seconds(FEED_CACHE_MAX_AGE_MS / 1000));
    await fx.render();
    expect(fx.calls).toHaveLength(1);
    fx.setClock(seconds(FEED_CACHE_MAX_AGE_MS / 1000 + 1));
    await fx.render();
    expect(fx.calls).toHaveLength(2);
  });
});

describe('the request log', () => {
  it('redacts the feed token of an absolute-form request target', async () => {
    const lines: string[] = [];
    const config = makeConfig({ FEED_TOKEN: TOKEN });
    const logger = pino(
      { level: 'info' },
      new Writable({
        write(chunk: Buffer, _encoding, done) {
          lines.push(chunk.toString('utf8'));
          done();
        },
      }),
    );
    const app = createApp({
      config,
      logger,
      db: healthyDb({ portal_listings: LISTINGS, portal_sync_state: [] }),
      registry: registryFrom([
        { adapter: feedAdapter, feedRenderer: recordingRenderer().renderer },
      ]),
    });
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;
    try {
      const socket = net.connect(port, '127.0.0.1');
      await once(socket, 'connect');
      socket.end(
        `GET http://api.example/feeds/feedy/${TOKEN}.xml HTTP/1.1\r\nHost: api.example\r\nConnection: close\r\n\r\n`,
      );
      const chunks: Buffer[] = [];
      for await (const chunk of socket) chunks.push(chunk as Buffer);
      // Routed like /feeds/feedy/<token>.xml.
      expect(Buffer.concat(chunks).toString('utf8')).toMatch(/^HTTP\/1\.1 200 /);
    } finally {
      server.close();
      await once(server, 'close');
    }

    const logged = lines.join('');
    expect(logged).toContain('http://api.example/feeds/feedy/***.xml');
    expect(logged).not.toContain(TOKEN);
  });
});

describe('isNotModified', () => {
  const feed = { etag: '"abc"', lastModified: new Date('2026-11-12T09:30:00Z') };

  it('compares ETags weakly and ignores If-Modified-Since when If-None-Match is sent', () => {
    expect(isNotModified({ ifNoneMatch: '"abc"' }, feed)).toBe(true);
    expect(isNotModified({ ifNoneMatch: 'W/"abc"' }, feed)).toBe(true);
    expect(isNotModified({ ifNoneMatch: ' "x" ,  "abc" ' }, feed)).toBe(true);
    expect(isNotModified({ ifNoneMatch: '"abcd"' }, feed)).toBe(false);
    expect(
      isNotModified({ ifNoneMatch: '"x"', ifModifiedSince: 'Fri, 13 Nov 2026 00:00:00 GMT' }, feed),
    ).toBe(false);
  });

  it('needs a Last-Modified to answer If-Modified-Since', () => {
    expect(isNotModified({ ifModifiedSince: 'Fri, 13 Nov 2026 00:00:00 GMT' }, feed)).toBe(true);
    expect(
      isNotModified(
        { ifModifiedSince: 'Fri, 13 Nov 2026 00:00:00 GMT' },
        { ...feed, lastModified: null },
      ),
    ).toBe(false);
    expect(isNotModified({}, feed)).toBe(false);
  });
});

describe('redactFeedToken (request log)', () => {
  it.each([
    ['/feeds/realistimo/s3cret-token.xml', '/feeds/realistimo/***.xml'],
    ['/feeds/bazar/s3cret-token.xml?x=1', '/feeds/bazar/***.xml?x=1'],
    ['/feeds/bazar/s3cret-token', '/feeds/bazar/***'],
    ['/feeds/bazar', '/feeds/bazar'],
    ['/api/properties/1', '/api/properties/1'],
    // An absolute-form request target (GET http://host/feeds/... HTTP/1.1): Express routes
    // it by its path, while req.originalUrl keeps the scheme and host.
    ['http://api.example/feeds/bazar/s3cret-token.xml', 'http://api.example/feeds/bazar/***.xml'],
    [
      'https://api.example:8443/feeds/realistimo/s3cret-token.xml?x=1',
      'https://api.example:8443/feeds/realistimo/***.xml?x=1',
    ],
    ['HTTP://API.EXAMPLE/FEEDS/bazar/s3cret-token.xml', 'HTTP://API.EXAMPLE/FEEDS/bazar/***.xml'],
    ['//feeds//bazar//s3cret-token.xml', '//feeds//bazar//***.xml'],
    ['http://api.example/api/properties/1', 'http://api.example/api/properties/1'],
  ])('%s -> %s', (url, logged) => {
    expect(redactFeedToken(url)).toBe(logged);
  });
});
