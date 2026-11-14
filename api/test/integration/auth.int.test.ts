import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { createLogger } from '../../src/logger.js';
import type { ErrorBody } from '../../src/middleware/error-handler.js';
import type { LoginResponse } from '../../src/modules/auth/auth.mappers.js';
import { createTokenService } from '../../src/modules/auth/tokens.js';
import { expectDocumented } from '../support/openapi.js';
import {
  ADMIN_EMAIL,
  authHeader,
  BROKER_EMAIL,
  closeApiFixture,
  DEMO_PASSWORD,
  startApiFixture,
  type ApiFixture,
} from './api-fixture.js';

let fx: ApiFixture;

beforeAll(async () => {
  fx = await startApiFixture();
});

afterAll(async () => {
  await closeApiFixture(fx);
});

const login = (body: unknown) =>
  request(fx.app)
    .post('/api/auth/login')
    .send(body as object);

describe('POST /api/auth/login', () => {
  it('returns a bearer token and the user', async () => {
    const res = await login({ email: ADMIN_EMAIL, password: DEMO_PASSWORD });

    expect(res.status).toBe(200);
    expectDocumented(res, 'post', '/auth/login');
    const body = res.body as LoginResponse;
    expect(body).toMatchObject({
      tokenType: 'Bearer',
      expiresIn: fx.config.jwtTtlSeconds,
      user: { id: 1, email: ADMIN_EMAIL, fullName: 'Demo Admin', role: 'admin' },
    });
    expect(body.accessToken.split('.')).toHaveLength(3);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers.ratelimit).toBeDefined();
  });

  it('finds the account whatever the case and surrounding spaces of the email', async () => {
    const res = await login({ email: '  Broker@ImotSync.LOCAL ', password: DEMO_PASSWORD });

    expect(res.status).toBe(200);
    expect((res.body as LoginResponse).user.email).toBe(BROKER_EMAIL);
  });

  it('gives the same answer for an unknown email and a wrong password', async () => {
    const unknown = await login({ email: 'nobody@imotsync.local', password: DEMO_PASSWORD });
    const wrong = await login({ email: ADMIN_EMAIL, password: 'not-the-password' });

    for (const res of [unknown, wrong]) {
      expect(res.status).toBe(401);
      // Every 401 names the scheme to use (RFC 9110).
      expect(res.headers['www-authenticate']).toBe('Bearer realm="imotsync"');
      expectDocumented(res, 'post', '/auth/login');
    }
    expect(unknown.body).toEqual(wrong.body);
    expect((wrong.body as ErrorBody).error.code).toBe('INVALID_CREDENTIALS');
  });

  it('rejects a malformed request', async () => {
    const missing = await login({ email: ADMIN_EMAIL });
    const notJson = await request(fx.app)
      .post('/api/auth/login')
      .set('Content-Type', 'text/plain')
      .send(`email=${ADMIN_EMAIL}`);
    const brokenJson = await request(fx.app)
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"email":');

    expect(missing.status).toBe(400);
    expect((missing.body as ErrorBody).error).toMatchObject({
      code: 'VALIDATION_ERROR',
      details: [{ field: 'password', message: 'is required' }],
    });
    expect(notJson.status).toBe(415);
    expect((notJson.body as ErrorBody).error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    expect(brokenJson.status).toBe(400);
    expect((brokenJson.body as ErrorBody).error.code).toBe('INVALID_JSON');
    for (const res of [missing, notJson, brokenJson]) expectDocumented(res, 'post', '/auth/login');
  });
});

describe('GET /api/auth/me', () => {
  it('returns the user of the token', async () => {
    const res = await request(fx.app)
      .get('/api/auth/me')
      .set(await authHeader(fx.app, BROKER_EMAIL));

    expect(res.status).toBe(200);
    expectDocumented(res, 'get', '/auth/me');
    expect(res.body).toEqual({
      user: { id: 2, email: BROKER_EMAIL, fullName: 'Demo Broker', role: 'broker' },
    });
  });

  it('answers 401 with a Bearer challenge without a token or with a bad one', async () => {
    const otherSecret = createTokenService({ secret: 'not-the-api-secret', ttlSeconds: 60 });
    const forged = (await otherSecret.sign({ userId: 1, role: 'admin' })).token;
    const cases = [
      ['/auth/me', undefined],
      ['/auth/me', 'Bearer abc.def.ghi'],
      ['/auth/me', `Bearer ${forged}`],
      ['/properties', `Bearer ${forged}`],
    ] as const;

    for (const [path, header] of cases) {
      const req = request(fx.app).get(`/api${path}`);
      const res = header === undefined ? await req : await req.set('Authorization', header);
      expect(res.status).toBe(401);
      expect(res.headers['www-authenticate']).toMatch(/^Bearer realm="imotsync"/);
      expect((res.body as ErrorBody).error.code).toBe('UNAUTHORIZED');
      expectDocumented(res, 'get', path);
    }
  });

  it('rejects an expired token', async () => {
    const tokens = createTokenService({
      secret: fx.config.jwtSecret,
      ttlSeconds: 60,
      now: () => Date.now() - 3_600_000,
    });
    const { token } = await tokens.sign({ userId: 1, role: 'admin' });
    const res = await request(fx.app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect((res.body as ErrorBody).error.message).toBe('Token has expired');
  });

  it('rejects the token of an account that was deleted', async () => {
    const [id] = await fx.db('users').insert({
      email: 'temp@imotsync.local',
      password_hash: (await fx.db('users').where({ id: 1 }).first())?.password_hash ?? '',
      full_name: 'Temporary User',
      role: 'broker',
    });
    const header = await authHeader(fx.app, 'temp@imotsync.local');
    expect((await request(fx.app).get('/api/auth/me').set(header)).status).toBe(200);

    await fx.db('users').where({ id }).delete();
    const res = await request(fx.app).get('/api/auth/me').set(header);

    expect(res.status).toBe(401);
    expect((res.body as ErrorBody).error).toEqual({
      code: 'UNAUTHORIZED',
      message: 'The account of this token no longer exists',
    });
    expect(res.headers['www-authenticate']).toBe('Bearer realm="imotsync", error="invalid_token"');
    expectDocumented(res, 'get', '/auth/me');
  });
});

describe('login rate limit', () => {
  it('blocks the client after the injected number of attempts, with 429 and Retry-After', async () => {
    const limited = createApp({
      config: fx.config,
      db: fx.db,
      logger: createLogger(fx.config),
      loginRateLimit: { limit: 3, windowMs: 15 * 60 * 1000 },
    });
    const attempt = (password: string) =>
      request(limited).post('/api/auth/login').send({ email: ADMIN_EMAIL, password });

    expect((await attempt('wrong-1')).status).toBe(401);
    expect((await attempt('wrong-2')).status).toBe(401);
    expect((await attempt(DEMO_PASSWORD)).status).toBe(200);
    // Even the right password is refused now, until the window has passed.
    const blocked = await attempt(DEMO_PASSWORD);

    expect(blocked.status).toBe(429);
    expectDocumented(blocked, 'post', '/auth/login');
    expect((blocked.body as ErrorBody).error.code).toBe('TOO_MANY_REQUESTS');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect(blocked.headers['ratelimit-policy']).toMatch(/q=3; ?w=900/);
  });
});
