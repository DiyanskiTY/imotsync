/*
 * The subset of OpenAPI 3.1 this API's document uses. Schemas are plain JSON Schema
 * (2020-12) objects.
 */

export type JsonSchema = Record<string, unknown>;

export interface Reference {
  $ref: string;
}

export const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export interface MediaType {
  schema: JsonSchema;
  encoding?: Record<string, { contentType?: string }>;
}

export interface Header {
  description: string;
  schema: JsonSchema;
  required?: boolean;
}

export interface Response {
  description: string;
  headers?: Record<string, Header | Reference>;
  content?: Record<string, MediaType>;
}

export interface Parameter {
  name: string;
  in: 'path' | 'query' | 'header';
  description: string;
  required?: boolean;
  style?: 'form' | 'simple';
  explode?: boolean;
  schema: JsonSchema;
}

export interface RequestBody {
  description?: string;
  required: boolean;
  content: Record<string, MediaType>;
}

export type SecurityRequirement = Record<string, string[]>;

export interface Operation {
  operationId: string;
  summary: string;
  description?: string;
  tags: string[];
  /** [] marks a public operation; omitted means the document-wide bearer requirement. */
  security?: SecurityRequirement[];
  parameters?: (Parameter | Reference)[];
  requestBody?: RequestBody;
  responses: Record<string, Response | Reference>;
}

export type PathItem = Partial<Record<HttpMethod, Operation>>;

export interface OpenApiDocument {
  openapi: '3.1.0';
  info: {
    title: string;
    version: string;
    description: string;
    license?: { name: string; identifier: string };
  };
  servers: { url: string; description: string }[];
  tags: { name: string; description: string }[];
  security: SecurityRequirement[];
  paths: Record<string, PathItem>;
  components: {
    securitySchemes: Record<string, Record<string, unknown>>;
    schemas: Record<string, JsonSchema>;
    parameters: Record<string, Parameter>;
    headers: Record<string, Header>;
    responses: Record<string, Response>;
  };
}
