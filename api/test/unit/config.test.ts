import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { API_ROOT, ConfigError, loadRootEnvFile, parseConfig } from '../../src/config.js';
import { makeConfig, MINIMAL_ENV } from './helpers.js';

describe('parseConfig', () => {
  it('applies defaults for everything optional', () => {
    const config = parseConfig({
      JWT_SECRET: 'secret',
      DB_USER: 'imotsync',
      DB_PASSWORD: 'pw',
    });

    expect(config).toEqual({
      nodeEnv: 'development',
      isProduction: false,
      port: 3000,
      corsOrigins: ['http://localhost:4200'],
      jwtSecret: 'secret',
      jwtTtlSeconds: 28_800,
      trustProxy: false,
      uploadDir: path.resolve(API_ROOT, 'uploads'),
      db: { host: '127.0.0.1', port: 3307, database: 'imotsync', user: 'imotsync', password: 'pw' },
      seed: { demoPassword: 'demo1234', allowInProduction: false },
    });
  });

  it('reads and converts the environment variables', () => {
    const config = makeConfig({
      NODE_ENV: 'production',
      API_PORT: '8080',
      JWT_SECRET: 'x'.repeat(32),
      DB_HOST: 'db',
      DB_PORT: '3306',
      DB_NAME: 'imotsync_demo',
      ALLOW_DEMO_SEED: 'true',
      SEED_DEMO_PASSWORD: 'another-pass',
    });

    expect(config.isProduction).toBe(true);
    expect(config.port).toBe(8080);
    expect(config.db).toMatchObject({ host: 'db', port: 3306, database: 'imotsync_demo' });
    expect(config.seed).toEqual({ demoPassword: 'another-pass', allowInProduction: true });
  });

  it('splits a comma-separated CORS_ORIGIN', () => {
    const config = makeConfig({
      CORS_ORIGIN: ' http://localhost:4200 ,https://demo.example.test,',
    });

    expect(config.corsOrigins).toEqual(['http://localhost:4200', 'https://demo.example.test']);
  });

  it('resolves a relative UPLOAD_DIR from the api folder and keeps an absolute one', () => {
    expect(makeConfig({ UPLOAD_DIR: './files/photos' }).uploadDir).toBe(
      path.join(API_ROOT, 'files', 'photos'),
    );
    const absolute = path.join(tmpdir(), 'imotsync-uploads');
    expect(makeConfig({ UPLOAD_DIR: absolute }).uploadDir).toBe(absolute);
  });

  it.each([
    [{ JWT_SECRET: undefined }, 'JWT_SECRET'],
    [{ DB_USER: undefined }, 'DB_USER'],
    [{ DB_PASSWORD: undefined }, 'DB_PASSWORD'],
    [{ API_PORT: 'abc' }, 'API_PORT'],
    [{ DB_PORT: '70000' }, 'DB_PORT'],
    [{ NODE_ENV: 'staging' }, 'NODE_ENV'],
    [{ CORS_ORIGIN: 'http://localhost:4200/admin' }, 'CORS_ORIGIN'],
    [{ CORS_ORIGIN: ' , ' }, 'CORS_ORIGIN'],
    [{ ALLOW_DEMO_SEED: 'maybe' }, 'ALLOW_DEMO_SEED'],
    [{ SEED_DEMO_PASSWORD: 'short' }, 'SEED_DEMO_PASSWORD'],
    [{ JWT_TTL_SECONDS: '59' }, 'JWT_TTL_SECONDS'],
    [{ JWT_TTL_SECONDS: '2592001' }, 'JWT_TTL_SECONDS'],
    [{ JWT_TTL_SECONDS: '1.5' }, 'JWT_TTL_SECONDS'],
    [{ TRUST_PROXY: 'yes' }, 'TRUST_PROXY'],
    [{ TRUST_PROXY: '10.0.0.0/33' }, 'TRUST_PROXY'],
    [{ TRUST_PROXY: 'loopback, not-an-ip' }, 'TRUST_PROXY'],
  ])('rejects invalid input %o', (override, variable) => {
    expect(() => makeConfig(override)).toThrow(ConfigError);
    expect(() => makeConfig(override)).toThrow(variable);
  });

  it('requires a JWT_SECRET of at least 32 characters in production only', () => {
    const shortSecret = { JWT_SECRET: 'dev-only-change-me' };

    expect(makeConfig({ ...shortSecret, NODE_ENV: 'development' }).jwtSecret).toBe(
      'dev-only-change-me',
    );
    expect(() => makeConfig({ ...shortSecret, NODE_ENV: 'production' })).toThrow(/at least 32/);
    expect(makeConfig({ NODE_ENV: 'production', JWT_SECRET: 'y'.repeat(32) }).isProduction).toBe(
      true,
    );
  });

  it('rejects the public dev-only placeholder secret in production only', () => {
    const placeholder = { JWT_SECRET: 'dev-only-change-me-to-a-long-random-value' };

    expect(makeConfig({ ...placeholder, NODE_ENV: 'development' }).jwtSecret).toBe(
      placeholder.JWT_SECRET,
    );
    expect(() => makeConfig({ ...placeholder, NODE_ENV: 'production' })).toThrow(
      /public 'dev-only\.\.\.' placeholder/,
    );
  });

  it('accepts the usual spellings of booleans for ALLOW_DEMO_SEED', () => {
    expect(makeConfig({ ALLOW_DEMO_SEED: '1' }).seed.allowInProduction).toBe(true);
    expect(makeConfig({ ALLOW_DEMO_SEED: 'false' }).seed.allowInProduction).toBe(false);
  });

  it('reads the token lifetime', () => {
    expect(makeConfig({ JWT_TTL_SECONDS: '3600' }).jwtTtlSeconds).toBe(3600);
  });

  it.each([
    ['false', false],
    ['', false],
    ['TRUE', true],
    ['1', 1],
    ['2', 2],
    ['loopback', ['loopback']],
    ['loopback, 10.0.0.0/8 ,fd00::/8', ['loopback', '10.0.0.0/8', 'fd00::/8']],
    ['172.18.0.1', ['172.18.0.1']],
  ])('reads TRUST_PROXY=%j for Express', (value, expected) => {
    expect(makeConfig({ TRUST_PROXY: value }).trustProxy).toEqual(expected);
  });

  it('refuses TRUST_PROXY=true in production, where clients could forge their address', () => {
    const production = { NODE_ENV: 'production', JWT_SECRET: 'z'.repeat(32) };

    expect(() => makeConfig({ ...production, TRUST_PROXY: 'true' })).toThrow(
      /must not be true when NODE_ENV=production; set the number of proxies[\s\S]*at TRUST_PROXY/,
    );
    expect(makeConfig({ ...production, TRUST_PROXY: '1' }).trustProxy).toBe(1);
    expect(makeConfig({ ...production, TRUST_PROXY: 'loopback' }).trustProxy).toEqual(['loopback']);
    expect(makeConfig({ TRUST_PROXY: 'true' }).trustProxy).toBe(true);
  });

  it('works with the minimal environment used by the other unit tests', () => {
    expect(parseConfig({ ...MINIMAL_ENV }).nodeEnv).toBe('test');
  });
});

describe('API_ROOT', () => {
  it('points to the api folder', () => {
    const packageJson = JSON.parse(readFileSync(path.join(API_ROOT, 'package.json'), 'utf8')) as {
      name: string;
    };
    expect(packageJson.name).toBe('imotsync-api');
  });
});

describe('loadRootEnvFile', () => {
  const keys = ['IMOTSYNC_TEST_FROM_SHELL', 'IMOTSYNC_TEST_FROM_FILE'];
  let dir: string | undefined;

  afterEach(async () => {
    for (const key of keys) Reflect.deleteProperty(process.env, key);
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('loads missing variables but never overrides ones that are already set', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'imotsync-env-'));
    const file = path.join(dir, '.env');
    await writeFile(file, 'IMOTSYNC_TEST_FROM_SHELL=file\nIMOTSYNC_TEST_FROM_FILE=file\n');
    process.env.IMOTSYNC_TEST_FROM_SHELL = 'shell';

    loadRootEnvFile(file);

    expect(process.env.IMOTSYNC_TEST_FROM_SHELL).toBe('shell');
    expect(process.env.IMOTSYNC_TEST_FROM_FILE).toBe('file');
  });

  it('does nothing when the file does not exist', () => {
    const missing = path.join(tmpdir(), 'imotsync-no-such-dir', '.env');
    expect(existsSync(missing)).toBe(false);
    expect(() => {
      loadRootEnvFile(missing);
    }).not.toThrow();
  });
});
