import { describe, expect, it } from 'vitest';
import {
  formatSofiaDateTime,
  formatSofiaStartOfDay,
  IMPORT_COOLDOWN_MS,
  importCooldownEndsAt,
  isImportCoolingDown,
  isWithinImportWindow,
  sofiaStartOfDay,
} from '../../../../src/portals/realistimo/time.js';

describe('formatSofiaDateTime', () => {
  it.each([
    // Winter: EET, UTC+2.
    ['2026-01-15T10:30:00Z', '2026-01-15 12:30:00'],
    // Summer: EEST, UTC+3.
    ['2026-07-01T10:30:05Z', '2026-07-01 13:30:05'],
    // The local date can be a day ahead of the UTC date.
    ['2026-11-15T22:38:56Z', '2026-11-16 00:38:56'],
    // Daylight saving starts at 03:00 local time on 29 March 2026.
    ['2026-03-29T00:59:59Z', '2026-03-29 02:59:59'],
    ['2026-03-29T01:00:00Z', '2026-03-29 04:00:00'],
    // ... and ends at 04:00 local time on 25 October 2026.
    ['2026-10-25T00:59:59Z', '2026-10-25 03:59:59'],
    ['2026-10-25T01:00:00Z', '2026-10-25 03:00:00'],
  ])('%s -> %s', (utc, sofia) => {
    expect(formatSofiaDateTime(new Date(utc))).toBe(sofia);
  });

  it('uses 00 for midnight, not 24', () => {
    expect(formatSofiaDateTime(new Date('2026-01-14T22:00:00Z'))).toBe('2026-01-15 00:00:00');
  });
});

describe('formatSofiaStartOfDay', () => {
  it('gives midnight of the Bulgarian date', () => {
    expect(formatSofiaStartOfDay(new Date('2026-11-15T22:38:56Z'))).toBe('2026-11-16 00:00:00');
    expect(formatSofiaStartOfDay(new Date('2026-07-01T20:59:59Z'))).toBe('2026-07-01 00:00:00');
  });
});

describe('isWithinImportWindow (08:00-20:59 Bulgarian time)', () => {
  it.each([
    ['2026-01-15T05:59:59Z', false], // 07:59:59 EET
    ['2026-01-15T06:00:00Z', true], // 08:00:00
    ['2026-01-15T18:59:59Z', true], // 20:59:59
    ['2026-01-15T19:00:00Z', false], // 21:00:00
    ['2026-07-15T04:59:59Z', false], // 07:59:59 EEST
    ['2026-07-15T05:00:00Z', true], // 08:00:00
    ['2026-07-15T17:59:59Z', true], // 20:59:59
    ['2026-07-15T18:00:00Z', false], // 21:00:00
    ['2026-07-15T23:30:00Z', false], // 02:30 the next day
  ])('%s -> %s', (utc, expected) => {
    expect(isWithinImportWindow(new Date(utc))).toBe(expected);
  });
});

describe('import cooldown (30 minutes)', () => {
  const last = new Date('2026-01-15T09:00:00Z');

  it('ends 30 minutes after the last import', () => {
    expect(IMPORT_COOLDOWN_MS).toBe(30 * 60 * 1000);
    expect(importCooldownEndsAt(last)).toEqual(new Date('2026-01-15T09:30:00Z'));
    expect(importCooldownEndsAt(null)).toBeNull();
  });

  it('is active only before it ends', () => {
    expect(isImportCoolingDown(new Date('2026-01-15T09:29:59Z'), last)).toBe(true);
    expect(isImportCoolingDown(new Date('2026-01-15T09:30:00Z'), last)).toBe(false);
    expect(isImportCoolingDown(new Date('2026-01-15T09:00:00Z'), null)).toBe(false);
  });
});

describe('sofiaStartOfDay', () => {
  it.each([
    // Winter (UTC+2): the Bulgarian day starts at 22:00 UTC the day before.
    ['2026-11-15T22:38:56Z', '2026-11-15T22:00:00.000Z'],
    ['2026-01-20T10:00:00Z', '2026-01-19T22:00:00.000Z'],
    // Summer (UTC+3).
    ['2026-07-01T20:59:59Z', '2026-06-30T21:00:00.000Z'],
    // The days the clocks change: midnight was still in the old offset.
    ['2026-03-29T12:00:00Z', '2026-03-28T22:00:00.000Z'],
    ['2026-10-25T12:00:00Z', '2026-10-24T21:00:00.000Z'],
  ])('%s -> %s', (now, start) => {
    const result = sofiaStartOfDay(new Date(now));

    expect(result.toISOString()).toBe(start);
    expect(formatSofiaDateTime(result)).toBe(formatSofiaStartOfDay(new Date(now)));
  });
});
