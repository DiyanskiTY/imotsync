import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { get } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { createLogger } from '../../src/logger.js';
import type { ErrorBody } from '../../src/middleware/error-handler.js';
import { LOGIN_RATE_LIMIT_DEFAULTS } from '../../src/modules/auth/login-rate-limit.js';
import { dbWithAdmin, makeConfig, tokenFor } from './helpers.js';

/** Content of a file next to UPLOAD_DIR (not inside it): no /uploads URL may return it. */
const OUTSIDE_SECRET = 'outside-upload-dir-sentinel';

let tempDir: string;
let app: ReturnType<typeof createApp>;
let token: string;

beforeAll(async () => {
  // <tempDir>/uploads is UPLOAD_DIR; <tempDir>/secret.txt is one level above it.
  tempDir = await mkdtemp(path.join(tmpdir(), 'imotsync-unit-'));
  const uploadDir = path.join(tempDir, 'uploads');
  await mkdir(path.join(uploadDir, 'demo'), { recursive: true });
  await writeFile(path.join(uploadDir, 'demo', 'photo.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  await writeFile(path.join(uploadDir, 'demo', '.secret'), 'hidden');
  await writeFile(path.join(tempDir, 'secret.txt'), OUTSIDE_SECRET);

  const config = makeConfig({
    UPLOAD_DIR: uploadDir,
    CORS_ORIGIN: 'http://localhost:4200, https://admin.example.test',
  });
  app = createApp({ config, logger: createLogger(config), db: dbWithAdmin() });
  token = await tokenFor(config);
});

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

/**
 * Sends the request path to the app byte for byte. An HTTP client library may resolve
 * "..", "%2e%2e" and similar segments before sending, which would hide a traversal bug.
 */
async function rawGet(requestPath: string): Promise<{ status: number; body: string }> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  try {
    const { port } = server.address() as AddressInfo;
    return await new Promise((resolve, reject) => {
      get({ host: '127.0.0.1', port, path: requestPath }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        res.on('error', reject);
      }).on('error', reject);
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('unknown routes', () => {
  it('asks for a token before revealing whether an /api route exists', async () => {
    const res = await request(app).get('/api/does-not-exist');

    expect(res.status).toBe(401);
    expect((res.body as ErrorBody).error.code).toBe('UNAUTHORIZED');
  });

  it('returns a JSON 404 for an unknown /api route', async () => {
    const res = await request(app)
      .get('/api/does-not-exist')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).toEqual({
      error: { code: 'NOT_FOUND', message: expect.any(String) as string },
    });
  });

  it('returns a JSON 404 for other methods and paths too', async () => {
    const res = await request(app).delete('/api/health').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
    expect((res.body as ErrorBody).error.code).toBe('NOT_FOUND');
  });
});

describe('request parsing', () => {
  it('returns a JSON 404 outside /api without a token', async () => {
    const res = await request(app).get('/nothing-here');

    expect(res.status).toBe(404);
    expect((res.body as ErrorBody).error.code).toBe('NOT_FOUND');
  });

  it('answers malformed JSON with a 400 JSON error', async () => {
    const res = await request(app)
      .post('/api/anything')
      .set('Content-Type', 'application/json')
      .send('{"title": ');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: { code: 'INVALID_JSON', message: 'Request body is not valid JSON' },
    });
  });

  it.each([
    ['charset', { 'Content-Type': 'application/json; charset=latin-9' }],
    ['encoding', { 'Content-Type': 'application/json', 'Content-Encoding': 'compress' }],
  ])('answers a body %s it cannot read with 415 UNSUPPORTED_MEDIA_TYPE', async (_name, headers) => {
    const res = await request(app).post('/api/anything').set(headers).send('{"title":"x"}');

    expect(res.status).toBe(415);
    expect((res.body as ErrorBody).error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('answers a path with broken percent-encoding with 400 VALIDATION_ERROR', async () => {
    const res = await request(app)
      .get('/api/properties/%E0%A4%A')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(400);
    expect((res.body as ErrorBody).error).toMatchObject({
      code: 'VALIDATION_ERROR',
      details: [{ field: 'path', message: 'contains invalid percent-encoding' }],
    });
  });

  it('rejects bodies over the size limit with 413', async () => {
    const res = await request(app)
      .post('/api/anything')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ text: 'x'.repeat(1_100_000) }));

    expect(res.status).toBe(413);
    expect((res.body as ErrorBody).error.code).toBe('PAYLOAD_TOO_LARGE');
  });
});

describe('login rate limit', () => {
  const loginFrom = (target: ReturnType<typeof createApp>, forwardedFor: string) =>
    request(target).post('/api/auth/login').set('X-Forwarded-For', forwardedFor).send({});

  const appWith = (env: Record<string, string>, loginRateLimit?: { limit: number }) => {
    const config = makeConfig(env);
    return createApp({ config, logger: createLogger(config), db: dbWithAdmin(), loginRateLimit });
  };

  it('allows 10 attempts per 15 minutes by default', async () => {
    const res = await request(appWith({})).post('/api/auth/login').send({});

    expect(LOGIN_RATE_LIMIT_DEFAULTS).toEqual({ windowMs: 15 * 60 * 1000, limit: 10 });
    expect(res.headers['ratelimit-policy']).toMatch(/q=10; ?w=900/);
    expect(res.headers.ratelimit).toMatch(/r=9/);
  });

  it('ignores X-Forwarded-For without TRUST_PROXY, so a forged one gets no fresh limit', async () => {
    const limited = appWith({}, { limit: 2 });
    const statuses = [];
    for (const address of ['203.0.113.1', '203.0.113.2', '203.0.113.3']) {
      statuses.push((await loginFrom(limited, address)).status);
    }

    expect(statuses).toEqual([400, 400, 429]);
  });

  it.each(['loopback', '1'])(
    'counts per X-Forwarded-For client behind a trusted proxy (TRUST_PROXY=%s)',
    async (trustProxy) => {
      const limited = appWith({ TRUST_PROXY: trustProxy }, { limit: 2 });
      const statuses = [];
      for (const address of ['203.0.113.1', '203.0.113.2', '203.0.113.3']) {
        statuses.push((await loginFrom(limited, address)).status);
      }
      statuses.push((await loginFrom(limited, '203.0.113.1')).status);
      statuses.push((await loginFrom(limited, '203.0.113.1')).status);

      expect(statuses).toEqual([400, 400, 400, 400, 429]);
    },
  );
});

describe('security headers and CORS', () => {
  it('sets helmet headers, hides x-powered-by and returns a request id', async () => {
    const res = await request(app).get('/api/health');

    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-request-id']).toMatch(/^[\w-]+$/);
  });

  it('allows every origin listed in CORS_ORIGIN', async () => {
    for (const origin of ['http://localhost:4200', 'https://admin.example.test']) {
      const res = await request(app).get('/api/health').set('Origin', origin);
      expect(res.headers['access-control-allow-origin']).toBe(origin);
    }
  });

  it('does not allow other origins', async () => {
    const res = await request(app).get('/api/health').set('Origin', 'https://evil.example.test');

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('lets pages on any origin embed photos, but not other API responses', async () => {
    const photo = await request(app).get('/uploads/demo/photo.jpg');
    const health = await request(app).get('/api/health');
    const missingPhoto = await request(app).get('/uploads/demo/missing.jpg');

    expect(photo.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(health.headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(missingPhoto.headers['cross-origin-resource-policy']).toBe('same-origin');
  });
});

describe('/uploads', () => {
  it('serves files from UPLOAD_DIR', async () => {
    const res = await request(app).get('/uploads/demo/photo.jpg');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
  });

  it('does not list directories', async () => {
    for (const url of ['/uploads/', '/uploads/demo', '/uploads/demo/']) {
      const res = await request(app).get(url);
      expect(res.status, url).toBe(404);
      expect((res.body as ErrorBody).error.code, url).toBe('NOT_FOUND');
    }
  });

  it('does not serve dotfiles', async () => {
    expect((await request(app).get('/uploads/demo/.secret')).status).toBe(404);
  });

  it('reaches files inside UPLOAD_DIR with the raw client (control for the next test)', async () => {
    const res = await rawGet('/uploads/demo/photo.jpg');

    expect(res.status).toBe(200);
  });

  it.each([
    '/uploads/../secret.txt',
    '/uploads/..%2fsecret.txt',
    '/uploads/..%2Fsecret.txt',
    '/uploads/%2e%2e/secret.txt',
    '/uploads/%2e%2e%2fsecret.txt',
    '/uploads/..%5csecret.txt',
    '/uploads/demo/..%2f..%2fsecret.txt',
    '/uploads/demo/%2e%2e%5c%2e%2e%5csecret.txt',
  ])('does not serve files outside UPLOAD_DIR (%s)', async (url) => {
    const res = await rawGet(url);

    expect(res.status).toBe(404);
    expect(res.body).not.toContain(OUTSIDE_SECRET);
    expect((JSON.parse(res.body) as ErrorBody).error.code).toBe('NOT_FOUND');
  });
});
