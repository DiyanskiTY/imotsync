/*
 * How long a feed keeps serving a removed listing. A feed portal may keep a removal in its
 * feed for a retention period (PortalRegistration.removedRetentionDays): Bazar.bg serves the
 * item as out of stock, so that Bazar sees it at one of its scheduled downloads and archives
 * the listing instead of the item vanishing. The Bazar feed renderer and the deletion rules
 * (src/jobs/property-deletion.ts) both decide with isRemovalStillServed, so a property is never
 * deleted while its feed still serves one of its rows.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The oldest removal still served at `now`: a removal whose payload changed at or after this
 * moment is served. The SQL pre-filter of finishPendingDeletions compares with it too.
 */
export function removalRetentionCutoff(retentionDays: number, now: Date): Date {
  return new Date(now.getTime() - retentionDays * DAY_MS);
}

/** The moment a removal whose payload changed at `removedAt` stops being served. */
export function removalServedUntil(removedAt: Date, retentionDays: number): Date {
  return new Date(removedAt.getTime() + retentionDays * DAY_MS);
}

/**
 * Whether the feed still serves a removed listing whose payload last changed at `removedAt`
 * (portal_listings.payload_updated_at): within `retentionDays` days of it, boundary included.
 * A retention period of 0 serves no removal at all.
 */
export function isRemovalStillServed(removedAt: Date, retentionDays: number, now: Date): boolean {
  return (
    retentionDays > 0 && removedAt.getTime() >= removalRetentionCutoff(retentionDays, now).getTime()
  );
}
