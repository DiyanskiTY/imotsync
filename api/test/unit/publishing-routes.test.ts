import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { createLogger } from '../../src/logger.js';
import type { ErrorBody } from '../../src/middleware/error-handler.js';
import { createDemoAdapter } from '../../src/portals/demo/demo-adapter.js';
import { registryFrom } from '../../src/portals/registry.js';
import type { PortalAdapter } from '../../src/portals/types.js';
import { expectDocumented } from '../support/openapi.js';
import { dbWithAdmin, makeConfig, tokenFor } from './helpers.js';

/*
 * The publishing and job routes without a database: request validation (which answers
 * before any query) and the portal list (which only reads the registry).
 */

const feedPortal: PortalAdapter = {
  key: 'feedy',
  displayName: 'Feedy',
  mode: 'feed',
  validate: () => [],
  publish: () => Promise.resolve({ message: 'ok' }),
  update: () => Promise.resolve({ message: 'ok' }),
  remove: () => Promise.resolve({ message: 'ok' }),
};

const config = makeConfig({
  PUBLIC_BASE_URL: 'https://imotsync.example',
  FEED_TOKEN: 'feed-token_123',
});
const app = createApp({
  config,
  logger: createLogger(config),
  db: dbWithAdmin(),
  registry: registryFrom([
    { adapter: createDemoAdapter({ failureRate: 0, latencyMs: 0 }) },
    { adapter: feedPortal, feedRenderer: { contentType: 'application/xml', render: () => '' } },
  ]),
});
let auth: { Authorization: string };

beforeAll(async () => {
  auth = { Authorization: `Bearer ${await tokenFor(config)}` };
});

const details = (body: unknown) => (body as ErrorBody).error.details ?? [];

describe('GET /api/portals', () => {
  it('lists the registered portals with the feed URL of feed portals', async () => {
    const res = await request(app).get('/api/portals').set(auth);

    expect(res.status).toBe(200);
    expectDocumented(res, 'get', '/portals');
    expect(res.body).toEqual({
      data: [
        { key: 'demo', displayName: 'Demo portal', mode: 'push', feedUrl: null },
        {
          key: 'feedy',
          displayName: 'Feedy',
          mode: 'feed',
          feedUrl: 'https://imotsync.example/feeds/feedy/feed-token_123.xml',
        },
      ],
    });
  });

  it('needs a token', async () => {
    const res = await request(app).get('/api/portals');

    expect(res.status).toBe(401);
  });
});

describe('publishing request validation', () => {
  const post = (path: string, body: unknown) =>
    request(app)
      .post(`/api${path}`)
      .set(auth)
      .send(body as object);

  it.each([
    [{}, 'portals', 'is required'],
    [{ portals: 'demo' }, 'portals', 'must be an array of portal keys'],
    [{ portals: [] }, 'portals', 'must name at least one portal'],
    [{ portals: ['demo', 'imotbg'] }, 'portals', 'must list portals from: demo, feedy'],
    [{ portals: ['demo', 'demo'] }, 'portals', 'must not name a portal twice'],
    [{ portals: [1] }, 'portals', 'must list portals from: demo, feedy'],
    [{ portals: ['demo'], force: true }, 'force', 'is not an allowed field'],
  ])('publish %j: 400 on %s', async (body, field, message) => {
    const res = await post('/properties/1/publish', body);

    expect(res.status).toBe(400);
    expectDocumented(res, 'post', '/properties/{id}/publish');
    expect(details(res.body)).toContainEqual({ field, message });
  });

  it('rejects a bad property id, a JSON array and a body that is not JSON', async () => {
    const badId = await post('/properties/abc/publish', { portals: ['demo'] });
    const array = await post('/properties/1/publish', ['demo']);
    const text = await request(app)
      .post('/api/properties/1/publish')
      .set(auth)
      .set('Content-Type', 'text/plain')
      .send('portals=demo');

    expect(badId.status).toBe(400);
    expect(details(badId.body)).toEqual([{ field: 'id', message: 'must be a positive integer' }]);
    expect(array.status).toBe(400);
    expect(text.status).toBe(415);
    expectDocumented(text, 'post', '/properties/{id}/publish');
  });

  it('unpublish takes optional portals, checked like publish', async () => {
    const res = await post('/properties/1/unpublish', { portals: ['nope'] });
    const unknown = await post('/properties/1/unpublish', { everything: true });

    expect(res.status).toBe(400);
    expectDocumented(res, 'post', '/properties/{id}/unpublish');
    expect(details(res.body)).toEqual([
      { field: 'portals', message: 'must list portals from: demo, feedy' },
    ]);
    expect(details(unknown.body)).toEqual([
      { field: 'everything', message: 'is not an allowed field' },
    ]);
  });

  it.each([
    [{ portals: ['demo'] }, 'propertyIds', 'is required'],
    [{ propertyIds: [], portals: ['demo'] }, 'propertyIds', 'must contain 1 to 100 ids'],
    [
      { propertyIds: Array.from({ length: 101 }, (_, i) => i + 1), portals: ['demo'] },
      'propertyIds',
      'must contain 1 to 100 ids',
    ],
    [{ propertyIds: [1, 1], portals: ['demo'] }, 'propertyIds', 'must not contain an id twice'],
    [
      { propertyIds: [1, '2'], portals: ['demo'] },
      'propertyIds',
      'must contain only positive integer ids',
    ],
    [
      { propertyIds: [0], portals: ['demo'] },
      'propertyIds',
      'must contain only positive integer ids',
    ],
    [
      { propertyIds: [1.5], portals: ['demo'] },
      'propertyIds',
      'must contain only positive integer ids',
    ],
    [{ propertyIds: [1] }, 'portals', 'is required'],
  ])('bulk publish %j: 400 on %s', async (body, field, message) => {
    const res = await post('/properties/bulk/publish', body);

    expect(res.status).toBe(400);
    expectDocumented(res, 'post', '/properties/bulk/publish');
    expect(details(res.body)).toContainEqual({ field, message });
  });

  it('bulk delete takes property ids only', async () => {
    const extra = await post('/properties/bulk/delete', { propertyIds: [1], portals: ['demo'] });
    const missing = await post('/properties/bulk/delete', {});

    expect(extra.status).toBe(400);
    expectDocumented(extra, 'post', '/properties/bulk/delete');
    expect(details(extra.body)).toEqual([{ field: 'portals', message: 'is not an allowed field' }]);
    expect(details(missing.body)).toEqual([{ field: 'propertyIds', message: 'is required' }]);
  });

  it('checks the portals query of the pre-publish check', async () => {
    const unknown = await request(app).get('/api/properties/1/checks?portals=demo,nope').set(auth);
    const twice = await request(app)
      .get('/api/properties/1/checks?portals=demo&portals=feedy')
      .set(auth);
    const extra = await request(app).get('/api/properties/1/checks?verbose=1').set(auth);

    expect(unknown.status).toBe(400);
    expectDocumented(unknown, 'get', '/properties/{id}/checks');
    expect(details(unknown.body)).toEqual([
      { field: 'portals', message: 'must list portals from: demo, feedy' },
    ]);
    expect(details(twice.body)).toEqual([
      { field: 'portals', message: 'must be given once, as a comma-separated list' },
    ]);
    expect(details(extra.body)).toEqual([
      { field: 'verbose', message: 'is not a supported query parameter' },
    ]);
  });
});

describe('job routes request validation', () => {
  it.each([
    [
      'status=done',
      'status',
      'must be a comma-separated list of: queued, running, succeeded, failed',
    ],
    ['action=delete', 'action', 'must be a comma-separated list of: publish, update, remove'],
    ['portal=Not%20A%20Key', 'portal', 'must be a comma-separated list of portal keys'],
    ['propertyId=0', 'propertyId', 'must be an integer from 1 to 4294967295'],
    ['page=0', 'page', 'must be an integer from 1 to 1000000'],
    ['pageSize=101', 'pageSize', 'must be an integer from 1 to 100'],
    [
      'sort=title',
      'sort',
      expect.stringMatching(/^must be one of: createdAt, -createdAt/) as string,
    ],
    ['limit=5', 'limit', 'is not a supported query parameter'],
  ])('GET /api/jobs?%s: 400 on %s', async (query, field, message) => {
    const res = await request(app).get(`/api/jobs?${query}`).set(auth);

    expect(res.status).toBe(400);
    expectDocumented(res, 'get', '/jobs');
    expect(details(res.body)).toContainEqual({ field, message });
  });

  it('rejects a bad job id and any body on retry', async () => {
    const badId = await request(app).get('/api/jobs/x').set(auth);
    const withBody = await request(app).post('/api/jobs/1/retry').set(auth).send({ force: true });

    expect(badId.status).toBe(400);
    expectDocumented(badId, 'get', '/jobs/{id}');
    expect(withBody.status).toBe(400);
    expectDocumented(withBody, 'post', '/jobs/{id}/retry');
    expect(details(withBody.body)).toEqual([
      { field: 'force', message: 'is not an allowed field' },
    ]);
  });
});
