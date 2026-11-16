import { PortalError } from '../types.js';

/*
 * Client for Realistimo's import REST API (realistimo.com/bg/docs/import/rest-api/). It does
 * not carry listings: it asks Realistimo to import the agency's registered feed now
 * (POST /rest-api/import/start) and reads the result of the latest import
 * (POST /rest-api/import/latest-log). Both calls send the key in the API-KEY header.
 *
 * Documented behaviour this client relies on:
 * - /start answers HTTP 200 for every outcome (queued, outside 08:00-20:59, already running,
 *   30-minute cooldown, no feed configured) with a message slug, and {"error":"Agency not
 *   found"} when the key belongs to no agency. A test key answers {"message":"Import in
 *   queue"} (text instead of a slug).
 * - Authentication failures are HTTP 401 {"status":"error","message":...}.
 * - latest-log's message is pending | in_progress | completed | null; logResult is an object
 *   (key "0" = success | success_with_warnings, counters, errors [{type, count}]) or, when
 *   the import stopped before the offers, a one-element array with the reason. A test key
 *   returns logResult and logOffers as JSON strings.
 */

export const DEFAULT_REALISTIMO_API_TIMEOUT_MS = 15_000;

export type StartOutcome =
  | 'queued'
  | 'outside-window'
  | 'in-progress'
  | 'cooldown'
  | 'no-feed'
  | 'agency-not-found'
  | 'unknown';

export interface StartImportResult {
  outcome: StartOutcome;
  /** Realistimo's own message (a slug such as 'import-in-queue', or the 'error' text). */
  message: string;
}

/** Message slugs of /rest-api/import/start, normalised to lower case with hyphens. */
const START_MESSAGES: Readonly<Record<string, StartOutcome>> = {
  'import-in-queue': 'queued',
  'import-is-allowed-between-the-time': 'outside-window',
  'import-in-progress': 'in-progress',
  'import-request-cooldown-is-time-given': 'cooldown',
  'error-while-importing': 'no-feed',
};

export type ImportLogState = 'pending' | 'in_progress' | 'completed' | 'none';
export type ImportResultKind = 'success' | 'success_with_warnings';

export interface ImportLogCounts {
  foundOffers: number | null;
  publishedFoundOffersInAgency: number | null;
  importedOffers: number | null;
  publishedOffers: number | null;
  notPublished: number | null;
  removedOffers: number | null;
  deletedOffers: number | null;
  updatedOffers: number | null;
}

const COUNT_KEYS: Readonly<Record<keyof ImportLogCounts, string>> = {
  foundOffers: 'found_offers',
  publishedFoundOffersInAgency: 'published_found_offers_in_agency',
  importedOffers: 'imported_offers',
  publishedOffers: 'published_offers',
  notPublished: 'not_published',
  removedOffers: 'removed_offers',
  deletedOffers: 'deleted_offers',
  updatedOffers: 'updated_offers',
};

export interface ImportLogOffer {
  /** Our <offer_uid> (the property's refCode), from offerSourceData.offer_uid. */
  offerUid: string;
  /** Realistimo's uuid of the log entry (what it identifies is not documented). */
  uuid: string | null;
  createdAt: string | null;
  /** The offer's errors as text (the shape of an error item is not documented). */
  errors: string[];
}

export interface LatestLogResult {
  state: ImportLogState;
  /** The log's date (ISO 8601 with offset in the response), or null without a log. */
  logDate: Date | null;
  /** logResult["0"]; null when there is no result yet or the import stopped early. */
  result: ImportResultKind | null;
  counts: ImportLogCounts;
  /** logResult.errors: errors grouped by type. */
  errorTypes: { type: string; count: number }[];
  offers: ImportLogOffer[];
  /** Why the import stopped before the offers (feed unchanged, older than 30 days, ...). */
  earlyStop: string | null;
}

export interface RealistimoClient {
  /** Asks Realistimo to import the agency's feed now. */
  start(signal?: AbortSignal): Promise<StartImportResult>;
  /** The state and result of the latest import. */
  latestLog(signal?: AbortSignal): Promise<LatestLogResult>;
}

export interface RealistimoClientOptions {
  apiKey: string;
  /** Default https://realistimo.com (REALISTIMO_API_BASE_URL). */
  baseUrl: string;
  /** Injected in tests; default globalThis.fetch. */
  fetch?: typeof globalThis.fetch;
  /** Time budget per request. Default 15 s. */
  timeoutMs?: number;
}

/* ---------- Interpreting responses (pure) ---------- */

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function asCount(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\s*\d+\s*$/.test(value)) return Number(value);
  return null;
}

/** The test key sends logResult and logOffers as JSON text; anything else is used as it is. */
function decodeMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

/** Maps the JSON body of an HTTP 200 answer of /rest-api/import/start to an outcome. */
export function interpretStartResponse(body: unknown): StartImportResult {
  const record = asRecord(body);
  const error = asText(record?.error);
  if (error !== null) {
    return {
      outcome: /agency not found/i.test(error) ? 'agency-not-found' : 'unknown',
      message: error,
    };
  }
  const message = asText(record?.message);
  if (message === null) return { outcome: 'unknown', message: '' };
  const slug = message
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-');
  return { outcome: START_MESSAGES[slug] ?? 'unknown', message };
}

function errorText(item: unknown): string | null {
  if (typeof item === 'string') return item.trim() === '' ? null : item.trim();
  if (typeof item === 'number' || typeof item === 'boolean') return String(item);
  const record = asRecord(item);
  if (record === null) return null;
  const message = asText(record.message) ?? asText(record.error) ?? asText(record.text);
  const type = asText(record.type) ?? asText(record.code);
  if (message !== null && type !== null) return `${type}: ${message}`;
  return message ?? type ?? JSON.stringify(record);
}

function interpretOffers(raw: unknown): ImportLogOffer[] {
  const list = decodeMaybeJson(raw);
  if (!Array.isArray(list)) return [];
  const offers: ImportLogOffer[] = [];
  for (const entry of list) {
    const record = asRecord(entry);
    const offerUid = asText(asRecord(record?.offerSourceData)?.offer_uid);
    if (record === null || offerUid === null) continue;
    const errors = Array.isArray(record.errors)
      ? record.errors.map(errorText).filter((text): text is string => text !== null)
      : [];
    offers.push({
      offerUid,
      uuid: asText(record.uuid),
      createdAt: asText(record.createdAt),
      errors,
    });
  }
  return offers;
}

function emptyCounts(): ImportLogCounts {
  return {
    foundOffers: null,
    publishedFoundOffersInAgency: null,
    importedOffers: null,
    publishedOffers: null,
    notPublished: null,
    removedOffers: null,
    deletedOffers: null,
    updatedOffers: null,
  };
}

/** Interprets the JSON body of /rest-api/import/latest-log (also the result_url callback). */
export function interpretLatestLog(body: unknown): LatestLogResult {
  const record = asRecord(body) ?? {};
  const message = asText(record.message);
  const state: ImportLogState =
    message === 'pending' || message === 'in_progress' || message === 'completed'
      ? message
      : 'none';

  const dateText = asText(record.logDate);
  const parsedDate = dateText === null ? null : new Date(dateText);
  const logDate = parsedDate === null || Number.isNaN(parsedDate.getTime()) ? null : parsedDate;

  const counts = emptyCounts();
  let result: ImportResultKind | null = null;
  let earlyStop: string | null = null;
  const errorTypes: { type: string; count: number }[] = [];

  const logResult = decodeMaybeJson(record.logResult);
  if (Array.isArray(logResult)) {
    // The import stopped before the offers: a one-element array with the reason.
    earlyStop =
      logResult
        .map(asText)
        .filter((text): text is string => text !== null)
        .join('; ') || null;
  } else if (typeof logResult === 'string' && logResult.trim() !== '') {
    earlyStop = logResult.trim();
  } else {
    const resultRecord = asRecord(logResult);
    if (resultRecord !== null) {
      const kind = asText(resultRecord['0']);
      result = kind === 'success' || kind === 'success_with_warnings' ? kind : null;
      for (const [field, key] of Object.entries(COUNT_KEYS) as [keyof ImportLogCounts, string][]) {
        counts[field] = asCount(resultRecord[key]);
      }
      if (Array.isArray(resultRecord.errors)) {
        for (const entry of resultRecord.errors) {
          const group = asRecord(entry);
          const type = asText(group?.type);
          if (type !== null) errorTypes.push({ type, count: asCount(group?.count) ?? 0 });
        }
      }
    }
  }

  return {
    state,
    logDate,
    result,
    counts,
    errorTypes,
    offers: interpretOffers(record.logOffers),
    earlyStop,
  };
}

/* ---------- HTTP ---------- */

function parseJson(text: string): unknown {
  if (text.trim() === '') return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function retryAfterMs(header: string | null): number | undefined {
  if (header === null) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function causeText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as Error & { cause?: unknown }).cause;
  return cause instanceof Error ? `${error.message} (${cause.message})` : error.message;
}

export function createRealistimoClient(options: RealistimoClientOptions): RealistimoClient {
  if (options.apiKey.trim() === '') throw new Error('A Realistimo API key is required');
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const doFetch = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_REALISTIMO_API_TIMEOUT_MS;

  /** POSTs to an import endpoint and returns the parsed JSON of an HTTP 200 answer. */
  async function post(path: string, signal: AbortSignal | undefined): Promise<unknown> {
    const what = `Realistimo ${path}`;
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    let response: Response;
    let text: string;
    try {
      response = await doFetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'API-KEY': options.apiKey, Accept: 'application/json' },
        // Never follow a redirect: the API key would go along to wherever it points.
        redirect: 'manual',
        signal: combined,
      });
      text = await response.text();
    } catch (error) {
      if (timeout.aborted) {
        throw new PortalError(`${what} did not answer within ${timeoutMs} ms`, true, {
          code: 'timeout',
        });
      }
      if (signal?.aborted === true) {
        throw new PortalError(`${what} was cancelled`, true, { code: 'aborted' });
      }
      throw new PortalError(`${what} could not be reached: ${causeText(error)}`, true, {
        code: 'network',
      });
    }

    const body = parseJson(text);

    const status = response.status;
    // 'manual' gives the 3xx answer itself (or, in browsers, an opaque one with status 0).
    if (response.type === 'opaqueredirect' || (status >= 300 && status < 400)) {
      const location = response.headers.get('location');
      throw new PortalError(
        `${what} answered with a redirect (HTTP ${status}${
          location === null ? '' : ` to ${location}`
        }), which is not followed; check REALISTIMO_API_BASE_URL`,
        false,
        { code: 'redirect', httpStatus: status },
      );
    }
    if (status === 401) {
      const message = asText(asRecord(body)?.message) ?? 'API key rejected';
      throw new PortalError(`Realistimo rejected the API key: ${message}`, false, {
        code: 'unauthorized',
        httpStatus: 401,
      });
    }
    if (status === 429 || status >= 500) {
      throw new PortalError(`${what} answered HTTP ${status}`, true, {
        code: 'http',
        httpStatus: status,
        retryAfterMs: retryAfterMs(response.headers.get('retry-after')),
      });
    }
    if (status < 200 || status >= 300) {
      throw new PortalError(`${what} answered HTTP ${status}`, false, {
        code: 'http',
        httpStatus: status,
      });
    }
    if (body === null) {
      throw new PortalError(`${what} answered without a JSON body`, true, {
        code: 'bad-response',
        httpStatus: status,
      });
    }
    return body;
  }

  return {
    async start(signal) {
      return interpretStartResponse(await post('/rest-api/import/start', signal));
    },
    async latestLog(signal) {
      return interpretLatestLog(await post('/rest-api/import/latest-log', signal));
    },
  };
}
