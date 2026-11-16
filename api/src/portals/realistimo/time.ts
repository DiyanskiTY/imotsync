/*
 * Time rules of the Realistimo integration. Realistimo's documentation gives dates as
 * 'YYYY-MM-DD HH:MM:SS' without a time zone and limits manual imports to 08:00-20:59
 * Bulgarian time; ImotSync writes every Realistimo date in Europe/Sofia time. (Whether
 * <updated> and <last_update> are read as Bulgarian time is to confirm during onboarding.)
 */

export const SOFIA_TIME_ZONE = 'Europe/Sofia';

const MINUTE_MS = 60 * 1000;

/** Realistimo refuses a manual import within 30 minutes of the last one (manual or scheduled). */
export const IMPORT_COOLDOWN_MS = 30 * MINUTE_MS;

/** First and last hour (inclusive) in which POST /rest-api/import/start is accepted. */
export const IMPORT_WINDOW_FIRST_HOUR = 8;
export const IMPORT_WINDOW_LAST_HOUR = 20;

const sofiaFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: SOFIA_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

interface WallClock {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second: string;
}

function sofiaWallClock(date: Date): WallClock {
  const parts: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
  for (const part of sofiaFormat.formatToParts(date)) {
    parts[part.type] = part.value;
  }
  return {
    year: parts.year ?? '0000',
    month: parts.month ?? '01',
    day: parts.day ?? '01',
    hour: parts.hour ?? '00',
    minute: parts.minute ?? '00',
    second: parts.second ?? '00',
  };
}

/** 'YYYY-MM-DD HH:MM:SS' in Bulgarian time, the date format of Realistimo's XML feed. */
export function formatSofiaDateTime(date: Date): string {
  const t = sofiaWallClock(date);
  return `${t.year}-${t.month}-${t.day} ${t.hour}:${t.minute}:${t.second}`;
}

/** Midnight of the given moment's day in Bulgarian time, as 'YYYY-MM-DD 00:00:00'. */
export function formatSofiaStartOfDay(date: Date): string {
  const t = sofiaWallClock(date);
  return `${t.year}-${t.month}-${t.day} 00:00:00`;
}

/** Bulgarian time minus UTC at the given moment, in milliseconds (2 or 3 hours). */
function sofiaOffsetMs(date: Date): number {
  const t = sofiaWallClock(date);
  const wallAsUtc = Date.UTC(
    Number(t.year),
    Number(t.month) - 1,
    Number(t.day),
    Number(t.hour),
    Number(t.minute),
    Number(t.second),
  );
  return wallAsUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** The moment midnight of the given moment's day in Bulgarian time began. */
export function sofiaStartOfDay(date: Date): Date {
  const t = sofiaWallClock(date);
  const midnightAsUtc = Date.UTC(Number(t.year), Number(t.month) - 1, Number(t.day));
  // The offset at midnight can differ from the offset now on the days the clocks change.
  const guess = midnightAsUtc - sofiaOffsetMs(date);
  return new Date(midnightAsUtc - sofiaOffsetMs(new Date(guess)));
}

/** True between 08:00:00 and 20:59:59 Bulgarian time, when Realistimo accepts manual imports. */
export function isWithinImportWindow(now: Date): boolean {
  const hour = Number(sofiaWallClock(now).hour);
  return hour >= IMPORT_WINDOW_FIRST_HOUR && hour <= IMPORT_WINDOW_LAST_HOUR;
}

/** When the 30-minute cooldown after the last import ends, or null if no import is known. */
export function importCooldownEndsAt(lastImportAt: Date | null): Date | null {
  return lastImportAt === null ? null : new Date(lastImportAt.getTime() + IMPORT_COOLDOWN_MS);
}

/** True while a manual import would be refused because the last one was under 30 minutes ago. */
export function isImportCoolingDown(now: Date, lastImportAt: Date | null): boolean {
  const endsAt = importCooldownEndsAt(lastImportAt);
  return endsAt !== null && now.getTime() < endsAt.getTime();
}
