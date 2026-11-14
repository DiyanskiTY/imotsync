import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import {
  createTokenService,
  InvalidTokenError,
  TOKEN_AUDIENCE,
  TOKEN_ISSUER,
} from '../../src/modules/auth/tokens.js';

const SECRET = 'unit-test-secret-for-tokens';
const tokens = createTokenService({ secret: SECRET, ttlSeconds: 3600 });
const key = new TextEncoder().encode(SECRET);

const base64url = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** A token built by hand, signed correctly unless the test wants otherwise. */
async function customToken(
  claims: Record<string, unknown>,
  options: { secret?: string; header?: Record<string, unknown> } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    sub: '1',
    role: 'admin',
    iss: TOKEN_ISSUER,
    aud: TOKEN_AUDIENCE,
    iat: now,
    exp: now + 600,
    ...claims,
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT', ...options.header })
    .sign(options.secret ? new TextEncoder().encode(options.secret) : key);
}

async function expectRejected(token: string, expired = false) {
  const error = await tokens.verify(token).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(InvalidTokenError);
  expect((error as InvalidTokenError).expired).toBe(expired);
}

describe('token service', () => {
  it('signs a token that verifies to the same user and role', async () => {
    const { token, expiresIn } = await tokens.sign({ userId: 42, role: 'broker' });

    expect(expiresIn).toBe(3600);
    expect(await tokens.verify(token)).toEqual({ userId: 42, role: 'broker' });
  });

  it('puts the expected claims and header in the token', async () => {
    const before = Math.floor(Date.now() / 1000);
    const { token } = await tokens.sign({ userId: 7, role: 'admin' });
    const [header = '', payload = ''] = token.split('.');

    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({
      alg: 'HS256',
      typ: 'JWT',
    });
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Record<
      string,
      unknown
    >;
    expect(claims).toMatchObject({ sub: '7', role: 'admin', iss: 'imotsync', aud: 'imotsync-api' });
    expect(claims.iat).toBeGreaterThanOrEqual(before);
    expect(claims.exp).toBe((claims.iat as number) + 3600);
  });

  it('rejects an expired token and says so', async () => {
    const past = createTokenService({
      secret: SECRET,
      ttlSeconds: 60,
      now: () => Date.now() - 2 * 60 * 60 * 1000,
    });
    const { token } = await past.sign({ userId: 1, role: 'admin' });

    await expectRejected(token, true);
  });

  it('rejects a token signed with another secret', async () => {
    await expectRejected(await customToken({}, { secret: 'some-other-secret' }));
  });

  it('rejects a token for another audience or from another issuer', async () => {
    await expectRejected(await customToken({ aud: 'some-other-api' }));
    await expectRejected(await customToken({ iss: 'someone-else' }));
  });

  it('rejects an unsigned token (alg "none")', async () => {
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${base64url({ alg: 'none', typ: 'JWT' })}.${base64url({
      sub: '1',
      role: 'admin',
      iss: TOKEN_ISSUER,
      aud: TOKEN_AUDIENCE,
      iat: now,
      exp: now + 600,
    })}.`;

    await expectRejected(unsigned);
  });

  it.each(['HS384', 'HS512'])(
    'rejects a token signed with the right secret but %s (the algorithm is pinned)',
    async (alg) => {
      // Same key and claims as a valid token: only the algorithm differs, so nothing but
      // the pinned algorithm can refuse it.
      const token = await customToken({}, { header: { alg } });
      expect(JSON.parse(Buffer.from(token.split('.')[0] ?? '', 'base64url').toString())).toEqual({
        alg,
        typ: 'JWT',
      });

      await expectRejected(token);
    },
  );

  it('rejects a tampered payload', async () => {
    const { token } = await tokens.sign({ userId: 2, role: 'broker' });
    const [header, , signature] = token.split('.');
    const forged = `${header}.${base64url({
      sub: '2',
      role: 'admin',
      iss: TOKEN_ISSUER,
      aud: TOKEN_AUDIENCE,
      iat: 1,
      exp: 9_999_999_999,
    })}.${signature}`;

    await expectRejected(forged);
  });

  it.each([
    [{ sub: undefined }],
    [{ sub: 'abc' }],
    [{ sub: '0' }],
    [{ role: 'superuser' }],
    [{ role: undefined }],
    [{ exp: undefined }],
  ])('rejects a token with bad or missing claims %o', async (claims) => {
    await expectRejected(await customToken(claims));
  });

  it('rejects a token of another type', async () => {
    await expectRejected(await customToken({}, { header: { typ: 'at+jwt' } }));
  });

  it('rejects garbage', async () => {
    await expectRejected('not.a.token');
    await expectRejected('');
  });
});
