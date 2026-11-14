import type { Request, RequestHandler } from 'express';
import {
  checkExact,
  matchedData,
  param,
  validationResult,
  type Location,
  type ValidationChain,
  type ValidationError,
} from 'express-validator';
import { HttpError, validationError, type FieldIssue } from './http-error.js';

/*
 * Request validation with express-validator. Routers declare chains per endpoint; the
 * validate() middleware runs them, rejects unknown fields, and turns every problem into
 * one 400 VALIDATION_ERROR with {"field","message"} details.
 */

const UNKNOWN_FIELD_MESSAGES: Partial<Record<Location, string>> = {
  body: 'is not an allowed field',
  query: 'is not a supported query parameter',
};

function issuesFrom(error: ValidationError): FieldIssue[] {
  switch (error.type) {
    case 'field':
      return [{ field: error.path || error.location, message: String(error.msg) }];
    case 'unknown_fields':
      return error.fields.map((field) => ({
        field: field.path,
        message: UNKNOWN_FIELD_MESSAGES[field.location] ?? 'is not allowed',
      }));
    case 'alternative':
    case 'alternative_grouped':
      return [{ field: 'request', message: String(error.msg) }];
  }
}

/** express-validator errors as field issues, at most one per field. */
export function toFieldIssues(errors: readonly ValidationError[]): FieldIssue[] {
  const seen = new Set<string>();
  const issues: FieldIssue[] = [];
  for (const issue of errors.flatMap(issuesFrom)) {
    if (seen.has(issue.field)) continue;
    seen.add(issue.field);
    issues.push(issue);
  }
  return issues;
}

export interface ValidateOptions {
  /**
   * Locations in which fields without a chain are rejected (checkExact). Defaults to
   * ['body']; the list endpoint adds 'query' so a misspelt filter is not silently ignored.
   */
  exact?: Location[];
}

/** Runs the chains and fails the request with VALIDATION_ERROR if anything is wrong. */
export function validate(chains: ValidationChain[], options: ValidateOptions = {}): RequestHandler {
  const exact = options.exact ?? ['body'];
  const runner = exact.length > 0 ? checkExact(chains, { locations: exact }) : undefined;

  return async (req, _res, next) => {
    if (runner) {
      // checkExact runs the chains itself before looking for unknown fields.
      await runner.run(req);
    } else {
      for (const chain of chains) await chain.run(req);
    }
    const result = validationResult(req);
    if (!result.isEmpty()) {
      throw validationError(toFieldIssues(result.array()));
    }
    next();
  };
}

/** The validated and sanitized values of one location, e.g. the trimmed body fields. */
export function validated<T>(req: Request, location: Location): T {
  return matchedData(req, { locations: [location] }) as T;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * For endpoints that take a JSON object: a body sent with another content type gets 415,
 * a JSON array gets 400, and with `requireFields` an empty object (or no body) gets 400.
 */
export function jsonObjectBody(options: { requireFields?: boolean } = {}): RequestHandler {
  return (req, _res, next) => {
    // An empty body (Content-Length: 0) is "no body", whatever its declared type.
    const hasContent =
      req.headers['transfer-encoding'] !== undefined ||
      Number(req.headers['content-length'] ?? 0) > 0;
    if (hasContent && !req.is('application/json')) {
      throw new HttpError(
        415,
        'UNSUPPORTED_MEDIA_TYPE',
        'Request body must be JSON (Content-Type: application/json)',
      );
    }
    const body: unknown = req.body;
    if (body !== undefined && !isPlainObject(body)) {
      throw validationError([{ field: 'body', message: 'must be a JSON object' }]);
    }
    if (options.requireFields && (body === undefined || Object.keys(body).length === 0)) {
      throw validationError([{ field: 'body', message: 'must contain at least one field' }]);
    }
    next();
  };
}

/** Largest value of an INT UNSIGNED id column. */
export const MAX_ID = 4_294_967_295;

/** A route parameter that must be a positive integer id ("12"); converted to a number. */
export function idParam(name: string): ValidationChain {
  return param(name)
    .custom((value: unknown) => typeof value === 'string' && /^[1-9]\d{0,9}$/.test(value))
    .withMessage('must be a positive integer')
    .bail()
    .toInt()
    .custom((value: number) => value <= MAX_ID)
    .withMessage('must be a positive integer');
}

/** Validates route parameters only (no unknown-field check: the body is validated later). */
export function validateParams(...chains: ValidationChain[]): RequestHandler {
  return validate(chains, { exact: [] });
}

/** A route parameter after idParam() validated it. */
export function intParam(req: Request, name: string): number {
  return Number(req.params[name]);
}
