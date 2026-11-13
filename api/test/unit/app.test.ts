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
import { healthyDb, makeConfig } from './helpers.js';

/** Content of a file next to UPLOAD_DIR (not inside it): no /uploads URL may return it. */
const OUTSIDE_SECRET = 'outside-upload-dir-sentinel';

let tempDir: string;
let app: ReturnType<typeof createApp>;

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
  app = createApp({ config, logger: createLogger(config), db: healthyDb() });
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
  it('returns a JSON 404 for an unknown /api route', async () => {
    const res = await request(app).get('/api/does-not-exist');

    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).toEqual({
      error: { code: 'NOT_FOUND', message: expect.any(String) as string },
    });
  });

  it('returns a JSON 404 for other methods and paths too', async () => {
    const res = await request(app).delete('/api/health');

    expect(res.status).toBe(404);
    expect((res.body as ErrorBody).error.code).toBe('NOT_FOUND');
  });
});

describe('request parsing', () => {
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

  it('rejects bodies over the size limit with 413', async () => {
    const res = await request(app)
      .post('/api/anything')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ text: 'x'.repeat(1_100_000) }));

    expect(res.status).toBe(413);
    expect((res.body as ErrorBody).error.code).toBe('PAYLOAD_TOO_LARGE');
  });
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
