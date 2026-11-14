/**
 * Every error code the API sends. Clients switch on these, so the list is closed: the
 * OpenAPI document publishes it as an enum, and HttpError only accepts these values.
 */
export const API_ERROR_CODES = [
  'VALIDATION_ERROR',
  'INVALID_JSON',
  'UNAUTHORIZED',
  'INVALID_CREDENTIALS',
  'FORBIDDEN',
  'NOT_FOUND',
  'REQUEST_TIMEOUT',
  'CONFLICT',
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
  'TOO_MANY_REQUESTS',
  'INTERNAL_ERROR',
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

/** One problem with one input field, e.g. {"field":"price","message":"must be at least 0"}. */
export interface FieldIssue {
  field: string;
  message: string;
}

export interface HttpErrorOptions {
  /** Per-field problems, sent as error.details (used by VALIDATION_ERROR). */
  details?: FieldIssue[];
  /** Extra response headers, e.g. WWW-Authenticate on a 401. */
  headers?: Record<string, string>;
}

/** An error that maps directly to an HTTP response: {"error":{"code","message","details"?}}. */
export class HttpError extends Error {
  override readonly name = 'HttpError';
  readonly details: FieldIssue[] | undefined;
  readonly headers: Readonly<Record<string, string>>;

  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
    options: HttpErrorOptions = {},
  ) {
    super(message);
    this.details = options.details;
    this.headers = options.headers ?? {};
  }
}

/** 400 VALIDATION_ERROR. The message names the field when there is only one problem. */
export function validationError(details: FieldIssue[], message?: string): HttpError {
  const [first] = details;
  const summary =
    message ??
    (details.length === 1 && first
      ? `Invalid ${first.field}: ${first.message}`
      : `Request validation failed for: ${[...new Set(details.map((d) => d.field))].join(', ')}`);
  return new HttpError(400, 'VALIDATION_ERROR', summary, { details });
}

export function notFound(message: string): HttpError {
  return new HttpError(404, 'NOT_FOUND', message);
}

export function conflict(message: string): HttpError {
  return new HttpError(409, 'CONFLICT', message);
}
