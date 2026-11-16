import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildGeoSubset,
  DEFAULT_GEO_CSV_PATH,
  parseGeoCsv,
  REALISTIMO_GEO_CSV_URL,
  type GeoRow,
} from './geo.js';

/*
 * Downloads Realistimo's public geo list (realistimo_geo_db.csv, linked from the XML import
 * documentation) to api/data/realistimo_geo_db.csv, where the geo resolver picks it up
 * instead of the committed subset. The file is git-ignored; the geo list changes over time,
 * so re-run this now and then.
 *
 *   npm run geo:realistimo                      download the full CSV
 *   npm run geo:realistimo -- --subset          ... and regenerate geo-subset.json
 *   npm run geo:realistimo -- --from <csv>      use a local copy instead
 *   npm run geo:realistimo -- --out <file>      save the CSV elsewhere
 * (the script is tsx src/portals/realistimo/download-geo.ts, run from api/)
 *
 * After --subset, run `npm run format` so the JSON matches the Prettier style.
 */

export const GEO_SUBSET_PATH = fileURLToPath(new URL('./geo-subset.json', import.meta.url));

export interface DownloadGeoCsvOptions {
  url?: string;
  /** Where to save the CSV. Default DEFAULT_GEO_CSV_PATH. */
  outFile?: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

export interface DownloadGeoCsvResult {
  outFile: string;
  rows: GeoRow[];
  /** The Last-Modified header of the download (ISO 8601), when the server sent one. */
  lastModified: string | null;
}

function isoDate(header: string | null): string | null {
  if (header === null) return null;
  const date = new Date(header);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Downloads the CSV, checks that it parses with the known layout, and only then replaces
 * the file (written to a temporary name and renamed), so a failed download never leaves a
 * broken CSV behind.
 */
export async function downloadGeoCsv(
  options: DownloadGeoCsvOptions = {},
): Promise<DownloadGeoCsvResult> {
  const url = options.url ?? REALISTIMO_GEO_CSV_URL;
  const outFile = path.resolve(options.outFile ?? DEFAULT_GEO_CSV_PATH);
  const doFetch = options.fetch ?? globalThis.fetch;
  const response = await doFetch(url, {
    headers: { Accept: 'text/csv' },
    signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
  });
  if (!response.ok) {
    throw new Error(`Downloading ${url} failed: HTTP ${response.status}`);
  }
  const text = await response.text();
  const rows = parseGeoCsv(text);

  await mkdir(path.dirname(outFile), { recursive: true });
  const temporary = `${outFile}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, text, 'utf8');
    await rename(temporary, outFile);
  } finally {
    await rm(temporary, { force: true });
  }
  return { outFile, rows, lastModified: isoDate(response.headers.get('last-modified')) };
}

interface CliArgs {
  from: string | null;
  out: string | null;
  subset: boolean;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = { from: null, out: null, subset: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--subset') args.subset = true;
    else if (arg === '--from' || arg === '--out') {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} needs a file path`);
      args[arg === '--from' ? 'from' : 'out'] = value;
      i += 1;
    } else {
      throw new Error(`Unknown argument: ${String(arg)}`);
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  let rows: GeoRow[];
  let lastModified: string | null = null;
  if (args.from === null) {
    const result = await downloadGeoCsv({ outFile: args.out ?? undefined });
    rows = result.rows;
    lastModified = result.lastModified;
    process.stdout.write(`Saved ${rows.length} geo rows to ${result.outFile}\n`);
  } else {
    rows = parseGeoCsv(await readFile(args.from, 'utf8'));
    process.stdout.write(`Read ${rows.length} geo rows from ${args.from}\n`);
  }
  if (args.subset) {
    const subset = buildGeoSubset(rows, {
      source: REALISTIMO_GEO_CSV_URL,
      downloadedAt: new Date().toISOString(),
      sourceLastModified: lastModified,
    });
    await writeFile(GEO_SUBSET_PATH, `${JSON.stringify(subset, null, 2)}\n`, 'utf8');
    process.stdout.write(`Wrote ${subset.rows.length} rows to ${GEO_SUBSET_PATH}\n`);
  }
}

/** True when this file is the entry point (tsx or node), not when a test imports it. */
function isEntryPoint(): boolean {
  const invoked = process.argv[1];
  if (invoked === undefined) return false;
  const self = fileURLToPath(import.meta.url);
  const resolved = path.resolve(invoked);
  // Windows paths are case-insensitive (drive letters especially).
  return process.platform === 'win32'
    ? resolved.toLowerCase() === self.toLowerCase()
    : resolved === self;
}

if (isEntryPoint()) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
