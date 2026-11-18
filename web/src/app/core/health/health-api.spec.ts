import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { TimeoutError } from 'rxjs';

import { UnexpectedResponseError } from '../api/api-error';
import {
  HEALTH_TIMEOUT_MS,
  HEALTH_URL,
  HealthApi,
  HealthReport,
  isHealthReport,
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
    expect(error).toBeInstanceOf(UnexpectedResponseError);
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
