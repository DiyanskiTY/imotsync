import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { buildOpenApiDocument } from '../../src/openapi/document.js';
import { OPENAPI_SNAPSHOT_PATH, serializeOpenApiDocument } from '../../src/openapi/export.js';

/*
 * api/openapi.json is the committed copy of the contract. The admin panel generates its
 * TypeScript types from it (web: npm run api:types), so it must never fall behind the code.
 */
describe('committed OpenAPI snapshot', () => {
  it('matches the document the API serves (run npm run openapi:export after API changes)', async () => {
    const committed = await readFile(OPENAPI_SNAPSHOT_PATH, 'utf8');
    expect(committed).toBe(serializeOpenApiDocument(buildOpenApiDocument()));
  });
});
