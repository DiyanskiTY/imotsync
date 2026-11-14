import { scrypt } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hashPassword, verifyPassword } from '../../src/lib/password.js';
import type { UserRepository } from '../../src/modules/auth/auth.repository.js';
import {
  createAuthService,
  DUMMY_PASSWORD_HASH,
  INVALID_CREDENTIALS_MESSAGE,
} from '../../src/modules/auth/auth.service.js';
import { createTokenService } from '../../src/modules/auth/tokens.js';
import { DEMO_ADMIN } from './helpers.js';

vi.mock('../../src/lib/password.js', { spy: true });
vi.mock('node:crypto', { spy: true });

const PASSWORD = 'correct horse battery staple';
const tokens = createTokenService({ secret: 'auth-service-test-secret', ttlSeconds: 900 });

let passwordHash: string;
const lookups: string[] = [];
const users: UserRepository = {
  findByEmail: (email) => {
    lookups.push(email);
    return Promise.resolve(
      email === DEMO_ADMIN.email ? { ...DEMO_ADMIN, password_hash: passwordHash } : undefined,
    );
  },
  findById: () => Promise.resolve(undefined),
};
const auth = createAuthService({ users, tokens });

beforeEach(async () => {
  passwordHash ??= await hashPassword(PASSWORD);
  lookups.length = 0;
  vi.mocked(verifyPassword).mockClear();
});

describe('login', () => {
  it('returns a bearer token and the user for the right password', async () => {
    const result = await auth.login(DEMO_ADMIN.email, PASSWORD);

    expect(result).toMatchObject({
      tokenType: 'Bearer',
      expiresIn: 900,
      user: { id: 1, email: 'admin@imotsync.local', fullName: 'Demo Admin', role: 'admin' },
    });
    expect(await tokens.verify(result.accessToken)).toEqual({ userId: 1, role: 'admin' });
  });

  it('compares the email trimmed and lower-cased', async () => {
    await auth.login('  ADMIN@ImotSync.Local ', PASSWORD);

    expect(lookups).toEqual(['admin@imotsync.local']);
  });

  it('gives the same error for a wrong password and an unknown email', async () => {
    const wrongPassword = await auth.login(DEMO_ADMIN.email, 'wrong').catch((e: unknown) => e);
    const unknownEmail = await auth
      .login('nobody@imotsync.local', PASSWORD)
      .catch((e: unknown) => e);

    for (const error of [wrongPassword, unknownEmail]) {
      expect(error).toMatchObject({
        status: 401,
        code: 'INVALID_CREDENTIALS',
        message: INVALID_CREDENTIALS_MESSAGE,
        headers: { 'WWW-Authenticate': 'Bearer realm="imotsync"' },
      });
    }
  });

  it('still runs scrypt for an unknown email, against the dummy hash', async () => {
    await auth.login('nobody@imotsync.local', PASSWORD).catch(() => undefined);

    expect(verifyPassword).toHaveBeenCalledTimes(1);
    expect(verifyPassword).toHaveBeenCalledWith(PASSWORD, DUMMY_PASSWORD_HASH);
  });
});

describe('DUMMY_PASSWORD_HASH', () => {
  it('uses the same scrypt parameters as hashPassword(), so it costs the same', async () => {
    const parameters = (hash: string) => hash.split('$').slice(1, 3).join('$');

    expect(parameters(DUMMY_PASSWORD_HASH)).toBe(parameters(await hashPassword('anything')));
  });

  it('is a well-formed hash that scrypt really checks (and matches no likely password)', async () => {
    // A malformed hash would make verifyPassword return false at once, without scrypt.
    vi.mocked(scrypt).mockClear();

    expect(await verifyPassword('demo1234', DUMMY_PASSWORD_HASH)).toBe(false);

    expect(scrypt).toHaveBeenCalledTimes(1);
    const [, salt, keyBytes, options] = vi.mocked(scrypt).mock.calls[0] as unknown[];
    // The salt and key sizes hashPassword() uses, and the full cost: N = 2^15, r = 8, p = 3.
    expect((salt as Buffer).length).toBe(16);
    expect(keyBytes).toBe(32);
    expect(options).toMatchObject({ N: 2 ** 15, r: 8, p: 3 });
  });
});
