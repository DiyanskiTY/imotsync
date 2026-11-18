/*
 * Writes the OpenAPI document to api/openapi.json (npm run openapi:export).
 *
 * The committed file is the contract the admin panel generates its types from
 * (web: npm run api:types); a unit test fails when it falls behind the code.
 */

import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { buildOpenApiDocument } from './document.js';
import type { OpenApiDocument } from './types.js';

export const OPENAPI_SNAPSHOT_PATH = fileURLToPath(new URL('../../openapi.json', import.meta.url));

export function serializeOpenApiDocument(document: OpenApiDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFile(OPENAPI_SNAPSHOT_PATH, serializeOpenApiDocument(buildOpenApiDocument()), 'utf8')
    .then(() => process.stdout.write(`Wrote ${OPENAPI_SNAPSHOT_PATH}\n`))
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
