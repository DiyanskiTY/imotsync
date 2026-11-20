import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp, type AppDeps } from '../../src/app.js';
import { ConfigError, parseConfig } from '../../src/config.js';
import type { UserRow } from '../../src/db/types.js';
import { DEMO_ACCOUNT_EMAIL, DEMO_USERS } from '../../src/db/seeds/demo-data.js';
import { createLogger } from '../../src/logger.js';
import type { ErrorBody } from '../../src/middleware/error-handler.js';
import {
  DEMO_MAX_PROPERTIES,
  DEMO_UPLOAD_LIMITS,
  type DemoRateLimitOptions,
} from '../../src/modules/demo/deployment-profile.js';
import { DEFAULT_UPLOAD_LIMITS } from '../../src/modules/images/image-processing.js';
import { createDemoAdapter } from '../../src/portals/demo/demo-adapter.js';
import { registryFrom } from '../../src/portals/registry.js';
import type { PortalAdapter } from '../../src/portals/types.js';
import { expectDocumented } from '../support/openapi.js';
import { healthyDb, makeConfig, MINIMAL_ENV, tokenFor } from './helpers.js';

/*
 * The public demo's rules (DEMO_MODE=true) without a database: the shared demo login, the
 * client configuration, the closed feeds, the lower upload limits and the per-IP limits.
 */

const FEED_TOKEN = 'demo-unit-feed-token';

const DEMO_BROKER: UserRow = {
  id: 2,
  email: DEMO_ACCOUNT_EMAIL,
  password_hash: '$scrypt$not-used-in-unit-tests',
  full_name: 'Demo Broker',
  role: 'broker',
  created_at: new Date('2026-01-01T00:00:00Z'),
  updated_at: new Date('2026-01-01T00:00:00Z'),
};

const feedPortal: PortalAdapter = {
  key: 'feedy',
  displayName: 'Feedy',
  mode: 'feed',
  validate: () => [],
  publish: () => Promise.resolve({ message: 'ok' }),
  update: () => Promise.resolve({ message: 'ok' }),
  remove: () => Promise.resolve({ message: 'ok' }),
};

const registry = registryFrom([
  { adapter: createDemoAdapter({ failureRate: 0, latencyMs: 0 }) },
  { adapter: feedPortal, feedRenderer: { contentType: 'application/xml', render: () => '<x/>' } },
]);

interface Options {
  demo?: boolean;
  tables?: Partial<Record<string, readonly unknown[]>>;
  demoRateLimit?: DemoRateLimitOptions;
}

function setUp({ demo = true, tables = { users: [DEMO_BROKER] }, demoRateLimit }: Options = {}) {
  const config = makeConfig({ DEMO_MODE: String(demo), FEED_TOKEN });
  const deps: AppDeps = {
    config,
    logger: createLogger(config),
    db: healthyDb(tables),
    registry,
    demoRateLimit,
  };
  return { app: createApp(deps), config };
}

const errorOf = (body: unknown) => (body as ErrorBody).error;

describe('DEMO_MODE configuration', () => {
  it('is off by default', () => {
    expect(makeConfig().demoMode).toBe(false);
    expect(makeConfig({ DEMO_MODE: 'true' }).demoMode).toBe(true);
  });

  it('refuses a Realistimo API key, so the demo never calls a real portal', () => {
    const env = { ...MINIMAL_ENV, DEMO_MODE: 'true', REALISTIMO_API_KEY: 'real-key' };
    expect(() => parseConfig(env)).toThrow(ConfigError);
    // The worker, which runs the Realistimo sync, refuses it too.
    expect(() => parseConfig(env, 'worker')).toThrow(/must be empty when DEMO_MODE=true/);
    expect(parseConfig({ ...env, DEMO_MODE: 'false' }).portals.realistimo.apiKey).toBe('real-key');
  });
});

describe('GET /api/client-config', () => {
  it('reports the demo and its lower upload limits', async () => {
    const res = await request(setUp().app).get('/api/client-config');

    expect(res.status).toBe(200);
    expectDocumented(res, 'get', '/client-config');
    expect(res.body).toEqual({ demoMode: true, uploadLimits: DEMO_UPLOAD_LIMITS });
  });

  it('reports the default limits outside the demo', async () => {
    const res = await request(setUp({ demo: false }).app).get('/api/client-config');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ demoMode: false, uploadLimits: DEFAULT_UPLOAD_LIMITS });
  });
});

describe('POST /api/auth/demo', () => {
  it('signs in the shared demo account without a password', async () => {
    const { app } = setUp();
    const res = await request(app).post('/api/auth/demo');

    expect(res.status).toBe(200);
    expectDocumented(res, 'post', '/auth/demo');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toMatchObject({
      tokenType: 'Bearer',
      user: { id: 2, email: DEMO_ACCOUNT_EMAIL, role: 'broker' },
    });

    const me = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${(res.body as { accessToken: string }).accessToken}`);
    expect(me.status).toBe(200);
  });

  it('does not exist outside the demo: no open sign-in anywhere else', async () => {
    const res = await request(setUp({ demo: false }).app).post('/api/auth/demo');

    expect(res.status).toBe(404);
    expectDocumented(res, 'post', '/auth/demo');
    expect(errorOf(res.body).code).toBe('NOT_FOUND');
  });

  it('fails with 500 while the demo data is not loaded', async () => {
    const res = await request(setUp({ tables: {} }).app).post('/api/auth/demo');

    expect(res.status).toBe(500);
    expect(errorOf(res.body).code).toBe('INTERNAL_ERROR');
  });

  it('never signs anyone in as an admin, even if the demo account became one', async () => {
    const admin = { ...DEMO_BROKER, role: 'admin' as const };
    const res = await request(setUp({ tables: { users: [admin] } }).app).post('/api/auth/demo');

    expect(res.status).toBe(500);
    expect(res.body).not.toHaveProperty('accessToken');
  });

  it('signs in the account the seed creates: the broker with id 2', () => {
    // The nightly reset keeps this id, so a visitor's token stays valid across it.
    expect(DEMO_USERS.find((user) => user.email === DEMO_ACCOUNT_EMAIL)).toMatchObject({
      id: 2,
      role: 'broker',
    });
  });

  it('is rate limited per client IP', async () => {
    const { app } = setUp({ demoRateLimit: { logins: 2 } });
    for (let i = 0; i < 2; i++) {
      expect((await request(app).post('/api/auth/demo')).status).toBe(200);
    }

    const res = await request(app).post('/api/auth/demo');
    expect(res.status).toBe(429);
    expectDocumented(res, 'post', '/auth/demo');
    expect(res.headers['retry-after']).toBeDefined();
  });
});

describe('the feeds of the demo', () => {
  it('are closed, even with the right token', async () => {
    const { app } = setUp();
    const res = await request(app).get(`/feeds/feedy/${FEED_TOKEN}.xml`);

    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/^text\/plain/);
    expect(res.text).toBe('Not Found');
  });

  it('are open outside the demo (the same request)', async () => {
    const res = await request(setUp({ demo: false }).app).get(`/feeds/feedy/${FEED_TOKEN}.xml`);
    expect(res.status).toBe(200);
  });

  it('are not shown: GET /api/portals has no feed URLs', async () => {
    const { app, config } = setUp();
    const res = await request(app)
      .get('/api/portals')
      .set('Authorization', `Bearer ${await tokenFor(config, DEMO_BROKER)}`);

    expect(res.status).toBe(200);
    expectDocumented(res, 'get', '/portals');
    const feedUrls = (res.body as { data: { feedUrl: string | null }[] }).data.map(
      (portal) => portal.feedUrl,
    );
    expect(feedUrls).toEqual([null, null]);
  });
});

describe('limits of the demo', () => {
  async function signedIn(options: Options = {}) {
    const { app, config } = setUp({
      ...options,
      tables: { users: [DEMO_BROKER], properties: [{ id: 1, total: DEMO_MAX_PROPERTIES }] },
    });
    return {
      app,
      auth: { Authorization: `Bearer ${await tokenFor(config, DEMO_BROKER)}` },
    };
  }

  it('refuses a photo over the demo file size before processing it', async () => {
    const { app, auth } = await signedIn();
    const res = await request(app)
      .post('/api/properties/1/images')
      .set(auth)
      .attach('photos', Buffer.alloc(DEMO_UPLOAD_LIMITS.maxFileBytes + 1, 0xff), 'big.jpg');

    expect(res.status).toBe(413);
    expect(errorOf(res.body).message).toMatch(/larger than 5 MB/);
  });

  it('refuses more files per upload than the demo allows', async () => {
    const { app, auth } = await signedIn();
    let req = request(app).post('/api/properties/1/images').set(auth);
    for (let i = 0; i <= DEMO_UPLOAD_LIMITS.maxFilesPerRequest; i++) {
      req = req.attach('photos', Buffer.from([0xff, 0xd8, i]), `photo-${i}.jpg`);
    }
    const res = await req;

    expect(res.status).toBe(400);
    expect(errorOf(res.body).details).toEqual([
      {
        field: 'photos',
        message: `at most ${DEMO_UPLOAD_LIMITS.maxFilesPerRequest} files per request`,
      },
    ]);
  });

  it('refuses a photo that would take a property over the demo maximum', async () => {
    const { app } = setUp({
      tables: {
        users: [DEMO_BROKER],
        properties: [{ id: 1 }],
        property_images: [{ total: DEMO_UPLOAD_LIMITS.maxPerProperty }],
      },
    });
    const config = makeConfig({ DEMO_MODE: 'true', FEED_TOKEN });
    const res = await request(app)
      .post('/api/properties/1/images')
      .set('Authorization', `Bearer ${await tokenFor(config, DEMO_BROKER)}`)
      .attach('photos', Buffer.from([0xff, 0xd8, 0xff]), 'one-more.jpg');

    expect(res.status).toBe(409);
    expect(errorOf(res.body).message).toMatch(
      `at most ${DEMO_UPLOAD_LIMITS.maxPerProperty} photos`,
    );
  });

  it('limits new properties per address and hour', async () => {
    const { app, config } = setUp({
      tables: { users: [DEMO_BROKER], properties: [{ id: 1, total: DEMO_MAX_PROPERTIES }] },
      demoRateLimit: { createsPerHour: 1 },
    });
    const auth = { Authorization: `Bearer ${await tokenFor(config, DEMO_BROKER)}` };
    const create = () =>
      request(app)
        .post('/api/properties')
        .set(auth)
        .send({ type: 'apartment', dealType: 'sale', city: 'Sofia' });

    expect((await create()).status).toBe(409); // counted, although the demo is full
    const limited = await create();
    expect(limited.status).toBe(429);
    expect(errorOf(limited.body).message).toMatch('Too many new properties');
  });

  it('refuses a new property once the demo holds the maximum', async () => {
    const { app, auth } = await signedIn();
    const res = await request(app)
      .post('/api/properties')
      .set(auth)
      .send({ type: 'apartment', dealType: 'sale', city: 'Sofia' });

    expect(res.status).toBe(409);
    expect(errorOf(res.body).message).toMatch(`at most ${DEMO_MAX_PROPERTIES} properties`);
  });

  it('limits all requests per client IP, except the health check', async () => {
    const { app, auth } = await signedIn({ demoRateLimit: { requests: 2 } });
    for (let i = 0; i < 2; i++) {
      expect((await request(app).get('/api/portals').set(auth)).status).toBe(200);
    }

    const limited = await request(app).get('/api/portals').set(auth);
    expect(limited.status).toBe(429);
    expect(errorOf(limited.body).code).toBe('TOO_MANY_REQUESTS');
    expect((await request(app).get('/api/health')).status).toBe(200);
  });

  it('limits changes separately from reads', async () => {
    const { app, auth } = await signedIn({ demoRateLimit: { writes: 1 } });
    const create = () =>
      request(app)
        .post('/api/properties')
        .set(auth)
        .send({ type: 'apartment', dealType: 'sale', city: 'Sofia' });

    expect((await create()).status).toBe(409); // counted: the demo is full
    expect((await create()).status).toBe(429);
    expect((await request(app).get('/api/portals').set(auth)).status).toBe(200);
  });

  it('applies none of this outside the demo', async () => {
    const { app, auth } = await signedIn({ demo: false, demoRateLimit: { requests: 1 } });
    for (let i = 0; i < 3; i++) {
      expect((await request(app).get('/api/portals').set(auth)).status).toBe(200);
    }
  });
});

describe('noindex', () => {
  it('asks search engines not to index any response', async () => {
    const { app } = setUp({ demo: false });
    for (const path of ['/api/health', '/api/client-config', '/feeds/x/y.xml', '/nowhere']) {
      const res = await request(app).get(path);
      expect(res.headers['x-robots-tag'], path).toBe('noindex, nofollow');
    }
  });
});
