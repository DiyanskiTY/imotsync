import type { BulkDeleteItem, BulkDeleteResult } from '../../core/api/models';

/** One sentence per outcome, in this order; only outcomes that occurred are mentioned. */
const SENTENCES: Readonly<Record<BulkDeleteResult, (count: number) => string>> = {
  deleted: (n) => `${n} deleted.`,
  removal_queued: (n) => `${n} being removed from the portals first, then deleted.`,
  deletion_scheduled: (n) =>
    `${n} archived and scheduled for deletion; ${n === 1 ? 'its page shows' : 'their pages show'} when.`,
  not_found: (n) => `${n} already gone.`,
  error: (n) => `${n} could not be deleted; try again.`,
};

export interface BulkDeleteSummary {
  severity: 'success' | 'warn';
  detail: string;
}

/** Turns the per-property results of POST /api/properties/bulk/delete into one toast. */
export function summarizeBulkDelete(items: readonly BulkDeleteItem[]): BulkDeleteSummary {
  const counts = new Map<BulkDeleteResult, number>();
  for (const item of items) {
    counts.set(item.result, (counts.get(item.result) ?? 0) + 1);
  }
  const detail = (Object.keys(SENTENCES) as BulkDeleteResult[])
    .filter((result) => counts.has(result))
    .map((result) => SENTENCES[result](counts.get(result) ?? 0))
    .join(' ');
  return { severity: counts.has('error') ? 'warn' : 'success', detail };
}
