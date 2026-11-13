import { randomBytes, scryptSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../../src/lib/password.js';

const toBase64 = (buffer: Buffer) => buffer.toString('base64').replace(/=+$/, '');

describe('password hashing', () => {
  it('produces a self-describing scrypt hash with a random salt', async () => {
    const first = await hashPassword('demo1234');
    const second = await hashPassword('demo1234');

    expect(first).toMatch(/^\$scrypt\$ln=15,r=8,p=3\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/);
    expect(first).not.toBe(second);
    expect(first).not.toContain('demo1234');
  });

  it('accepts the correct password', async () => {
    const hash = await hashPassword('correct horse battery staple');

    await expect(verifyPassword('correct horse battery staple', hash)).resolves.toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await hashPassword('demo1234');

    await expect(verifyPassword('demo12345', hash)).resolves.toBe(false);
    await expect(verifyPassword('Demo1234', hash)).resolves.toBe(false);
    await expect(verifyPassword('', hash)).resolves.toBe(false);
  });

  it('handles non-ASCII passwords, including different Unicode forms', async () => {
    const hash = await hashPassword('парола-Ж');

    await expect(verifyPassword('парола-Ж', hash)).resolves.toBe(true);
    await expect(verifyPassword('парола-ж', hash)).resolves.toBe(false);

    // "é" as one code point vs "e" + combining accent: same password after normalisation.
    const composed = await hashPassword('café');
    await expect(verifyPassword('café', composed)).resolves.toBe(true);
  });

  it('returns false instead of throwing for malformed hashes', async () => {
    const valid = await hashPassword('demo1234');
    const [, , params = '', salt = '', key = ''] = valid.split('$');

    const malformed = [
      '',
      'demo1234',
      'not-a-hash',
      `$bcrypt$${params}$${salt}$${key}`,
      `$scrypt$${params}$${salt}`,
      `$scrypt$ln=x,r=8,p=3$${salt}$${key}`,
      `$scrypt$${params}$${salt}$${key}$extra`,
      `$scrypt$${params}$***$${key}`,
      // Parameters outside the accepted bounds (would need huge memory or are too weak).
      `$scrypt$ln=30,r=8,p=3$${salt}$${key}`,
      `$scrypt$ln=4,r=8,p=3$${salt}$${key}`,
      `$scrypt$ln=0,r=0,p=0$${salt}$${key}`,
      // Salt or key too short.
      `$scrypt$${params}$AAAA$${key}`,
      `$scrypt$${params}$${salt}$AAAA`,
    ];

    for (const stored of malformed) {
      await expect(verifyPassword('demo1234', stored), stored).resolves.toBe(false);
    }
  });

  it('refuses parameters that would make one check use too much memory or CPU', async () => {
    const valid = await hashPassword('demo1234');
    const [, , , salt = '', key = ''] = valid.split('$');

    // Each of these would make scrypt use far more resources than a normal login (the
    // first one about 4 GiB of memory and 16 times the work), so none may reach scrypt.
    const tooExpensive = [
      'ln=20,r=32,p=16',
      'ln=18,r=8,p=1',
      'ln=17,r=16,p=1',
      'ln=16,r=32,p=1',
      'ln=15,r=8,p=5',
      'ln=15,r=4,p=3',
      'ln=13,r=8,p=10',
    ];

    for (const params of tooExpensive) {
      await expect(
        verifyPassword('demo1234', `$scrypt$${params}$${salt}$${key}`),
        params,
      ).resolves.toBe(false);
    }
  });

  it(
    'verifies hashes made with other parameters inside the bounds',
    { timeout: 20_000 },
    async () => {
      const salt = randomBytes(16);
      const cases = [
        { logN: 14, r: 8, p: 1 },
        // The largest working memory allowed: 128 MiB.
        { logN: 17, r: 8, p: 1 },
        { logN: 16, r: 16, p: 1 },
      ];

      for (const { logN, r, p } of cases) {
        const N = 2 ** logN;
        const key = scryptSync('demo1234', salt, 32, { N, r, p, maxmem: 256 * N * r });
        const stored = `$scrypt$ln=${logN},r=${r},p=${p}$${toBase64(salt)}$${toBase64(key)}`;

        await expect(verifyPassword('demo1234', stored), stored).resolves.toBe(true);
        await expect(verifyPassword('demo12345', stored), stored).resolves.toBe(false);
      }
    },
  );

  it('refuses to hash an empty password', async () => {
    await expect(hashPassword('')).rejects.toThrow(/empty/);
  });
});
