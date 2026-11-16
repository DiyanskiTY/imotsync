import { describe, expect, it } from 'vitest';
import type { JobAction, JobRow, JobStatus, PortalListingRow } from '../../../src/db/types.js';
import { planEnqueue, type EnqueueIntent } from '../../../src/jobs/enqueue.js';
import { isOnPortal, mayBeLive } from '../../../src/jobs/listing-state.js';

/*
 * The per-listing rules of docs/architecture.md ("Rules that keep a listing consistent"),
 * one test per cell of the merge table.
 */

type ListingState = Pick<PortalListingRow, 'status' | 'published_at' | 'removed_at'>;

const AT = new Date('2026-11-01T10:00:00Z');

const listing = (
  status: PortalListingRow['status'],
  online: 'online' | 'offline' = status === 'published' ? 'online' : 'offline',
): ListingState => ({
  status,
  published_at: online === 'online' ? AT : null,
  removed_at: null,
});

const removedListing: ListingState = { status: 'removed', published_at: AT, removed_at: AT };

let nextId = 100;
function job(action: JobAction, status: JobStatus, attempts = status === 'queued' ? 0 : 1): JobRow {
  return {
    id: nextId++,
    portal_listing_id: 1,
    action,
    status,
    attempts,
    max_attempts: 5,
    run_after: AT,
    locked_at: status === 'running' ? AT : null,
    locked_by: status === 'running' ? 'host:1:abc' : null,
    result: null,
    last_error: null,
    finished_at: null,
    created_at: AT,
    updated_at: AT,
  };
}

const plan = (state: ListingState, unfinished: JobRow[], intent: EnqueueIntent) =>
  planEnqueue(state, unfinished, intent);

describe('planEnqueue: no unfinished job', () => {
  it('publish: a new publish, or an update when the listing is on the portal', () => {
    expect(plan(listing('draft'), [], 'publish')).toEqual({ kind: 'insert', action: 'publish' });
    expect(plan(removedListing, [], 'publish')).toEqual({ kind: 'insert', action: 'publish' });
    expect(plan(listing('error'), [], 'publish')).toEqual({ kind: 'insert', action: 'publish' });
    expect(plan(listing('published'), [], 'publish')).toEqual({
      kind: 'insert',
      action: 'update',
    });
    // A failed update or remove leaves the earlier version online.
    expect(plan(listing('error', 'online'), [], 'publish')).toEqual({
      kind: 'insert',
      action: 'update',
    });
  });

  it('update (an edit): a new update for a listing that is on the portal', () => {
    expect(plan(listing('published'), [], 'update')).toEqual({ kind: 'insert', action: 'update' });
    // In error but still online with older data (a failed update, an import error).
    expect(plan(listing('error', 'online'), [], 'update')).toEqual({
      kind: 'insert',
      action: 'update',
    });
    for (const state of [listing('draft'), listing('error'), removedListing]) {
      expect(plan(state, [], 'update').kind).toBe('skip');
    }
  });

  it('remove: a new remove only for a listing that is on the portal', () => {
    expect(plan(listing('published'), [], 'remove')).toEqual({ kind: 'insert', action: 'remove' });
    expect(plan(listing('error', 'online'), [], 'remove')).toEqual({
      kind: 'insert',
      action: 'remove',
    });
    // A first publish that failed never reached the portal: nothing to remove.
    expect(plan(listing('error'), [], 'remove')).toEqual({
      kind: 'skip',
      reason: 'the listing is error and not on the portal; there is nothing to remove',
    });
    expect(plan(listing('draft'), [], 'remove')).toMatchObject({ kind: 'skip' });
    expect(plan(removedListing, [], 'remove')).toMatchObject({
      kind: 'skip',
      reason: 'the listing is removed and not on the portal; there is nothing to remove',
    });
  });
});

describe('planEnqueue: newest job queued publish/update', () => {
  it('publish and update merge into a queued publish (it sends the current data)', () => {
    const queued = job('publish', 'queued');
    expect(plan(listing('pending'), [queued], 'publish')).toEqual({ kind: 'merge', job: queued });
    expect(plan(listing('pending'), [queued], 'update')).toEqual({ kind: 'merge', job: queued });
  });

  it('update merges into a queued update; publish turns it into a publish', () => {
    const queued = job('update', 'queued');
    expect(plan(listing('pending'), [queued], 'update')).toEqual({ kind: 'merge', job: queued });
    // Publish and update merged keep publish, also for an update that waits for a retry and
    // for a listing that never reached the portal (its first publish failed behind it).
    expect(plan(listing('pending'), [queued], 'publish')).toEqual({
      kind: 'replace',
      job: queued,
      action: 'publish',
    });
    const retrying = job('update', 'queued', 2);
    expect(plan(listing('pending', 'online'), [retrying], 'publish')).toEqual({
      kind: 'replace',
      job: retrying,
      action: 'publish',
    });
  });

  for (const action of ['publish', 'update'] as const) {
    it(`remove replaces a queued ${action} that never ran`, () => {
      const queued = job(action, 'queued', 0);
      expect(plan(listing('pending'), [queued], 'remove')).toEqual({
        kind: 'replace',
        job: queued,
        action: 'remove',
      });
    });

    it(`remove queues behind a ${action} that waits for a retry (it may have reached the portal)`, () => {
      const retrying = job(action, 'queued', 2);
      expect(plan(listing('pending'), [retrying], 'remove')).toEqual({
        kind: 'insert',
        action: 'remove',
      });
    });
  }

  it('merging keeps the queued action: publish stays publish after an edit', () => {
    const queued = job('publish', 'queued');
    const result = plan(listing('pending'), [queued], 'update');

    expect(result).toEqual({ kind: 'merge', job: queued });
    expect(queued.action).toBe('publish');
  });

  it('looks only at the newest job when two are unfinished', () => {
    const running = job('update', 'running');
    const queued = job('update', 'queued');

    expect(plan(listing('pending', 'online'), [running, queued], 'update')).toEqual({
      kind: 'merge',
      job: queued,
    });
    expect(plan(listing('pending', 'online'), [running, queued], 'publish')).toEqual({
      kind: 'replace',
      job: queued,
      action: 'publish',
    });
    expect(plan(listing('pending', 'online'), [running, queued], 'remove')).toEqual({
      kind: 'replace',
      job: queued,
      action: 'remove',
    });
  });
});

describe('planEnqueue: newest job queued remove', () => {
  it('publish replaces a remove that never ran (publish, or update while online)', () => {
    const offline = job('remove', 'queued', 0);
    expect(plan(listing('pending'), [offline], 'publish')).toEqual({
      kind: 'replace',
      job: offline,
      action: 'publish',
    });

    const online = job('remove', 'queued', 0);
    expect(plan(listing('pending', 'online'), [online], 'publish')).toEqual({
      kind: 'replace',
      job: online,
      action: 'update',
    });
  });

  it('publish queues a publish behind a remove that waits for a retry', () => {
    const retrying = job('remove', 'queued', 1);
    expect(plan(listing('pending', 'online'), [retrying], 'publish')).toEqual({
      kind: 'insert',
      action: 'publish',
    });
  });

  it('an edit is dropped and another remove is merged', () => {
    const queued = job('remove', 'queued');
    expect(plan(listing('pending', 'online'), [queued], 'update')).toMatchObject({ kind: 'skip' });
    expect(plan(listing('pending', 'online'), [queued], 'remove')).toEqual({
      kind: 'merge',
      job: queued,
    });
  });
});

describe('planEnqueue: newest job running', () => {
  for (const action of ['publish', 'update'] as const) {
    it(`a running ${action}: publish merges, an edit and a remove queue behind it`, () => {
      const running = job(action, 'running');
      expect(plan(listing('pending'), [running], 'publish')).toEqual({
        kind: 'merge',
        job: running,
      });
      expect(plan(listing('pending'), [running], 'update')).toEqual({
        kind: 'insert',
        action: 'update',
      });
      expect(plan(listing('pending'), [running], 'remove')).toEqual({
        kind: 'insert',
        action: 'remove',
      });
    });
  }

  it('a running remove: publish queues a publish behind it, an edit is dropped, remove merges', () => {
    const running = job('remove', 'running');
    expect(plan(listing('pending', 'online'), [running], 'publish')).toEqual({
      kind: 'insert',
      action: 'publish',
    });
    expect(plan(listing('pending', 'online'), [running], 'update')).toMatchObject({
      kind: 'skip',
    });
    expect(plan(listing('pending', 'online'), [running], 'remove')).toEqual({
      kind: 'merge',
      job: running,
    });
  });
});

describe('planEnqueue: at most two unfinished jobs', () => {
  const states = [listing('pending'), listing('pending', 'online')];
  const intents: EnqueueIntent[] = ['publish', 'update', 'remove'];
  const singles = (): JobRow[][] => [
    [job('publish', 'queued', 0)],
    [job('update', 'queued', 0)],
    [job('remove', 'queued', 0)],
    [job('publish', 'queued', 3)],
    [job('update', 'queued', 3)],
    [job('remove', 'queued', 3)],
    [job('publish', 'running')],
    [job('update', 'running')],
    [job('remove', 'running')],
  ];

  it('never inserts a third job, whatever arrives', () => {
    for (const state of states) {
      for (const first of singles()) {
        for (const intent of intents) {
          const afterFirst = plan(state, first, intent);
          const jobs =
            afterFirst.kind === 'insert' ? [...first, job(afterFirst.action, 'queued')] : first;
          for (const next of intents) {
            const second = plan(state, jobs, next);
            if (jobs.length === 2) {
              expect(second.kind, `${intent} then ${next}`).not.toBe('insert');
            }
          }
        }
      }
    }
  });
});

describe('listing state helpers', () => {
  it('a listing is on the portal when published and not removed since', () => {
    expect(isOnPortal(listing('published'))).toBe(true);
    expect(isOnPortal(listing('error', 'online'))).toBe(true);
    expect(isOnPortal(listing('error'))).toBe(false);
    expect(isOnPortal(removedListing)).toBe(false);
  });

  it('a pending listing, or one on the portal, may be live', () => {
    expect(mayBeLive(listing('pending'))).toBe(true);
    expect(mayBeLive(listing('published'))).toBe(true);
    expect(mayBeLive(listing('error', 'online'))).toBe(true);
    expect(mayBeLive(listing('error'))).toBe(false);
    expect(mayBeLive(listing('draft'))).toBe(false);
    expect(mayBeLive(removedListing)).toBe(false);
  });
});
