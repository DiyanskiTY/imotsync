import { readFileSync } from 'node:fs';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { createLogger } from '../../src/logger.js';
import type { HealthResponse } from '../../src/routes/health.js';
import { failingDb, hangingDb, healthyDb, makeConfig } from './helpers.js';

const config = makeConfig();
const logger = createLogger(config);

const packageVersion = (
  JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;

describe('GET /api/health', () => {
  it('returns 200 with db "up" when the database answers', async () => {
    const app = createApp({ config, logger, db: healthyDb() });

    const res = await request(app).get('/api/health');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.body as HealthResponse;
    expect(body).toEqual({
      status: 'ok',
      db: 'up',
      version: packageVersion,
      uptimeSeconds: expect.any(Number) as number,
    });
    expect(Number.isInteger(body.uptimeSeconds)).toBe(true);
    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('returns 503 with db "down" when the database query fails', async () => {
    const app = createApp({ config, logger, db: failingDb() });

    const res = await request(app).get('/api/health');

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ status: 'degraded', db: 'down', version: packageVersion });
  });

  it('returns 503 instead of hanging when the database never answers', async () => {
    const app = createApp({ config, logger, db: hangingDb(), healthCheckTimeoutMs: 100 });

    const started = performance.now();
    const res = await request(app).get('/api/health');
    const elapsed = performance.now() - started;

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ status: 'degraded', db: 'down' });
    expect(elapsed).toBeLessThan(1_000);
  });

  it('gives up on a hanging database after about 2 seconds by default', async () => {
    const app = createApp({ config, logger, db: hangingDb() });

    const started = performance.now();
    const res = await request(app).get('/api/health');
    const elapsed = performance.now() - started;

    expect(res.status).toBe(503);
    expect(elapsed).toBeGreaterThanOrEqual(1_900);
    expect(elapsed).toBeLessThan(3_500);
  });
});
