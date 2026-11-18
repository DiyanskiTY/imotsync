import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { catchError, map, Observable, of, throwError, timeout } from 'rxjs';

import { UnexpectedResponseError } from '../api/api-error';
import type { Health } from '../api/models';

/** Body of GET /api/health (200 when everything is up, 503 when the database check fails). */
export type HealthReport = Health;

export const HEALTH_URL = '/api/health';
export const HEALTH_TIMEOUT_MS = 10_000;

/** Data access for the API health endpoint. */
@Injectable({ providedIn: 'root' })
export class HealthApi {
  private readonly http = inject(HttpClient);

  /**
   * Loads the health report. A 503 that still carries a report means "the API is running but the
   * database is down", so it is returned as a value; anything else (API unreachable, timeout,
   * unexpected status, a body that is not a health report) is an error; toApiError explains it.
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
          throw new UnexpectedResponseError();
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
