import type { FieldIssue } from '../../lib/http-error.js';
import type { PortalAdapter, PortalMode, ValidationIssue } from '../../portals/types.js';
import type { JobDto } from '../jobs/jobs.mappers.js';
import type { PortalListingDto } from '../properties/properties.mappers.js';

/** A portal this deployment publishes to. */
export interface PortalDto {
  key: string;
  displayName: string;
  mode: PortalMode;
  /** Feed portals: the URL to give the portal; push portals: null. */
  feedUrl: string | null;
}

/** The pre-publish check of one property against one portal. */
export interface PortalCheckDto {
  portal: string;
  displayName: string;
  ready: boolean;
  issues: ValidationIssue[];
}

/** What publish and unpublish queued: the listings involved and their jobs. */
export interface PublishResultDto {
  listings: PortalListingDto[];
  jobs: JobDto[];
}

export interface BulkPublishItemDto {
  propertyId: number;
  ok: boolean;
  /** NOT_READY: what blocks publishing, per portal. */
  issues?: FieldIssue[];
  /** ok: the jobs queued (or merged into) for this property. */
  jobs?: JobDto[];
  /** Not ok: why (NOT_FOUND, CONFLICT for an archived property, NOT_READY, INTERNAL_ERROR). */
  error?: { code: string; message: string };
}

export const BULK_DELETE_RESULTS = [
  'deleted',
  'removal_queued',
  'deletion_scheduled',
  'not_found',
  'error',
] as const;
export type BulkDeleteResult = (typeof BULK_DELETE_RESULTS)[number];

export interface BulkDeleteItemDto {
  propertyId: number;
  result: BulkDeleteResult;
  /** result 'error' only: INTERNAL_ERROR (the details are logged). */
  error?: { code: string; message: string };
}

/** Feed URL of a feed portal: PUBLIC_BASE_URL/feeds/<key>/<FEED_TOKEN>.xml. */
export function feedUrlFor(publicBaseUrl: string, portal: string, token: string): string {
  return `${publicBaseUrl}/feeds/${encodeURIComponent(portal)}/${encodeURIComponent(token)}.xml`;
}

export function toPortalDto(
  adapter: PortalAdapter,
  feeds: { publicBaseUrl: string; token: string },
): PortalDto {
  return {
    key: adapter.key,
    displayName: adapter.displayName,
    mode: adapter.mode,
    feedUrl:
      adapter.mode === 'feed' ? feedUrlFor(feeds.publicBaseUrl, adapter.key, feeds.token) : null,
  };
}

export function toPortalCheck(adapter: PortalAdapter, issues: ValidationIssue[]): PortalCheckDto {
  return {
    portal: adapter.key,
    displayName: adapter.displayName,
    ready: issues.length === 0,
    issues: issues.map(({ field, message }) => ({ field, message })),
  };
}
