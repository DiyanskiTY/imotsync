import { randomBytes } from 'node:crypto';
import { PortalError, type ValidationIssue } from '../portals/types.js';

/** What went wrong with one attempt, as the worker records it. */
export interface JobFailure {
  /** English, for jobs.last_error and the job log. */
  message: string;
  /** Whether another attempt may succeed (network trouble, 5xx, 429, timeouts). */
  retryable: boolean;
  /** Minimum wait before the next attempt (e.g. from Retry-After). */
  retryAfterMs?: number;
  httpStatus?: number;
  code?: string;
  /**
   * Unexpected errors only: the id under which the worker logged the details. The details
   * themselves (SQL, server messages, file paths) are never stored.
   */
  errorId?: string;
}

/** What jobs.last_error and the listing say about an unexpected error (plus its error id). */
export const UNEXPECTED_ERROR_MESSAGE =
  'Unexpected error while processing the job (see worker logs)';

/** The adapter call ran out of its time budget (JOB_TIMEOUT_SECONDS). */
export class JobTimeoutError extends Error {
  override readonly name = 'JobTimeoutError';
}

/** The worker is shutting down and could not wait for the adapter call any longer. */
export class WorkerShutdownError extends Error {
  override readonly name = 'WorkerShutdownError';
}

/** The longest message kept from an unexpected error (jobs.last_error is TEXT). */
const MAX_MESSAGE_LENGTH = 2000;

const clip = (text: string) =>
  text.length > MAX_MESSAGE_LENGTH ? `${text.slice(0, MAX_MESSAGE_LENGTH - 3)}...` : text;

/** 'Validation failed: price: Realistimo needs a price.; images: ...' (never retried). */
export function validationFailure(issues: readonly ValidationIssue[]): JobFailure {
  const list = issues.map((issue) => `${issue.field}: ${issue.message}`).join('; ');
  return { message: clip(`Validation failed: ${list}`), retryable: false, code: 'VALIDATION' };
}

/** A failure that no retry can fix, e.g. a job for a portal without an adapter. */
export function permanentFailure(message: string, code?: string): JobFailure {
  return { message: clip(message), retryable: false, ...(code ? { code } : {}) };
}

/**
 * Classifies whatever an adapter call threw. PortalError says itself whether to retry;
 * timeouts and a worker shutdown are retried; anything else is unexpected and is retried
 * too (attempts are limited, and a later attempt may well succeed). An unexpected error is
 * recorded only as UNEXPECTED_ERROR_MESSAGE with a new error id; the caller logs the error
 * itself under that id.
 */
export function describeFailure(error: unknown): JobFailure {
  if (error instanceof PortalError) {
    const { code, retryAfterMs, httpStatus } = error.options;
    return {
      message: clip(error.message),
      retryable: error.retryable,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      ...(httpStatus !== undefined ? { httpStatus } : {}),
      ...(code !== undefined ? { code } : {}),
    };
  }
  if (error instanceof JobTimeoutError) {
    return { message: clip(error.message), retryable: true, code: 'TIMEOUT' };
  }
  if (error instanceof WorkerShutdownError) {
    return { message: clip(error.message), retryable: true, code: 'SHUTDOWN' };
  }
  const errorId = randomBytes(6).toString('hex');
  return {
    message: `${UNEXPECTED_ERROR_MESSAGE}. Error id: ${errorId}`,
    retryable: true,
    code: 'UNEXPECTED',
    errorId,
  };
}
