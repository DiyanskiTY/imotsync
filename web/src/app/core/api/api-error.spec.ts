import { HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { TimeoutError } from 'rxjs';

import { ApiError, readApiErrorBody, toApiError } from './api-error';

function httpError(status: number, body: unknown = null, headers?: Record<string, string>) {
  return new HttpErrorResponse({
    status,
    error: body,
    headers: headers ? new HttpHeaders(headers) : undefined,
    url: '/api/test',
  });
}

function envelope(code: string, message: string, details?: unknown[]) {
  return { error: { code, message, ...(details ? { details } : {}) } };
}

describe('toApiError', () => {
  it('reads the API error envelope', () => {
    expect(toApiError(httpError(404, envelope('NOT_FOUND', 'Property 9 not found.')))).toEqual({
      status: 404,
      code: 'NOT_FOUND',
      message: 'Property 9 not found.',
      details: [],
      unreachable: false,
      retryAfterSeconds: null,
    } satisfies ApiError);
  });

  it('keeps per-portal details of NOT_READY', () => {
    const details = [
      { portal: 'bazar', field: 'title', message: 'Bazar.bg needs a title in Cyrillic.' },
      { portal: 'realistimo', field: 'areaM2', message: 'Realistimo needs the floor area (m²).' },
    ];
    const error = toApiError(httpError(422, envelope('NOT_READY', 'Not ready.', details)));
    expect(error.code).toBe('NOT_READY');
    expect(error.details).toEqual(details);
  });

  it('keeps field details of VALIDATION_ERROR and drops malformed ones', () => {
    const details = [
      { field: 'price', message: 'Must be at least 0.' },
      { field: 42, message: 'not a detail' },
      'nonsense',
    ];
    const error = toApiError(httpError(400, envelope('VALIDATION_ERROR', 'Invalid.', details)));
    expect(error.details).toEqual([{ field: 'price', message: 'Must be at least 0.' }]);
  });

  it('reads Retry-After in seconds from a 429', () => {
    const error = toApiError(
      httpError(429, envelope('TOO_MANY_REQUESTS', 'Too many uploads.'), { 'Retry-After': '10' }),
    );
    expect(error.code).toBe('TOO_MANY_REQUESTS');
    expect(error.retryAfterSeconds).toBe(10);
  });

  it.each([
    ['a network error', httpError(0)],
    ['a proxy 502 without an API body', httpError(502, 'Bad Gateway')],
    ['a proxy 504', httpError(504)],
    ['an envelope without a code', httpError(502, { error: { message: 'no code' } })],
  ])('treats %s as unreachable', (_label, error) => {
    expect(toApiError(error)).toMatchObject({
      code: null,
      unreachable: true,
      message: 'The API could not be reached.',
    });
  });

  it('treats a timeout as unreachable', () => {
    expect(toApiError(new TimeoutError())).toMatchObject({
      status: 0,
      unreachable: true,
      message: 'The API did not answer in time.',
    });
  });

  it('explains a 2xx whose body was not JSON', () => {
    expect(toApiError(httpError(200, { error: new SyntaxError('bad json') }))).toMatchObject({
      code: null,
      unreachable: false,
      message: 'The API returned an unexpected response.',
    });
  });

  it('names the status of any other answer', () => {
    expect(toApiError(httpError(418, 'teapot')).message).toBe('The API responded with HTTP 418.');
  });

  it('turns anything else into a generic error', () => {
    expect(toApiError(new Error('boom'))).toMatchObject({
      status: 0,
      code: null,
      unreachable: false,
      message: 'Something went wrong. Please try again.',
    });
  });
});

describe('readApiErrorBody', () => {
  it.each([null, 'text', { error: 'x' }, { error: { code: 'X', message: '' } }])(
    'returns undefined for %j',
    (body) => {
      expect(readApiErrorBody(body)).toBeUndefined();
    },
  );
});
