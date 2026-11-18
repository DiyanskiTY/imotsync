/*
 * Names for the API's types. Everything here comes from schema.d.ts, which is generated from the
 * API's OpenAPI document (npm run api:types), so the admin panel cannot drift from the API.
 * Do not hand-write request or response shapes anywhere else.
 */

import type { components, operations } from './schema';

type Schemas = components['schemas'];

export type Health = Schemas['Health'];
export type User = Schemas['User'];
export type LoginRequest = Schemas['LoginRequest'];
export type LoginResponse = Schemas['LoginResponse'];
export type CurrentUser = Schemas['CurrentUser'];

export type PropertySummary = Schemas['PropertySummary'];
export type PropertyDetail = Schemas['PropertyDetail'];
export type ScheduledDeletion = Schemas['ScheduledDeletion'];
export type PropertyCreate = Schemas['PropertyCreate'];
export type PropertyUpdate = Schemas['PropertyUpdate'];
export type PropertyList = Schemas['PropertyList'];
export type PropertyImage = Schemas['PropertyImage'];
export type PortalStatusSummary = Schemas['PortalStatus'];
export type PortalListing = Schemas['PortalListing'];
export type PaginationMeta = Schemas['PaginationMeta'];

export type Portal = Schemas['Portal'];
export type PortalCheck = Schemas['PortalCheck'];
export type ValidationIssue = Schemas['ValidationIssue'];
export type PublishResult = Schemas['PublishResult'];
export type BulkPublishItem = Schemas['BulkPublishItem'];
export type BulkDeleteItem = Schemas['BulkDeleteItem'];

export type Job = Schemas['Job'];

/** Request bodies and response envelopes, so services cannot drift from the contract. */
export type PropertyImageOrder = Schemas['PropertyImageOrder'];
export type PropertyImageList = Schemas['PropertyImageList'];
export type PortalList = Schemas['PortalList'];
export type PortalCheckList = Schemas['PortalCheckList'];
export type PublishRequest = Schemas['PublishRequest'];
export type UnpublishRequest = Schemas['UnpublishRequest'];
export type PublishResponse = Schemas['PublishResponse'];
export type BulkPublishRequest = Schemas['BulkPublishRequest'];
export type BulkPublishResponse = Schemas['BulkPublishResponse'];
export type BulkDeleteRequest = Schemas['BulkDeleteRequest'];
export type BulkDeleteResponse = Schemas['BulkDeleteResponse'];
export type JobResponse = Schemas['JobResponse'];
export type JobList = Schemas['JobList'];

export type ErrorDetail = Schemas['ErrorDetail'];
export type ApiErrorBody = Schemas['Error'];
export type ApiErrorCode = ApiErrorBody['error']['code'];

export type PropertyType = PropertySummary['type'];
export type DealType = PropertySummary['dealType'];
export type PropertyStatus = PropertySummary['status'];
export type ListingStatus = PortalListing['status'];
export type JobStatus = Job['status'];
export type JobAction = Job['action'];
export type BulkDeleteResult = BulkDeleteItem['result'];

/** Query of GET /api/properties, exactly as the API accepts it. */
export type PropertyListQuery = NonNullable<operations['listProperties']['parameters']['query']>;
export type PropertySort = NonNullable<PropertyListQuery['sort']>;

/** Query of GET /api/jobs, exactly as the API accepts it. */
export type JobListQuery = NonNullable<operations['listJobs']['parameters']['query']>;
export type JobSort = NonNullable<JobListQuery['sort']>;

/**
 * Lists every value of a union type, in display order. Compiles only when no value is missing,
 * so a new enum value in the API breaks the build here instead of hiding from a filter.
 */
function allOf<T extends string>() {
  return <const U extends readonly T[]>(
    values: U & ([T] extends [U[number]] ? unknown : { missing: Exclude<T, U[number]> }),
  ): U => values;
}

/** Enum values for selects and filters. */
export const PROPERTY_TYPES = allOf<PropertyType>()([
  'apartment',
  'house',
  'office',
  'shop',
  'land',
  'garage',
  'other',
]);
export const DEAL_TYPES = allOf<DealType>()(['sale', 'rent']);
export const PROPERTY_STATUSES = allOf<PropertyStatus>()(['draft', 'active', 'archived']);
export const LISTING_STATUSES = allOf<ListingStatus>()([
  'draft',
  'pending',
  'published',
  'error',
  'removed',
]);
export const JOB_STATUSES = allOf<JobStatus>()(['queued', 'running', 'succeeded', 'failed']);
export const JOB_ACTIONS = allOf<JobAction>()(['publish', 'update', 'remove']);
/** Portal keys the property list can filter by (the deployment's registered portals). */
export type PortalKey = NonNullable<PropertyListQuery['portal']>;
export const PORTAL_KEYS = allOf<PortalKey>()(['realistimo', 'bazar', 'demo']);

export const PROPERTY_SORTS = allOf<PropertySort>()([
  '-updatedAt',
  'updatedAt',
  '-createdAt',
  'createdAt',
  'price',
  '-price',
  'areaM2',
  '-areaM2',
  'refCode',
  '-refCode',
  'city',
  '-city',
]);
export const JOB_SORTS = allOf<JobSort>()([
  '-createdAt',
  'createdAt',
  '-updatedAt',
  'updatedAt',
  '-runAfter',
  'runAfter',
  '-finishedAt',
  'finishedAt',
  '-id',
  'id',
]);
