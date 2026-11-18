import { HttpErrorResponse } from '@angular/common/http';
import { TimeoutError } from 'rxjs';

import type { ApiErrorCode, ErrorDetail } from './models';

/**
 * Any failed API call, in the one shape the UI works with. Components show `message`, react to
 * `code` (the API's closed list; null when the answer did not come from the API) and map
 * `details` onto form fields or portals.
 */
export interface ApiError {
  /** HTTP status; 0 when no answer arrived (network error, timeout). */
  status: number;
  code: ApiErrorCode | null;
  /** Short, user-facing explanation. */
  message: string;
  details: ErrorDetail[];
  /** True when the API itself did not answer (network, timeout, a proxy with nothing behind). */
  unreachable: boolean;
  /** From the Retry-After header (429 TOO_MANY_REQUESTS), in seconds. */
  retryAfterSeconds: number | null;
}

/** Statuses a proxy in front of the API answers with when nothing answers behind it. */
const PROXY_ERROR_STATUSES: readonly number[] = [500, 502, 503, 504];

export const UNREACHABLE_MESSAGE = 'The API could not be reached.';
const UNEXPECTED_RESPONSE_MESSAGE = 'The API returned an unexpected response.';

/** The API answered successfully, but not with what the endpoint returns (a client's own check). */
export class UnexpectedResponseError extends Error {
  constructor() {
    super(UNEXPECTED_RESPONSE_MESSAGE);
    this.name = 'UnexpectedResponseError';
  }
}

export function toApiError(error: unknown): ApiError {
  if (error instanceof HttpErrorResponse) {
    return fromHttpError(error);
  }
  if (error instanceof TimeoutError) {
    return failure(0, 'The API did not answer in time.', true);
  }
  if (error instanceof UnexpectedResponseError) {
    return failure(0, error.message, false);
  }
  return failure(0, 'Something went wrong. Please try again.', false);
}

function fromHttpError(error: HttpErrorResponse): ApiError {
  const body = readApiErrorBody(error.error);
  if (body) {
    return {
      status: error.status,
      code: body.code,
      message: body.message,
      details: body.details,
      unreachable: false,
      retryAfterSeconds: readRetryAfter(error),
    };
  }
  if (error.status === 0 || PROXY_ERROR_STATUSES.includes(error.status)) {
    return failure(error.status, UNREACHABLE_MESSAGE, true);
  }
  // A 2xx status here means the body could not be parsed as JSON.
  if (error.status >= 200 && error.status < 300) {
    return failure(error.status, UNEXPECTED_RESPONSE_MESSAGE, false);
  }
  return failure(error.status, `The API responded with HTTP ${error.status}.`, false);
}

function failure(status: number, message: string, unreachable: boolean): ApiError {
  return { status, code: null, message, details: [], unreachable, retryAfterSeconds: null };
}

function readRetryAfter(error: HttpErrorResponse): number | null {
  const seconds = Number.parseInt(error.headers.get('Retry-After') ?? '', 10);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

/** Reads the API's error format {"error": {"code", "message", "details"?}}, or undefined. */
export function readApiErrorBody(
  body: unknown,
): { code: ApiErrorCode; message: string; details: ErrorDetail[] } | undefined {
  if (!isRecord(body) || !isRecord(body['error'])) {
    return undefined;
  }
  const { code, message, details } = body['error'];
  if (typeof code !== 'string' || typeof message !== 'string' || message.length === 0) {
    return undefined;
  }
  return {
    // The API's codes are a closed list; an unknown one is still shown by its message.
    code: code as ApiErrorCode,
    message,
    details: Array.isArray(details) ? details.filter(isErrorDetail) : [],
  };
}

function isErrorDetail(value: unknown): value is ErrorDetail {
  return (
    isRecord(value) &&
    typeof value['field'] === 'string' &&
    typeof value['message'] === 'string' &&
    (value['portal'] === undefined || typeof value['portal'] === 'string')
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
