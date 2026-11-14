import {
  DEAL_TYPES,
  PORTAL_LISTING_STATUSES,
  PORTALS,
  PROPERTY_STATUSES,
  PROPERTY_TYPES,
} from '../db/types.js';
import { ACCEPTED_FORMATS_TEXT, PHOTO_LIMITS } from '../modules/images/image-processing.js';
import {
  DEFAULT_UPLOAD_BODY_TIMEOUT_MS,
  MAX_UPLOAD_BODY_BYTES,
  PHOTO_FIELD,
} from '../modules/images/photo-upload.js';
import { DEFAULT_PAGE_SIZE, DEFAULT_SORT, SORT_VALUES } from '../modules/properties/list-query.js';
import { FIELD_LIMITS } from '../modules/properties/properties.validators.js';
import { APP_VERSION } from '../version.js';
import { ref, schemas } from './schemas.js';
import type {
  JsonSchema,
  OpenApiDocument,
  Operation,
  Parameter,
  Reference,
  RequestBody,
  Response,
} from './types.js';

/*
 * The OpenAPI 3.1 description of the API, served at /api/openapi.json and rendered by
 * Swagger UI at /api/docs. Tests check that it is valid, that it lists exactly the routes
 * the app registers, and that real responses match its schemas.
 */

export const OPENAPI_JSON_PATH = '/api/openapi.json';
export const DOCS_PATH = '/api/docs';

const MB = 1024 * 1024;

const json = (schema: JsonSchema) => ({ 'application/json': { schema } });
const response = (name: string): Reference => ({ $ref: `#/components/responses/${name}` });
const parameter = (name: string): Reference => ({ $ref: `#/components/parameters/${name}` });
const header = (name: string): Reference => ({ $ref: `#/components/headers/${name}` });

const jsonBody = (schemaName: string, description?: string): RequestBody => ({
  required: true,
  ...(description ? { description } : {}),
  content: json(ref(schemaName)),
});

/** Errors any authenticated JSON operation can return. */
const AUTHENTICATED: Record<string, Reference> = {
  '401': response('Unauthorized'),
  '500': response('InternalError'),
};

function listParam(name: string, values: readonly string[], description: string): Parameter {
  return {
    name,
    in: 'query',
    description: `${description} Comma-separated, any of: ${values.join(', ')}.`,
    style: 'form',
    explode: false,
    schema: { type: 'array', items: { type: 'string', enum: [...values] }, uniqueItems: true },
  };
}

const listPropertiesParameters: Parameter[] = [
  {
    name: 'page',
    in: 'query',
    description: 'Page number, from 1.',
    schema: { type: 'integer', minimum: 1, maximum: FIELD_LIMITS.pageMax, default: 1 },
  },
  {
    name: 'pageSize',
    in: 'query',
    description: 'Properties per page.',
    schema: {
      type: 'integer',
      minimum: 1,
      maximum: FIELD_LIMITS.pageSizeMax,
      default: DEFAULT_PAGE_SIZE,
    },
  },
  {
    name: 'q',
    in: 'query',
    description:
      'Search text: matches part of the reference code, title, city or district, case-insensitively (Cyrillic included). % and _ match themselves.',
    schema: { type: 'string', maxLength: FIELD_LIMITS.searchMax, examples: ['Лозенец'] },
  },
  listParam('status', PROPERTY_STATUSES, 'Property status.'),
  listParam('type', PROPERTY_TYPES, 'Property type.'),
  listParam('dealType', DEAL_TYPES, 'Deal type.'),
  {
    name: 'city',
    in: 'query',
    description: 'Exact city name, case-insensitive.',
    schema: { type: 'string', maxLength: FIELD_LIMITS.cityMax, examples: ['Sofia'] },
  },
  {
    name: 'priceMin',
    in: 'query',
    description: 'Lowest price (inclusive). Properties without a price are left out.',
    schema: { type: 'number', minimum: 0 },
  },
  {
    name: 'priceMax',
    in: 'query',
    description: 'Highest price (inclusive); not below priceMin.',
    schema: { type: 'number', minimum: 0 },
  },
  {
    name: 'portal',
    in: 'query',
    description:
      'Only properties with a listing on this portal (in any status, or in portalStatus).',
    schema: { type: 'string', enum: [...PORTALS] },
  },
  listParam(
    'portalStatus',
    PORTAL_LISTING_STATUSES,
    'Only properties with a listing in one of these statuses: on `portal` if given, otherwise on any portal.',
  ),
  {
    name: 'sort',
    in: 'query',
    description:
      'Sort field; a leading "-" sorts descending. Ties are broken by id in the same direction.',
    schema: { type: 'string', enum: [...SORT_VALUES], default: DEFAULT_SORT },
  },
];

const properties: Record<string, Operation> = {
  list: {
    operationId: 'listProperties',
    summary: 'List properties',
    description: 'Paginated, filtered and sorted. Unknown query parameters are rejected with 400.',
    tags: ['Properties'],
    parameters: listPropertiesParameters,
    responses: {
      '200': { description: 'One page of properties.', content: json(ref('PropertyList')) },
      '400': response('BadRequest'),
      ...AUTHENTICATED,
    },
  },
  create: {
    operationId: 'createProperty',
    summary: 'Create a property',
    description: 'The signed-in user is recorded as the creator.',
    tags: ['Properties'],
    requestBody: jsonBody('PropertyCreate'),
    responses: {
      '201': {
        description: 'Created.',
        headers: { Location: header('Location') },
        content: json(ref('PropertyDetail')),
      },
      '400': response('BadRequest'),
      '409': response('Conflict'),
      '413': response('PayloadTooLarge'),
      '415': response('UnsupportedMediaType'),
      ...AUTHENTICATED,
    },
  },
  get: {
    operationId: 'getProperty',
    summary: 'Get a property',
    description: 'With its photos in display order and its listing on every portal.',
    tags: ['Properties'],
    parameters: [parameter('PropertyId')],
    responses: {
      '200': { description: 'The property.', content: json(ref('PropertyDetail')) },
      '400': response('BadRequest'),
      '404': response('NotFound'),
      ...AUTHENTICATED,
    },
  },
  update: {
    operationId: 'updateProperty',
    summary: 'Update a property',
    tags: ['Properties'],
    parameters: [parameter('PropertyId')],
    requestBody: jsonBody('PropertyUpdate'),
    responses: {
      '200': { description: 'The updated property.', content: json(ref('PropertyDetail')) },
      '400': response('BadRequest'),
      '404': response('NotFound'),
      '413': response('PayloadTooLarge'),
      '415': response('UnsupportedMediaType'),
      ...AUTHENTICATED,
    },
  },
  delete: {
    operationId: 'deleteProperty',
    summary: 'Delete a property',
    description:
      'Deletes the property with its photos (rows and files), portal listings and jobs. Refused with 409 while a portal listing is pending or published: remove it from the portals first.',
    tags: ['Properties'],
    parameters: [parameter('PropertyId')],
    responses: {
      '204': { description: 'Deleted.' },
      '400': response('BadRequest'),
      '404': response('NotFound'),
      '409': response('Conflict'),
      ...AUTHENTICATED,
    },
  },
};

const photos: Record<string, Operation> = {
  upload: {
    operationId: 'uploadPropertyImages',
    summary: 'Upload photos',
    description: [
      `Send 1 to ${PHOTO_LIMITS.maxFilesPerRequest} files in the multipart field "${PHOTO_FIELD}", each at most ${PHOTO_LIMITS.maxFileBytes / MB} MB;`,
      `any other field, text fields included, gets 400 naming it.`,
      `The content decides, not the file name or declared type: ${ACCEPTED_FORMATS_TEXT} images are accepted (415 otherwise),`,
      `with at least ${PHOTO_LIMITS.minShortSide} px on the shorter side and at most ${PHOTO_LIMITS.maxInputPixels / 1_000_000} megapixels (400 otherwise).`,
      `Every photo is turned upright, stripped of all metadata (including GPS), fitted inside ${PHOTO_LIMITS.maxStoredSide}x${PHOTO_LIMITS.maxStoredSide} px and stored as JPEG;`,
      `the stored photo keeps at least ${PHOTO_LIMITS.minShortSide} px on its shorter side too, so very long, narrow images are refused (400).`,
      `New photos go after the existing ones. A property has at most ${PHOTO_LIMITS.maxPerProperty} photos (409 otherwise).`,
      `The server handles a few uploads at a time; when all are busy it answers 429 with Retry-After.`,
      `The whole body has to arrive within ${DEFAULT_UPLOAD_BODY_TIMEOUT_MS / 1000} seconds (408 otherwise, and the connection is closed); on a slow connection, send fewer photos per request.`,
    ].join(' '),
    tags: ['Photos'],
    parameters: [parameter('PropertyId')],
    requestBody: {
      required: true,
      content: {
        'multipart/form-data': {
          schema: {
            type: 'object',
            required: [PHOTO_FIELD],
            additionalProperties: false,
            properties: {
              [PHOTO_FIELD]: {
                type: 'array',
                minItems: 1,
                maxItems: PHOTO_LIMITS.maxFilesPerRequest,
                // contentMediaType is the OpenAPI 3.1 way to describe a file. Swagger UI
                // (5.35) shows a file picker for array items only with format: binary,
                // and looking that format up logs a harmless "Could not find component:
                // JsonSchema_string_binary" warning in the browser console.
                items: {
                  type: 'string',
                  format: 'binary',
                  contentMediaType: 'application/octet-stream',
                },
              },
            },
          },
          encoding: {
            [PHOTO_FIELD]: { contentType: 'image/jpeg, image/png, image/webp, image/avif' },
          },
        },
      },
    },
    responses: {
      '201': {
        description: 'The new photos, in display order.',
        content: json(ref('PropertyImageList')),
      },
      '400': response('BadRequest'),
      '404': response('NotFound'),
      '408': response('UploadTimedOut'),
      '409': response('Conflict'),
      '413': response('PayloadTooLarge'),
      '415': response('UnsupportedMediaType'),
      '429': response('UploadsBusy'),
      ...AUTHENTICATED,
    },
  },
  reorder: {
    operationId: 'reorderPropertyImages',
    summary: 'Reorder photos',
    description:
      "Sets the display order. imageIds must list each of the property's photos exactly once; the first becomes the cover photo.",
    tags: ['Photos'],
    parameters: [parameter('PropertyId')],
    requestBody: jsonBody('PropertyImageOrder'),
    responses: {
      '200': {
        description: 'All photos of the property, in the new order.',
        content: json(ref('PropertyImageList')),
      },
      '400': response('BadRequest'),
      '404': response('NotFound'),
      '413': response('PayloadTooLarge'),
      '415': response('UnsupportedMediaType'),
      ...AUTHENTICATED,
    },
  },
  delete: {
    operationId: 'deletePropertyImage',
    summary: 'Delete a photo',
    tags: ['Photos'],
    parameters: [parameter('PropertyId'), parameter('ImageId')],
    responses: {
      '204': { description: 'Deleted (the row and the file).' },
      '400': response('BadRequest'),
      '404': response('NotFound'),
      ...AUTHENTICATED,
    },
  },
};

const errorResponse = (description: string, extra: Partial<Response> = {}): Response => ({
  description,
  ...extra,
  content: json(ref('Error')),
});

export function buildOpenApiDocument(): OpenApiDocument {
  return {
    openapi: '3.1.0',
    info: {
      title: 'ImotSync API',
      version: APP_VERSION,
      description: [
        'Prepare a property once and publish it to several real estate portals through their official import feeds.',
        '',
        '**Authentication.** `POST /auth/login` returns a JWT. Send it as `Authorization: Bearer <token>` (in this page: **Authorize**). Every operation needs it except the health check, login and this document.',
        '',
        '**Errors** always look like `{"error":{"code","message","details"?}}`; `details` lists per-field problems for `VALIDATION_ERROR`.',
        '',
        '**Conventions.** JSON fields are camelCase, times are ISO 8601 in UTC, prices and areas are numbers.',
      ].join('\n'),
    },
    servers: [{ url: '/api', description: 'This server' }],
    tags: [
      { name: 'Auth', description: 'Login and the current user.' },
      { name: 'Properties', description: 'Properties and their per-portal status.' },
      { name: 'Photos', description: 'Property photos.' },
      { name: 'System', description: 'Health check and this document.' },
    ],
    security: [{ bearerAuth: [] }],
    paths: {
      '/health': {
        get: {
          operationId: 'getHealth',
          summary: 'Health check',
          description: 'Reports whether the API can reach its database.',
          tags: ['System'],
          security: [],
          responses: {
            '200': { description: 'API and database are up.', content: json(ref('Health')) },
            '503': {
              description: 'The database is down or too slow.',
              content: json(ref('Health')),
            },
            '500': response('InternalError'),
          },
        },
      },
      '/openapi.json': {
        get: {
          operationId: 'getOpenApiDocument',
          summary: 'This OpenAPI document',
          tags: ['System'],
          security: [],
          responses: {
            '200': {
              description: 'The OpenAPI 3.1 document.',
              content: json({
                type: 'object',
                required: ['openapi', 'info', 'paths'],
                properties: {
                  openapi: { type: 'string', const: '3.1.0' },
                  info: { type: 'object' },
                  paths: { type: 'object' },
                },
              }),
            },
            '500': response('InternalError'),
          },
        },
      },
      '/auth/login': {
        post: {
          operationId: 'login',
          summary: 'Log in',
          description:
            'Exchanges email and password for an access token. Limited to about 10 attempts per 15 minutes per client IP; the RateLimit headers report the state.',
          tags: ['Auth'],
          security: [],
          requestBody: jsonBody('LoginRequest'),
          responses: {
            '200': {
              description: 'Logged in.',
              headers: {
                RateLimit: header('RateLimit'),
                'RateLimit-Policy': header('RateLimitPolicy'),
              },
              content: json(ref('LoginResponse')),
            },
            '400': response('BadRequest'),
            '401': response('InvalidCredentials'),
            '413': response('PayloadTooLarge'),
            '415': response('UnsupportedMediaType'),
            '429': response('TooManyRequests'),
            '500': response('InternalError'),
          },
        },
      },
      '/auth/me': {
        get: {
          operationId: 'getCurrentUser',
          summary: 'Current user',
          description: 'The user the token belongs to.',
          tags: ['Auth'],
          responses: {
            '200': { description: 'The signed-in user.', content: json(ref('CurrentUser')) },
            ...AUTHENTICATED,
          },
        },
      },
      '/properties': { get: properties.list, post: properties.create },
      '/properties/{id}': {
        get: properties.get,
        patch: properties.update,
        delete: properties.delete,
      },
      '/properties/{id}/images': { post: photos.upload },
      '/properties/{id}/images/order': { put: photos.reorder },
      '/properties/{id}/images/{imageId}': { delete: photos.delete },
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'The accessToken from POST /auth/login.',
        },
      },
      schemas,
      parameters: {
        PropertyId: {
          name: 'id',
          in: 'path',
          required: true,
          description: 'Property id.',
          schema: { type: 'integer', minimum: 1 },
        },
        ImageId: {
          name: 'imageId',
          in: 'path',
          required: true,
          description: 'Photo id (of this property).',
          schema: { type: 'integer', minimum: 1 },
        },
      },
      headers: {
        Location: {
          description: 'URL of the new property.',
          schema: { type: 'string', examples: ['/api/properties/42'] },
        },
        WWWAuthenticate: {
          description: 'Bearer challenge (RFC 6750).',
          schema: { type: 'string', examples: ['Bearer realm="imotsync", error="invalid_token"'] },
        },
        RateLimit: {
          description: 'Requests left in the current window (IETF RateLimit header, draft 8).',
          schema: { type: 'string', examples: ['"login";r=9;t=900'] },
        },
        RateLimitPolicy: {
          description: 'The limit and window (IETF RateLimit-Policy header, draft 8).',
          schema: { type: 'string', examples: ['"login";q=10;w=900'] },
        },
        RetryAfter: {
          description: 'Seconds until another attempt is allowed.',
          schema: { type: 'integer', minimum: 0 },
        },
      },
      responses: {
        BadRequest: errorResponse(
          'VALIDATION_ERROR: invalid path, query or body; `details` names each field (`path` for a malformed URL, `body` for a malformed body). INVALID_JSON: the body is not valid JSON.',
        ),
        Unauthorized: errorResponse('UNAUTHORIZED: the token is missing, invalid or expired.', {
          headers: { 'WWW-Authenticate': header('WWWAuthenticate') },
        }),
        InvalidCredentials: errorResponse(
          'INVALID_CREDENTIALS: unknown email or wrong password (the same answer for both).',
          { headers: { 'WWW-Authenticate': header('WWWAuthenticate') } },
        ),
        Forbidden: errorResponse('FORBIDDEN: the signed-in user lacks the required role.'),
        NotFound: errorResponse('NOT_FOUND: no such property or photo.'),
        UploadTimedOut: errorResponse(
          `REQUEST_TIMEOUT: the upload body did not arrive within ${DEFAULT_UPLOAD_BODY_TIMEOUT_MS / 1000} seconds; the connection is closed. On a slow connection, send fewer photos per request.`,
        ),
        Conflict: errorResponse(
          'CONFLICT: the request clashes with the current state (duplicate refCode, photo limit, property still on a portal).',
        ),
        PayloadTooLarge: errorResponse(
          `PAYLOAD_TOO_LARGE: JSON body over 1 MB, a photo over ${PHOTO_LIMITS.maxFileBytes / MB} MB, or an upload body over ${Math.floor(MAX_UPLOAD_BODY_BYTES / MB)} MB.`,
        ),
        UnsupportedMediaType: errorResponse(
          'UNSUPPORTED_MEDIA_TYPE: wrong Content-Type, a body encoding (Content-Encoding) or charset the API does not read, or a file that is not an accepted image.',
        ),
        TooManyRequests: errorResponse('TOO_MANY_REQUESTS: too many login attempts.', {
          headers: {
            'Retry-After': header('RetryAfter'),
            RateLimit: header('RateLimit'),
            'RateLimit-Policy': header('RateLimitPolicy'),
          },
        }),
        UploadsBusy: errorResponse(
          'TOO_MANY_REQUESTS: the server is busy with other photo uploads; try again after Retry-After seconds.',
          { headers: { 'Retry-After': header('RetryAfter') } },
        ),
        InternalError: errorResponse(
          'INTERNAL_ERROR: unexpected failure (no details in production).',
        ),
      },
    },
  };
}
