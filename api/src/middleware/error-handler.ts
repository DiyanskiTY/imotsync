import type { ErrorRequestHandler } from 'express';
import {
  HttpError,
  validationError,
  type ApiErrorCode,
  type FieldIssue,
} from '../lib/http-error.js';

export interface ErrorBody {
  error: { code: ApiErrorCode; message: string; details?: FieldIssue[] };
}

/**
 * A client error from Express' own middleware (body parser and friends), which create
 * their errors with the http-errors package. http-errors sets `expose: true` on 4xx
 * errors whose message is meant for the client.
 */
interface ExposedClientError {
  status: number;
  message: string;
  expose: true;
  /** body-parser sets this, for example "entity.parse.failed". */
  type?: unknown;
}

/** body-parser's errors (by their `type`), in the API's own codes. */
const BODY_PARSER_ERRORS: Record<string, () => HttpError> = {
  'entity.parse.failed': () => new HttpError(400, 'INVALID_JSON', 'Request body is not valid JSON'),
  'entity.too.large': () => new HttpError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large'),
  'encoding.unsupported': () =>
    new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Request body encoding is not supported'),
  'charset.unsupported': () =>
    new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Request body charset is not supported'),
  'request.aborted': () =>
    validationError([{ field: 'body', message: 'was not received completely' }]),
  'request.size.invalid': () =>
    validationError([{ field: 'body', message: 'does not match its Content-Length' }]),
};

/** The API's code for the status of any other client error. */
const CODE_BY_STATUS: Partial<Record<number, ApiErrorCode>> = {
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  429: 'TOO_MANY_REQUESTS',
};

/**
 * Only errors that opt in with `expose === true` count. Other libraries also throw
 * errors with a 4xx `status` (an HTTP client whose request got a 401, for example);
 * those are failures of this API and must not pass their status or message on.
 */
function isExposedClientError(error: unknown): error is ExposedClientError {
  if (typeof error !== 'object' || error === null) return false;
  const { status, message, expose } = error as Partial<Record<keyof ExposedClientError, unknown>>;
  return (
    expose === true &&
    typeof status === 'number' &&
    Number.isInteger(status) &&
    status >= 400 &&
    status < 500 &&
    typeof message === 'string'
  );
}

/**
 * Express' router decodes route parameters with decodeURIComponent and, when that fails,
 * rethrows the URIError with `status = 400` (but without `expose`).
 */
function isRouteParamDecodeError(error: unknown): boolean {
  return error instanceof URIError && (error as URIError & { status?: unknown }).status === 400;
}

function fromClientError(error: ExposedClientError): HttpError {
  const known =
    typeof error.type === 'string' && Object.hasOwn(BODY_PARSER_ERRORS, error.type)
      ? BODY_PARSER_ERRORS[error.type]
      : undefined;
  if (known) return known();
  const code = CODE_BY_STATUS[error.status];
  if (code) return new HttpError(error.status, code, error.message);
  // The list of codes has no other client errors (406, 411, ...): a bad request it is.
  return validationError([{ field: 'request', message: error.message }], error.message);
}

/** The error as one of the API's documented errors, or undefined for an unexpected one. */
function toHttpError(error: unknown): HttpError | undefined {
  if (error instanceof HttpError) return error;
  if (isExposedClientError(error)) return fromClientError(error);
  if (isRouteParamDecodeError(error)) {
    return validationError([{ field: 'path', message: 'contains invalid percent-encoding' }]);
  }
  return undefined;
}

/** Maps any thrown value to a status and a body that is safe to send to the client. */
export function toErrorResponse(
  error: unknown,
  isProduction: boolean,
): { status: number; body: ErrorBody; headers?: Readonly<Record<string, string>> } {
  const known = toHttpError(error);
  if (known) {
    const { status, code, message, details, headers } = known;
    return {
      status,
      body: { error: details ? { code, message, details } : { code, message } },
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    };
  }

  // Unexpected failure: the details go to the log, never to a production client.
  const detail = error instanceof Error ? error.message : String(error);
  return {
    status: 500,
    body: {
      error: {
        code: 'INTERNAL_ERROR',
        message: isProduction ? 'Internal server error' : detail,
      },
    },
  };
}

/** Central error handler: every error leaves the API as {"error":{"code","message","details"?}}. */
export function createErrorHandler(options: { isProduction: boolean }): ErrorRequestHandler {
  return (error: unknown, _req, res, next) => {
    if (res.headersSent) {
      // Too late for a JSON body; let Express close the connection.
      next(error);
      return;
    }
    const { status, body, headers } = toErrorResponse(error, options.isProduction);
    if (status >= 500) {
      // pino-http picks this up and logs it, with the stack, on the request's log line.
      res.err = error instanceof Error ? error : new Error(String(error));
    }
    if (headers) res.set(headers);
    res.status(status).json(body);
  };
}
