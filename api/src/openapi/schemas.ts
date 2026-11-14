import {
  DEAL_TYPES,
  PORTAL_LISTING_STATUSES,
  PROPERTY_STATUSES,
  PROPERTY_TYPES,
  USER_ROLES,
} from '../db/types.js';
import { API_ERROR_CODES } from '../lib/http-error.js';
import { PHOTO_LIMITS } from '../modules/images/image-processing.js';
import { FIELD_LIMITS } from '../modules/properties/properties.validators.js';
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
  ErrorDetail: object(
    {
      field: { type: 'string', examples: ['price'] },
      message: { type: 'string', examples: ['must be a number from 0 to 9999999999.99'] },
    },
    { description: 'One problem with one field.' },
  ),

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
            description: 'Per-field problems (VALIDATION_ERROR, and per-file for photo uploads).',
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
    ...audit,
  }),

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
      maxItems: PHOTO_LIMITS.maxPerProperty,
      description: 'Every photo id of the property exactly once, in the new display order.',
      examples: [[12, 10, 11]],
    },
  }),
};
