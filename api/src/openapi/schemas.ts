import {
  DEAL_TYPES,
  JOB_ACTIONS,
  JOB_STATUSES,
  PORTAL_LISTING_STATUSES,
  PROPERTY_STATUSES,
  PROPERTY_TYPES,
  USER_ROLES,
} from '../db/types.js';
import { API_ERROR_CODES } from '../lib/http-error.js';
import { DEFAULT_UPLOAD_LIMITS } from '../modules/images/image-processing.js';
import { FIELD_LIMITS } from '../modules/properties/properties.validators.js';
import { BULK_DELETE_RESULTS } from '../modules/publishing/publishing.mappers.js';
import { BULK_MAX_PROPERTIES } from '../modules/publishing/publishing.validators.js';
import type { JsonSchema } from './types.js';

/*
 * Reusable JSON Schemas (OpenAPI 3.1 = JSON Schema 2020-12) for every request and
 * response body. Limits come from the same constants the validators use. Response
 * schemas set additionalProperties: false, so the integration tests notice any field
 * the API returns but the document does not describe.
 */

export const ref = (name: string): JsonSchema => ({ $ref: `#/components/schemas/${name}` });

const nullable = (type: string, extra: JsonSchema = {}): JsonSchema => ({
  type: [type, 'null'],
  ...extra,
});

const dateTime = (description: string): JsonSchema => ({
  type: 'string',
  format: 'date-time',
  description: `${description} (ISO 8601, UTC).`,
  examples: ['2026-11-13T09:30:00.000Z'],
});

const object = (properties: Record<string, JsonSchema>, extra: JsonSchema = {}): JsonSchema => ({
  type: 'object',
  required: Object.keys(properties),
  additionalProperties: false,
  properties,
  ...extra,
});

const id = (description: string): JsonSchema => ({
  type: 'integer',
  minimum: 1,
  description,
  examples: [42],
});

const L = FIELD_LIMITS;

/**
 * A chosen reference code, or "" (which, like null, lets the server assign one). Built from
 * the validator's own pattern, so the two cannot drift apart.
 */
export const REF_CODE_INPUT_PATTERN = `^(?:${L.refCodePattern.source.slice(1, -1)})?$`;

/** GENERATED_REF_CODE (/^IS-\d+$/i) without the i flag, which JSON Schema patterns lack. */
export const RESERVED_REF_CODE_PATTERN = '^[Ii][Ss]-[0-9]+$';

/* ---- property fields, shared by the summary, the detail and the request bodies ---- */

const propertyFields = {
  refCode: {
    type: 'string',
    description:
      'Agency reference. Portals use it to recognise a listing when it is imported again.',
    examples: ['IS-00042'],
  },
  title: nullable('string', {
    maxLength: L.titleMax,
    examples: ['Two-bedroom flat near the park'],
  }),
  type: { type: 'string', enum: [...PROPERTY_TYPES] },
  dealType: { type: 'string', enum: [...DEAL_TYPES] },
  city: { type: 'string', minLength: 1, maxLength: L.cityMax, examples: ['Sofia'] },
  district: nullable('string', { maxLength: L.districtMax, examples: ['Lozenets'] }),
  price: nullable('number', {
    minimum: 0,
    maximum: L.priceMax,
    description: 'At most 2 decimals. For rentals: per month.',
    examples: [185000],
  }),
  currency: {
    type: 'string',
    pattern: L.currencyPattern.source,
    description: 'ISO 4217 code.',
    examples: ['EUR'],
  },
  areaM2: nullable('number', {
    exclusiveMinimum: 0,
    maximum: L.areaMax,
    description: 'Area in square metres, at most 2 decimals.',
    examples: [92.5],
  }),
  rooms: nullable('integer', { minimum: 0, maximum: L.roomsMax, examples: [3] }),
  floor: nullable('integer', {
    minimum: L.floorMin,
    maximum: L.floorMax,
    description: '0 is the ground floor, negative numbers are basements.',
    examples: [4],
  }),
  totalFloors: nullable('integer', { minimum: 0, maximum: L.totalFloorsMax, examples: [8] }),
  status: {
    type: 'string',
    enum: [...PROPERTY_STATUSES],
    description: "The agency's own lifecycle of the property.",
  },
} satisfies Record<string, JsonSchema>;

const description = nullable('string', {
  maxLength: L.descriptionMax,
  description: `At most ${L.descriptionMax} characters and ${L.descriptionMaxBytes} bytes in UTF-8.`,
});

const summaryFields = {
  id: id('Property id.'),
  ...propertyFields,
  coverImageUrl: nullable('string', {
    description: 'URL of the first photo (by sort order), or null without photos.',
    examples: ['/uploads/properties/42/0f8fad5b-d9cb-469f-a165-70867728950e.jpg'],
  }),
  imageCount: { type: 'integer', minimum: 0 },
} satisfies Record<string, JsonSchema>;

const audit = {
  createdBy: {
    oneOf: [ref('CreatedBy'), { type: 'null' }],
    description: 'Who created the property; null if unknown or the account was deleted.',
  },
  createdAt: dateTime('When the property was created'),
  updatedAt: dateTime('When the property or its photos last changed'),
} satisfies Record<string, JsonSchema>;

/** Request body fields: trimmed strings, "" stores null for the nullable ones. */
function inputFields(): Record<string, JsonSchema> {
  const { refCode: _refCode, ...fields } = propertyFields;
  return {
    ...fields,
    description,
    title: nullable('string', {
      maxLength: L.titleMax,
      description: 'Trimmed; an empty string stores null.',
    }),
    district: nullable('string', {
      maxLength: L.districtMax,
      description: 'Trimmed; an empty string stores null.',
    }),
  };
}

export const schemas: Record<string, JsonSchema> = {
  ErrorDetail: {
    type: 'object',
    required: ['field', 'message'],
    additionalProperties: false,
    description: 'One problem with one field.',
    properties: {
      portal: {
        type: 'string',
        description: 'NOT_READY only: the portal whose rules the field breaks.',
        examples: ['demo'],
      },
      field: { type: 'string', examples: ['price'] },
      message: { type: 'string', examples: ['must be a number from 0 to 9999999999.99'] },
    },
  },

  Error: object(
    {
      error: {
        type: 'object',
        required: ['code', 'message'],
        additionalProperties: false,
        properties: {
          code: {
            type: 'string',
            enum: [...API_ERROR_CODES],
            description:
              'Stable, machine-readable code; the response descriptions say which codes each status uses.',
            examples: ['VALIDATION_ERROR'],
          },
          message: { type: 'string', description: 'Human-readable explanation.' },
          details: {
            type: 'array',
            items: ref('ErrorDetail'),
            description:
              'Per-field problems (VALIDATION_ERROR, per file for photo uploads, per portal and field for NOT_READY).',
          },
        },
      },
    },
    { description: 'Every error response has this shape.' },
  ),

  Health: object({
    status: { type: 'string', enum: ['ok', 'degraded'] },
    db: { type: 'string', enum: ['up', 'down'] },
    version: { type: 'string', examples: ['0.2.0'] },
    uptimeSeconds: { type: 'integer', minimum: 0 },
  }),

  User: object({
    id: id('User id.'),
    email: { type: 'string', examples: ['admin@imotsync.local'] },
    fullName: { type: 'string', examples: ['Demo Admin'] },
    role: { type: 'string', enum: [...USER_ROLES] },
  }),

  LoginRequest: object({
    email: {
      type: 'string',
      maxLength: 255,
      description: 'Compared trimmed and case-insensitively.',
      examples: ['admin@imotsync.local'],
    },
    password: { type: 'string', minLength: 1, maxLength: 1024, examples: ['demo1234'] },
  }),

  LoginResponse: object({
    accessToken: {
      type: 'string',
      description: 'JWT (HS256). Send it as "Authorization: Bearer <token>".',
    },
    tokenType: { type: 'string', const: 'Bearer' },
    expiresIn: {
      type: 'integer',
      minimum: 1,
      description: 'Seconds until the token expires (JWT_TTL_SECONDS).',
      examples: [28800],
    },
    user: ref('User'),
  }),

  CurrentUser: object({ user: ref('User') }),

  ClientConfig: object({
    demoMode: {
      type: 'boolean',
      description:
        'true on the public demo (DEMO_MODE): made-up data reset every night, POST /auth/demo signs in the shared demo account, and the feeds are closed.',
    },
    uploadLimits: object(
      {
        maxFileBytes: { type: 'integer', minimum: 1, examples: [15 * 1024 * 1024] },
        maxFilesPerRequest: { type: 'integer', minimum: 1, examples: [20] },
        maxPerProperty: { type: 'integer', minimum: 1, examples: [40] },
      },
      { description: 'Photo upload limits of this deployment (lower on the public demo).' },
    ),
  }),

  CreatedBy: object({
    id: id('User id.'),
    fullName: { type: 'string', examples: ['Demo Broker'] },
  }),

  PortalStatus: object(
    {
      portal: { type: 'string', description: 'Portal adapter key.', examples: ['bazar'] },
      status: { type: 'string', enum: [...PORTAL_LISTING_STATUSES] },
      lastError: nullable('string', { description: 'Why the last portal job failed.' }),
      publishedAt: {
        ...nullable('string', { format: 'date-time' }),
        description: 'When the listing was first published (ISO 8601, UTC).',
      },
    },
    { description: "A property's state on one portal." },
  ),

  PortalListing: object(
    {
      id: id('Portal listing id.'),
      portal: { type: 'string', description: 'Portal adapter key.', examples: ['bazar'] },
      status: { type: 'string', enum: [...PORTAL_LISTING_STATUSES] },
      externalId: nullable('string', { description: 'The id the portal assigned, if any.' }),
      lastError: nullable('string', { description: 'Why the last portal job failed.' }),
      publishedAt: {
        ...nullable('string', { format: 'date-time' }),
        description: 'When the listing was first published (ISO 8601, UTC).',
      },
      lastSentAt: {
        ...nullable('string', { format: 'date-time' }),
        description:
          'When the listing was last sent to the portal: the finish time of its newest successful publish or update job (ISO 8601, UTC); null if it never was. For a feed portal, when its feed entry was last written; the portal picks it up at its next download.',
      },
      updatedAt: dateTime('When the listing last changed'),
    },
    { description: "A property's listing on one portal." },
  ),

  PropertyImage: object({
    id: id('Photo id.'),
    url: {
      type: 'string',
      description: 'Public URL of the stored JPEG.',
      examples: ['/uploads/properties/42/0f8fad5b-d9cb-469f-a165-70867728950e.jpg'],
    },
    sortOrder: { type: 'integer', minimum: 0, description: 'Display position, 0 first.' },
    width: nullable('integer', { minimum: 1, examples: [2048] }),
    height: nullable('integer', { minimum: 1, examples: [1365] }),
    sizeBytes: nullable('integer', { minimum: 1, examples: [412345] }),
    createdAt: dateTime('When the photo was uploaded'),
  }),

  PropertySummary: object({
    ...summaryFields,
    portals: { type: 'array', items: ref('PortalStatus'), description: 'Ordered by portal.' },
    ...audit,
  }),

  PropertyDetail: object({
    ...summaryFields,
    description,
    images: { type: 'array', items: ref('PropertyImage'), description: 'In display order.' },
    portals: { type: 'array', items: ref('PortalListing'), description: 'Ordered by portal.' },
    deletion: {
      oneOf: [ref('ScheduledDeletion'), { type: 'null' }],
      description: 'Set while a requested deletion has not happened yet; null otherwise.',
    },
    ...audit,
  }),

  ScheduledDeletion: object(
    {
      requestedAt: dateTime('When the deletion was requested'),
      state: {
        type: 'string',
        enum: ['removing', 'feed_retention', 'due'],
        description:
          'removing: a listing is still pending or online (a removal is queued, running, or failed and needs a retry), so no date is known yet. feed_retention: only feeds that still serve its removal (Bazar.bg keeps a removed item as out of stock for BAZAR_REMOVED_RETENTION_DAYS) hold it back, until deletesAfter. due: nothing holds it back; the worker deletes it within a minute.',
      },
      portals: {
        type: 'array',
        items: { type: 'string' },
        description: 'Keys of the portals it waits for (empty when due).',
        examples: [['bazar']],
      },
      deletesAfter: {
        type: ['string', 'null'],
        format: 'date-time',
        description:
          'feed_retention: when the last feed stops serving its removal, after which the worker deletes it (ISO 8601, UTC). Otherwise null.',
      },
    },
    {
      description:
        'An archived property waiting to be deleted. Setting its status to draft or active cancels the deletion.',
    },
  ),

  PaginationMeta: object({
    page: { type: 'integer', minimum: 1 },
    pageSize: { type: 'integer', minimum: 1, maximum: L.pageSizeMax },
    total: { type: 'integer', minimum: 0, description: 'Matching properties on all pages.' },
    totalPages: { type: 'integer', minimum: 0 },
  }),

  PropertyList: object({
    data: { type: 'array', items: ref('PropertySummary') },
    meta: ref('PaginationMeta'),
  }),

  PropertyCreate: {
    type: 'object',
    required: ['type', 'dealType', 'city'],
    additionalProperties: false,
    description:
      'Unknown fields are rejected. floor must not exceed totalFloors when both are set.',
    properties: {
      refCode: {
        type: ['string', 'null'],
        pattern: REF_CODE_INPUT_PATTERN,
        not: { type: 'string', pattern: RESERVED_REF_CODE_PATTERN },
        description:
          'Optional and unique, 3 to 32 letters, digits, "-" or "_" (trimmed). Omitted, empty or null: the server assigns "IS-" + the id padded to 5 digits. Codes of the form IS-<number>, in any letter case, are reserved for that.',
        examples: ['SOF-LOZ-17'],
      },
      ...inputFields(),
      currency: { ...propertyFields.currency, default: 'EUR' },
      status: { ...propertyFields.status, default: 'draft' },
    },
  },

  PropertyUpdate: {
    type: 'object',
    minProperties: 1,
    additionalProperties: false,
    description:
      'Partial update: only the fields sent change, null clears a nullable field. refCode cannot be changed. Unknown fields are rejected.',
    properties: inputFields(),
  },

  PropertyImageList: object({
    data: { type: 'array', items: ref('PropertyImage') },
  }),

  PropertyImageOrder: object({
    imageIds: {
      type: 'array',
      items: { type: 'integer', minimum: 1 },
      uniqueItems: true,
      maxItems: DEFAULT_UPLOAD_LIMITS.maxPerProperty,
      description: 'Every photo id of the property exactly once, in the new display order.',
      examples: [[12, 10, 11]],
    },
  }),

  /* ---- publishing ---- */

  Portal: object(
    {
      key: { type: 'string', description: 'Portal adapter key.', examples: ['demo'] },
      displayName: { type: 'string', examples: ['Demo portal'] },
      mode: {
        type: 'string',
        enum: ['feed', 'push'],
        description:
          'feed: the portal downloads a feed from this server on its own schedule. push: the worker sends each change to the portal.',
      },
      feedUrl: nullable('string', {
        description:
          'Feed portals: the URL to give the portal (public, protected by the FEED_TOKEN in its path). Push portals: null.',
        examples: ['https://imotsync.example/feeds/bazar/0f8fad5bd9cb469fa16570867728950e.xml'],
      }),
    },
    { description: 'A portal this server publishes to.' },
  ),

  PortalList: object({ data: { type: 'array', items: ref('Portal') } }),

  ValidationIssue: object(
    {
      field: { type: 'string', examples: ['images'] },
      message: { type: 'string', examples: ['The demo portal needs at least one photo.'] },
    },
    { description: "One thing that keeps a property from a portal, by the portal's rules." },
  ),

  PortalCheck: object(
    {
      portal: { type: 'string', examples: ['demo'] },
      displayName: { type: 'string', examples: ['Demo portal'] },
      ready: { type: 'boolean', description: 'True when there are no issues.' },
      issues: { type: 'array', items: ref('ValidationIssue') },
    },
    { description: 'The pre-publish check of one property against one portal.' },
  ),

  PortalCheckList: object({ data: { type: 'array', items: ref('PortalCheck') } }),

  PublishRequest: object({
    portals: {
      type: 'array',
      items: { type: 'string' },
      minItems: 1,
      uniqueItems: true,
      description: 'Keys of registered portals (GET /portals).',
      examples: [['demo']],
    },
  }),

  UnpublishRequest: {
    type: 'object',
    additionalProperties: false,
    description: 'Unknown fields are rejected. Without portals: every portal of the property.',
    properties: {
      portals: {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        uniqueItems: true,
        description: 'Keys of registered portals.',
        examples: [['demo']],
      },
    },
  },

  JobListing: object({
    id: id('Portal listing id.'),
    portal: { type: 'string', examples: ['demo'] },
    status: { type: 'string', enum: [...PORTAL_LISTING_STATUSES] },
  }),

  JobProperty: object({
    id: id('Property id.'),
    refCode: { type: 'string', examples: ['IS-00042'] },
    title: nullable('string'),
  }),

  Job: object(
    {
      id: id('Job id.'),
      action: { type: 'string', enum: [...JOB_ACTIONS] },
      status: {
        type: 'string',
        enum: [...JOB_STATUSES],
        description:
          'queued (waiting, possibly for a retry at runAfter), running, succeeded or failed (final).',
      },
      attempts: { type: 'integer', minimum: 0, description: 'Attempts started so far.' },
      maxAttempts: { type: 'integer', minimum: 1 },
      runAfter: dateTime('The job is not started before this time'),
      lockedAt: {
        ...nullable('string', { format: 'date-time' }),
        description: 'Running jobs: when the worker took it (ISO 8601, UTC).',
      },
      lockedBy: nullable('string', {
        description: 'Running jobs: the worker that holds it (host:pid:random).',
      }),
      lastError: nullable('string', { description: 'Error of the last failed attempt.' }),
      result: {
        type: ['object', 'null'],
        description:
          'Outcome of the last attempt: {message, externalId?, details?} on success, {error, retryable, httpStatus?, code?, errorId?, retryInSeconds?} on failure. An unexpected error (code UNEXPECTED) is stored only as a generic message with an errorId; its details are in the worker log under that id.',
      },
      finishedAt: {
        ...nullable('string', { format: 'date-time' }),
        description: 'When the job succeeded or failed for good (ISO 8601, UTC).',
      },
      createdAt: dateTime('When the job was queued'),
      updatedAt: dateTime('When the job last changed'),
      listing: ref('JobListing'),
      property: { oneOf: [ref('JobProperty'), { type: 'null' }] },
    },
    { description: 'One publish, update or remove operation for one portal listing.' },
  ),

  JobList: object({
    data: { type: 'array', items: ref('Job') },
    meta: ref('PaginationMeta'),
  }),

  JobResponse: object({ data: ref('Job') }),

  PublishResult: object(
    {
      listings: {
        type: 'array',
        items: ref('PortalListing'),
        description: 'The listings involved, after the change, ordered by portal.',
      },
      jobs: {
        type: 'array',
        items: ref('Job'),
        description:
          'The jobs that will carry the request out: new ones, or queued ones the request was merged into.',
      },
    },
    { description: 'What a publish or unpublish request queued.' },
  ),

  PublishResponse: object({ data: ref('PublishResult') }),

  BulkPublishRequest: object({
    propertyIds: {
      type: 'array',
      items: { type: 'integer', minimum: 1 },
      minItems: 1,
      maxItems: BULK_MAX_PROPERTIES,
      uniqueItems: true,
      examples: [[1, 2, 3]],
    },
    portals: {
      type: 'array',
      items: { type: 'string' },
      minItems: 1,
      uniqueItems: true,
      examples: [['demo']],
    },
  }),

  BulkPublishItem: {
    type: 'object',
    required: ['propertyId', 'ok'],
    additionalProperties: false,
    description:
      'ok: jobs were queued. Not ok: error says why (NOT_FOUND, CONFLICT for an archived property, NOT_READY with issues, INTERNAL_ERROR for an unexpected error, which is logged; the other properties go ahead).',
    properties: {
      propertyId: id('Property id.'),
      ok: { type: 'boolean' },
      issues: { type: 'array', items: ref('ErrorDetail') },
      jobs: { type: 'array', items: ref('Job') },
      error: {
        type: 'object',
        required: ['code', 'message'],
        additionalProperties: false,
        properties: {
          code: { type: 'string', enum: ['NOT_FOUND', 'CONFLICT', 'NOT_READY', 'INTERNAL_ERROR'] },
          message: { type: 'string' },
        },
      },
    },
  },

  BulkPublishResponse: object({ data: { type: 'array', items: ref('BulkPublishItem') } }),

  BulkDeleteRequest: object({
    propertyIds: {
      type: 'array',
      items: { type: 'integer', minimum: 1 },
      minItems: 1,
      maxItems: BULK_MAX_PROPERTIES,
      uniqueItems: true,
      examples: [[8, 9]],
    },
  }),

  BulkDeleteItem: {
    type: 'object',
    required: ['propertyId', 'result'],
    additionalProperties: false,
    properties: {
      propertyId: id('Property id.'),
      result: {
        type: 'string',
        enum: [...BULK_DELETE_RESULTS],
        description:
          'deleted: gone now (nothing was online). removal_queued: archived, remove jobs queued; the worker deletes it once every portal has removed it. deletion_scheduled: nothing is online, but a feed still serves its removal (a Bazar.bg item kept as out of stock for BAZAR_REMOVED_RETENTION_DAYS): archived; the worker deletes it once that period has passed. not_found: no such property. error: an unexpected error (logged; see error); the other properties go ahead.',
      },
      error: {
        type: 'object',
        required: ['code', 'message'],
        additionalProperties: false,
        description: "Only with result 'error'.",
        properties: {
          code: { type: 'string', enum: ['INTERNAL_ERROR'] },
          message: { type: 'string' },
        },
      },
    },
  },

  DeletionScheduledResponse: object({
    data: object({
      result: {
        type: 'string',
        enum: ['deletion_scheduled'],
        description:
          'The property was archived and is deleted by the worker once its removal has been served for the retention period.',
      },
    }),
  }),

  BulkDeleteResponse: object({ data: { type: 'array', items: ref('BulkDeleteItem') } }),
};
