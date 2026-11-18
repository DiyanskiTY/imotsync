import { once } from 'node:events';
import { get } from 'node:http';
import type { AddressInfo } from 'node:net';
import SwaggerParser from '@apidevtools/swagger-parser';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { API_ERROR_CODES } from '../../src/lib/http-error.js';
import { createLogger } from '../../src/logger.js';
import type { ErrorBody } from '../../src/middleware/error-handler.js';
import { HTTP_METHODS, type HttpMethod, type Operation } from '../../src/openapi/types.js';
import { APP_VERSION } from '../../src/version.js';
import { PHOTO_LIMITS } from '../../src/modules/images/image-processing.js';
import {
  expectDocumented,
  matchesSchema,
  openApiDocument,
  servedPath,
} from '../support/openapi.js';
import { dbWithAdmin, makeConfig } from './helpers.js';

const config = makeConfig();
const logger = createLogger(config);
const app = createApp({ config, logger, db: dbWithAdmin() });

/** The parts of Express' (router 2.x) internals the route walker reads. */
interface Layer {
  route?: { path: string; methods: Record<string, boolean | undefined> };
  handle: unknown;
  slash: boolean;
  match(path: string): boolean;
}

function stackOf(handle: unknown): Layer[] | undefined {
  const stack = (handle as { stack?: unknown } | null)?.stack;
  return typeof handle === 'function' && Array.isArray(stack) ? (stack as Layer[]) : undefined;
}

/** "GET /properties/{id}" for every route in a router and the routers mounted in it. */
function collectRoutes(stack: Layer[], found = new Set<string>()): Set<string> {
  for (const layer of stack) {
    if (layer.route) {
      const path = layer.route.path.replace(/:(\w+)/g, '{$1}');
      for (const [method, enabled] of Object.entries(layer.route.methods)) {
        if (enabled && method !== '_all') found.add(`${method.toUpperCase()} ${path}`);
      }
      continue;
    }
    const nested = stackOf(layer.handle);
    if (nested) {
      // The walker only understands routers mounted without a path of their own.
      expect(layer.slash, 'nested router mounted with a path').toBe(true);
      collectRoutes(nested, found);
    }
  }
  return found;
}

const operations: [HttpMethod, string, Operation][] = Object.entries(openApiDocument.paths).flatMap(
  ([path, item]) =>
    HTTP_METHODS.flatMap((method) => {
      const operation = item[method];
      return operation ? [[method, path, operation] as [HttpMethod, string, Operation]] : [];
    }),
);

const isPublic = (operation: Operation) => operation.security?.length === 0;

describe('OpenAPI document', () => {
  it('is a valid OpenAPI 3.1 document', async () => {
    const validated = await SwaggerParser.validate(structuredClone(openApiDocument) as never);

    expect(validated.info.title).toBe('ImotSync API');
  });

  it('reports the API version from package.json', () => {
    expect(openApiDocument.info.version).toBe(APP_VERSION);
    expect(APP_VERSION).toBe('0.4.0');
  });

  it('gives every operation a unique operationId', () => {
    const ids = operations.map(([, , operation]) => operation.operationId);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it('documents 401 for every protected operation and 500 for all of them', () => {
    for (const [method, path, operation] of operations) {
      const label = `${method.toUpperCase()} ${path}`;
      expect(Object.keys(operation.responses), label).toContain('500');
      if (!isPublic(operation)) expect(Object.keys(operation.responses), label).toContain('401');
    }
  });

  it('lists every error code the API sends, and only those', () => {
    const error = openApiDocument.components.schemas.Error as {
      properties: { error: { properties: { code: { enum: string[] } } } };
    };

    expect(error.properties.error.properties.code.enum).toEqual([...API_ERROR_CODES]);
    expect(matchesSchema({ error: { code: 'NOT_FOUND', message: 'x' } }, 'Error')).toBe(true);
    expect(matchesSchema({ error: { code: 'INVALID_URL', message: 'x' } }, 'Error')).toBe(false);
  });

  it.each([
    [undefined, true],
    [null, true],
    ['', true],
    ['abc', true],
    ['x'.repeat(32), true],
    ['SOF-LOZ_17', true],
    ['ISA-1', true],
    ['IS-A1', true],
    ['ab', false],
    ['x'.repeat(33), false],
    ['with space', false],
    ['IS-00042', false],
    ['is-7', false],
  ])('accepts refCode %j in PropertyCreate exactly when the API does (%s)', (refCode, valid) => {
    const body = { type: 'apartment', dealType: 'sale', city: 'Sofia', refCode };

    expect(matchesSchema(body, 'PropertyCreate')).toBe(valid);
  });

  it('limits a photo order to the most photos a property can have', () => {
    const ids = (count: number) => Array.from({ length: count }, (_, index) => index + 1);

    expect(
      matchesSchema({ imageIds: ids(PHOTO_LIMITS.maxPerProperty) }, 'PropertyImageOrder'),
    ).toBe(true);
    expect(
      matchesSchema({ imageIds: ids(PHOTO_LIMITS.maxPerProperty + 1) }, 'PropertyImageOrder'),
    ).toBe(false);
  });

  it('lists only health, login, the document itself and the feeds as public', () => {
    const publicOperations = operations
      .filter(([, , operation]) => isPublic(operation))
      .map(([method, path]) => `${method.toUpperCase()} ${path}`);

    expect(publicOperations.sort()).toEqual([
      'GET /feeds/{portal}/{token}.xml',
      'GET /health',
      'GET /openapi.json',
      'POST /auth/login',
    ]);
  });

  it('serves everything under /api except the feeds, which have their own server', () => {
    const served = operations.map(([, path]) => servedPath(path));

    expect(served.filter((path) => !path.startsWith('/api/'))).toEqual([
      '/feeds/{portal}/{token}.xml',
    ]);
  });
});

describe('route coverage', () => {
  it('documents exactly the routes the app registers', () => {
    const appStack = stackOf((app as unknown as { router: unknown }).router) ?? [];

    // Routes live in two routers, never directly on the app: /api, and the public /feeds.
    expect(appStack.filter((layer) => layer.route)).toEqual([]);
    const routers = appStack.filter((layer) => stackOf(layer.handle));
    expect(routers).toHaveLength(2);
    const [api, feeds] = routers;
    expect(api?.match('/api/properties')).toBe(true);
    expect(api?.match('/uploads/x.jpg')).toBe(false);
    expect(feeds?.match('/feeds/realistimo/token.xml')).toBe(true);
    expect(feeds?.match('/api/properties')).toBe(false);

    const registered = [
      ...[...collectRoutes(stackOf(api?.handle) ?? [])].map((route) =>
        route.replace(' /', ' /api/'),
      ),
      ...[...collectRoutes(stackOf(feeds?.handle) ?? [])].map((route) =>
        route.replace(' /', ' /feeds/'),
      ),
    ].sort();
    const documented = operations
      .map(([method, path]) => `${method.toUpperCase()} ${servedPath(path)}`)
      .sort();

    expect(registered).toEqual(documented);
  });
});

describe('authentication on every operation', () => {
  it.each(operations)(
    '%s %s needs a token unless it is documented as public',
    async (method, path, operation) => {
      const url = servedPath(path).replace(/\{\w+\}/g, '1');
      const res = await request(app)[method](url);

      if (isPublic(operation)) {
        expect(res.status).not.toBe(401);
      } else {
        expect(res.status).toBe(401);
        expect(res.headers['www-authenticate']).toMatch(/^Bearer /);
        expect((res.body as ErrorBody).error.code).toBe('UNAUTHORIZED');
      }
      expectDocumented(res, method, path);
    },
  );
});

describe('GET /api/openapi.json', () => {
  it('serves the document without a token', async () => {
    const res = await request(app).get('/api/openapi.json');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(JSON.parse(JSON.stringify(openApiDocument)));
    expectDocumented(res, 'get', '/openapi.json');
  });
});

describe('Swagger UI at /api/docs', () => {
  it('redirects /api/docs to /api/docs/, where its relative asset URLs work', async () => {
    const res = await request(app).get('/api/docs');

    expect(res.status).toBe(301);
    expect(res.headers.location).toBe('/api/docs/');
  });

  it('redirects to its own path, whatever host an absolute request target names', async () => {
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const { port } = server.address() as AddressInfo;
      // "GET http://evil.example/api/docs?x=1 HTTP/1.1", as a proxy would forward it.
      const res = await new Promise<{ status?: number; location?: string }>((resolve, reject) => {
        get({ host: '127.0.0.1', port, path: 'http://evil.example/api/docs?x=1' }, (answer) => {
          answer.resume();
          resolve({ status: answer.statusCode, location: answer.headers.location });
        }).on('error', reject);
      });

      expect(res).toEqual({ status: 301, location: '/api/docs/?x=1' });
    } finally {
      server.close();
    }
  });

  it('serves the page with a CSP that allows it, relaxed for /api/docs only', async () => {
    const page = await request(app).get('/api/docs/');
    const api = await request(app).get('/api/health');

    expect(page.status).toBe(200);
    expect(page.headers['content-type']).toMatch(/text\/html/);
    expect(page.text).toContain('<title>ImotSync API docs</title>');
    expect(page.text).toContain('./swagger-ui-bundle.js');

    const docsCsp = String(page.headers['content-security-policy']);
    expect(docsCsp).toContain("script-src 'self'");
    expect(docsCsp).not.toContain('unsafe-eval');
    expect(docsCsp).not.toContain('upgrade-insecure-requests');
    expect(String(api.headers['content-security-policy'])).toContain('upgrade-insecure-requests');
  });

  it('loads the document from /api/openapi.json and keeps the token', async () => {
    const res = await request(app).get('/api/docs/swagger-ui-init.js');

    expect(res.status).toBe(200);
    expect(res.text).toContain('"swaggerUrl": "/api/openapi.json"');
    expect(res.text).toContain('"persistAuthorization": true');
  });

  it('serves the Swagger UI files, and nothing else from the package', async () => {
    const bundle = await request(app).get('/api/docs/swagger-ui-bundle.js');

    expect(bundle.status).toBe(200);
    expect(bundle.headers['content-type']).toMatch(/javascript/);
    for (const url of [
      '/api/docs/index.html',
      '/api/docs/package.json',
      '/api/docs/swagger-initializer.js',
    ]) {
      expect((await request(app).get(url)).status, url).toBe(404);
    }
  });
});

describe('login rate limit', () => {
  let limited: ReturnType<typeof createApp>;

  beforeAll(() => {
    limited = createApp({
      config,
      logger,
      db: dbWithAdmin(),
      loginRateLimit: { limit: 2, windowMs: 60_000 },
    });
  });

  it('answers 429 TOO_MANY_REQUESTS with Retry-After once the limit is used up', async () => {
    const attempts = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      attempts.push(await request(limited).post('/api/auth/login').send({}));
    }
    const [first, second, third] = attempts;

    expect(first?.status).toBe(400);
    expect(first?.headers.ratelimit).toMatch(/r=1/);
    expect(first?.headers['ratelimit-policy']).toMatch(/q=2; ?w=60/);
    expect(second?.status).toBe(400);
    expect(third?.status).toBe(429);
    expect(third?.headers['retry-after']).toMatch(/^\d+$/);
    expect((third?.body as ErrorBody).error.code).toBe('TOO_MANY_REQUESTS');
    if (third) expectDocumented(third, 'post', '/auth/login');
  });

  it('does not limit other routes', async () => {
    for (let attempt = 0; attempt < 4; attempt++) {
      expect((await request(limited).get('/api/health')).status).toBe(200);
    }
  });
});
