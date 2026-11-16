import type { JobAction, JobStatus, PortalListingStatus } from '../../db/types.js';
import type { JobWithContextRow } from './jobs.repository.js';

/** One entry of the job log. */
export interface JobDto {
  id: number;
  action: JobAction;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  runAfter: string;
  lockedAt: string | null;
  lockedBy: string | null;
  lastError: string | null;
  /** Outcome of the last attempt: {message, externalId?, details?} or {error, retryable, ...}. */
  result: Record<string, unknown> | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  listing: { id: number; portal: string; status: PortalListingStatus };
  property: { id: number; refCode: string; title: string | null } | null;
}

const isoOrNull = (date: Date | null) => (date ? date.toISOString() : null);

export function toJobDto(row: JobWithContextRow): JobDto {
  return {
    id: row.id,
    action: row.action,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    runAfter: row.run_after.toISOString(),
    lockedAt: isoOrNull(row.locked_at),
    lockedBy: row.locked_by,
    lastError: row.last_error,
    result: row.result,
    finishedAt: isoOrNull(row.finished_at),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    listing: { id: row.portal_listing_id, portal: row.listing_portal, status: row.listing_status },
    property:
      row.property_id !== null && row.property_ref_code !== null
        ? { id: row.property_id, refCode: row.property_ref_code, title: row.property_title }
        : null,
  };
}
