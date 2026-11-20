import {
  DEAL_TYPES,
  JOB_ACTIONS,
  JOB_STATUSES,
  PORTAL_LISTING_STATUSES,
  PORTALS,
  PROPERTY_STATUSES,
  PROPERTY_TYPES,
} from '../db/types.js';
import {
  DEFAULT_JOB_PAGE_SIZE,
  DEFAULT_JOB_SORT,
  JOB_LIST_LIMITS,
  JOB_SORT_VALUES,
} from '../modules/jobs/jobs.validators.js';
import { FEEDS_PATH } from '../modules/feeds/feeds.router.js';
import { BULK_MAX_PROPERTIES } from '../modules/publishing/publishing.validators.js';
import {
  ACCEPTED_FORMATS_TEXT,
  DEFAULT_UPLOAD_LIMITS,
  PHOTO_LIMITS,
} from '../modules/images/image-processing.js';
import {
  DEMO_MAX_PROPERTIES,
  DEMO_RATE_LIMIT_DEFAULTS,
} from '../modules/demo/deployment-profile.js';
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
      'Deletes the property with its photos, portal listings and jobs (the photo files are deleted later by the worker, once no stored feed entry links to them). Refused with 409 while a portal listing is pending, published, or in error but still online: unpublish it first (POST /properties/{id}/unpublish), or use POST /properties/bulk/delete, which removes it from the portals and deletes it afterwards. When nothing is online but a feed still serves the removal of one of its listings (a Bazar.bg item kept as out of stock for BAZAR_REMOVED_RETENTION_DAYS), the property is archived instead and answered with 202: the worker deletes it once that period has passed (setting its status back to active cancels this).',
    tags: ['Properties'],
    parameters: [parameter('PropertyId')],
    responses: {
      '202': {
        description:
          'Archived; the worker deletes it once its removal has been served long enough.',
        content: json(ref('DeletionScheduledResponse')),
      },
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
      `Send 1 to ${DEFAULT_UPLOAD_LIMITS.maxFilesPerRequest} files in the multipart field "${PHOTO_FIELD}", each at most ${DEFAULT_UPLOAD_LIMITS.maxFileBytes / MB} MB;`,
      `any other field, text fields included, gets 400 naming it.`,
      `The content decides, not the file name or declared type: ${ACCEPTED_FORMATS_TEXT} images are accepted (415 otherwise),`,
      `with at least ${PHOTO_LIMITS.minShortSide} px on the shorter side and at most ${PHOTO_LIMITS.maxInputPixels / 1_000_000} megapixels (400 otherwise).`,
      `Every photo is turned upright, stripped of all metadata (including GPS), fitted inside ${PHOTO_LIMITS.maxStoredSide}x${PHOTO_LIMITS.maxStoredSide} px and stored as JPEG;`,
      `the stored photo keeps at least ${PHOTO_LIMITS.minShortSide} px on its shorter side too, so very long, narrow images are refused (400).`,
      `New photos go after the existing ones. A property has at most ${DEFAULT_UPLOAD_LIMITS.maxPerProperty} photos (409 otherwise).`,
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
                maxItems: DEFAULT_UPLOAD_LIMITS.maxFilesPerRequest,
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
      '204': {
        description:
          "Deleted. The row goes at once; the worker's photo sweep deletes the file once nothing refers to it.",
      },
      '400': response('BadRequest'),
      '404': response('NotFound'),
      ...AUTHENTICATED,
    },
  },
};

const portalsQuery: Parameter = {
  name: 'portals',
  in: 'query',
  description: 'Portal keys (GET /portals), comma-separated. Default: every registered portal.',
  style: 'form',
  explode: false,
  schema: { type: 'array', items: { type: 'string' }, minItems: 1, uniqueItems: true },
};

const publishing: Record<string, Operation> = {
  portals: {
    operationId: 'listPortals',
    summary: 'List portals',
    description:
      'The portals this server publishes to, in display order. Feed portals come with the feed URL to give the portal.',
    tags: ['Publishing'],
    responses: {
      '200': { description: 'The registered portals.', content: json(ref('PortalList')) },
      ...AUTHENTICATED,
    },
  },
  checks: {
    operationId: 'checkProperty',
    summary: 'Pre-publish check',
    description:
      "Runs each portal's rules against the property's current data and lists what would keep it from that portal. Changes nothing and sends nothing.",
    tags: ['Publishing'],
    parameters: [parameter('PropertyId'), portalsQuery],
    responses: {
      '200': { description: 'One check per portal.', content: json(ref('PortalCheckList')) },
      '400': response('BadRequest'),
      '404': response('NotFound'),
      ...AUTHENTICATED,
    },
  },
  publish: {
    operationId: 'publishProperty',
    summary: 'Publish to portals',
    description: [
      "Runs every selected portal's pre-publish check first: any problem answers 422 NOT_READY with the problems in details, and nothing is queued.",
      'Otherwise a draft property becomes active, and each portal gets a job that the worker carries out:',
      'a publish job for a new, draft, removed or never-published listing; an update job for a listing that is already online;',
      'a request for a listing that has a queued job is merged into that job (jobs always send the current data).',
      'An archived property answers 409.',
    ].join(' '),
    tags: ['Publishing'],
    parameters: [parameter('PropertyId')],
    requestBody: jsonBody('PublishRequest'),
    responses: {
      '202': {
        description: 'Queued. The listings are pending until the worker has run the jobs.',
        content: json(ref('PublishResponse')),
      },
      '400': response('BadRequest'),
      '404': response('NotFound'),
      '409': response('Conflict'),
      '413': response('PayloadTooLarge'),
      '415': response('UnsupportedMediaType'),
      '422': response('NotReady'),
      ...AUTHENTICATED,
    },
  },
  unpublish: {
    operationId: 'unpublishProperty',
    summary: 'Remove from portals',
    description:
      'Queues remove jobs for the listings on the given portals (default: all of them) that are online, pending or in error. Draft listings, which never went out, are deleted; removed ones stay as they are.',
    tags: ['Publishing'],
    parameters: [parameter('PropertyId')],
    requestBody: {
      required: false,
      content: json(ref('UnpublishRequest')),
    },
    responses: {
      '202': { description: 'Queued.', content: json(ref('PublishResponse')) },
      '400': response('BadRequest'),
      '404': response('NotFound'),
      '413': response('PayloadTooLarge'),
      '415': response('UnsupportedMediaType'),
      ...AUTHENTICATED,
    },
  },
  bulkPublish: {
    operationId: 'bulkPublishProperties',
    summary: 'Publish several properties',
    description: `Publishes up to ${BULK_MAX_PROPERTIES} properties to the same portals, each as POST /properties/{id}/publish would. A property that is not ready, archived or missing is reported with ok: false and skipped; the others are queued.`,
    tags: ['Publishing'],
    requestBody: jsonBody('BulkPublishRequest'),
    responses: {
      '200': {
        description: 'One result per property, in the order given.',
        content: json(ref('BulkPublishResponse')),
      },
      '400': response('BadRequest'),
      '413': response('PayloadTooLarge'),
      '415': response('UnsupportedMediaType'),
      ...AUTHENTICATED,
    },
  },
  bulkDelete: {
    operationId: 'bulkDeleteProperties',
    summary: 'Delete several properties',
    description: `Deletes up to ${BULK_MAX_PROPERTIES} properties, one at a time. One that is not online anywhere is deleted at once, with its photos (the files are deleted later by the worker). One that is (or may be) online on a portal is archived and gets remove jobs; the worker deletes it once every portal has removed it. One whose removal a feed still serves (a Bazar.bg item kept as out of stock) is archived; the worker deletes it once that period has passed. An unexpected error is reported for its property (result error) and the others go ahead.`,
    tags: ['Publishing'],
    requestBody: jsonBody('BulkDeleteRequest'),
    responses: {
      '200': {
        description: 'One result per property, in the order given.',
        content: json(ref('BulkDeleteResponse')),
      },
      '400': response('BadRequest'),
      '413': response('PayloadTooLarge'),
      '415': response('UnsupportedMediaType'),
      ...AUTHENTICATED,
    },
  },
};

const listJobsParameters: Parameter[] = [
  {
    name: 'page',
    in: 'query',
    description: 'Page number, from 1.',
    schema: { type: 'integer', minimum: 1, maximum: JOB_LIST_LIMITS.pageMax, default: 1 },
  },
  {
    name: 'pageSize',
    in: 'query',
    description: 'Jobs per page.',
    schema: {
      type: 'integer',
      minimum: 1,
      maximum: JOB_LIST_LIMITS.pageSizeMax,
      default: DEFAULT_JOB_PAGE_SIZE,
    },
  },
  listParam('status', JOB_STATUSES, 'Job status.'),
  listParam('action', JOB_ACTIONS, 'Job action.'),
  {
    name: 'portal',
    in: 'query',
    description: 'Portal keys, comma-separated.',
    style: 'form',
    explode: false,
    schema: { type: 'array', items: { type: 'string' }, uniqueItems: true },
  },
  {
    name: 'propertyId',
    in: 'query',
    description: "Only this property's jobs.",
    schema: { type: 'integer', minimum: 1 },
  },
  {
    name: 'sort',
    in: 'query',
    description:
      'Sort field; a leading "-" sorts descending. Ties are broken by id in the same direction.',
    schema: { type: 'string', enum: [...JOB_SORT_VALUES], default: DEFAULT_JOB_SORT },
  },
];

const jobs: Record<string, Operation> = {
  list: {
    operationId: 'listJobs',
    summary: 'Job log',
    description:
      'Every publish, update and remove job with its attempts, schedule and outcome, newest first by default. Unknown query parameters are rejected with 400.',
    tags: ['Jobs'],
    parameters: listJobsParameters,
    responses: {
      '200': { description: 'One page of jobs.', content: json(ref('JobList')) },
      '400': response('BadRequest'),
      ...AUTHENTICATED,
    },
  },
  get: {
    operationId: 'getJob',
    summary: 'Get a job',
    tags: ['Jobs'],
    parameters: [parameter('JobId')],
    responses: {
      '200': { description: 'The job.', content: json(ref('JobResponse')) },
      '400': response('BadRequest'),
      '404': response('NotFound'),
      ...AUTHENTICATED,
    },
  },
  retry: {
    operationId: 'retryJob',
    summary: 'Retry a failed job',
    description:
      "Queues a new job with the same action for the same listing; the failed job stays in the log. Only for the listing's newest job, when it failed and nothing else is queued or running for the listing (409 otherwise). Takes no body.",
    tags: ['Jobs'],
    parameters: [parameter('JobId')],
    responses: {
      '202': { description: 'The new job.', content: json(ref('JobResponse')) },
      '400': response('BadRequest'),
      '404': response('NotFound'),
      '409': response('Conflict'),
      '413': response('PayloadTooLarge'),
      '415': response('UnsupportedMediaType'),
      ...AUTHENTICATED,
    },
  },
};

const feedNotFound: Response = {
  description:
    'Unknown portal, a push portal (it has no feed), a wrong token, or any other path under /feeds: always the same plain-text answer.',
  content: { 'text/plain': { schema: { type: 'string', const: 'Not Found' } } },
};

const feed: Operation = {
  operationId: 'getFeed',
  summary: "A feed portal's feed",
  description: [
    'The import feed a feed portal downloads, built from the payloads the last successful jobs stored (GET /portals gives each feed URL).',
    'Public because portals send no credentials: the FEED_TOKEN in the path protects it, so keep the URL secret.',
    'Realistimo: its XML feed format, with the published offers. Bazar.bg: Google Merchant RSS 2.0, with the published listings in stock and removed ones out of stock for BAZAR_REMOVED_RETENTION_DAYS.',
    'Conditional requests with If-None-Match or If-Modified-Since get 304 when nothing changed.',
  ].join(' '),
  tags: ['Feeds'],
  security: [],
  parameters: [
    {
      name: 'portal',
      in: 'path',
      required: true,
      description: 'Key of a feed portal.',
      schema: { type: 'string', examples: ['realistimo', 'bazar'] },
    },
    {
      name: 'token',
      in: 'path',
      required: true,
      description: 'FEED_TOKEN.',
      schema: { type: 'string' },
    },
    {
      name: 'If-None-Match',
      in: 'header',
      description: 'ETag of a copy the client holds.',
      schema: { type: 'string' },
    },
    {
      name: 'If-Modified-Since',
      in: 'header',
      description: 'Last-Modified of a copy the client holds (ignored with If-None-Match).',
      schema: { type: 'string' },
    },
  ],
  responses: {
    '200': {
      description: 'The feed document (XML, UTF-8).',
      headers: {
        ETag: header('ETag'),
        'Last-Modified': header('LastModified'),
        'Cache-Control': header('CacheControlNoCache'),
      },
      content: { 'application/xml': { schema: { type: 'string' } } },
    },
    '304': {
      description: 'Not modified: the copy named by If-None-Match or If-Modified-Since is current.',
      headers: {
        ETag: header('ETag'),
        'Last-Modified': header('LastModified'),
        'Cache-Control': header('CacheControlNoCache'),
      },
    },
    '404': feedNotFound,
    '500': response('InternalError'),
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
        '**Authentication.** `POST /auth/login` returns a JWT. Send it as `Authorization: Bearer <token>` (in this page: **Authorize**). Every operation needs it except the health check, login, the demo sign-in, the client configuration, this document and the feeds (`/feeds/{portal}/{token}.xml`, outside `/api`, protected by the token in the path).',
        '',
        '**Errors** always look like `{"error":{"code","message","details"?}}`; `details` lists per-field problems for `VALIDATION_ERROR`.',
        '',
        '**Conventions.** JSON fields are camelCase, times are ISO 8601 in UTC, prices and areas are numbers.',
        '',
        `**Public demo.** When \`GET /client-config\` reports \`demoMode\`, the data is made up and reset every night, the feeds are closed, photo uploads have lower limits (\`uploadLimits\`), at most ${DEMO_MAX_PROPERTIES} properties can exist (${DEMO_RATE_LIMIT_DEFAULTS.createsPerHour} new ones per hour per address), and every operation may answer \`429 TOO_MANY_REQUESTS\` when one address sends too many requests.`,
      ].join('\n'),
    },
    servers: [{ url: '/api', description: 'This server' }],
    tags: [
      { name: 'Auth', description: 'Login and the current user.' },
      { name: 'Properties', description: 'Properties and their per-portal status.' },
      { name: 'Photos', description: 'Property photos.' },
      {
        name: 'Publishing',
        description:
          'Portals, the pre-publish check, publishing and removal. Requests queue jobs; the worker carries them out.',
      },
      { name: 'Jobs', description: 'The job log: every portal operation and its attempts.' },
      {
        name: 'Feeds',
        description:
          'The feeds feed portals download, outside /api and without a login (FEED_TOKEN in the path).',
      },
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
      '/client-config': {
        get: {
          operationId: 'getClientConfig',
          summary: 'Client configuration',
          description:
            'What the admin panel adapts to before anyone signs in: whether this is the public demo, and the photo upload limits.',
          tags: ['System'],
          security: [],
          responses: {
            '200': { description: 'The configuration.', content: json(ref('ClientConfig')) },
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
      '/auth/demo': {
        post: {
          operationId: 'demoLogin',
          summary: 'Try the demo',
          description: `Public demo only (GET /client-config says demoMode): signs in the shared demo account without a password. Limited to about ${DEMO_RATE_LIMIT_DEFAULTS.logins} sign-ins per ${DEMO_RATE_LIMIT_DEFAULTS.windowMs / 60_000} minutes per client IP. Answers 404 on any other deployment.`,
          tags: ['Auth'],
          security: [],
          responses: {
            '200': {
              description: 'Signed in as the demo account.',
              content: json(ref('LoginResponse')),
            },
            '404': errorResponse('NOT_FOUND: this deployment is not the public demo.'),
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
      '/portals': { get: publishing.portals },
      '/properties/{id}/checks': { get: publishing.checks },
      '/properties/{id}/publish': { post: publishing.publish },
      '/properties/{id}/unpublish': { post: publishing.unpublish },
      '/properties/bulk/publish': { post: publishing.bulkPublish },
      '/properties/bulk/delete': { post: publishing.bulkDelete },
      '/jobs': { get: jobs.list },
      '/jobs/{id}': { get: jobs.get },
      '/jobs/{id}/retry': { post: jobs.retry },
      [`${FEEDS_PATH}/{portal}/{token}.xml`]: {
        servers: [{ url: '/', description: 'This server (the feeds are outside /api)' }],
        get: feed,
      },
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
        JobId: {
          name: 'id',
          in: 'path',
          required: true,
          description: 'Job id.',
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
        ETag: {
          description: 'Strong validator of the document (a hash of its content).',
          schema: { type: 'string', examples: ['"q1w2e3r4t5y6u7i8o9p0a1s2d3f4g5h6j7k8l9z0x1c"'] },
        },
        LastModified: {
          description:
            'When the document last changed (a job stored a new payload, a listing left the feed).',
          schema: { type: 'string', examples: ['Mon, 16 Nov 2026 08:30:00 GMT'] },
        },
        CacheControlNoCache: {
          description: 'no-cache: a copy may be kept, but must be revalidated before use.',
          schema: { type: 'string', const: 'no-cache' },
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
        NotFound: errorResponse('NOT_FOUND: no such property, photo or job.'),
        UploadTimedOut: errorResponse(
          `REQUEST_TIMEOUT: the upload body did not arrive within ${DEFAULT_UPLOAD_BODY_TIMEOUT_MS / 1000} seconds; the connection is closed. On a slow connection, send fewer photos per request.`,
        ),
        Conflict: errorResponse(
          'CONFLICT: the request clashes with the current state (duplicate refCode, photo limit, property still on a portal, archived property, a job that cannot be retried).',
        ),
        PayloadTooLarge: errorResponse(
          `PAYLOAD_TOO_LARGE: JSON body over 1 MB, a photo over ${DEFAULT_UPLOAD_LIMITS.maxFileBytes / MB} MB, or an upload body over ${Math.floor(MAX_UPLOAD_BODY_BYTES / MB)} MB.`,
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
        NotReady: errorResponse(
          "NOT_READY: the property breaks a selected portal's rules; details lists each problem with its portal and field. Nothing was queued.",
        ),
        InternalError: errorResponse(
          'INTERNAL_ERROR: unexpected failure (no details in production).',
        ),
      },
    },
  };
}
