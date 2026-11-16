import { PortalError } from '../types.js';
import type { LatestLogResult, RealistimoClient, StartOutcome } from './api-client.js';
import { isImportCoolingDown, isWithinImportWindow } from './time.js';

/*
 * The optional Realistimo REST sync (only with REALISTIMO_API_KEY). Every cycle it reads the
 * latest import log, applies the per-offer errors of an import it has not processed yet, and
 * asks Realistimo to import the feed when the feed changed since the last import it queued,
 * the time is within 08:00-20:59 Bulgarian time and the 30-minute cooldown has passed.
 *
 * Everything here is free of database code: the worker loads RealistimoSyncState from
 * portal_sync_state, runs one cycle, saves the returned state and sets the listings named in
 * offerErrors to 'error'.
 */

export const REALISTIMO_IMPORT_ERROR_PREFIX = 'Realistimo import: ';

/** portal_sync_state.last_trigger_message is VARCHAR(100). */
export const TRIGGER_MESSAGE_MAX_LENGTH = 100;

const LAST_ERROR_MAX_LENGTH = 2000;

/** After this long without a log for a queued import, stop treating it as awaited. */
export const AWAIT_RESULT_MAX_MS = 2 * 60 * 60 * 1000;

/**
 * start() answers that need a person to fix something at Realistimo or in the configuration
 * (REALISTIMO_AGENCY_UID, the feed registered for the agency) rather than a later retry.
 */
export const CONFIGURATION_START_OUTCOMES: readonly StartOutcome[] = [
  'agency-not-found',
  'no-feed',
  'unknown',
];

/**
 * After such an answer, start() is not called again until the feed changes or this long has
 * passed, so a sync that cannot work does not ask Realistimo every cycle.
 */
export const CONFIGURATION_ERROR_BACKOFF_MS = 60 * 60 * 1000;

export const isConfigurationOutcome = (outcome: StartOutcome | 'error'): boolean =>
  (CONFIGURATION_START_OUTCOMES as readonly string[]).includes(outcome);

/** What is kept in portal_sync_state.last_result (JSON). */
export interface RealistimoSyncSummary {
  /** The latest start() call: when, and what Realistimo answered. */
  lastAttempt: { at: string; outcome: StartOutcome | 'error'; message: string } | null;
  /** The latest completed import log that was processed. */
  log: {
    logDate: string;
    result: LatestLogResult['result'];
    earlyStop: string | null;
    counts: LatestLogResult['counts'];
    errorTypes: LatestLogResult['errorTypes'];
    offersWithErrors: number;
  } | null;
}

/** One row of portal_sync_state (portal = 'realistimo'). */
export interface RealistimoSyncState {
  /** When start() last queued an import (outcome 'queued'). */
  lastTriggeredAt: Date | null;
  /** Outcome of the latest start() call, e.g. 'queued', 'cooldown', 'error: ...' (max 100 chars). */
  lastTriggerMessage: string | null;
  /** logDate of the latest completed import log that was processed. */
  lastLogDate: Date | null;
  /** portal_sync_state.last_result as read from the database. */
  lastResult: RealistimoSyncSummary | null;
}

export const EMPTY_SYNC_STATE: RealistimoSyncState = {
  lastTriggeredAt: null,
  lastTriggerMessage: null,
  lastLogDate: null,
  lastResult: null,
};

export type TriggerDecision =
  | { trigger: true }
  | {
      trigger: false;
      reason: 'unchanged' | 'running' | 'outside-window' | 'cooldown' | 'configuration-error';
    };

export interface TriggerDecisionInput {
  now: Date;
  /** The newest change of the feed (feedLastChanged: payload changes, removals, deletions). */
  feedChangedAt: Date | null;
  /** When an import was last queued through start(). */
  lastTriggeredAt: Date | null;
  /** The latest import Realistimo ran or was asked to run (manual or scheduled). */
  lastImportAt: Date | null;
  /** latest-log says an import is pending or in progress. */
  importRunning: boolean;
  /**
   * When start() last answered with a configuration problem (CONFIGURATION_START_OUTCOMES),
   * if that was its latest answer; null otherwise.
   */
  configurationErrorAt?: Date | null;
}

/** Whether to call start() now. Pure. */
export function decideImportTrigger(input: TriggerDecisionInput): TriggerDecision {
  const { now, feedChangedAt, lastTriggeredAt } = input;
  if (feedChangedAt === null) return { trigger: false, reason: 'unchanged' };
  if (lastTriggeredAt !== null && feedChangedAt.getTime() <= lastTriggeredAt.getTime()) {
    return { trigger: false, reason: 'unchanged' };
  }
  const errorAt = input.configurationErrorAt ?? null;
  if (
    errorAt !== null &&
    feedChangedAt.getTime() <= errorAt.getTime() &&
    now.getTime() - errorAt.getTime() < CONFIGURATION_ERROR_BACKOFF_MS
  ) {
    return { trigger: false, reason: 'configuration-error' };
  }
  if (input.importRunning) return { trigger: false, reason: 'running' };
  if (!isWithinImportWindow(now)) return { trigger: false, reason: 'outside-window' };
  if (isImportCoolingDown(now, input.lastImportAt)) return { trigger: false, reason: 'cooldown' };
  return { trigger: true };
}

export interface OfferImportError {
  /** <offer_uid>: the property's refCode. */
  offerUid: string;
  /** For portal_listings.last_error: 'Realistimo import: ...'. */
  lastError: string;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** The offers a completed import reported errors for, one entry per offer_uid. */
export function offerErrorsFromLog(log: LatestLogResult): OfferImportError[] {
  const byOffer = new Map<string, string[]>();
  for (const offer of log.offers) {
    if (offer.errors.length === 0) continue;
    byOffer.set(offer.offerUid, [...(byOffer.get(offer.offerUid) ?? []), ...offer.errors]);
  }
  return [...byOffer].map(([offerUid, errors]) => ({
    offerUid,
    lastError: truncate(
      `${REALISTIMO_IMPORT_ERROR_PREFIX}${[...new Set(errors)].join('; ')}`,
      LAST_ERROR_MAX_LENGTH,
    ),
  }));
}

/** The offers a completed import reported without errors. */
export function offersOkFromLog(log: LatestLogResult): string[] {
  const failed = new Set(offerErrorsFromLog(log).map((entry) => entry.offerUid));
  return [...new Set(log.offers.map((offer) => offer.offerUid))].filter((uid) => !failed.has(uid));
}

/** Reads portal_sync_state.last_result back (JSON from the database) defensively. */
export function parseSyncSummary(value: unknown): RealistimoSyncSummary | null {
  const parsed = typeof value === 'string' ? safeJson(value) : value;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Partial<RealistimoSyncSummary>;
  return { lastAttempt: record.lastAttempt ?? null, log: record.log ?? null };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function latest(...dates: (Date | null)[]): Date | null {
  let newest: Date | null = null;
  for (const date of dates) {
    if (date !== null && (newest === null || date.getTime() > newest.getTime())) newest = date;
  }
  return newest;
}

export interface RealistimoSyncCycleInput {
  client: RealistimoClient;
  now: Date;
  /** As loaded from portal_sync_state; lastResult may be the raw JSON column. */
  state: Omit<RealistimoSyncState, 'lastResult'> & { lastResult: unknown };
  /** The newest change of the feed (feedLastChanged in src/portals/feed-items.ts), or null. */
  feedChangedAt: Date | null;
  signal?: AbortSignal;
}

export interface RealistimoSyncCycleResult {
  /** Save to portal_sync_state (portal 'realistimo'). */
  state: RealistimoSyncState;
  /** The latest-log answer of this cycle, or null when it could not be read. */
  log: LatestLogResult | null;
  /** True when this cycle processed a completed import log it had not seen before. */
  newLog: boolean;
  /** Listings to move to 'error' (match offerUid to the property's refCode). */
  offerErrors: OfferImportError[];
  /** Offers the new log reported without errors. */
  offersOk: string[];
  decision: TriggerDecision | null;
  /** What start() answered, when it was called. */
  started: StartOutcome | null;
  /** True while an import is queued or running: polling sooner than the interval is useful. */
  awaitingResult: boolean;
  /** A failed API call (network, timeout, rejected key, ...); the cycle stopped there. */
  error: { message: string; retryable: boolean } | null;
}

function failure(error: unknown): { message: string; retryable: boolean } {
  if (error instanceof PortalError) return { message: error.message, retryable: error.retryable };
  return { message: error instanceof Error ? error.message : String(error), retryable: true };
}

/**
 * One sync cycle: read the latest log (and process it once when it is a new completed
 * import), then trigger an import if the feed changed. API errors are returned, not thrown.
 */
export async function runRealistimoSyncCycle(
  input: RealistimoSyncCycleInput,
): Promise<RealistimoSyncCycleResult> {
  const { client, now, feedChangedAt, signal } = input;
  const summary: RealistimoSyncSummary = parseSyncSummary(input.state.lastResult) ?? {
    lastAttempt: null,
    log: null,
  };
  const state: RealistimoSyncState = { ...input.state, lastResult: summary };
  const result: RealistimoSyncCycleResult = {
    state,
    log: null,
    newLog: false,
    offerErrors: [],
    offersOk: [],
    decision: null,
    started: null,
    awaitingResult: false,
    error: null,
  };

  let log: LatestLogResult;
  try {
    log = await client.latestLog(signal);
  } catch (error) {
    result.error = failure(error);
    return result;
  }
  result.log = log;

  if (
    log.state === 'completed' &&
    log.logDate !== null &&
    (state.lastLogDate === null || log.logDate.getTime() > state.lastLogDate.getTime())
  ) {
    result.newLog = true;
    result.offerErrors = offerErrorsFromLog(log);
    result.offersOk = offersOkFromLog(log);
    state.lastLogDate = log.logDate;
    summary.log = {
      logDate: log.logDate.toISOString(),
      result: log.result,
      earlyStop: log.earlyStop,
      counts: log.counts,
      errorTypes: log.errorTypes,
      offersWithErrors: result.offerErrors.length,
    };
  }

  const importRunning = log.state === 'pending' || log.state === 'in_progress';
  const attempt = summary.lastAttempt;
  const attemptAt = attempt === null ? Number.NaN : Date.parse(attempt.at);
  const decision = decideImportTrigger({
    now,
    feedChangedAt,
    lastTriggeredAt: state.lastTriggeredAt,
    lastImportAt: latest(state.lastTriggeredAt, state.lastLogDate, log.logDate),
    importRunning,
    configurationErrorAt:
      attempt !== null && isConfigurationOutcome(attempt.outcome) && !Number.isNaN(attemptAt)
        ? new Date(attemptAt)
        : null,
  });
  result.decision = decision;

  if (decision.trigger) {
    try {
      const started = await client.start(signal);
      result.started = started.outcome;
      state.lastTriggerMessage = truncate(started.outcome, TRIGGER_MESSAGE_MAX_LENGTH);
      summary.lastAttempt = {
        at: now.toISOString(),
        outcome: started.outcome,
        message: started.message,
      };
      if (started.outcome === 'queued') state.lastTriggeredAt = now;
    } catch (error) {
      result.error = failure(error);
      state.lastTriggerMessage = truncate(
        `error: ${result.error.message}`,
        TRIGGER_MESSAGE_MAX_LENGTH,
      );
      summary.lastAttempt = {
        at: now.toISOString(),
        outcome: 'error',
        message: result.error.message,
      };
    }
  }

  // Waiting for an import that was queued after the last processed log, or one that runs now.
  const queuedNotReported =
    state.lastTriggeredAt !== null &&
    now.getTime() - state.lastTriggeredAt.getTime() < AWAIT_RESULT_MAX_MS &&
    (state.lastLogDate === null || state.lastLogDate.getTime() < state.lastTriggeredAt.getTime());
  result.awaitingResult = importRunning || result.started === 'queued' || queuedNotReported;
  return result;
}
