import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import type { Knex } from 'knex';
import type { RetryConfig, WorkerConfig } from '../config.js';
import type { JobRow } from '../db/types.js';
import type { FileStorage } from '../lib/storage.js';
import type { Logger } from '../logger.js';
import type { PortalRegistry } from '../portals/registry.js';
import { claimNextJob, MAX_WORKER_ID_LENGTH } from './claim.js';
import { createJobRunner, type JobRunReport } from './job-runner.js';
import { collectUnusedPhotos } from './photo-gc.js';
import { finishPendingDeletions } from './property-deletion.js';
import { sweepStaleJobs } from './sweep.js';

/** What a periodic task may ask for after a run. */
export interface PeriodicTaskRun {
  /** Run again this long after this run started, instead of after intervalMs. */
  nextRunInMs?: number;
}

/**
 * Work the worker does on a schedule besides jobs, e.g. the Realistimo REST sync. In run mode
 * a task runs at the first cycle and then every intervalMs; with --once it runs once, after
 * the due jobs (so it sees their results).
 */
export interface PeriodicTask {
  name: string;
  intervalMs: number;
  /** Should honour `signal` (aborted when the worker stops). Errors are logged, not fatal. */
  run(context: { signal: AbortSignal; logger: Logger }): Promise<void | PeriodicTaskRun>;
}

export interface WorkerDeps {
  db: Knex;
  registry: PortalRegistry;
  storage: FileStorage;
  logger: Logger;
  config: { worker: WorkerConfig; retry: RetryConfig; publicBaseUrl: string };
  /** Default: hostname:pid:random. */
  workerId?: string;
  /** Jitter for the back-off (default Math.random). */
  random?: () => number;
  periodicTasks?: readonly PeriodicTask[];
  /**
   * The built-in housekeeping task (default on): finishing requested property deletions and
   * deleting unused photo files (see createMaintenanceTask). false turns it off (tests).
   */
  maintenance?: boolean;
  /** Clock for the jobs and for scheduling the periodic tasks (default: new Date()). */
  now?: () => Date;
  /** Called after every job (tests, metrics). */
  onJobDone?: (report: JobRunReport) => void;
}

/** How often the worker finishes requested deletions that are ready. */
export const DELETION_SWEEP_INTERVAL_MS = 60_000;
/** How often the worker deletes photo files nothing refers to any more. */
export const PHOTO_GC_INTERVAL_MS = 60 * 60 * 1000;

export const MAINTENANCE_TASK_NAME = 'maintenance';

/**
 * The worker's housekeeping, a periodic task like any other (with --once: once, after the
 * jobs). Every DELETION_SWEEP_INTERVAL_MS it finishes the requested deletions (bulk delete,
 * or DELETE of a property whose feed still serves a removal) that nothing blocks any more,
 * e.g. once a removal tombstone has passed its retention period, or after the last job
 * failed. Then, at its first run and every PHOTO_GC_INTERVAL_MS, it deletes the photo files
 * that no photo row and no stored feed payload refers to (after the deletions, so their
 * files go in the same run).
 */
export function createMaintenanceTask(deps: {
  db: Knex;
  storage: FileStorage;
  registry: PortalRegistry;
  now?: () => Date;
}): PeriodicTask {
  const { db, storage, registry } = deps;
  const now = deps.now ?? (() => new Date());
  let lastPhotoSweepAt = Number.NEGATIVE_INFINITY;
  return {
    name: MAINTENANCE_TASK_NAME,
    intervalMs: DELETION_SWEEP_INTERVAL_MS,
    async run({ logger }) {
      const at = now();
      await finishPendingDeletions(db, logger, {
        removedRetentionDays: registry.removedRetentionDays,
        now: at,
      });
      if (at.getTime() - lastPhotoSweepAt >= PHOTO_GC_INTERVAL_MS) {
        lastPhotoSweepAt = at.getTime();
        await collectUnusedPhotos(db, storage, logger, { now: at });
      }
    },
  };
}

export interface WorkerStats {
  claimed: number;
  succeeded: number;
  retrying: number;
  failed: number;
  lost: number;
}

export interface Worker {
  readonly id: string;
  /** Claims and runs jobs until stop() is called, polling while none is due. */
  run(): Promise<WorkerStats>;
  /**
   * Claims and runs jobs until none is due and none is running, then resolves. Rejects when
   * a claim fails (e.g. the database is unreachable), after the running jobs have finished.
   */
  runOnce(): Promise<WorkerStats>;
  /**
   * Graceful stop: claims nothing more, lets running jobs finish within JOB_TIMEOUT_SECONDS
   * (then aborts them), and resolves when the loop has ended.
   */
  stop(): Promise<void>;
}

/** "my-host:12345:9f3a1c", at most 64 characters (jobs.locked_by). */
export function defaultWorkerId(): string {
  const suffix = `:${process.pid}:${randomBytes(3).toString('hex')}`;
  return `${hostname().slice(0, MAX_WORKER_ID_LENGTH - suffix.length)}${suffix}`;
}

/** Extra time after JOB_TIMEOUT_SECONDS for running jobs to record their outcome on stop. */
const STOP_GRACE_MS = 5_000;

export function createWorker(deps: WorkerDeps): Worker {
  const { db, registry, logger, config } = deps;
  const id = deps.workerId ?? defaultWorkerId();
  const log = logger.child({ workerId: id });
  const { concurrency, pollIntervalMs, jobTimeoutSeconds, lockTimeoutSeconds } = config.worker;
  const now = deps.now ?? (() => new Date());
  const runner = createJobRunner({
    db,
    registry,
    logger: log,
    publicBaseUrl: config.publicBaseUrl,
    jobTimeoutMs: jobTimeoutSeconds * 1000,
    retry: config.retry,
    random: deps.random,
    now,
  });
  const portals = registry.keys();
  // The worker's own housekeeping first, then the tasks it was given.
  const periodicTasks: readonly PeriodicTask[] = [
    ...(deps.maintenance === false
      ? []
      : [createMaintenanceTask({ db, storage: deps.storage, registry, now })]),
    ...(deps.periodicTasks ?? []),
  ];

  const stats: WorkerStats = { claimed: 0, succeeded: 0, retrying: 0, failed: 0, lost: 0 };
  const inFlight = new Set<Promise<void>>();
  /** Aborts running adapter calls: only when they overrun the grace period on stop. */
  const abortJobs = new AbortController();
  /** Aborts periodic tasks: as soon as stop() is called. */
  const abortTasks = new AbortController();
  const taskRuns = new Map<string, { nextRunAt: number; running?: Promise<void> }>();
  let stopping = false;
  let loop: Promise<WorkerStats> | undefined;

  // Wake-up for the loop: a finished job may let the next job of its listing run.
  let woken = false;
  let wakeWaiter: (() => void) | undefined;
  function wake() {
    woken = true;
    wakeWaiter?.();
  }
  async function sleepUntilWoken(timeoutMs: number | undefined): Promise<void> {
    if (woken) {
      woken = false;
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = timeoutMs === undefined ? undefined : setTimeout(resolve, timeoutMs);
      wakeWaiter = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    wakeWaiter = undefined;
    woken = false;
  }

  async function sweep(): Promise<void> {
    try {
      await sweepStaleJobs(db, {
        lockTimeoutSeconds,
        retry: config.retry,
        random: deps.random,
        logger: log,
      });
    } catch (error) {
      log.error({ err: error }, 'Stale-lock sweep failed');
    }
  }

  function startDueTasks(): void {
    for (const task of periodicTasks) {
      const state = taskRuns.get(task.name) ?? { nextRunAt: Number.NEGATIVE_INFINITY };
      taskRuns.set(task.name, state);
      if (state.running || now().getTime() < state.nextRunAt) continue;
      const startedAt = now().getTime();
      state.nextRunAt = startedAt + task.intervalMs;
      const taskLog = log.child({ task: task.name });
      state.running = task
        .run({ signal: abortTasks.signal, logger: taskLog })
        .then(
          (result) => {
            if (result?.nextRunInMs !== undefined) {
              state.nextRunAt = startedAt + Math.max(0, result.nextRunInMs);
            }
          },
          (error: unknown) => {
            taskLog.error({ err: error }, 'Periodic task failed');
          },
        )
        .finally(() => {
          state.running = undefined;
        });
    }
  }

  /** Set by runOnce(): a failed claim then ends the run with an error instead of a retry. */
  let failOnClaimError = false;

  async function claim(): Promise<JobRow | null> {
    try {
      return await claimNextJob(db, { workerId: id, portals });
    } catch (error) {
      // --once (CI, cron) must not report success while the database is unreachable.
      if (failOnClaimError) throw error;
      log.error({ err: error }, 'Could not claim a job; polling again');
      return null;
    }
  }

  function start(job: JobRow): void {
    stats.claimed++;
    const running: Promise<void> = runner
      .runJob(job, abortJobs.signal)
      .then((report) => {
        stats[report.recordedAs]++;
        deps.onJobDone?.(report);
      })
      .catch((error: unknown) => {
        log.error({ err: error, jobId: job.id }, 'Could not record the outcome of a job');
      })
      .finally(() => {
        inFlight.delete(running);
        wake();
      });
    inFlight.add(running);
  }

  /** Fills free slots with due jobs; returns whether any job was claimed. */
  async function fillSlots(): Promise<boolean> {
    let claimed = false;
    while (!stopping && inFlight.size < concurrency) {
      const job = await claim();
      if (!job) break;
      claimed = true;
      start(job);
    }
    return claimed;
  }

  async function mainLoop(once: boolean): Promise<WorkerStats> {
    log.info({ concurrency, portals, once }, 'Worker started');
    try {
      while (!stopping) {
        await sweep();
        if (!once) startDueTasks();
        const claimed = await fillSlots();
        if (once && !claimed && inFlight.size === 0) break;
        // Busy or idle: wait for a job to finish, or poll again after the interval. In once
        // mode with jobs running, only a finished job can make more work due.
        await sleepUntilWoken(once ? undefined : pollIntervalMs);
      }
      // --once: the periodic tasks run once, after the jobs (e.g. the Realistimo sync then
      // sees the feed the jobs just changed).
      if (once && !stopping) startDueTasks();
    } finally {
      // Also when a claim failed in once mode: the jobs already running record their outcome.
      await Promise.allSettled(inFlight);
      await Promise.allSettled(
        [...taskRuns.values()].flatMap((state) => (state.running ? [state.running] : [])),
      );
    }
    log.info({ ...stats }, 'Worker stopped');
    return { ...stats };
  }

  function begin(once: boolean): Promise<WorkerStats> {
    if (loop) throw new Error('This worker is already running');
    failOnClaimError = once;
    loop = mainLoop(once);
    return loop;
  }

  return {
    id,
    run: () => begin(false),
    runOnce: () => begin(true),
    async stop() {
      if (stopping) {
        await loop;
        return;
      }
      stopping = true;
      log.info({ running: inFlight.size }, 'Stopping: no new jobs are claimed');
      // Periodic tasks stop right away; they run again after the next start.
      abortTasks.abort();
      wake();
      if (!loop) return;
      const timer = setTimeout(
        () => {
          log.warn('Running jobs did not finish in time; aborting them');
          abortJobs.abort();
        },
        jobTimeoutSeconds * 1000 + STOP_GRACE_MS,
      );
      try {
        await loop;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
