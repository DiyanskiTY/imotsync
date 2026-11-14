import express from 'express';
import multer from 'multer';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import {
  API_ERROR_CODES,
  conflict,
  HttpError,
  notFound,
  validationError,
} from '../../src/lib/http-error.js';
import { createLogger } from '../../src/logger.js';
import { createErrorHandler, toErrorResponse } from '../../src/middleware/error-handler.js';
import { notFoundHandler } from '../../src/middleware/not-found.js';
import { createRequestLogger } from '../../src/middleware/request-logger.js';
import { displayName, toUploadError } from '../../src/modules/images/photo-upload.js';

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
    throw new HttpError(409, 'CONFLICT', 'Reference code IS-00001 is already used');
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
        error: { code: 'CONFLICT', message: 'Reference code IS-00001 is already used' },
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
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid path: contains invalid percent-encoding',
          details: [{ field: 'path', message: 'contains invalid percent-encoding' }],
        },
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

    it('gives other client errors the code of their status', () => {
      const error = Object.assign(new Error('No such file'), { status: 404, expose: true });

      expect(toErrorResponse(error, true)).toEqual({
        status: 404,
        body: { error: { code: 'NOT_FOUND', message: 'No such file' } },
      });
    });

    it('answers client errors without a code of their own as 400 VALIDATION_ERROR', () => {
      const error = Object.assign(new Error('Not acceptable here'), { status: 406, expose: true });

      expect(toErrorResponse(error, true)).toEqual({
        status: 400,
        body: {
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Not acceptable here',
            details: [{ field: 'request', message: 'Not acceptable here' }],
          },
        },
      });
    });

    it.each([
      ['entity.parse.failed', 400, 400, 'INVALID_JSON'],
      ['entity.too.large', 413, 413, 'PAYLOAD_TOO_LARGE'],
      ['encoding.unsupported', 415, 415, 'UNSUPPORTED_MEDIA_TYPE'],
      ['charset.unsupported', 415, 415, 'UNSUPPORTED_MEDIA_TYPE'],
      ['request.aborted', 400, 400, 'VALIDATION_ERROR'],
      ['request.size.invalid', 400, 400, 'VALIDATION_ERROR'],
    ])('maps the body-parser error %s (%i) to %i %s', (type, status, expected, code) => {
      const error = Object.assign(new Error('body-parser message'), { status, expose: true, type });

      const { status: answered, body } = toErrorResponse(error, true);

      expect([answered, body.error.code]).toEqual([expected, code]);
      expect(API_ERROR_CODES).toContain(body.error.code);
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
        code: 'VALIDATION_ERROR',
        message: 'Bad request',
        details: [{ field: 'request', message: 'Bad request' }],
      });
    });
  });
});

describe('error codes and details', () => {
  const app = express();
  app.get('/validation', () => {
    throw validationError([
      { field: 'price', message: 'must be at least 0' },
      { field: 'city', message: 'is required' },
    ]);
  });
  app.get('/unauthorized', () => {
    throw new HttpError(401, 'UNAUTHORIZED', 'Token has expired', {
      headers: { 'WWW-Authenticate': 'Bearer realm="imotsync", error="invalid_token"' },
    });
  });
  app.use(createErrorHandler({ isProduction: true }));

  it('sends field details with VALIDATION_ERROR', async () => {
    const res = await request(app).get('/validation');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed for: price, city',
        details: [
          { field: 'price', message: 'must be at least 0' },
          { field: 'city', message: 'is required' },
        ],
      },
    });
  });

  it('names the field in the message when there is one problem', () => {
    expect(validationError([{ field: 'price', message: 'must be at least 0' }]).message).toBe(
      'Invalid price: must be at least 0',
    );
  });

  it('sends the headers an HttpError carries', async () => {
    const res = await request(app).get('/unauthorized');

    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toBe('Bearer realm="imotsync", error="invalid_token"');
    expect(res.body).toEqual({ error: { code: 'UNAUTHORIZED', message: 'Token has expired' } });
  });

  it('has the documented status for every helper', () => {
    expect([notFound('x').status, notFound('x').code]).toEqual([404, 'NOT_FOUND']);
    expect([conflict('x').status, conflict('x').code]).toEqual([409, 'CONFLICT']);
    expect(validationError([]).status).toBe(400);
  });
});

describe('upload errors', () => {
  it.each([
    [new multer.MulterError('LIMIT_FILE_SIZE', 'photos'), 413, 'PAYLOAD_TOO_LARGE'],
    [new multer.MulterError('LIMIT_FILE_COUNT'), 400, 'VALIDATION_ERROR'],
    [new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'photos'), 400, 'VALIDATION_ERROR'],
    [new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'image'), 400, 'VALIDATION_ERROR'],
    [new multer.MulterError('LIMIT_FIELD_COUNT'), 400, 'VALIDATION_ERROR'],
    [new Error('Unexpected end of form'), 400, 'VALIDATION_ERROR'],
  ])('maps %s to %i %s', (error, status, code) => {
    const mapped = toUploadError(error);

    expect(mapped).toBeInstanceOf(HttpError);
    expect(mapped).toMatchObject({ status, code });
  });

  it('names the unexpected field', () => {
    const mapped = toUploadError(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'image'));

    expect(mapped.details).toEqual([
      { field: 'image', message: 'is not an accepted field; send the photos in "photos"' },
    ]);
  });

  it('names the text field, which an upload does not accept', () => {
    const onlyPhotos = 'Only files in the "photos" field are accepted';

    expect(toUploadError(new multer.MulterError('LIMIT_FIELD_VALUE', 'caption'))).toMatchObject({
      status: 400,
      code: 'VALIDATION_ERROR',
      message: 'Unexpected field "caption": only files in the "photos" field are accepted',
      details: [{ field: 'caption', message: onlyPhotos }],
    });
    // multer names no field when a second one arrives; the first one is named instead.
    expect(toUploadError(new multer.MulterError('LIMIT_FIELD_COUNT'), 'note').details).toEqual([
      { field: 'note', message: onlyPhotos },
    ]);
    expect(toUploadError(new multer.MulterError('MISSING_FIELD_NAME')).details).toEqual([
      { field: 'body', message: onlyPhotos },
    ]);
    expect(
      toUploadError(new multer.MulterError('LIMIT_FIELD_VALUE', `x\u0000${'y'.repeat(200)}`))
        .details?.[0]?.field,
    ).toBe(`x${'y'.repeat(116)}...`);
  });

  it('cleans client file names before quoting them', () => {
    expect(displayName('  bad\u0000name\r\n.jpg ', 0)).toBe('badname.jpg');
    expect(displayName('', 2)).toBe('photo 3');
    expect(displayName('x'.repeat(200), 0)).toHaveLength(120);
  });
});
