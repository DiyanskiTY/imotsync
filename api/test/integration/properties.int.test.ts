import { existsSync } from 'node:fs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { LocalFileStorage } from '../../src/lib/storage.js';
import { createLogger } from '../../src/logger.js';
import type { ErrorBody } from '../../src/middleware/error-handler.js';
import type {
  PropertyDetailDto,
  PropertySummaryDto,
} from '../../src/modules/properties/properties.mappers.js';
import type { PropertyList } from '../../src/modules/properties/properties.service.js';
import { expectDocumented } from '../support/openapi.js';
import { testImage } from '../support/images.js';
import {
  authHeader,
  backdate,
  BACKDATED,
  BROKER_EMAIL,
  closeApiFixture,
  countQueries,
  fileForUrl,
  startApiFixture,
  type ApiFixture,
} from './api-fixture.js';

let fx: ApiFixture;
let auth: { Authorization: string };
/** Every seeded property, as the list returns them (default order). */
let seeded: PropertySummaryDto[];

beforeAll(async () => {
  fx = await startApiFixture();
  auth = await authHeader(fx.app, BROKER_EMAIL);
  seeded = (await list({ pageSize: '100' })).data;
});

afterAll(async () => {
  await closeApiFixture(fx);
});

async function list(query: Record<string, string> = {}): Promise<PropertyList> {
  const res = await request(fx.app).get('/api/properties').query(query).set(auth);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  expectDocumented(res, 'get', '/properties');
  return res.body as PropertyList;
}

const refCodes = (properties: { refCode: string }[]) => properties.map((p) => p.refCode);
const sortedRefCodes = (properties: { refCode: string }[]) => refCodes(properties).sort();

async function create(body: object) {
  const res = await request(fx.app).post('/api/properties').set(auth).send(body);
  expectDocumented(res, 'post', '/properties');
  return res;
}

describe('GET /api/properties', () => {
  it('lists the most recently updated first, with pagination meta', async () => {
    const page = await list();

    expect(page.meta).toEqual({ page: 1, pageSize: 20, total: 12, totalPages: 1 });
    expect(page.data).toHaveLength(12);
    const keys = page.data.map((p) => [p.updatedAt, p.id] as const);
    const expected = [...keys].sort((a, b) => b[0].localeCompare(a[0]) || b[1] - a[1]);
    expect(keys).toEqual(expected);
  });

  it('pages through the list without gaps or overlaps', async () => {
    const pages = [];
    for (let page = 1; page <= 3; page++) {
      pages.push(await list({ page: String(page), pageSize: '5' }));
    }
    const beyond = await list({ page: '4', pageSize: '5' });

    expect(pages.map((p) => p.data.length)).toEqual([5, 5, 2]);
    expect(pages[0]?.meta).toEqual({ page: 1, pageSize: 5, total: 12, totalPages: 3 });
    expect(pages.flatMap((p) => refCodes(p.data))).toEqual(refCodes(seeded));
    expect(beyond.data).toEqual([]);
    expect(beyond.meta).toEqual({ page: 4, pageSize: 5, total: 12, totalPages: 3 });
  });

  it('shows the cover photo, photo count, creator and portal states', () => {
    const first = seeded.find((p) => p.refCode === 'IS-00001');
    const noPhotos = seeded.find((p) => p.refCode === 'IS-00011');

    expect(first).toMatchObject({
      coverImageUrl: '/uploads/demo/is-00001-1.jpg',
      imageCount: 4,
      createdBy: { id: 1, fullName: 'Demo Admin' },
    });
    expect(first?.portals.map((p) => [p.portal, p.status])).toEqual([
      ['bazar', 'published'],
      ['demo', 'published'],
      ['realistimo', 'published'],
    ]);
    expect(noPhotos).toMatchObject({ coverImageUrl: null, imageCount: 0, portals: [] });
  });

  it('runs the same number of queries for 2 or 12 properties (no N+1)', async () => {
    const forTwo = await countQueries(fx.db, () => list({ pageSize: '2' }));
    const forTwelve = await countQueries(fx.db, () => list({ pageSize: '12' }));

    expect(forTwelve).toBe(forTwo);
    // Token user, count, page, cover photos, portal listings.
    expect(forTwelve).toBeLessThanOrEqual(5);
  });

  it('filters by status, type and deal type, each a comma-separated list', async () => {
    const result = await list({ status: 'active,draft', type: 'apartment,land', dealType: 'sale' });
    const expected = seeded.filter(
      (p) =>
        ['active', 'draft'].includes(p.status) &&
        ['apartment', 'land'].includes(p.type) &&
        p.dealType === 'sale',
    );

    expect(expected.length).toBeGreaterThan(2);
    expect(sortedRefCodes(result.data)).toEqual(sortedRefCodes(expected));
  });

  it('filters by city, exact but case-insensitive', async () => {
    const result = await list({ city: 'VARNA' });

    expect(sortedRefCodes(result.data)).toEqual(
      sortedRefCodes(seeded.filter((p) => p.city === 'Varna')),
    );
    expect((await list({ city: 'Var' })).data).toEqual([]);
  });

  it('filters by a price range (inclusive), leaving out properties without a price', async () => {
    const result = await list({ priceMin: '900', priceMax: '132000' });
    const expected = seeded.filter((p) => p.price !== null && p.price >= 900 && p.price <= 132000);

    expect(expected.length).toBeGreaterThan(2);
    expect(sortedRefCodes(result.data)).toEqual(sortedRefCodes(expected));
  });

  it('searches reference codes, titles, cities and districts', async () => {
    expect(sortedRefCodes((await list({ q: 'is-0001' })).data)).toEqual([
      'IS-00010',
      'IS-00011',
      'IS-00012',
    ]);
    expect(sortedRefCodes((await list({ q: 'plovdiv' })).data)).toEqual(
      sortedRefCodes(seeded.filter((p) => p.city === 'Plovdiv')),
    );
    expect(refCodes((await list({ q: 'kapana' })).data)).toEqual(['IS-00005']);
  });

  it('searches Cyrillic text case-insensitively', async () => {
    const lower = await list({ q: 'лозенец' });
    const upper = await list({ q: 'ЛОЗЕНЕЦ' });

    expect(refCodes(lower.data)).toEqual(['IS-00001']);
    expect(refCodes(upper.data)).toEqual(['IS-00001']);
    expect(lower.data[0]?.title).toContain('Лозенец');
  });

  it('treats % and _ in the search text as plain characters', async () => {
    const created = await create({
      type: 'shop',
      dealType: 'rent',
      city: 'Ruse',
      title: 'Магазин 100% ремонтиран',
    });
    const { id, refCode } = created.body as PropertyDetailDto;
    try {
      // Unescaped, "0%" would match every reference code with a 0 in it.
      expect(refCodes((await list({ q: '0%' })).data)).toEqual([refCode]);
      expect((await list({ q: '_' })).data).toEqual([]);
    } finally {
      // Even when an assertion fails: the other list tests expect only the seeded rows.
      await fx.db('properties').where({ id }).delete();
    }
  });

  it('filters by portal, by listing status, and by both', async () => {
    const onBazar = await list({ portal: 'bazar' });
    const anyError = await list({ portalStatus: 'error' });
    const pendingOnRealistimo = await list({ portal: 'realistimo', portalStatus: 'pending,error' });

    const has = (p: PropertySummaryDto, portal?: string, statuses?: string[]) =>
      p.portals.some(
        (l) =>
          (portal === undefined || l.portal === portal) &&
          (statuses === undefined || statuses.includes(l.status)),
      );
    expect(sortedRefCodes(onBazar.data)).toEqual(
      sortedRefCodes(seeded.filter((p) => has(p, 'bazar'))),
    );
    expect(sortedRefCodes(anyError.data)).toEqual(
      sortedRefCodes(seeded.filter((p) => has(p, undefined, ['error']))),
    );
    expect(sortedRefCodes(pendingOnRealistimo.data)).toEqual(
      sortedRefCodes(seeded.filter((p) => has(p, 'realistimo', ['pending', 'error']))),
    );
    expect(anyError.data.length).toBeGreaterThan(1);
    expect(pendingOnRealistimo.data.length).toBeGreaterThan(0);
  });

  it.each([
    ['price', (p: PropertySummaryDto) => p.price],
    ['areaM2', (p: PropertySummaryDto) => p.areaM2],
    ['refCode', (p: PropertySummaryDto) => p.refCode],
    ['city', (p: PropertySummaryDto) => p.city],
    ['createdAt', (p: PropertySummaryDto) => p.createdAt],
  ])('sorts by %s in both directions', async (field, value) => {
    // Only the seeded rows count, so a row another test left behind cannot break this.
    const seededIds = new Set(seeded.map((p) => p.id));
    const sorted = async (sort: string) =>
      (await list({ sort, pageSize: '100' })).data.filter((p) => seededIds.has(p.id));
    const ascending = await sorted(field);
    const descending = await sorted(`-${field}`);

    // MariaDB puts NULL first when ascending.
    const compare = (a: PropertySummaryDto, b: PropertySummaryDto) => {
      const [x, y] = [value(a), value(b)];
      if (x === y) return a.id - b.id;
      if (x === null) return -1;
      if (y === null) return 1;
      return typeof x === 'number' && typeof y === 'number'
        ? x - y
        : String(x).localeCompare(String(y));
    };
    expect(refCodes(ascending)).toEqual(refCodes([...seeded].sort(compare)));
    expect(refCodes(descending)).toEqual(refCodes([...seeded].sort(compare).reverse()));
  });

  it('rejects unknown parameters and invalid values', async () => {
    const res = await request(fx.app)
      .get('/api/properties')
      .query({ sort: 'description', pageSize: '500', portal: 'imot.bg', colour: 'red' })
      .set(auth);

    expect(res.status).toBe(400);
    expectDocumented(res, 'get', '/properties');
    expect(((res.body as ErrorBody).error.details ?? []).map((d) => d.field).sort()).toEqual([
      'colour',
      'pageSize',
      'portal',
      'sort',
    ]);
  });
});

describe('GET /api/properties/:id', () => {
  it('returns the property with its photos in order and its listings', async () => {
    const id = seeded.find((p) => p.refCode === 'IS-00002')?.id;
    const res = await request(fx.app).get(`/api/properties/${id}`).set(auth);

    expect(res.status).toBe(200);
    expectDocumented(res, 'get', '/properties/{id}');
    const detail = res.body as PropertyDetailDto;
    expect(detail.description).toEqual(expect.any(String));
    expect(detail.images.map((image) => image.sortOrder)).toEqual([0, 1, 2]);
    expect(detail.coverImageUrl).toBe(detail.images[0]?.url);
    expect(detail.portals.map((listing) => [listing.portal, listing.status])).toEqual([
      ['bazar', 'pending'],
      ['demo', 'error'],
      ['realistimo', 'published'],
    ]);
    expect(detail.portals.find((l) => l.status === 'error')?.lastError).toEqual(expect.any(String));
  });

  it('answers 404 for a missing property and 400 for a malformed id', async () => {
    const missing = await request(fx.app).get('/api/properties/99999').set(auth);
    const malformed = await request(fx.app).get('/api/properties/abc').set(auth);

    expect(missing.status).toBe(404);
    expect((missing.body as ErrorBody).error.code).toBe('NOT_FOUND');
    expect(malformed.status).toBe(400);
    expect((malformed.body as ErrorBody).error).toMatchObject({
      code: 'VALIDATION_ERROR',
      details: [{ field: 'id', message: 'must be a positive integer' }],
    });
    expectDocumented(missing, 'get', '/properties/{id}');
    expectDocumented(malformed, 'get', '/properties/{id}');
  });
});

describe('POST /api/properties', () => {
  it('creates a property with a generated reference code', async () => {
    const res = await create({ type: 'apartment', dealType: 'rent', city: '  Varna ' });

    expect(res.status).toBe(201);
    const created = res.body as PropertyDetailDto;
    expect(res.headers.location).toBe(`/api/properties/${created.id}`);
    expect(created).toMatchObject({
      refCode: `IS-${String(created.id).padStart(5, '0')}`,
      city: 'Varna',
      title: null,
      currency: 'EUR',
      status: 'draft',
      imageCount: 0,
      images: [],
      portals: [],
      createdBy: { id: 2, fullName: 'Demo Broker' },
    });

    const fetched = await request(fx.app).get(String(res.headers.location)).set(auth);
    expect(fetched.body).toEqual(created);
  });

  it('keeps Cyrillic text, emoji and decimals intact', async () => {
    const body = {
      refCode: 'VAR-CHAIKA_01',
      type: 'apartment',
      dealType: 'sale',
      city: 'Варна',
      district: 'Чайка',
      title: 'Двустаен апартамент 🌊 до морето',
      description: 'Слънчев, южно изложение.\nНов ремонт.',
      price: 123456.78,
      currency: 'EUR',
      areaM2: 64.5,
      rooms: 2,
      floor: 3,
      totalFloors: 8,
      status: 'active',
    };
    const res = await create(body);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject(body);
  });

  it('gives concurrent creates distinct generated codes', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => create({ type: 'land', dealType: 'sale', city: 'Sofia' })),
    );
    const created = results.map((res) => res.body as PropertyDetailDto);

    expect(results.map((res) => res.status)).toEqual([201, 201, 201, 201, 201]);
    for (const property of created) {
      expect(property.refCode).toBe(`IS-${String(property.id).padStart(5, '0')}`);
    }
    expect(new Set(created.map((p) => p.refCode)).size).toBe(5);
  });

  it('answers 409 CONFLICT for a reference code that is taken, in any letter case', async () => {
    const first = await create({
      refCode: 'SOF-77',
      type: 'house',
      dealType: 'sale',
      city: 'Sofia',
    });
    const again = await create({
      refCode: 'sof-77',
      type: 'house',
      dealType: 'sale',
      city: 'Sofia',
    });

    expect(first.status).toBe(201);
    expect(again.status).toBe(409);
    expect((again.body as ErrorBody).error).toMatchObject({
      code: 'CONFLICT',
      message: 'Reference code sof-77 is already in use',
    });
  });

  it('rejects invalid input with field details', async () => {
    const res = await create({ type: 'apartment', city: 'Sofia', price: -1, wifi: true });

    expect(res.status).toBe(400);
    expect(((res.body as ErrorBody).error.details ?? []).map((d) => d.field).sort()).toEqual([
      'dealType',
      'price',
      'wifi',
    ]);
  });

  it('answers 415 for a body that is not JSON', async () => {
    const res = await request(fx.app)
      .post('/api/properties')
      .set(auth)
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('type=apartment&dealType=sale&city=Sofia');

    expect(res.status).toBe(415);
    expectDocumented(res, 'post', '/properties');
  });
});

describe('PATCH /api/properties/:id', () => {
  let property: PropertyDetailDto;

  beforeAll(async () => {
    property = (
      await create({
        type: 'apartment',
        dealType: 'sale',
        city: 'Plovdiv',
        title: 'Before',
        district: 'Center',
        price: 100000,
        floor: 2,
        totalFloors: 5,
      })
    ).body as PropertyDetailDto;
  });

  const patch = async (body: unknown, id = property.id) => {
    const res = await request(fx.app)
      .patch(`/api/properties/${id}`)
      .set(auth)
      .send(body as object);
    expectDocumented(res, 'patch', '/properties/{id}');
    return res;
  };

  it('changes only the fields sent and clears fields set to null', async () => {
    await backdate(fx, property.id);
    const res = await patch({ price: 99500.5, title: null, district: '' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      price: 99500.5,
      title: null,
      district: null,
      city: 'Plovdiv',
      floor: 2,
      refCode: property.refCode,
    });
    expect((res.body as PropertyDetailDto).updatedAt > BACKDATED).toBe(true);
  });

  it('refuses to change the reference code', async () => {
    const res = await patch({ refCode: 'NEW-1', price: 1 });

    expect(res.status).toBe(400);
    expect((res.body as ErrorBody).error.details).toEqual([
      { field: 'refCode', message: 'cannot be changed after the property is created' },
    ]);
  });

  it('checks the floor against the stored total floors', async () => {
    const tooHigh = await patch({ floor: 6 });
    const raised = await patch({ totalFloors: 9, floor: 6 });

    expect(tooHigh.status).toBe(400);
    expect((tooHigh.body as ErrorBody).error.details?.[0]?.field).toBe('floor');
    expect(raised.status).toBe(200);
  });

  it('rejects an empty update, and answers 404 for a missing property', async () => {
    const empty = await patch({});
    const missing = await patch({ price: 1 }, 99999);

    expect(empty.status).toBe(400);
    expect((empty.body as ErrorBody).error).toMatchObject({
      code: 'VALIDATION_ERROR',
      details: [{ field: 'body', message: 'must contain at least one field' }],
    });
    expect(missing.status).toBe(404);
    expect((missing.body as ErrorBody).error.code).toBe('NOT_FOUND');
  });
});

describe('DELETE /api/properties/:id', () => {
  it('refuses while a portal listing is published or pending', async () => {
    const id = seeded.find((p) => p.refCode === 'IS-00001')?.id;
    const res = await request(fx.app).delete(`/api/properties/${id}`).set(auth);

    expect(res.status).toBe(409);
    expectDocumented(res, 'delete', '/properties/{id}');
    expect((res.body as ErrorBody).error.message).toMatch(/Remove it from the portals first/);
    expect((await request(fx.app).get(`/api/properties/${id}`).set(auth)).status).toBe(200);
  });

  it('refuses while a portal listing is pending, even with no published one', async () => {
    const { id } = (await create({ type: 'office', dealType: 'rent', city: 'Sofia' }))
      .body as PropertyDetailDto;
    await fx.db('portal_listings').insert({ property_id: id, portal: 'bazar', status: 'pending' });
    try {
      const res = await request(fx.app).delete(`/api/properties/${id}`).set(auth);

      expect(res.status).toBe(409);
      expectDocumented(res, 'delete', '/properties/{id}');
      expect((res.body as ErrorBody).error).toMatchObject({
        code: 'CONFLICT',
        message: expect.stringContaining('bazar (pending)') as string,
      });
      expect(await fx.db('properties').where({ id })).toHaveLength(1);
    } finally {
      await fx.db('properties').where({ id }).delete();
    }
  });

  it('deletes a property whose listings are draft, error or removed, with their jobs', async () => {
    const { id } = (await create({ type: 'office', dealType: 'sale', city: 'Varna' }))
      .body as PropertyDetailDto;
    const listingIds: number[] = [];
    for (const [portal, status] of [
      ['bazar', 'draft'],
      ['demo', 'error'],
      ['realistimo', 'removed'],
    ] as const) {
      const [listingId = 0] = await fx.db('portal_listings').insert({
        property_id: id,
        portal,
        status,
        last_error: status === 'error' ? 'Rejected by the portal' : null,
      });
      listingIds.push(listingId);
      await fx
        .db('jobs')
        .insert({ portal_listing_id: listingId, action: 'publish', status: 'failed' });
    }
    expect(await fx.db('jobs').whereIn('portal_listing_id', listingIds)).toHaveLength(3);

    const res = await request(fx.app).delete(`/api/properties/${id}`).set(auth);

    expect(res.status).toBe(204);
    expect(await fx.db('properties').where({ id })).toEqual([]);
    expect(await fx.db('portal_listings').where({ property_id: id })).toEqual([]);
    expect(await fx.db('jobs').whereIn('portal_listing_id', listingIds)).toEqual([]);
  });

  it('deletes a property, its rows and its photo files', async () => {
    // IS-00008: archived, listings removed from both portals, two seeded photos.
    const id = seeded.find((p) => p.refCode === 'IS-00008')?.id ?? 0;
    const detail = (await request(fx.app).get(`/api/properties/${id}`).set(auth))
      .body as PropertyDetailDto;
    const files = detail.images.map((image) => fileForUrl(fx, image.url));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) expect(existsSync(file)).toBe(true);
    const listingIds = await fx.db('portal_listings').where({ property_id: id }).pluck('id');
    expect(await fx.db('jobs').whereIn('portal_listing_id', listingIds)).not.toEqual([]);

    const res = await request(fx.app).delete(`/api/properties/${id}`).set(auth);

    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    expectDocumented(res, 'delete', '/properties/{id}');
    for (const file of files) expect(existsSync(file)).toBe(false);
    expect(await fx.db('property_images').where({ property_id: id })).toEqual([]);
    expect(await fx.db('portal_listings').where({ property_id: id })).toEqual([]);
    expect(await fx.db('jobs').whereIn('portal_listing_id', listingIds)).toEqual([]);
    expect((await request(fx.app).get(`/api/properties/${id}`).set(auth)).status).toBe(404);
  });

  it('deletes uploaded photos and their folder', async () => {
    const property = (await create({ type: 'garage', dealType: 'rent', city: 'Ruse' }))
      .body as PropertyDetailDto;
    const upload = await request(fx.app)
      .post(`/api/properties/${property.id}/images`)
      .set(auth)
      .attach('photos', await testImage(), 'garage.jpg');
    const [image] = (upload.body as { data: { url: string }[] }).data;
    const file = fileForUrl(fx, image?.url ?? '');
    expect(existsSync(file)).toBe(true);

    const res = await request(fx.app).delete(`/api/properties/${property.id}`).set(auth);

    expect(res.status).toBe(204);
    expect(existsSync(file)).toBe(false);
    expect(existsSync(fileForUrl(fx, `/uploads/properties/${property.id}`))).toBe(false);
  });

  it('answers 404 for a missing property', async () => {
    const res = await request(fx.app).delete('/api/properties/99999').set(auth);

    expect(res.status).toBe(404);
    expect((res.body as ErrorBody).error.code).toBe('NOT_FOUND');
    expectDocumented(res, 'delete', '/properties/{id}');
  });
});

describe('a file that cannot be deleted', () => {
  it('is logged, while the photo and property deletes still answer 204', async () => {
    const local = new LocalFileStorage(fx.uploadDir);
    const busy = () => Promise.reject(new Error('EBUSY: resource busy or locked'));
    const storage = Object.assign(Object.create(local) as LocalFileStorage, {
      delete: busy,
      deletePrefix: busy,
    });
    const logger = createLogger(fx.config);
    const logError = vi.spyOn(logger, 'error');
    const app = createApp({ config: fx.config, db: fx.db, logger, storage });

    const { id } = (await create({ type: 'garage', dealType: 'sale', city: 'Burgas' }))
      .body as PropertyDetailDto;
    const upload = await request(app)
      .post(`/api/properties/${id}/images`)
      .set(auth)
      .attach('photos', await testImage(), 'a.jpg')
      .attach('photos', await testImage(), 'b.jpg');
    expect(upload.status).toBe(201);
    const [first] = (upload.body as { data: { id: number; url: string }[] }).data;

    const photo = await request(app).delete(`/api/properties/${id}/images/${first?.id}`).set(auth);

    expect(photo.status).toBe(204);
    expect(await fx.db('property_images').where({ id: first?.id })).toEqual([]);
    // The file stays behind as an orphan; nothing points at it any more.
    expect(existsSync(fileForUrl(fx, first?.url ?? ''))).toBe(true);

    const property = await request(app).delete(`/api/properties/${id}`).set(auth);

    expect(property.status).toBe(204);
    expect(await fx.db('properties').where({ id })).toEqual([]);
    expect(await fx.db('property_images').where({ property_id: id })).toEqual([]);
    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({ key: first?.url.replace(/^\/uploads\//, '') }),
      'Could not delete a photo file',
    );
    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({ folder: `properties/${id}` }),
      'Could not delete a photo folder',
    );
  });
});
