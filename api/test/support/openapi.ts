import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { expect } from 'vitest';
import { buildOpenApiDocument } from '../../src/openapi/document.js';
import type { HttpMethod, Response } from '../../src/openapi/types.js';

/*
 * Checks real responses against the OpenAPI document: the status must be documented for
 * the operation, and the body must match the documented schema (response schemas forbid
 * undocumented properties, so a field added to the API but not to the document fails).
 */

export const openApiDocument = buildOpenApiDocument();

const DOCUMENT_ID = 'https://imotsync.test/openapi.json';

const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
addFormats.default(ajv);
// The whole document is registered as one schema, so "#/components/..." references resolve.
// Its top-level OpenAPI fields are declared as (inert) keywords; everything compiled from
// it is still checked in strict mode.
ajv.addVocabulary(['openapi', 'info', 'servers', 'tags', 'security', 'paths', 'components']);
ajv.addSchema({ ...openApiDocument, $id: DOCUMENT_ID });

const validators = new Map<string, ValidateFunction>();

/** JSON pointer segment, also safe inside a URI fragment ("/properties/{id}" -> "~1properties~1%7Bid%7D"). */
const segment = (value: string) =>
  encodeURIComponent(value.replace(/~/g, '~0').replace(/\//g, '~1')).replace(/%7E/g, '~');

function validatorFor(pointer: string): ValidateFunction {
  let validate = validators.get(pointer);
  if (!validate) {
    validate = ajv.compile({ $ref: `${DOCUMENT_ID}#${pointer}` });
    validators.set(pointer, validate);
  }
  return validate;
}

export interface CheckedResponse {
  status: number;
  body: unknown;
  text?: string;
  headers: Record<string, string | string[] | undefined>;
}

/** The documented response for an operation and status, with a JSON pointer to it. */
export function documentedResponse(
  method: HttpMethod,
  path: string,
  status: number,
): { response: Response; pointer: string } {
  const operation = openApiDocument.paths[path]?.[method];
  if (!operation) throw new Error(`${method.toUpperCase()} ${path} is not documented`);
  const documented = operation.responses[String(status)];
  if (!documented) {
    throw new Error(`${method.toUpperCase()} ${path} returned ${status}, which is not documented`);
  }
  if ('$ref' in documented) {
    const name = documented.$ref.split('/').at(-1) ?? '';
    const response = openApiDocument.components.responses[name];
    if (!response) throw new Error(`Unknown response ${documented.$ref}`);
    return { response, pointer: `/components/responses/${segment(name)}` };
  }
  return {
    response: documented,
    pointer: `/paths/${segment(path)}/${method}/responses/${status}`,
  };
}

function schemaValidator(schemaName: string): ValidateFunction {
  if (!(schemaName in openApiDocument.components.schemas)) {
    throw new Error(`Unknown schema ${schemaName}`);
  }
  return validatorFor(`/components/schemas/${segment(schemaName)}`);
}

/** Whether the value matches the named schema in components.schemas. */
export function matchesSchema(value: unknown, schemaName: string): boolean {
  return schemaValidator(schemaName)(value);
}

/** Fails the test unless the value matches the named schema in components.schemas. */
export function expectSchema(value: unknown, schemaName: string): void {
  const validate = schemaValidator(schemaName);
  const valid = validate(value);
  expect(valid ? [] : validate.errors, `value does not match ${schemaName}`).toEqual([]);
}

/**
 * The URL path an operation is served at: the path's own server (the feeds live outside
 * /api) or the document's server, followed by the documented path.
 */
export function servedPath(path: string): string {
  const server = openApiDocument.paths[path]?.servers?.[0] ?? openApiDocument.servers[0];
  return `${(server?.url ?? '').replace(/\/+$/, '')}${path}`;
}

/** Fails the test unless the response is documented for the operation and matches it. */
export function expectDocumented(res: CheckedResponse, method: HttpMethod, path: string): void {
  const { response, pointer } = documentedResponse(method, path, res.status);
  const label = `${method.toUpperCase()} ${path} ${res.status}`;
  const mediaTypes = Object.keys(response.content ?? {});
  if (mediaTypes.length === 0) {
    expect(res.text ?? '', `${label} has no body`).toBe('');
    return;
  }
  const contentType = String(res.headers['content-type'] ?? '');
  const mediaType = mediaTypes.find((type) => contentType.startsWith(type));
  if (mediaType === undefined) {
    throw new Error(`${label}: Content-Type "${contentType}" is not documented`);
  }
  if (mediaType !== 'application/json') {
    // Text bodies (XML, plain text) are checked as the string they are.
    const validateText = validatorFor(`${pointer}/content/${segment(mediaType)}/schema`);
    const validText = validateText(res.text ?? '');
    expect(validText ? [] : validateText.errors, `${label} body does not match`).toEqual([]);
    return;
  }
  const validate = validatorFor(`${pointer}/content/${segment('application/json')}/schema`);
  const valid = validate(res.body);
  expect(
    valid ? [] : validate.errors,
    `${method.toUpperCase()} ${path} ${res.status} body does not match the document`,
  ).toEqual([]);
}
