import { readFileSync } from 'node:fs';

interface PackageJson {
  version?: unknown;
}

// package.json sits one level above both src/ and dist/, and is copied into the Docker image.
const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as PackageJson;

/** The API version reported by GET /api/health (from api/package.json). */
export const APP_VERSION = typeof packageJson.version === 'string' ? packageJson.version : '0.0.0';
