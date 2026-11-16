import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { downloadGeoCsv } from '../../../../src/portals/realistimo/download-geo.js';
import { startFakeServer, type FakeServer } from './fixtures.js';

const CSV = [
  '"id","internal_id","state_name","city_name","village_name","neighborhood_name","location_type"',
  '47,4669,"София","София",NULL,NULL,"city"',
  '5838,8621,"София","София",NULL,"Лозенец","neighborhood"',
  '',
].join('\r\n');

let tempDir: string;
let outFile: string;
let server: FakeServer;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'imotsync-geo-download-'));
  outFile = path.join(tempDir, 'data', 'realistimo_geo_db.csv');
  server = await startFakeServer((_request, response) => {
    response.writeHead(200, {
      'Content-Type': 'text/csv',
      'Last-Modified': 'Fri, 13 Nov 2026 11:24:08 GMT',
    });
    response.end(CSV);
  });
});

afterEach(async () => {
  await server.close();
  await rm(tempDir, { recursive: true, force: true });
});

describe('downloadGeoCsv', () => {
  it('saves a valid download, creating the folder', async () => {
    const result = await downloadGeoCsv({ url: `${server.baseUrl}/geo.csv`, outFile });

    expect(result.outFile).toBe(outFile);
    expect(result.rows).toHaveLength(2);
    expect(result.lastModified).toBe('2026-11-13T11:24:08.000Z');
    expect(await readFile(outFile, 'utf8')).toBe(CSV);
    expect(server.requests[0]?.method).toBe('GET');
    // No temporary file is left behind.
    expect(await readdir(path.dirname(outFile))).toEqual(['realistimo_geo_db.csv']);
  });

  it('keeps the previous file when the download is not a geo CSV', async () => {
    await downloadGeoCsv({ url: server.baseUrl, outFile });
    server.handle((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end('<html>Just a moment...</html>');
    });

    await expect(downloadGeoCsv({ url: server.baseUrl, outFile })).rejects.toThrow(
      /Unexpected geo CSV header/,
    );
    expect(await readFile(outFile, 'utf8')).toBe(CSV);
  });

  it('fails on an HTTP error without writing anything', async () => {
    server.handle((_request, response) => {
      response.writeHead(404);
      response.end();
    });

    await expect(downloadGeoCsv({ url: server.baseUrl, outFile })).rejects.toThrow(/HTTP 404/);
    expect(existsSync(outFile)).toBe(false);
  });

  it('replaces an existing file', async () => {
    await writeFile(path.join(tempDir, 'old.csv'), 'old', 'utf8');

    await downloadGeoCsv({ url: server.baseUrl, outFile: path.join(tempDir, 'old.csv') });

    expect(await readFile(path.join(tempDir, 'old.csv'), 'utf8')).toBe(CSV);
  });
});
