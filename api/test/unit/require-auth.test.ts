import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { UserRow } from '../../src/db/types.js';
import { createLogger } from '../../src/logger.js';
import type { ErrorBody } from '../../src/middleware/error-handler.js';
import { createErrorHandler } from '../../src/middleware/error-handler.js';
import { createRequestLogger } from '../../src/middleware/request-logger.js';
import type { UserRepository } from '../../src/modules/auth/auth.repository.js';
import {
  bearerToken,
  createRequireAuth,
  currentUser,
  requireRole,
} from '../../src/modules/auth/require-auth.js';
import { createTokenService } from '../../src/modules/auth/tokens.js';
import { DEMO_ADMIN } from './helpers.js';

const BROKER: UserRow = {
  ...DEMO_ADMIN,
  id: 2,
  email: 'broker@imotsync.local',
  full_name: 'Demo Broker',
  role: 'broker',
};

const tokens = createTokenService({ secret: 'require-auth-test-secret', ttlSeconds: 600 });

function usersWith(...rows: UserRow[]): UserRepository {
  return {
    findByEmail: (email) => Promise.resolve(rows.find((row) => row.email === email)),
    findById: (id) => Promise.resolve(rows.find((row) => row.id === id)),
  };
}

function appWith(users: UserRepository) {
  const app = express();
  app.use(createRequestLogger(createLogger({ nodeEnv: 'test' })));
  const requireAuth = createRequireAuth({ tokens, users });
  app.get('/me', requireAuth, (req, res) => {
    res.json(currentUser(req));
  });
  app.get('/admin', requireAuth, requireRole('admin'), (_req, res) => {
    res.json({ ok: true });
  });
  app.get('/role-without-auth', requireRole('admin'), (_req, res) => {
    res.json({ ok: true });
  });
  app.get('/no-guard', (req, res) => {
    res.json(currentUser(req));
  });
  app.use(createErrorHandler({ isProduction: true }));
  return app;
}

const app = appWith(usersWith(DEMO_ADMIN, BROKER));
const tokenOf = async (user: UserRow) =>
  (await tokens.sign({ userId: user.id, role: user.role })).token;

describe('bearerToken', () => {
  it.each([
    ['Bearer abc.def.ghi', 'abc.def.ghi'],
    ['bearer abc.def.ghi', 'abc.def.ghi'],
    ['Bearer   abc-_.~+/=', 'abc-_.~+/='],
  ])('reads %j', (header, token) => {
    expect(bearerToken(header)).toBe(token);
  });

  it.each([undefined, '', 'Basic dXNlcjpwYXNz', 'Bearer', 'Bearer a b', 'Token abc'])(
    'finds no token in %j',
    (header) => {
      expect(bearerToken(header)).toBeUndefined();
    },
  );
});

describe('requireAuth', () => {
  it('lets a valid token through and exposes the user', async () => {
    const res = await request(app)
      .get('/me')
      .set('Authorization', `Bearer ${await tokenOf(BROKER)}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: 2,
      email: 'broker@imotsync.local',
      fullName: 'Demo Broker',
      role: 'broker',
    });
  });

  it('answers a request without a token with 401 and a Bearer challenge', async () => {
    const res = await request(app).get('/me');

    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toBe('Bearer realm="imotsync"');
    expect((res.body as ErrorBody).error.code).toBe('UNAUTHORIZED');
  });

  it.each(['Bearer not-a-jwt', 'Basic dXNlcjpwYXNz', 'Bearer'])(
    'answers %j with 401 invalid_token',
    async (header) => {
      const res = await request(app).get('/me').set('Authorization', header);

      expect(res.status).toBe(401);
      expect(res.headers['www-authenticate']).toBe(
        'Bearer realm="imotsync", error="invalid_token"',
      );
      expect((res.body as ErrorBody).error.code).toBe('UNAUTHORIZED');
    },
  );

  it('rejects the token of a user that no longer exists', async () => {
    const res = await request(appWith(usersWith(DEMO_ADMIN)))
      .get('/me')
      .set('Authorization', `Bearer ${await tokenOf(BROKER)}`);

    expect(res.status).toBe(401);
    expect((res.body as ErrorBody).error.code).toBe('UNAUTHORIZED');
  });

  it('uses the role from the database, not from the token', async () => {
    // The token still says admin, but the account has been changed to broker since.
    const demoted = await tokens.sign({ userId: BROKER.id, role: 'admin' });
    const res = await request(app).get('/admin').set('Authorization', `Bearer ${demoted.token}`);

    expect(res.status).toBe(403);
  });

  it('reports an expired token as such', async () => {
    const old = createTokenService({
      secret: 'require-auth-test-secret',
      ttlSeconds: 60,
      now: () => Date.now() - 3_600_000,
    });
    const { token } = await old.sign({ userId: 1, role: 'admin' });
    const res = await request(app).get('/me').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect((res.body as ErrorBody).error.message).toBe('Token has expired');
  });
});

describe('requireRole', () => {
  it('allows the role', async () => {
    const res = await request(app)
      .get('/admin')
      .set('Authorization', `Bearer ${await tokenOf(DEMO_ADMIN)}`);

    expect(res.status).toBe(200);
  });

  it('answers other roles with 403 FORBIDDEN', async () => {
    const res = await request(app)
      .get('/admin')
      .set('Authorization', `Bearer ${await tokenOf(BROKER)}`);

    expect(res.status).toBe(403);
    expect((res.body as ErrorBody).error.code).toBe('FORBIDDEN');
  });

  it('answers 401 when requireAuth did not run before it', async () => {
    const res = await request(app).get('/role-without-auth');

    expect(res.status).toBe(401);
  });

  it('makes currentUser() fail loudly on a route without requireAuth', async () => {
    const res = await request(app).get('/no-guard');

    expect(res.status).toBe(500);
  });
});
