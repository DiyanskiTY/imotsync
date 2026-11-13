import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { HttpError } from '../../src/lib/http-error.js';
import { createLogger } from '../../src/logger.js';
import { createErrorHandler, toErrorResponse } from '../../src/middleware/error-handler.js';
import { notFoundHandler } from '../../src/middleware/not-found.js';
import { createRequestLogger } from '../../src/middleware/request-logger.js';

const SECRET_DETAIL = 'connect ECONNREFUSED 10.0.0.5:3306 as user imotsync';

/** The app's middleware chain around a few routes that fail on purpose. */
function appWithFailingRoutes(isProduction: boolean) {
  const app = express();
  app.use(createRequestLogger(createLogger({ nodeEnv: 'test' })));
  app.get('/sync-error', () => {
    throw new Error(SECRET_DETAIL);
  });
  app.get('/async-error', async () => {
    await Promise.resolve();
    throw new Error(SECRET_DETAIL);
  });
  app.get('/http-error', () => {
    throw new HttpError(409, 'REF_CODE_TAKEN', 'Reference code IS-00001 is already used');
  });
  app.get('/upstream-401', () => {
    // What an HTTP client library throws when a call to another service gets a 401.
    throw Object.assign(new Error(`Request failed with status code 401 (${SECRET_DETAIL})`), {
      status: 401,
    });
  });
  app.get('/items/:id', (req, res) => {
    res.json({ id: req.params.id });
  });
  app.use(notFoundHandler);
  app.use(createErrorHandler({ isProduction }));
  return app;
}

describe('error handler', () => {
  describe('in production', () => {
    const app = appWithFailingRoutes(true);

    it.each(['/sync-error', '/async-error'])(
      'hides the details of unexpected errors (%s)',
      async (url) => {
        const res = await request(app).get(url);

        expect(res.status).toBe(500);
        expect(res.headers['content-type']).toMatch(/application\/json/);
        expect(res.body).toEqual({
          error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
        });
        expect(res.text).not.toContain('ECONNREFUSED');
        expect(res.text).not.toMatch(/stack|\.ts:\d+/i);
      },
    );

    it('keeps the status, code and message of an HttpError', async () => {
      const res = await request(app).get('/http-error');

      expect(res.status).toBe(409);
      expect(res.body).toEqual({
        error: { code: 'REF_CODE_TAKEN', message: 'Reference code IS-00001 is already used' },
      });
    });

    it("does not pass on another library's 4xx status or message", async () => {
      const res = await request(app).get('/upstream-401');

      expect(res.status).toBe(500);
      expect(res.body).toEqual({
        error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
      });
    });

    it('answers a route parameter with broken percent-encoding with a 400', async () => {
      expect((await request(app).get('/items/IS-00001')).body).toEqual({ id: 'IS-00001' });

      const res = await request(app).get('/items/%E0%A4%A');

      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        error: { code: 'INVALID_URL', message: 'Request path contains invalid percent-encoding' },
      });
    });
  });

  describe('in development', () => {
    const app = appWithFailingRoutes(false);

    it('shows the error message but never a stack trace', async () => {
      const res = await request(app).get('/sync-error');

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: { code: 'INTERNAL_ERROR', message: SECRET_DETAIL } });
      expect(res.text).not.toMatch(/\.ts:\d+/);
    });
  });

  describe('toErrorResponse', () => {
    it('handles thrown values that are not Error objects', () => {
      expect(toErrorResponse('plain string', true)).toEqual({
        status: 500,
        body: { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
      });
      expect(toErrorResponse(undefined, false).body.error.message).toBe('undefined');
    });

    it('derives a code from the status of other client errors', () => {
      const error = Object.assign(new Error('Not acceptable here'), { status: 406, expose: true });

      expect(toErrorResponse(error, true)).toEqual({
        status: 406,
        body: { error: { code: 'NOT_ACCEPTABLE', message: 'Not acceptable here' } },
      });
    });

    it('treats errors that do not opt in with expose: true as internal errors', () => {
      const internal = {
        status: 500,
        body: { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
      };
      const notExposed = [
        // A 4xx status without `expose`, as HTTP client libraries throw them.
        Object.assign(new Error('Request failed with status code 401'), { status: 401 }),
        Object.assign(new Error('Not found upstream'), { statusCode: 404, expose: true }),
        // http-errors marks errors that must not be shown with expose: false.
        Object.assign(new Error('Token signature mismatch'), { status: 401, expose: false }),
        // Not a client error, even if it claims to be safe to show.
        Object.assign(new Error('Upstream unavailable'), { status: 503, expose: true }),
        { status: 400.5, message: 'Odd status', expose: true },
        { status: '400', message: 'Status as text', expose: true },
        { status: 400, message: 42, expose: true },
      ];

      for (const error of notExposed) {
        expect(toErrorResponse(error, true), JSON.stringify(error)).toEqual(internal);
      }
    });

    it('maps only known body-parser types to fixed codes', () => {
      const parseFailed = Object.assign(new Error('Unexpected end of JSON input'), {
        status: 400,
        expose: true,
        type: 'entity.parse.failed',
      });
      const inheritedKey = Object.assign(new Error('Bad request'), {
        status: 400,
        expose: true,
        type: 'constructor',
      });

      expect(toErrorResponse(parseFailed, true).body.error).toEqual({
        code: 'INVALID_JSON',
        message: 'Request body is not valid JSON',
      });
      expect(toErrorResponse(inheritedKey, true).body.error).toEqual({
        code: 'BAD_REQUEST',
        message: 'Bad request',
      });
    });
  });
});
