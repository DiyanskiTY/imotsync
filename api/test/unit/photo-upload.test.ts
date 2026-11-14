import { once } from 'node:events';
import { request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp, type AppDeps } from '../../src/app.js';
import { createConcurrencyLimit } from '../../src/lib/concurrency-limit.js';
import { createLogger } from '../../src/logger.js';
import { createErrorHandler, type ErrorBody } from '../../src/middleware/error-handler.js';
import { PHOTO_LIMITS } from '../../src/modules/images/image-processing.js';
import type { PropertyImageDto } from '../../src/modules/images/images.mappers.js';
import {
  createImagesRouter,
  UPLOAD_RETRY_AFTER_SECONDS,
} from '../../src/modules/images/images.router.js';
import type { ImagesService } from '../../src/modules/images/images.service.js';
import {
  createPhotoReceiver,
  DEFAULT_UPLOAD_BODY_TIMEOUT_MS,
  MAX_UPLOAD_BODY_BYTES,
  type UploadedPhoto,
} from '../../src/modules/images/photo-upload.js';
import { expectDocumented, type CheckedResponse } from '../support/openapi.js';
import { DEMO_ADMIN, healthyDb, makeConfig, tokenFor } from './helpers.js';

const MB = 1024 * 1024;
const UPLOAD_URL = '/api/properties/1/images';
const ONLY_PHOTOS = 'Only files in the "photos" field are accepted';

describe('photo limits', () => {
  it('match the documented limits', () => {
    expect(PHOTO_LIMITS).toMatchObject({
      maxFileBytes: 15 * MB,
      maxFilesPerRequest: 20,
      maxPerProperty: 40,
      minShortSide: 400,
      maxInputPixels: 50_000_000,
      maxStoredSide: 2048,
    });
    expect(MAX_UPLOAD_BODY_BYTES).toBe(20 * 15 * MB + MB);
    expect(DEFAULT_UPLOAD_BODY_TIMEOUT_MS).toBe(60_000);
  });

  it.each([0, -1, 1.5, Number.NaN, 2 ** 31])('refuses an upload body timeout of %s ms', (ms) => {
    expect(() => createPhotoReceiver({ bodyTimeoutMs: ms })).toThrow(RangeError);
  });
});

describe('createConcurrencyLimit', () => {
  it('hands out a fixed number of slots and takes each back once', () => {
    const limit = createConcurrencyLimit(2);
    const first = limit.tryAcquire();
    const second = limit.tryAcquire();

    expect(first).toBeTypeOf('function');
    expect(second).toBeTypeOf('function');
    expect(limit.tryAcquire()).toBeUndefined();

    first?.();
    first?.();
    expect(limit.active).toBe(1);
    expect(limit.tryAcquire()).toBeTypeOf('function');
    expect(limit.tryAcquire()).toBeUndefined();
  });

  it.each([0, -1, 1.5, Number.NaN])('refuses %s slots', (max) => {
    expect(() => createConcurrencyLimit(max)).toThrow(RangeError);
  });
});

/** The app on a real port (raw requests can leave a body unfinished), with one upload slot. */
interface UploadServer {
  server: Server;
  port: number;
  auth: string;
}

async function startUploadServer(deps: Partial<AppDeps> = {}): Promise<UploadServer> {
  const config = makeConfig();
  // Property 1 exists; nothing in these tests gets as far as storing a photo.
  const db = healthyDb({ users: [DEMO_ADMIN], properties: [{ id: 1 }] });
  const app = createApp({
    config,
    logger: createLogger(config),
    db,
    maxConcurrentUploads: 1,
    ...deps,
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    server,
    port: (server.address() as AddressInfo).port,
    auth: `Bearer ${await tokenFor(config)}`,
  };
}

async function stopUploadServer(target: UploadServer | undefined): Promise<void> {
  if (!target) return;
  target.server.closeAllConnections();
  await new Promise<void>((resolve) => target.server.close(() => resolve()));
}

/** Starts a multipart upload that declares `length` bytes but sends only the first few. */
function startUpload({ port, auth }: UploadServer, length: number) {
  const req = httpRequest({
    host: '127.0.0.1',
    port,
    method: 'POST',
    path: UPLOAD_URL,
    headers: {
      Authorization: auth,
      'Content-Type': 'multipart/form-data; boundary=x',
      'Content-Length': String(length),
    },
  });
  // The server may close the connection while the body is unfinished.
  req.on('error', () => undefined);
  req.write('--x\r\n');
  const closed = new Promise<void>((resolve) => req.once('close', () => resolve()));
  const response = new Promise<{ res: IncomingMessage; body: string }>((resolve) => {
    req.on('response', (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (body += chunk));
      res.on('end', () => resolve({ res, body }));
    });
  });
  return { req, response, closed };
}

/** A raw response in the shape expectDocumented checks. */
const checked = ({ res, body }: { res: IncomingMessage; body: string }): CheckedResponse => ({
  status: res.statusCode ?? 0,
  headers: res.headers,
  body: JSON.parse(body) as unknown,
  text: body,
});

/** A request that passes the upload slot and then fails fast (415: not multipart). */
const probe = ({ server, auth }: UploadServer) =>
  request(server).post(UPLOAD_URL).set('Authorization', auth).type('text').send('x');

/** Waits until a probe gets the answer, which tells whether the upload slot is free (415). */
async function expectProbe(target: UploadServer, status: 415 | 429): Promise<void> {
  await vi.waitFor(
    async () => {
      expect((await probe(target)).status).toBe(status);
    },
    { timeout: 5000, interval: 20 },
  );
}

describe('POST /api/properties/:id/images limits', () => {
  let target: UploadServer;

  beforeAll(async () => {
    target = await startUploadServer();
  });

  afterAll(async () => {
    await stopUploadServer(target);
  });

  it('answers 429 with Retry-After while every upload slot is busy, until it is free', async () => {
    const slow = startUpload(target, 10_000);

    // Once the slow upload holds the only slot, the next one is turned away.
    const busy = await vi.waitFor(
      async () => {
        const res = await probe(target);
        expect(res.status).toBe(429);
        return res;
      },
      { timeout: 5000, interval: 20 },
    );
    expect((busy.body as ErrorBody).error.code).toBe('TOO_MANY_REQUESTS');
    expect(busy.headers['retry-after']).toBe(String(UPLOAD_RETRY_AFTER_SECONDS));
    expectDocumented(busy, 'post', '/properties/{id}/images');

    // The client gives up: the slot is free again.
    slow.req.destroy();
    await expectProbe(target, 415);
  });

  it('refuses a body declared larger than 20 photos of 15 MB without reading it', async () => {
    const { req, response } = startUpload(target, MAX_UPLOAD_BODY_BYTES + 1);
    const { res, body } = await response;
    req.destroy();

    expect(res.statusCode).toBe(413);
    expect(res.headers.connection).toBe('close');
    expect((JSON.parse(body) as ErrorBody).error.code).toBe('PAYLOAD_TOO_LARGE');
    // The slot was given back.
    expect((await probe(target)).status).toBe(415);
  });

  describe('text fields', () => {
    const photo = Buffer.from('not looked at: the field is refused first');
    const upload = () => request(target.server).post(UPLOAD_URL).set('Authorization', target.auth);

    it.each([
      [
        'before the photos',
        () => upload().field('caption', 'hello').attach('photos', photo, 'a.jpg'),
      ],
      [
        'after the photos',
        () => upload().attach('photos', photo, 'a.jpg').field('caption', 'hello'),
      ],
      ['with an empty value', () => upload().attach('photos', photo, 'a.jpg').field('caption', '')],
      ['followed by another one', () => upload().field('caption', '').field('note', 'x')],
    ])('refuses one %s with 400, naming it', async (_case, send) => {
      const res = await send();

      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        error: {
          code: 'VALIDATION_ERROR',
          message: `Unexpected field "caption": only files in the "photos" field are accepted`,
          details: [{ field: 'caption', message: ONLY_PHOTOS }],
        },
      });
      expectDocumented(res, 'post', '/properties/{id}/images');
    });

    it('names a field with brackets as it was sent', async () => {
      const res = await upload().field('meta[note]', '').attach('photos', photo, 'a.jpg');

      expect(res.status).toBe(400);
      expect((res.body as ErrorBody).error.details).toEqual([
        { field: 'meta[note]', message: ONLY_PHOTOS },
      ]);
    });

    it('refuses a part without a name as part of the body', async () => {
      const res = await upload()
        .set('Content-Type', 'multipart/form-data; boundary=x')
        .send('--x\r\nContent-Disposition: form-data\r\n\r\nhello\r\n--x--\r\n');

      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        error: {
          code: 'VALIDATION_ERROR',
          message: ONLY_PHOTOS,
          details: [{ field: 'body', message: ONLY_PHOTOS }],
        },
      });
    });
  });
});

describe('POST /api/properties/:id/images body deadline', () => {
  const DEADLINE_MS = 300;
  let target: UploadServer;

  beforeAll(async () => {
    target = await startUploadServer({ uploadBodyTimeoutMs: DEADLINE_MS });
  });

  afterAll(async () => {
    await stopUploadServer(target);
  });

  function expectTimedOut(answer: { res: IncomingMessage; body: string }): void {
    const res = checked(answer);
    expect(res.status).toBe(408);
    expect(res.headers.connection).toBe('close');
    expect(res.body).toEqual({
      error: {
        code: 'REQUEST_TIMEOUT',
        message: `The upload did not arrive within ${DEADLINE_MS} ms. On a slow connection, send fewer photos at a time.`,
      },
    });
    expectDocumented(res, 'post', '/properties/{id}/images');
  }

  it('answers 408 and frees the slot when the body stops arriving', async () => {
    const started = performance.now();
    const stalled = startUpload(target, 10_000);
    await expectProbe(target, 429);

    const answer = await stalled.response;

    // setTimeout may fire a millisecond early.
    expect(performance.now() - started).toBeGreaterThanOrEqual(DEADLINE_MS - 5);
    expectTimedOut(answer);
    // The slot was given back before the answer was sent.
    expect((await probe(target)).status).toBe(415);
  });

  it('also ends a body that keeps trickling in', async () => {
    const trickle = startUpload(target, 10_000);
    const drip = setInterval(() => trickle.req.write('a'), 20);
    trickle.req.on('response', () => clearInterval(drip));
    try {
      await expectProbe(target, 429);
      expectTimedOut(await trickle.response);
    } finally {
      clearInterval(drip);
    }
    expect((await probe(target)).status).toBe(415);
  });

  it('gives the slot back once: the end of a timed-out upload does not free a later one', async () => {
    const first = startUpload(target, 10_000);
    expectTimedOut(await first.response);
    // The server has closed the first connection, and multer has let go of its body.
    await first.closed;

    const second = startUpload(target, 10_000);
    try {
      await expectProbe(target, 429);
      // Still taken by the second upload, not freed a second time by the first.
      await sleep(DEADLINE_MS / 3);
      expect((await probe(target)).status).toBe(429);
      expectTimedOut(await second.response);
    } finally {
      second.req.destroy();
    }
    expect((await probe(target)).status).toBe(415);
  });
});

describe('the upload deadline and an upload that arrives in time', () => {
  const DEADLINE_MS = 200;
  const received: UploadedPhoto[][] = [];

  const imageDto = (index: number): PropertyImageDto => ({
    id: index + 1,
    url: `/uploads/properties/1/${index}.jpg`,
    sortOrder: index,
    width: 400,
    height: 400,
    sizeBytes: 1000,
    createdAt: '2026-01-01T00:00:00.000Z',
  });

  const images = {
    assertPropertyExists: () => Promise.resolve(),
    // Takes longer than the deadline: only receiving the body is timed.
    async upload(_propertyId: number, photos: readonly UploadedPhoto[]) {
      received.push([...photos]);
      await sleep(DEADLINE_MS * 2);
      return photos.map((_photo, index) => imageDto(index));
    },
    reorder: () => Promise.reject(new Error('not used here')),
    remove: () => Promise.reject(new Error('not used here')),
  } satisfies ImagesService;

  const app = express();
  app.use(
    createImagesRouter({ images, maxConcurrentUploads: 1, uploadBodyTimeoutMs: DEADLINE_MS }),
  );
  app.use(createErrorHandler({ isProduction: true }));
  let server: Server;

  beforeAll(async () => {
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  // Kept alive, so a deadline that fired after all would show as Connection: close.
  const upload = (...names: string[]) =>
    names.reduce(
      (req, name) => req.attach('photos', Buffer.from(`bytes of ${name}`), name),
      request(server).post('/properties/1/images').set('Connection', 'keep-alive'),
    );

  it('is stored however long processing takes, and gives the slot back', async () => {
    const first = await upload('a.jpg', 'b.jpg');
    // Long past the first upload's deadline, which must not have fired.
    const second = await upload('c.jpg');

    for (const res of [first, second]) {
      expect(res.status).toBe(201);
      expect(res.headers.connection).toBe('keep-alive');
      expectDocumented(res, 'post', '/properties/{id}/images');
    }
    expect((first.body as { data: PropertyImageDto[] }).data).toEqual([imageDto(0), imageDto(1)]);
    expect(
      received.map((photos) =>
        photos.map(({ buffer, originalName }) => [originalName, buffer.toString()]),
      ),
    ).toEqual([
      [
        ['a.jpg', 'bytes of a.jpg'],
        ['b.jpg', 'bytes of b.jpg'],
      ],
      [['c.jpg', 'bytes of c.jpg']],
    ]);
  });
});
