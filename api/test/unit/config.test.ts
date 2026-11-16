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
      publicBaseUrl: 'http://localhost:3000',
      feeds: { token: 'dev-only-feed-token' },
      worker: {
        concurrency: 2,
        pollIntervalMs: 1000,
        jobTimeoutSeconds: 60,
        lockTimeoutSeconds: 300,
      },
      retry: { baseSeconds: 30, capSeconds: 3600 },
      portals: {
        publicListingUrlTemplate: null,
        demo: { failureRate: 0.3, latencyMs: 400 },
        realistimo: {
          agencyUid: 'imotsync-demo',
          apiKey: null,
          apiBaseUrl: 'https://realistimo.com',
          syncIntervalSeconds: 900,
        },
        bazar: { removedRetentionDays: 30 },
      },
    });
  });

  it('reads and converts the environment variables', () => {
    const config = makeConfig({
      NODE_ENV: 'production',
      PUBLIC_BASE_URL: 'https://imotsync.example',
      API_PORT: '8080',
      JWT_SECRET: 'x'.repeat(32),
      FEED_TOKEN: 'f'.repeat(32),
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
    expect(
      makeConfig({
        NODE_ENV: 'production',
        JWT_SECRET: 'y'.repeat(32),
        FEED_TOKEN: 'f'.repeat(32),
        PUBLIC_BASE_URL: 'https://imotsync.example',
      }).isProduction,
    ).toBe(true);
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
    const production = {
      NODE_ENV: 'production',
      JWT_SECRET: 'z'.repeat(32),
      FEED_TOKEN: 'f'.repeat(32),
      PUBLIC_BASE_URL: 'https://imotsync.example',
    };

    expect(() => makeConfig({ ...production, TRUST_PROXY: 'true' })).toThrow(
      /must not be true when NODE_ENV=production; set the number of proxies[\s\S]*at TRUST_PROXY/,
    );
    expect(makeConfig({ ...production, TRUST_PROXY: '1' }).trustProxy).toBe(1);
    expect(makeConfig({ ...production, TRUST_PROXY: 'loopback' }).trustProxy).toEqual(['loopback']);
    expect(makeConfig({ TRUST_PROXY: 'true' }).trustProxy).toBe(true);
  });

  it('reads the publishing settings', () => {
    const config = makeConfig({
      PUBLIC_BASE_URL: 'https://imotsync.example',
      FEED_TOKEN: 'a-feed-token_123',
      WORKER_CONCURRENCY: '4',
      WORKER_POLL_INTERVAL_MS: '250',
      JOB_TIMEOUT_SECONDS: '30',
      JOB_LOCK_TIMEOUT_SECONDS: '120',
      RETRY_BASE_SECONDS: '5',
      RETRY_CAP_SECONDS: '600',
      DEMO_PORTAL_FAILURE_RATE: '0',
      DEMO_PORTAL_LATENCY_MS: '0',
      REALISTIMO_AGENCY_UID: ' my-agency ',
      REALISTIMO_API_KEY: ' key-123 ',
      REALISTIMO_API_BASE_URL: 'http://127.0.0.1:4010',
      REALISTIMO_SYNC_INTERVAL_SECONDS: '300',
      BAZAR_REMOVED_RETENTION_DAYS: '7',
      PUBLIC_LISTING_URL_TEMPLATE: 'https://agency.example/properties/{refCode}',
    });

    expect(config.publicBaseUrl).toBe('https://imotsync.example');
    expect(config.feeds).toEqual({ token: 'a-feed-token_123' });
    expect(config.worker).toEqual({
      concurrency: 4,
      pollIntervalMs: 250,
      jobTimeoutSeconds: 30,
      lockTimeoutSeconds: 120,
    });
    expect(config.retry).toEqual({ baseSeconds: 5, capSeconds: 600 });
    expect(config.portals).toEqual({
      publicListingUrlTemplate: 'https://agency.example/properties/{refCode}',
      demo: { failureRate: 0, latencyMs: 0 },
      realistimo: {
        agencyUid: 'my-agency',
        apiKey: 'key-123',
        apiBaseUrl: 'http://127.0.0.1:4010',
        syncIntervalSeconds: 300,
      },
      bazar: { removedRetentionDays: 7 },
    });
  });

  it.each([
    [{ PUBLIC_BASE_URL: 'https://imotsync.example/' }, 'PUBLIC_BASE_URL'],
    [{ PUBLIC_BASE_URL: 'imotsync.example' }, 'PUBLIC_BASE_URL'],
    [{ FEED_TOKEN: 'short' }, 'FEED_TOKEN'],
    [{ FEED_TOKEN: 'has a space in it' }, 'FEED_TOKEN'],
    [{ FEED_TOKEN: 'slash/in/the/token' }, 'FEED_TOKEN'],
    [{ WORKER_CONCURRENCY: '0' }, 'WORKER_CONCURRENCY'],
    [{ WORKER_CONCURRENCY: '17' }, 'WORKER_CONCURRENCY'],
    [{ WORKER_POLL_INTERVAL_MS: '99' }, 'WORKER_POLL_INTERVAL_MS'],
    [{ WORKER_POLL_INTERVAL_MS: '60001' }, 'WORKER_POLL_INTERVAL_MS'],
    [{ JOB_TIMEOUT_SECONDS: '0' }, 'JOB_TIMEOUT_SECONDS'],
    [{ JOB_TIMEOUT_SECONDS: '60', JOB_LOCK_TIMEOUT_SECONDS: '60' }, 'JOB_LOCK_TIMEOUT_SECONDS'],
    [{ JOB_TIMEOUT_SECONDS: '60', JOB_LOCK_TIMEOUT_SECONDS: '119' }, 'JOB_LOCK_TIMEOUT_SECONDS'],
    [{ RETRY_BASE_SECONDS: '60', RETRY_CAP_SECONDS: '30' }, 'RETRY_CAP_SECONDS'],
    [{ DEMO_PORTAL_FAILURE_RATE: '1.5' }, 'DEMO_PORTAL_FAILURE_RATE'],
    [{ DEMO_PORTAL_FAILURE_RATE: '-0.1' }, 'DEMO_PORTAL_FAILURE_RATE'],
    [{ DEMO_PORTAL_LATENCY_MS: 'slow' }, 'DEMO_PORTAL_LATENCY_MS'],
    [{ REALISTIMO_AGENCY_UID: '  ' }, 'REALISTIMO_AGENCY_UID'],
    [{ REALISTIMO_API_BASE_URL: 'https://realistimo.com/api' }, 'REALISTIMO_API_BASE_URL'],
    [{ REALISTIMO_SYNC_INTERVAL_SECONDS: '10' }, 'REALISTIMO_SYNC_INTERVAL_SECONDS'],
    [{ BAZAR_REMOVED_RETENTION_DAYS: '0' }, 'BAZAR_REMOVED_RETENTION_DAYS'],
    [{ PUBLIC_LISTING_URL_TEMPLATE: 'https://agency.example/p/1' }, 'PUBLIC_LISTING_URL_TEMPLATE'],
    [{ PUBLIC_LISTING_URL_TEMPLATE: 'agency.example/{refCode}' }, 'PUBLIC_LISTING_URL_TEMPLATE'],
  ])('rejects invalid publishing setting %o', (override, variable) => {
    expect(() => makeConfig(override)).toThrow(ConfigError);
    expect(() => makeConfig(override)).toThrow(variable);
  });

  it('requires a real FEED_TOKEN in production only, like JWT_SECRET', () => {
    const production = {
      NODE_ENV: 'production',
      JWT_SECRET: 'z'.repeat(32),
      PUBLIC_BASE_URL: 'https://imotsync.example',
    };

    expect(() => makeConfig(production)).toThrow(/FEED_TOKEN/);
    expect(() => makeConfig({ ...production, FEED_TOKEN: 'short-token-123' })).toThrow(
      /at least 32 characters when NODE_ENV=production[\s\S]*at FEED_TOKEN/,
    );
    expect(() => makeConfig({ ...production, FEED_TOKEN: `dev-only-${'x'.repeat(32)}` })).toThrow(
      /public 'dev-only\.\.\.' placeholder[\s\S]*at FEED_TOKEN/,
    );
    expect(makeConfig({ ...production, FEED_TOKEN: 'f'.repeat(32) }).feeds.token).toBe(
      'f'.repeat(32),
    );
    expect(makeConfig({ FEED_TOKEN: 'dev-only-feed-token' }).feeds.token).toBe(
      'dev-only-feed-token',
    );
  });

  it('leaves JOB_LOCK_TIMEOUT_SECONDS at least 60 s above JOB_TIMEOUT_SECONDS', () => {
    expect(() =>
      makeConfig({ JOB_TIMEOUT_SECONDS: '60', JOB_LOCK_TIMEOUT_SECONDS: '119' }),
    ).toThrow(
      /must be at least JOB_TIMEOUT_SECONDS \+ 60 \(120\)[\s\S]*at JOB_LOCK_TIMEOUT_SECONDS/,
    );
    expect(
      makeConfig({ JOB_TIMEOUT_SECONDS: '60', JOB_LOCK_TIMEOUT_SECONDS: '120' }).worker
        .lockTimeoutSeconds,
    ).toBe(120);
  });

  it('requires a public https PUBLIC_BASE_URL in production, unless explicitly allowed', () => {
    const production = {
      NODE_ENV: 'production',
      JWT_SECRET: 'z'.repeat(32),
      FEED_TOKEN: 'f'.repeat(32),
    };

    for (const url of [
      'http://imotsync.example',
      'https://localhost:3000',
      'https://127.0.0.1',
      'https://[::1]:8443',
      'https://app.localhost',
    ]) {
      expect(() => makeConfig({ ...production, PUBLIC_BASE_URL: url }), url).toThrow(
        /public https:\/\/ origin[\s\S]*at PUBLIC_BASE_URL/,
      );
    }
    // The default (http://localhost:3000) too.
    expect(() => makeConfig(production)).toThrow(/at PUBLIC_BASE_URL/);
    expect(
      makeConfig({ ...production, PUBLIC_BASE_URL: 'https://imotsync.example' }).publicBaseUrl,
    ).toBe('https://imotsync.example');
    // A local run of the production build (Docker Compose, CI) opts out explicitly.
    expect(
      makeConfig({ ...production, ALLOW_INSECURE_PUBLIC_BASE_URL: 'true' }).publicBaseUrl,
    ).toBe('http://localhost:3000');
    // Outside production any origin is fine.
    expect(makeConfig({ PUBLIC_BASE_URL: 'http://localhost:3000' }).publicBaseUrl).toBe(
      'http://localhost:3000',
    );
  });

  it('lets the worker start without JWT_SECRET and FEED_TOKEN, which it never uses', () => {
    const { JWT_SECRET: _unused, ...withoutSecret } = MINIMAL_ENV;
    const production = {
      ...withoutSecret,
      NODE_ENV: 'production',
      PUBLIC_BASE_URL: 'https://imotsync.example',
    };

    // The API needs both.
    expect(() => parseConfig(production)).toThrow(/JWT_SECRET/);
    const worker = parseConfig(production, 'worker');
    expect(worker.isProduction).toBe(true);
    // Random values that nobody knows, not the API's secrets, even when they are set.
    const withSecrets = parseConfig(
      { ...production, JWT_SECRET: 's'.repeat(40), FEED_TOKEN: 't'.repeat(40) },
      'worker',
    );
    expect(withSecrets.jwtSecret).not.toBe('s'.repeat(40));
    expect(withSecrets.feeds.token).not.toBe('t'.repeat(40));
    expect(withSecrets.jwtSecret).not.toBe(worker.jwtSecret);
    // Everything else is checked as for the API.
    expect(() =>
      parseConfig({ ...production, PUBLIC_BASE_URL: 'http://x.example' }, 'worker'),
    ).toThrow(/at PUBLIC_BASE_URL/);
  });

  it('requires an https REALISTIMO_API_BASE_URL in production only', () => {
    const production = {
      NODE_ENV: 'production',
      JWT_SECRET: 'z'.repeat(32),
      FEED_TOKEN: 'f'.repeat(32),
      PUBLIC_BASE_URL: 'https://imotsync.example',
    };

    expect(() =>
      makeConfig({ ...production, REALISTIMO_API_BASE_URL: 'http://realistimo.example' }),
    ).toThrow(
      /must be an https:\/\/ origin when NODE_ENV=production[\s\S]*at REALISTIMO_API_BASE_URL/,
    );
    expect(
      makeConfig({ REALISTIMO_API_BASE_URL: 'http://127.0.0.1:9' }).portals.realistimo.apiBaseUrl,
    ).toBe('http://127.0.0.1:9');
  });

  it('turns an empty REALISTIMO_API_KEY and PUBLIC_LISTING_URL_TEMPLATE into null', () => {
    const config = makeConfig({ REALISTIMO_API_KEY: '', PUBLIC_LISTING_URL_TEMPLATE: ' ' });

    expect(config.portals.realistimo.apiKey).toBeNull();
    expect(config.portals.publicListingUrlTemplate).toBeNull();
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
