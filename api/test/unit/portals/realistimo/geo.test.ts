import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildGeoSubset,
  createGeoResolver,
  GeoDataError,
  geoSubsetInfo,
  loadGeoSubset,
  parseGeoCsv,
  REALISTIMO_GEO_CSV_URL,
  rowsFromSubset,
  type GeoRow,
} from '../../../../src/portals/realistimo/geo.js';
import { subsetGeo } from './fixtures.js';

const HEADER =
  '"id","internal_id","state_name","city_name","village_name","neighborhood_name","location_type"';

/** A few real rows of realistimo_geo_db.csv, in its exact layout (CRLF, NULL, quoting). */
const SAMPLE_CSV = [
  HEADER,
  '3,4668,"София",NULL,NULL,NULL,"state"',
  '47,4669,"София","София",NULL,NULL,"city"',
  '36,1726,"Варна","Бяла",NULL,NULL,"city"',
  '999,30001,"Русе","Бяла",NULL,NULL,"city"',
  '3903,55924,"Пловдив",NULL,"Виница",NULL,"village"',
  '9001,9433,"София",NULL,"Лозен",NULL,"village"',
  '5838,8621,"София","София",NULL,"Лозенец","neighborhood"',
  '5849,8537,"София","София",NULL,"Младост-1","neighborhood"',
  '5846,8574,"София","София",NULL,"Младост-1А","neighborhood"',
  '',
].join('\r\n');

describe('parseGeoCsv', () => {
  it('reads quoted names, unquoted ids, NULL and CRLF line endings', () => {
    const rows = parseGeoCsv(SAMPLE_CSV);

    expect(rows).toHaveLength(9);
    expect(rows[0]).toEqual({
      internalId: 4668,
      locationType: 'state',
      stateName: 'София',
      cityName: null,
      villageName: null,
      neighborhoodName: null,
    });
    expect(rows[6]).toEqual({
      internalId: 8621,
      locationType: 'neighborhood',
      stateName: 'София',
      cityName: 'София',
      villageName: null,
      neighborhoodName: 'Лозенец',
    });
  });

  it('accepts a byte order mark, LF endings and "" inside quotes', () => {
    const csv = `\uFEFF${HEADER}\n1,7,"A","Say ""hi"", B",NULL,NULL,"city"\n`;

    expect(parseGeoCsv(csv)[0]?.cityName).toBe('Say "hi", B');
  });

  it('refuses a file with another layout', () => {
    expect(() => parseGeoCsv('"id","name"\r\n1,"x"')).toThrow(GeoDataError);
    expect(() => parseGeoCsv(`${HEADER}\r\n1,abc,"A",NULL,NULL,NULL,"state"`)).toThrow(
      /invalid internal_id/,
    );
    expect(() => parseGeoCsv(`${HEADER}\r\n1,5,"A",NULL,NULL,NULL,"planet"`)).toThrow(
      /invalid location_type/,
    );
    expect(() => parseGeoCsv(`${HEADER}\r\n1,5,"A",NULL,"state"`)).toThrow(/7 columns/);
    expect(() => parseGeoCsv(`${HEADER}\r\n1,5,"A,NULL,NULL,NULL,"state"`)).toThrow(GeoDataError);
    expect(() => parseGeoCsv(`${HEADER}\r\n`)).toThrow(/no rows/);
  });
});

describe('the committed subset (geo-subset.json)', () => {
  const rows = loadGeoSubset();

  it('names its source and download date', () => {
    const info = geoSubsetInfo();

    expect(info.source).toBe(REALISTIMO_GEO_CSV_URL);
    expect(info.downloadedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(info.description).toMatch(/internal_id/);
  });

  it('has every city row and the neighbourhoods of the five cities', () => {
    const cities = rows.filter((row) => row.locationType === 'city');
    const neighborhoods = rows.filter((row) => row.locationType === 'neighborhood');

    expect(cities.length).toBeGreaterThan(250);
    expect(new Set(neighborhoods.map((row) => row.cityName))).toEqual(
      new Set(['София', 'Пловдив', 'Варна', 'Бургас']),
    );
    expect(rows.some((row) => row.locationType === 'village' || row.locationType === 'state')).toBe(
      false,
    );
    // internal_id values are unique, as in the full CSV.
    expect(new Set(rows.map((row) => row.internalId)).size).toBe(rows.length);
  });

  it('keeps the documented example ids', () => {
    const byId = new Map(rows.map((row) => [row.internalId, row]));

    expect(byId.get(4669)).toMatchObject({ locationType: 'city', cityName: 'София' });
    expect(byId.get(22)).toMatchObject({ locationType: 'city', cityName: 'Варна' });
    expect(byId.get(52948)).toMatchObject({ locationType: 'city', cityName: 'Пловдив' });
    expect(byId.get(8545)).toMatchObject({ neighborhoodName: 'Дружба-1' });
    expect(byId.get(70190)).toMatchObject({ cityName: 'София', neighborhoodName: 'Център' });
  });

  it('validates the subset structure', () => {
    expect(() => rowsFromSubset({})).toThrow(GeoDataError);
    expect(() => rowsFromSubset({ rows: [{ internal_id: 'x', location_type: 'city' }] })).toThrow(
      /internal_id/,
    );
    expect(() => rowsFromSubset({ rows: [{ internal_id: 1, location_type: 'moon' }] })).toThrow(
      /location_type/,
    );
  });
});

describe('createGeoResolver with the subset', () => {
  it('uses the subset when no CSV is configured', () => {
    expect(subsetGeo.source).toBe('subset');
    expect(subsetGeo.size).toBe(loadGeoSubset().length);
  });

  // The seeded demo properties (Latin names) must all resolve.
  it.each([
    ['Sofia', 'Lozenets', 8621, 'София, Лозенец'],
    ['Sofia', 'Mladost 1', 8537, 'София, Младост-1'],
    ['Sofia', 'Center', 70190, 'София, Център'],
    ['Plovdiv', 'Ostromila', 54086, 'Пловдив, Остромила'],
    ['Plovdiv', 'Kapana', 54084, 'Пловдив, Капана'],
    ['Plovdiv', 'Center', 70035, 'Пловдив, Център'],
    ['Varna', 'Chaika', 69935, 'Варна, Чайка'],
    ['Varna', 'Levski', 1013, 'Варна, Левски'],
    ['Varna', 'Vinitsa', 1025, 'Варна, Виница'],
    ['Burgas', 'Lazur', 21409, 'Бургас, Лазур'],
    ['Burgas', 'Meden Rudnik', 21404, 'Бургас, Меден Рудник'],
  ])('%s / %s -> neighbourhood %i', (city, district, internalId, label) => {
    expect(subsetGeo.resolve(city, district)).toEqual({
      ok: true,
      internalId,
      level: 'neighborhood',
      label,
      districtMatched: true,
      placeName: label.split(', ')[0],
      districtName: label.split(', ')[1],
    });
  });

  it('resolves a town without neighbourhoods to the city (Bansko)', () => {
    expect(subsetGeo.resolve('Bansko', null)).toEqual({
      ok: true,
      internalId: 25444,
      level: 'city',
      label: 'Банско',
      districtMatched: true,
      placeName: 'Банско',
      districtName: null,
    });
  });

  it('matches Cyrillic input and odd spellings', () => {
    expect(subsetGeo.resolve('София', 'Лозенец')).toMatchObject({ internalId: 8621 });
    expect(subsetGeo.resolve('  SOFIYA ', 'mladost-1')).toMatchObject({ internalId: 8537 });
    expect(subsetGeo.resolve('sofia', 'Mladost-1A')).toMatchObject({ internalId: 8574 });
    expect(subsetGeo.resolve('Varna', 'Chayka')).toMatchObject({ internalId: 69935 });
    expect(subsetGeo.resolve('Sofia', 'Lyulin 7')).toMatchObject({ internalId: 8638 });
    expect(subsetGeo.resolve('Veliko Tarnovo')).toMatchObject({ ok: true, level: 'city' });
  });

  it('treats Center, Centre, Centar and Tsentar as Център', () => {
    for (const spelling of ['Center', 'centre', 'City Centre', 'Centar', 'Tsentar', 'център']) {
      expect(subsetGeo.resolve('Burgas', spelling)).toMatchObject({ internalId: 69970 });
    }
  });

  it('matches names with a kind-of-place prefix, preferring the exact name', () => {
    expect(subsetGeo.resolve('Varna', 'k.k. Chayka')).toMatchObject({ internalId: 2879 });
    expect(subsetGeo.resolve('Sofia', 'kv. Lozenets')).toMatchObject({ internalId: 8621 });
    expect(subsetGeo.resolve('гр. София', 'ж.к. Младост 1')).toMatchObject({ internalId: 8537 });
    // Only 'В.З. Люлин' is called just Люлин once its prefix is set aside.
    expect(subsetGeo.resolve('Sofia', 'Lyulin')).toMatchObject({ internalId: 70241 });
  });

  it('keeps districts within their city', () => {
    // Лазур exists in both Varna and Burgas.
    expect(subsetGeo.resolve('Varna', 'Lazur')).toMatchObject({ internalId: 69946 });
    expect(subsetGeo.resolve('Burgas', 'Lazur')).toMatchObject({ internalId: 21409 });
  });

  it('falls back to the city when the district is unknown', () => {
    expect(subsetGeo.resolve('Sofia', 'Nowhere Park')).toEqual({
      ok: true,
      internalId: 4669,
      level: 'city',
      label: 'София',
      districtMatched: false,
      placeName: 'София',
      districtName: null,
    });
  });

  it('reports an unknown city', () => {
    expect(subsetGeo.resolve('Atlantis', 'Center')).toEqual({
      ok: false,
      reason: 'unknown-city',
      candidates: [],
    });
    expect(subsetGeo.resolve('', null)).toMatchObject({ ok: false, reason: 'unknown-city' });
  });

  it('reports a city name that several provinces share', () => {
    expect(subsetGeo.resolve('Byala')).toEqual({
      ok: false,
      reason: 'ambiguous-city',
      candidates: ['Бяла (Варна)', 'Бяла (Русе)'],
    });
  });
});

describe('createGeoResolver with other rows', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'imotsync-geo-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('loads the full CSV when it exists', async () => {
    const csvPath = path.join(tempDir, 'realistimo_geo_db.csv');
    await writeFile(csvPath, SAMPLE_CSV, 'utf8');

    const geo = createGeoResolver({ csvPath });

    expect(geo.source).toBe('csv');
    expect(geo.size).toBe(9);
    expect(geo.resolve('Sofia', 'Lozenets')).toMatchObject({ internalId: 8621 });
  });

  it('falls back to the subset when the CSV is missing', () => {
    const geo = createGeoResolver({ csvPath: path.join(tempDir, 'missing.csv') });

    expect(geo.source).toBe('subset');
  });

  it('refuses a broken CSV instead of silently using the subset', async () => {
    const csvPath = path.join(tempDir, 'broken.csv');
    await writeFile(csvPath, 'not,a,geo,file', 'utf8');

    expect(() => createGeoResolver({ csvPath })).toThrow(/Cannot read the Realistimo geo CSV/);
  });

  it('matches a village when no city has the name, if only one village does', () => {
    const geo = createGeoResolver({ rows: parseGeoCsv(SAMPLE_CSV) });

    expect(geo.source).toBe('rows');
    expect(geo.resolve('Lozen', 'Center')).toEqual({
      ok: true,
      internalId: 9433,
      level: 'village',
      label: 'Лозен',
      districtMatched: false,
      placeName: 'Лозен',
      districtName: null,
    });
    expect(geo.resolve('Vinitsa')).toMatchObject({ internalId: 55924, level: 'village' });
    // Province rows are never used.
    expect(geo.resolve('Sofia')).toMatchObject({ internalId: 4669 });
  });

  it('prefers a city over a village of the same name', () => {
    const rows: GeoRow[] = [
      ...parseGeoCsv(SAMPLE_CSV),
      {
        internalId: 777,
        locationType: 'village',
        stateName: 'Плевен',
        cityName: null,
        villageName: 'София',
        neighborhoodName: null,
      },
    ];

    expect(createGeoResolver({ rows }).resolve('Sofia')).toMatchObject({ internalId: 4669 });
  });
});

describe('buildGeoSubset', () => {
  it('keeps every city and only the neighbourhoods of the subset cities', () => {
    const rows = parseGeoCsv(
      [
        HEADER,
        '47,4669,"София","София",NULL,NULL,"city"',
        '200,18922,"Шумен","Шумен",NULL,NULL,"city"',
        '5838,8621,"София","София",NULL,"Лозенец","neighborhood"',
        '6000,19112,"Шумен","Шумен",NULL,"Топхане","neighborhood"',
        '9001,9433,"София",NULL,"Лозен",NULL,"village"',
      ].join('\r\n'),
    );

    const subset = buildGeoSubset(rows, {
      source: REALISTIMO_GEO_CSV_URL,
      downloadedAt: '2026-11-15T22:38:56.000Z',
      sourceLastModified: null,
    });

    expect(subset.rows).toEqual([
      { internal_id: 4669, location_type: 'city', state_name: 'София', city_name: 'София' },
      { internal_id: 18922, location_type: 'city', state_name: 'Шумен', city_name: 'Шумен' },
      {
        internal_id: 8621,
        location_type: 'neighborhood',
        state_name: 'София',
        city_name: 'София',
        neighborhood_name: 'Лозенец',
      },
    ]);
    expect(rowsFromSubset(subset)).toEqual(rows.slice(0, 3));
  });
});
