import type { ListingStatus, PortalListing, PropertyStatus } from '../../core/api/models';

/** Listing states in which the property is online, or about to be. */
const ONLINE: ReadonlySet<ListingStatus> = new Set(['published', 'pending']);

/**
 * A listing that may still be online: published or pending, or in error after an earlier
 * successful publish (a failed update or removal leaves the previous version up).
 */
function mayBeOnline(listing: PortalListing): boolean {
  return ONLINE.has(listing.status) || (listing.status === 'error' && listing.publishedAt !== null);
}

/**
 * The status is the agency's own label and never touches the portals, so Draft or Archived on a
 * property that is online is easy to misread as "taken down". Returns the warning to show under
 * the Status field, or null.
 */
export function statusWarning(
  status: PropertyStatus,
  listings: readonly PortalListing[],
  portalName: (key: string) => string,
): string | null {
  if (status === 'active') return null;
  const names = listings.filter(mayBeOnline).map((listing) => portalName(listing.portal));
  if (names.length === 0) return null;
  const where =
    names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0];
  return status === 'draft'
    ? `Still online on ${where}: Draft is only your own label. To take it down, use "Remove from portal" in the Portals panel.`
    : `Still online on ${where}: archiving does not remove it there, and changes to an archived property are not sent. Use Delete to take it off every portal first, or "Remove from portal" in the Portals panel.`;
}
