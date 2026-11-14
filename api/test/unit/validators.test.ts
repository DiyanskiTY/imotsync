import express from 'express';
import type { ValidationChain } from 'express-validator';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { FieldIssue } from '../../src/lib/http-error.js';
import {
  idParam,
  jsonObjectBody,
  validate,
  validated,
  validateParams,
} from '../../src/lib/validation.js';
import type { ErrorBody } from '../../src/middleware/error-handler.js';
import { createErrorHandler } from '../../src/middleware/error-handler.js';
import { loginValidators } from '../../src/modules/auth/auth.validators.js';
import { reorderImagesValidators } from '../../src/modules/images/images.validators.js';
import {
  createPropertyValidators,
  listPropertiesValidators,
  updatePropertyValidators,
} from '../../src/modules/properties/properties.validators.js';

/** A tiny app that answers with the validated data, or with the validation error. */
function bodyApp(chains: ValidationChain[], options: { requireFields?: boolean } = {}) {
  const app = express();
  app.use(express.json());
  app.post('/', jsonObjectBody(options), validate(chains), (req, res) => {
    res.json(validated(req, 'body'));
  });
  app.use(createErrorHandler({ isProduction: true }));
  return app;
}

const createApp = bodyApp(createPropertyValidators);
const updateApp = bodyApp(updatePropertyValidators, { requireFields: true });

const queryApp = (() => {
  const app = express();
  app.get('/', validate(listPropertiesValidators, { exact: ['query'] }), (req, res) => {
    res.json(validated(req, 'query'));
  });
  app.get('/items/:id', validateParams(idParam('id')), (req, res) => {
    res.json(validated(req, 'params'));
  });
  app.use(createErrorHandler({ isProduction: true }));
  return app;
})();

const details = (body: unknown) => (body as ErrorBody).error.details ?? [];
const fields = (body: unknown) =>
  details(body)
    .map((issue) => issue.field)
    .sort();
const issueFor = (body: unknown, field: string): FieldIssue | undefined =>
  details(body).find((issue) => issue.field === field);

const VALID = { type: 'apartment', dealType: 'sale', city: 'Sofia' };

describe('create property validators', () => {
  it('accepts the three required fields and trims strings', async () => {
    const res = await request(createApp)
      .post('/')
      .send({ ...VALID, city: '  Sofia ', title: '   ', district: '' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ...VALID, title: null, district: null });
  });

  it('accepts every field with valid values', async () => {
    const full = {
      ...VALID,
      refCode: 'SOF-LOZ_17',
      title: 'Тристаен апартамент',
      district: 'Lozenets',
      price: 245000.5,
      currency: 'BGN',
      areaM2: 98.25,
      rooms: 3,
      floor: -1,
      totalFloors: 6,
      description: 'Описание',
      status: 'active',
    };
    const res = await request(createApp).post('/').send(full);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(full);
  });

  it('accepts null for the nullable fields', async () => {
    const nulls = {
      ...VALID,
      refCode: null,
      title: null,
      district: null,
      price: null,
      areaM2: null,
      rooms: null,
      floor: null,
      totalFloors: null,
      description: null,
    };
    const res = await request(createApp).post('/').send(nulls);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(nulls);
  });

  it('requires type, dealType and city', async () => {
    const res = await request(createApp).post('/').send({});

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    expect(fields(res.body)).toEqual(['city', 'dealType', 'type']);
    expect(issueFor(res.body, 'city')?.message).toBe('is required');
  });

  it('rejects unknown fields by name', async () => {
    const res = await request(createApp)
      .post('/')
      .send({ ...VALID, id: 5, createdAt: '2026-01-01', nested: { a: 1 } });

    expect(res.status).toBe(400);
    expect(fields(res.body)).toEqual(['createdAt', 'id', 'nested']);
    expect(issueFor(res.body, 'id')?.message).toBe('is not an allowed field');
  });

  it.each([
    ['type', 'castle'],
    ['type', null],
    ['dealType', 'lease'],
    ['city', ''],
    ['city', '   '],
    ['city', null],
    ['city', 42],
    ['city', 'x'.repeat(101)],
    ['title', 'x'.repeat(201)],
    ['title', 7],
    ['district', 'x'.repeat(101)],
    ['description', 'x'.repeat(20_001)],
    // 17,000 four-byte characters: under 20,000 characters, but over the TEXT column's 65,535 bytes.
    ['description', '🏠'.repeat(17_000)],
    ['price', -1],
    ['price', 12.345],
    ['price', '1200'],
    ['price', 10_000_000_000],
    ['price', true],
    ['areaM2', 0],
    ['areaM2', 1_000_000],
    ['areaM2', 50.555],
    ['rooms', 256],
    ['rooms', 1.5],
    ['rooms', -1],
    ['floor', -6],
    ['floor', 201],
    ['totalFloors', 201],
    ['totalFloors', -1],
    ['currency', 'eur'],
    ['currency', 'EURO'],
    ['currency', null],
    ['status', 'sold'],
    ['refCode', 'ab'],
    ['refCode', 'with space'],
    ['refCode', 'x'.repeat(33)],
    ['refCode', 'IS-00042'],
    ['refCode', 'is-7'],
  ])('rejects %s = %j', async (field, value) => {
    const res = await request(createApp)
      .post('/')
      .send({ ...VALID, [field]: value });

    expect(res.status).toBe(400);
    expect(fields(res.body)).toEqual([field]);
  });

  it.each([
    ['price', 0],
    ['price', 9_999_999_999.99],
    ['price', 12.5],
    ['areaM2', 0.01],
    ['areaM2', 999_999.99],
    ['rooms', 0],
    ['rooms', 255],
    ['floor', -5],
    ['floor', 200],
    ['totalFloors', 0],
    ['totalFloors', 200],
    // 200 emoji are 400 UTF-16 units but 200 characters for the database.
    ['title', '🏠'.repeat(200)],
    ['title', 'x'.repeat(200)],
    ['city', 'x'.repeat(100)],
    ['district', 'x'.repeat(100)],
    ['description', 'x'.repeat(20_000)],
    ['refCode', 'abc'],
    ['refCode', 'x'.repeat(32)],
    ['refCode', 'ISA-1'],
    ['refCode', 'IS-A1'],
  ])('accepts %s = %j', async (field, value) => {
    const res = await request(createApp)
      .post('/')
      .send({ ...VALID, [field]: value });

    expect(res.status).toBe(200);
  });

  it('assigns the reference code when refCode is empty', async () => {
    const res = await request(createApp)
      .post('/')
      .send({ ...VALID, refCode: '  ' });

    expect(res.status).toBe(200);
    expect((res.body as { refCode: unknown }).refCode).toBeNull();
  });

  it('rejects a floor above totalFloors, but not an equal one', async () => {
    const above = await request(createApp)
      .post('/')
      .send({ ...VALID, floor: 7, totalFloors: 6 });
    const equal = await request(createApp)
      .post('/')
      .send({ ...VALID, floor: 6, totalFloors: 6 });

    expect(above.status).toBe(400);
    expect(issueFor(above.body, 'floor')?.message).toBe('must not be greater than totalFloors');
    expect(equal.status).toBe(200);
  });

  it('names the field in the message when one field is wrong', async () => {
    const res = await request(createApp)
      .post('/')
      .send({ ...VALID, price: -5 });

    expect((res.body as ErrorBody).error.message).toBe(
      'Invalid price: must be a number from 0 to 9999999999.99 with at most 2 decimals',
    );
  });
});

describe('update property validators', () => {
  it('accepts a single field', async () => {
    const res = await request(updateApp).post('/').send({ price: 1000 });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ price: 1000 });
  });

  it('accepts null to clear nullable fields', async () => {
    const res = await request(updateApp)
      .post('/')
      .send({ title: null, price: null, floor: null, description: '' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ title: null, price: null, floor: null, description: null });
  });

  it('rejects a refCode change, naming the field', async () => {
    const res = await request(updateApp).post('/').send({ refCode: 'NEW-CODE' });

    expect(res.status).toBe(400);
    expect(details(res.body)).toEqual([
      { field: 'refCode', message: 'cannot be changed after the property is created' },
    ]);
  });

  it.each([{}, undefined])('rejects an empty body (%j)', async (body) => {
    const res = await request(updateApp).post('/').send(body);

    expect(res.status).toBe(400);
    expect(fields(res.body)).toEqual(['body']);
  });

  it.each([
    ['type', null],
    ['dealType', null],
    ['city', null],
    ['city', ''],
    ['status', null],
    ['currency', null],
  ])('does not clear the required field %s with %j', async (field, value) => {
    const res = await request(updateApp)
      .post('/')
      .send({ [field]: value });

    expect(res.status).toBe(400);
    expect(fields(res.body)).toEqual([field]);
  });

  it('rejects unknown fields', async () => {
    const res = await request(updateApp).post('/').send({ title: 'ok', imageCount: 3 });

    expect(res.status).toBe(400);
    expect(fields(res.body)).toEqual(['imageCount']);
  });

  it('checks floor against totalFloors when both are sent', async () => {
    const res = await request(updateApp).post('/').send({ floor: 3, totalFloors: 2 });

    expect(res.status).toBe(400);
    expect(fields(res.body)).toEqual(['floor']);
  });
});

describe('JSON body handling', () => {
  it('rejects a JSON array', async () => {
    const res = await request(createApp).post('/').send([VALID]);

    expect(res.status).toBe(400);
    expect(details(res.body)).toEqual([{ field: 'body', message: 'must be a JSON object' }]);
  });

  it('answers another content type with 415', async () => {
    const res = await request(createApp)
      .post('/')
      .set('Content-Type', 'text/plain')
      .send('type=apartment');

    expect(res.status).toBe(415);
    expect((res.body as ErrorBody).error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });
});

describe('list query validators', () => {
  it('passes through nothing when nothing is given', async () => {
    const res = await request(queryApp).get('/');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
  });

  it('converts and splits the parameters', async () => {
    const res = await request(queryApp).get('/').query({
      page: '3',
      pageSize: '50',
      q: '  Лозенец ',
      status: 'active, draft',
      type: 'apartment',
      dealType: 'sale,rent',
      city: ' sofia ',
      priceMin: '1000',
      priceMax: '2500.50',
      portal: 'bazar',
      portalStatus: 'published,error',
      sort: '-price',
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      page: 3,
      pageSize: 50,
      q: 'Лозенец',
      status: ['active', 'draft'],
      type: ['apartment'],
      dealType: ['sale', 'rent'],
      city: 'sofia',
      priceMin: 1000,
      priceMax: 2500.5,
      portal: 'bazar',
      portalStatus: ['published', 'error'],
      sort: '-price',
    });
  });

  it('accepts a repeated list parameter', async () => {
    const res = await request(queryApp).get('/?status=active&status=draft');

    expect(res.body).toEqual({ status: ['active', 'draft'] });
  });

  it.each([
    ['page', '0'],
    ['page', '1.5'],
    ['page', 'abc'],
    ['pageSize', '0'],
    ['pageSize', '101'],
    ['status', 'active,sold'],
    ['type', 'castle'],
    ['dealType', 'lease'],
    ['portal', 'imot.bg'],
    ['portalStatus', 'online'],
    ['sort', 'description'],
    ['sort', '--price'],
    ['priceMin', '-1'],
    ['priceMin', '1e5'],
    ['priceMax', '10.555'],
    ['q', 'x'.repeat(101)],
  ])('rejects %s=%s', async (name, value) => {
    const res = await request(queryApp)
      .get('/')
      .query({ [name]: value });

    expect(res.status).toBe(400);
    expect(fields(res.body)).toEqual([name]);
  });

  it('rejects priceMin above priceMax', async () => {
    const res = await request(queryApp).get('/?priceMin=500&priceMax=100');

    expect(res.status).toBe(400);
    expect(fields(res.body)).toEqual(['priceMax']);
  });

  it('rejects a single-value parameter given twice', async () => {
    const res = await request(queryApp).get('/?q=a&q=b');

    expect(res.status).toBe(400);
    expect(fields(res.body)).toEqual(['q']);
  });

  it('rejects unknown query parameters (a misspelt filter is not ignored)', async () => {
    const res = await request(queryApp).get('/?stauts=active');

    expect(res.status).toBe(400);
    expect(details(res.body)).toEqual([
      { field: 'stauts', message: 'is not a supported query parameter' },
    ]);
  });
});

describe('id parameters', () => {
  it('converts a positive integer', async () => {
    const res = await request(queryApp).get('/items/42');

    expect(res.body).toEqual({ id: 42 });
  });

  it.each(['0', '-1', '1.5', 'abc', '01', '1e3', '99999999999'])('rejects %s', async (id) => {
    const res = await request(queryApp).get(`/items/${id}`);

    expect(res.status).toBe(400);
    expect(details(res.body)).toEqual([{ field: 'id', message: 'must be a positive integer' }]);
  });
});

describe('login validators', () => {
  const app = bodyApp(loginValidators);

  it('trims the email but not the password', async () => {
    const res = await request(app)
      .post('/')
      .send({ email: ' Admin@ImotSync.local ', password: ' pass ' });

    expect(res.body).toEqual({ email: 'Admin@ImotSync.local', password: ' pass ' });
  });

  it.each([
    [{}, ['email', 'password']],
    [{ email: '', password: 'x' }, ['email']],
    [{ email: 'a@b.c', password: '' }, ['password']],
    [{ email: ['a@b.c'], password: 'x' }, ['email']],
    [{ email: 'a@b.c', password: 'x'.repeat(1025) }, ['password']],
    [{ email: 'a@b.c', password: 'x', remember: true }, ['remember']],
  ])('rejects %j', async (body, expected) => {
    const res = await request(app).post('/').send(body);

    expect(res.status).toBe(400);
    expect(fields(res.body)).toEqual(expected);
  });
});

describe('reorder validators', () => {
  const app = bodyApp(reorderImagesValidators);

  it('accepts a list of ids, and an empty one', async () => {
    expect(
      (
        await request(app)
          .post('/')
          .send({ imageIds: [3, 1, 2] })
      ).body,
    ).toEqual({
      imageIds: [3, 1, 2],
    });
    expect((await request(app).post('/').send({ imageIds: [] })).status).toBe(200);
  });

  it.each([
    [{}],
    [{ imageIds: '1,2' }],
    [{ imageIds: [1, 1] }],
    [{ imageIds: [1, '2'] }],
    [{ imageIds: [0] }],
    [{ imageIds: [1.5] }],
    [{ imageIds: Array.from({ length: 41 }, (_, index) => index + 1) }],
  ])('rejects %j', async (body) => {
    const res = await request(app).post('/').send(body);

    expect(res.status).toBe(400);
    expect(fields(res.body)).toEqual(['imageIds']);
  });

  it('rejects other fields', async () => {
    const res = await request(app)
      .post('/')
      .send({ imageIds: [1], extra: true });

    expect(fields(res.body)).toEqual(['extra']);
  });
});
