import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { TimeoutError } from 'rxjs';

import {
  describeHealthError,
  HEALTH_TIMEOUT_MS,
  HEALTH_URL,
  HealthApi,
  HealthReport,
  isHealthReport,
  UnexpectedHealthResponseError,
} from './health-api';

const okReport: HealthReport = { status: 'ok', db: 'up', version: '0.1.0', uptimeSeconds: 42 };
const degradedReport: HealthReport = {
  status: 'degraded',
  db: 'down',
  version: '0.1.0',
  uptimeSeconds: 42,
};

describe('HealthApi', () => {
  let api: HealthApi;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    api = TestBed.inject(HealthApi);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    vi.useRealTimers();
    http.verify();
  });

  it('sends GET /api/health with a relative URL and returns the report', () => {
    let result: HealthReport | undefined;
    api.getHealth().subscribe((report) => (result = report));

    const request = http.expectOne(HEALTH_URL);
    expect(request.request.method).toBe('GET');
    expect(request.request.url).toBe('/api/health');
    request.flush(okReport);

    expect(result).toEqual(okReport);
  });

  it('returns the report of a 503 response (database down) as a value', () => {
    let result: HealthReport | undefined;
    let failed = false;
    api.getHealth().subscribe({
      next: (report) => (result = report),
      error: () => (failed = true),
    });

    http
      .expectOne(HEALTH_URL)
      .flush(degradedReport, { status: 503, statusText: 'Service Unavailable' });

    expect(failed).toBe(false);
    expect(result).toEqual(degradedReport);
  });

  it.each([
    ['null', null],
    ['an incomplete report', { status: 'ok' }],
    ['a string', 'ok'],
  ])('fails when a 200 response carries %s instead of a health report', (_label, body) => {
    let result: HealthReport | undefined;
    let error: unknown;
    api.getHealth().subscribe({
      next: (report) => (result = report),
      error: (e: unknown) => (error = e),
    });

    http.expectOne(HEALTH_URL).flush(body);

    expect(result).toBeUndefined();
    expect(error).toBeInstanceOf(UnexpectedHealthResponseError);
  });

  it('fails when a 503 response does not carry a health report', () => {
    let error: unknown;
    api.getHealth().subscribe({ error: (e: unknown) => (error = e) });

    http.expectOne(HEALTH_URL).flush('Service Unavailable', {
      status: 503,
      statusText: 'Service Unavailable',
    });

    expect(error).toBeInstanceOf(HttpErrorResponse);
    expect((error as HttpErrorResponse).status).toBe(503);
  });

  it('fails when the API cannot be reached', () => {
    let error: unknown;
    api.getHealth().subscribe({ error: (e: unknown) => (error = e) });

    http.expectOne(HEALTH_URL).error(new ProgressEvent('error'));

    expect(error).toBeInstanceOf(HttpErrorResponse);
    expect((error as HttpErrorResponse).status).toBe(0);
  });

  it('gives up when the API does not answer in time', () => {
    vi.useFakeTimers();
    let error: unknown;
    api.getHealth().subscribe({ error: (e: unknown) => (error = e) });
    const request = http.expectOne(HEALTH_URL);

    vi.advanceTimersByTime(HEALTH_TIMEOUT_MS);

    expect(error).toBeInstanceOf(TimeoutError);
    expect(request.cancelled).toBe(true);
  });
});

describe('isHealthReport', () => {
  it('accepts a complete report', () => {
    expect(isHealthReport(okReport)).toBe(true);
    expect(isHealthReport(degradedReport)).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isHealthReport(null)).toBe(false);
    expect(isHealthReport('ok')).toBe(false);
    expect(isHealthReport({ status: 'ok', db: 'up' })).toBe(false);
    expect(isHealthReport({ ...okReport, status: 'fine' })).toBe(false);
  });
});

describe('describeHealthError', () => {
  const httpError = (status: number, error: unknown = null) =>
    new HttpErrorResponse({ status, error, url: HEALTH_URL });
  const unreachable = { unreachable: true, message: 'The API could not be reached.' };

  it('treats a timeout as an unreachable API', () => {
    expect(describeHealthError(new TimeoutError())).toEqual({
      unreachable: true,
      message: 'The API did not answer within 10 seconds.',
    });
  });

  it('treats network errors and proxy errors without an API body as an unreachable API', () => {
    expect(describeHealthError(httpError(0))).toEqual(unreachable);
    expect(describeHealthError(httpError(500, ''))).toEqual(unreachable);
    expect(describeHealthError(httpError(502))).toEqual(unreachable);
    expect(describeHealthError(httpError(503, 'Service Unavailable'))).toEqual(unreachable);
    expect(describeHealthError(httpError(504))).toEqual(unreachable);
  });

  it("uses the message from the API's error body: the API answered", () => {
    const body = { error: { code: 'INTERNAL', message: 'Something broke.' } };
    expect(describeHealthError(httpError(500, body))).toEqual({
      unreachable: false,
      message: 'Something broke.',
    });
  });

  it('ignores error bodies that are not in the API format', () => {
    // What HttpClient reports when a 200 body is not JSON (e.g. an HTML page).
    const parseFailure = { error: new SyntaxError('Unexpected token <'), text: '<!doctype html>' };
    expect(describeHealthError(httpError(200, parseFailure))).toEqual({
      unreachable: false,
      message: 'The API returned an unexpected health response.',
    });
    expect(describeHealthError(httpError(502, { error: { message: 'no code' } }))).toEqual(
      unreachable,
    );
  });

  it('explains a successful response that is not a health report', () => {
    expect(describeHealthError(new UnexpectedHealthResponseError())).toEqual({
      unreachable: false,
      message: 'The API returned an unexpected health response.',
    });
  });

  it('falls back to the HTTP status', () => {
    expect(describeHealthError(httpError(418))).toEqual({
      unreachable: false,
      message: 'The API responded with HTTP 418.',
    });
  });

  it('handles unexpected errors', () => {
    expect(describeHealthError(new Error('boom'))).toEqual({
      unreachable: false,
      message: 'Unexpected error while checking the API.',
    });
  });
});
