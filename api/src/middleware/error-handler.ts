import { STATUS_CODES } from 'node:http';
import type { ErrorRequestHandler } from 'express';
import { HttpError } from '../lib/http-error.js';

export interface ErrorBody {
  error: { code: string; message: string };
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

const BODY_PARSER_ERRORS: Record<string, ErrorBody['error']> = {
  'entity.parse.failed': { code: 'INVALID_JSON', message: 'Request body is not valid JSON' },
  'entity.too.large': { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large' },
  'encoding.unsupported': {
    code: 'UNSUPPORTED_ENCODING',
    message: 'Request body encoding is not supported',
  },
  'charset.unsupported': {
    code: 'UNSUPPORTED_CHARSET',
    message: 'Request body charset is not supported',
  },
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

/** 404 -> NOT_FOUND, 413 -> PAYLOAD_TOO_LARGE, ... */
function codeForStatus(status: number): string {
  return (STATUS_CODES[status] ?? 'Error').toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

/** Maps any thrown value to a status and a body that is safe to send to the client. */
export function toErrorResponse(
  error: unknown,
  isProduction: boolean,
): { status: number; body: ErrorBody } {
  if (error instanceof HttpError) {
    return { status: error.status, body: { error: { code: error.code, message: error.message } } };
  }

  if (isExposedClientError(error)) {
    const known =
      typeof error.type === 'string' && Object.hasOwn(BODY_PARSER_ERRORS, error.type)
        ? BODY_PARSER_ERRORS[error.type]
        : undefined;
    return {
      status: error.status,
      body: { error: known ?? { code: codeForStatus(error.status), message: error.message } },
    };
  }

  if (isRouteParamDecodeError(error)) {
    return {
      status: 400,
      body: {
        error: { code: 'INVALID_URL', message: 'Request path contains invalid percent-encoding' },
      },
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

/** Central error handler: every error leaves the API as {"error":{"code","message"}}. */
export function createErrorHandler(options: { isProduction: boolean }): ErrorRequestHandler {
  return (error: unknown, _req, res, next) => {
    if (res.headersSent) {
      // Too late for a JSON body; let Express close the connection.
      next(error);
      return;
    }
    const { status, body } = toErrorResponse(error, options.isProduction);
    if (status >= 500) {
      // pino-http picks this up and logs it, with the stack, on the request's log line.
      res.err = error instanceof Error ? error : new Error(String(error));
    }
    res.status(status).json(body);
  };
}
