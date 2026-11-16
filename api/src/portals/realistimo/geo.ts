import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { API_ROOT } from '../../config.js';
import geoSubsetJson from './geo-subset.json' with { type: 'json' };
import { placeKeys, type PlaceKeys } from './transliterate.js';

/*
 * Realistimo identifies a location by the internal_id of a row in its geo list
 * (realistimo_geo_db.csv, linked from the XML import documentation): a city, a village or a
 * neighbourhood. Use the internal_id column, never the row id. A missing or wrong id makes
 * Realistimo look for the place in the description, and the offer stays unpublished if
 * none is found, so ImotSync resolves every location before it publishes.
 *
 * The repository carries a subset (geo-subset.json: every city plus the neighbourhoods of
 * Sofia, Plovdiv, Varna, Burgas and Bansko). The full CSV is used instead when it has been
 * downloaded to api/data/realistimo_geo_db.csv (see download-geo.ts).
 */

export const REALISTIMO_GEO_CSV_URL =
  'https://static.realistimo.com/build/media/blog-assets/integration-files/geo-db/realistimo_geo_db.csv';

/** Where the downloaded full CSV is looked for (git-ignored). */
export const DEFAULT_GEO_CSV_PATH = path.join(API_ROOT, 'data', 'realistimo_geo_db.csv');

export const GEO_CSV_COLUMNS = [
  'id',
  'internal_id',
  'state_name',
  'city_name',
  'village_name',
  'neighborhood_name',
  'location_type',
] as const;

export const LOCATION_TYPES = ['state', 'city', 'village', 'neighborhood'] as const;
export type LocationType = (typeof LOCATION_TYPES)[number];

/** Cities whose neighbourhoods the committed subset contains. */
export const SUBSET_CITIES = ['София', 'Пловдив', 'Варна', 'Бургас', 'Банско'] as const;

/** One row of Realistimo's geo list. Names are Bulgarian (Cyrillic); null where the CSV has NULL. */
export interface GeoRow {
  internalId: number;
  locationType: LocationType;
  stateName: string | null;
  cityName: string | null;
  villageName: string | null;
  neighborhoodName: string | null;
}

export class GeoDataError extends Error {
  override readonly name = 'GeoDataError';
}

function isLocationType(value: unknown): value is LocationType {
  return typeof value === 'string' && (LOCATION_TYPES as readonly string[]).includes(value);
}

/**
 * Splits one CSV line: double-quoted text (with "" for a quote inside), unquoted numbers,
 * and an unquoted NULL for a missing value.
 */
function parseCsvLine(line: string, lineNumber: number): (string | null)[] {
  const values: (string | null)[] = [];
  let i = 0;
  for (;;) {
    if (line[i] === '"') {
      let value = '';
      let j = i + 1;
      for (;;) {
        if (j >= line.length) throw new GeoDataError(`Line ${lineNumber}: unterminated quote`);
        if (line[j] === '"') {
          if (line[j + 1] === '"') {
            value += '"';
            j += 2;
            continue;
          }
          break;
        }
        value += line[j];
        j += 1;
      }
      values.push(value);
      i = j + 1;
    } else {
      const end = line.indexOf(',', i);
      const raw = (end === -1 ? line.slice(i) : line.slice(i, end)).trim();
      values.push(raw === 'NULL' ? null : raw);
      i = end === -1 ? line.length : end;
    }
    if (i >= line.length) return values;
    if (line[i] !== ',') throw new GeoDataError(`Line ${lineNumber}: expected a comma`);
    i += 1;
  }
}

/** Parses realistimo_geo_db.csv. Throws GeoDataError when the file does not have its known layout. */
export function parseGeoCsv(text: string): GeoRow[] {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const header = parseCsvLine(lines[0] ?? '', 1);
  if (header.join(',') !== GEO_CSV_COLUMNS.join(',')) {
    throw new GeoDataError(
      `Unexpected geo CSV header: ${JSON.stringify(header)}; expected ${JSON.stringify(GEO_CSV_COLUMNS)}`,
    );
  }
  const rows: GeoRow[] = [];
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (line.trim() === '') continue;
    const lineNumber = index + 1;
    const values = parseCsvLine(line, lineNumber);
    if (values.length !== GEO_CSV_COLUMNS.length) {
      throw new GeoDataError(`Line ${lineNumber}: expected ${GEO_CSV_COLUMNS.length} columns`);
    }
    const [, internalId, stateName, cityName, villageName, neighborhoodName, locationType] = values;
    const id = Number(internalId);
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new GeoDataError(`Line ${lineNumber}: invalid internal_id ${String(internalId)}`);
    }
    if (!isLocationType(locationType)) {
      throw new GeoDataError(`Line ${lineNumber}: invalid location_type ${String(locationType)}`);
    }
    rows.push({
      internalId: id,
      locationType,
      stateName: stateName ?? null,
      cityName: cityName ?? null,
      villageName: villageName ?? null,
      neighborhoodName: neighborhoodName ?? null,
    });
  }
  if (rows.length === 0) throw new GeoDataError('The geo CSV has no rows');
  return rows;
}

/* ---------- The committed subset ---------- */

export interface GeoSubsetFile {
  source: string;
  downloadedAt: string;
  sourceLastModified: string | null;
  description: string;
  rows: GeoSubsetRow[];
}

/** A subset row uses the CSV's column names; columns that are NULL in the CSV are left out. */
export interface GeoSubsetRow {
  internal_id: number;
  location_type: LocationType;
  state_name?: string;
  city_name?: string;
  village_name?: string;
  neighborhood_name?: string;
}

function optionalName(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Validates the subset file's content and turns it into rows. */
export function rowsFromSubset(data: unknown): GeoRow[] {
  const rows = (data as { rows?: unknown } | null)?.rows;
  if (!Array.isArray(rows)) throw new GeoDataError('The geo subset has no rows array');
  return rows.map((item: unknown, index): GeoRow => {
    const record = (item ?? {}) as Record<string, unknown>;
    const internalId = record.internal_id;
    const locationType = record.location_type;
    if (typeof internalId !== 'number' || !Number.isSafeInteger(internalId)) {
      throw new GeoDataError(`Geo subset row ${index}: invalid internal_id`);
    }
    if (!isLocationType(locationType)) {
      throw new GeoDataError(`Geo subset row ${index}: invalid location_type`);
    }
    return {
      internalId,
      locationType,
      stateName: optionalName(record, 'state_name'),
      cityName: optionalName(record, 'city_name'),
      villageName: optionalName(record, 'village_name'),
      neighborhoodName: optionalName(record, 'neighborhood_name'),
    };
  });
}

/** The rows of the committed subset (geo-subset.json). */
export function loadGeoSubset(): GeoRow[] {
  return rowsFromSubset(geoSubsetJson);
}

/** Header fields of the committed subset: where and when its data came from. */
export function geoSubsetInfo(): Omit<GeoSubsetFile, 'rows'> {
  const data = geoSubsetJson as unknown as GeoSubsetFile;
  return {
    source: data.source,
    downloadedAt: data.downloadedAt,
    sourceLastModified: data.sourceLastModified,
    description: data.description,
  };
}

/**
 * Builds the content of geo-subset.json from the full CSV's rows: every city row, plus the
 * neighbourhood rows of SUBSET_CITIES, in the CSV's order.
 */
export function buildGeoSubset(
  rows: readonly GeoRow[],
  meta: { source: string; downloadedAt: string; sourceLastModified: string | null },
): GeoSubsetFile {
  const cities = rows.filter((row) => row.locationType === 'city');
  const subsetCities = new Set(
    cities
      .filter((row) => (SUBSET_CITIES as readonly (string | null)[]).includes(row.cityName))
      .map((row) => `${row.stateName ?? ''}|${row.cityName ?? ''}`),
  );
  const neighborhoods = rows.filter(
    (row) =>
      row.locationType === 'neighborhood' &&
      subsetCities.has(`${row.stateName ?? ''}|${row.cityName ?? ''}`),
  );
  const toSubsetRow = (row: GeoRow): GeoSubsetRow => ({
    internal_id: row.internalId,
    location_type: row.locationType,
    ...(row.stateName === null ? {} : { state_name: row.stateName }),
    ...(row.cityName === null ? {} : { city_name: row.cityName }),
    ...(row.villageName === null ? {} : { village_name: row.villageName }),
    ...(row.neighborhoodName === null ? {} : { neighborhood_name: row.neighborhoodName }),
  });
  return {
    source: meta.source,
    downloadedAt: meta.downloadedAt,
    sourceLastModified: meta.sourceLastModified,
    description:
      "Subset of Realistimo's geo list (realistimo_geo_db.csv): every city row, plus the " +
      `neighbourhood rows of ${SUBSET_CITIES.join(', ')} (where the CSV has any). ` +
      'Columns that are NULL in the CSV are left out. <internal_id> takes internal_id, ' +
      'never the CSV row id. Regenerate with src/portals/realistimo/download-geo.ts --subset.',
    rows: [...cities, ...neighborhoods].map(toSubsetRow),
  };
}

/* ---------- Resolver ---------- */

export type GeoLevel = 'neighborhood' | 'city' | 'village';

export type GeoResolution =
  | {
      ok: true;
      /** The value for <internal_id>. */
      internalId: number;
      level: GeoLevel;
      /** Bulgarian label, e.g. 'София, Лозенец' or 'Банско'. */
      label: string;
      /** False when a district was given but not found, so the city's id is used instead. */
      districtMatched: boolean;
      /** Bulgarian name of the city or village, e.g. 'София'. */
      placeName: string;
      /** Bulgarian name of the matched neighbourhood, e.g. 'Лозенец'; null when none matched. */
      districtName: string | null;
    }
  | {
      ok: false;
      reason: 'unknown-city' | 'ambiguous-city';
      /** For 'ambiguous-city': the matching places with their province, e.g. 'Бяла (Варна)'. */
      candidates: string[];
    };

export interface GeoResolver {
  /** Where the rows came from: the full CSV, the committed subset, or rows passed in. */
  readonly source: 'csv' | 'subset' | 'rows';
  /** Number of rows indexed. */
  readonly size: number;
  /** Finds the Realistimo location for a property's city and optional district. Pure. */
  resolve(city: string, district?: string | null): GeoResolution;
}

export interface GeoResolverOptions {
  /** Index exactly these rows (tests, or rows loaded elsewhere). */
  rows?: readonly GeoRow[];
  /**
   * The full geo CSV, used when the file exists. Default DEFAULT_GEO_CSV_PATH; null never
   * reads a file and always uses the committed subset.
   */
  csvPath?: string | null;
}

/** District spellings that mean the city centre (Център). */
const DISTRICT_ALIASES: ReadonlyMap<string, string> = new Map(
  ['Center', 'Centre', 'City Center', 'City Centre', 'Centar'].map((spelling) => [
    placeKeys(spelling).exact,
    'Център',
  ]),
);

class KeyIndex {
  private readonly exact = new Map<string, GeoRow[]>();
  private readonly loose = new Map<string, GeoRow[]>();

  add(name: string | null, row: GeoRow): void {
    if (name === null) return;
    const keys = placeKeys(name);
    if (keys.exact === '') return;
    push(this.exact, keys.exact, row);
    push(this.loose, keys.loose, row);
  }

  /** Rows whose whole name matches, otherwise rows that match without the kind-of-place prefix. */
  find(keys: PlaceKeys): GeoRow[] {
    return this.exact.get(keys.exact) ?? this.loose.get(keys.loose) ?? [];
  }
}

function push(map: Map<string, GeoRow[]>, key: string, row: GeoRow): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [row]);
  else list.push(row);
}

const cityKey = (row: GeoRow) => `${row.stateName ?? ''}|${row.cityName ?? ''}`;

function placeName(row: GeoRow): string {
  return (row.locationType === 'village' ? row.villageName : row.cityName) ?? '';
}

function readRows(options: GeoResolverOptions): {
  rows: readonly GeoRow[];
  source: GeoResolver['source'];
} {
  if (options.rows !== undefined) return { rows: options.rows, source: 'rows' };
  const csvPath = options.csvPath === undefined ? DEFAULT_GEO_CSV_PATH : options.csvPath;
  if (csvPath !== null && existsSync(csvPath)) {
    try {
      return { rows: parseGeoCsv(readFileSync(csvPath, 'utf8')), source: 'csv' };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new GeoDataError(`Cannot read the Realistimo geo CSV at ${csvPath}: ${reason}`);
    }
  }
  return { rows: loadGeoSubset(), source: 'subset' };
}

/**
 * Indexes Realistimo's geo rows for lookups by city and district. Names match in Cyrillic
 * or Latin (Streamlined transliteration), ignoring case, spaces, hyphens and dots, with y
 * and i treated alike; "Center"/"Centre" mean Център. A city name that is not a city row
 * may still match a single village row. A district that is not found falls back to the
 * city's id.
 */
export function createGeoResolver(options: GeoResolverOptions = {}): GeoResolver {
  const { rows, source } = readRows(options);
  const cities = new KeyIndex();
  const villages = new KeyIndex();
  const neighborhoods = new Map<string, KeyIndex>();

  for (const row of rows) {
    switch (row.locationType) {
      case 'city':
        cities.add(row.cityName, row);
        break;
      case 'village':
        villages.add(row.villageName, row);
        break;
      case 'neighborhood': {
        let index = neighborhoods.get(cityKey(row));
        if (index === undefined) {
          index = new KeyIndex();
          neighborhoods.set(cityKey(row), index);
        }
        index.add(row.neighborhoodName, row);
        break;
      }
      case 'state':
        // Whether province-level ids are accepted is not documented; they are never sent.
        break;
    }
  }

  return {
    source,
    size: rows.length,
    resolve(city, district = null) {
      const keys = placeKeys(city);
      let places = keys.exact === '' ? [] : cities.find(keys);
      if (places.length === 0 && keys.exact !== '') places = villages.find(keys);
      const place = places[0];
      if (place === undefined) return { ok: false, reason: 'unknown-city', candidates: [] };
      if (places.length > 1) {
        return {
          ok: false,
          reason: 'ambiguous-city',
          candidates: places.map((row) => `${placeName(row)} (${row.stateName ?? '?'})`),
        };
      }

      const label = placeName(place);
      const wanted = district?.trim() ?? '';
      if (wanted === '' || place.locationType !== 'city') {
        return {
          ok: true,
          internalId: place.internalId,
          level: place.locationType === 'city' ? 'city' : 'village',
          label,
          districtMatched: wanted === '',
          placeName: label,
          districtName: null,
        };
      }
      const alias = DISTRICT_ALIASES.get(placeKeys(wanted).exact);
      const match = neighborhoods.get(cityKey(place))?.find(placeKeys(alias ?? wanted))[0];
      // Neighbourhoods are indexed by name, so a match always has one.
      if (match === undefined || match.neighborhoodName === null) {
        return {
          ok: true,
          internalId: place.internalId,
          level: 'city',
          label,
          districtMatched: false,
          placeName: label,
          districtName: null,
        };
      }
      return {
        ok: true,
        internalId: match.internalId,
        level: 'neighborhood',
        label: `${label}, ${match.neighborhoodName}`,
        districtMatched: true,
        placeName: label,
        districtName: match.neighborhoodName,
      };
    },
  };
}
