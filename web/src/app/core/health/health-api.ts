import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { catchError, map, Observable, of, throwError, timeout, TimeoutError } from 'rxjs';

import { toApiError } from '../api/api-error';
import type { Health } from '../api/models';

/** Body of GET /api/health (200 when everything is up, 503 when the database check fails). */
export type HealthReport = Health;

/** Why a health check failed, in a form the UI can show. */
export interface HealthCheckFailure {
  /**
   * True when no answer came from the API itself: a network error, a timeout, or a proxy reporting
   * that nothing answers behind it. False when the API answered, but not with a health report.
   */
  unreachable: boolean;
  /** Short, user-facing explanation. */
  message: string;
}

export const HEALTH_URL = '/api/health';
export const HEALTH_TIMEOUT_MS = 10_000;

/** The health endpoint answered successfully, but the body is not a health report. */
export class UnexpectedHealthResponseError extends Error {
  constructor() {
    super('The API returned an unexpected health response.');
    this.name = 'UnexpectedHealthResponseError';
  }
}

/** Data access for the API health endpoint. */
@Injectable({ providedIn: 'root' })
export class HealthApi {
  private readonly http = inject(HttpClient);

  /**
   * Loads the health report. A 503 that still carries a report means "the API is running but the
   * database is down", so it is returned as a value; anything else (API unreachable, timeout,
   * unexpected status, a body that is not a health report) is an error.
   */
  getHealth(): Observable<HealthReport> {
    return this.http.get<unknown>(HEALTH_URL).pipe(
      timeout(HEALTH_TIMEOUT_MS),
      catchError((error: unknown) => {
        if (
          error instanceof HttpErrorResponse &&
          error.status === 503 &&
          isHealthReport(error.error)
        ) {
          return of(error.error);
        }
        return throwError(() => error);
      }),
      map((body) => {
        if (!isHealthReport(body)) {
          throw new UnexpectedHealthResponseError();
        }
        return body;
      }),
    );
  }
}

export function isHealthReport(value: unknown): value is HealthReport {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const report = value as Record<string, unknown>;
  return (
    (report['status'] === 'ok' || report['status'] === 'degraded') &&
    (report['db'] === 'up' || report['db'] === 'down') &&
    typeof report['version'] === 'string' &&
    typeof report['uptimeSeconds'] === 'number'
  );
}

/** Explains a failed health check and tells whether the API answered at all. */
export function describeHealthError(error: unknown): HealthCheckFailure {
  if (error instanceof TimeoutError) {
    return {
      unreachable: true,
      message: `The API did not answer within ${HEALTH_TIMEOUT_MS / 1000} seconds.`,
    };
  }
  if (error instanceof UnexpectedHealthResponseError) {
    return { unreachable: false, message: error.message };
  }
  if (error instanceof HttpErrorResponse) {
    const { unreachable, message, code, status } = toApiError(error);
    // A 2xx status here means the body could not be parsed as JSON.
    if (code === null && status >= 200 && status < 300) {
      return { unreachable: false, message: new UnexpectedHealthResponseError().message };
    }
    return { unreachable, message };
  }
  return { unreachable: false, message: 'Unexpected error while checking the API.' };
}
