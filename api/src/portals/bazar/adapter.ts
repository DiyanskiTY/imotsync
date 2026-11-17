import { createFeedAdapter, type FeedAdapterSpec } from '../feed-adapter.js';
import type { PortalAdapter } from '../types.js';
import { buildBazarItem, type BazarPlaceNames } from './mapping.js';
import { readBazarPayload } from './payload.js';
import { validateForBazar } from './validation.js';

export const BAZAR_PORTAL_KEY = 'bazar';
export const BAZAR_DISPLAY_NAME = 'Bazar.bg';

export interface BazarAdapterOptions {
  /**
   * PUBLIC_LISTING_URL_TEMPLATE (config.portals.publicListingUrlTemplate): the agency's page
   * for a listing, with '{refCode}' as the placeholder, e.g.
   * 'https://agency.example/properties/{refCode}'. Null, empty or missing: items carry no
   * <link>.
   */
  listingUrlTemplate?: string | null;
  /** Bulgarian names of the town and district for the custom labels (see BazarPlaceNames). */
  placeNames?: BazarPlaceNames;
}

/**
 * Bazar.bg through its product feed import: the agency registers the feed URL once in its
 * Bazar Premium account, and Bazar downloads the feed on its own schedule (every 6, 12 or
 * 24 hours depending on the plan). The feed uses the Google Merchant RSS format, which
 * Bazar documents as working directly.
 *
 * - publish / update store the listing's feed item as the payload; the next download picks
 *   it up. Bazar recognises the item by g:id (the ref code), so updates never duplicate.
 * - remove keeps the item in the feed marked out_of_stock, which makes Bazar archive the
 *   listing; the feed renderer drops it after the retention period.
 *
 * Nothing here does I/O: the spec only computes what the feed serves (see createFeedAdapter).
 */
export function bazarFeedSpec(options: BazarAdapterOptions = {}): FeedAdapterSpec {
  return {
    key: BAZAR_PORTAL_KEY,
    displayName: BAZAR_DISPLAY_NAME,
    messages: {
      publish: 'Added to the Bazar feed (Bazar picks it up on its next scheduled download)',
      update: 'Updated in the Bazar feed (Bazar applies it on its next scheduled download)',
    },

    validate: validateForBazar,

    buildPayload(property) {
      const { payload, truncated } = buildBazarItem(property, {
        listingUrlTemplate: options.listingUrlTemplate,
        placeNames: options.placeNames,
      });
      return {
        payload,
        details: {
          feedItemId: payload.id,
          availability: payload.availability,
          imageCount: 1 + payload.additionalImageLinks.length,
          ...(truncated.length > 0 ? { truncated } : {}),
        },
      };
    },

    buildRemoval(previousPayload) {
      const previous = readBazarPayload(previousPayload);
      if (!previous) {
        // The feed only ever serves stored payloads, so Bazar never received this listing.
        return { payload: null, message: 'Not in the Bazar feed, nothing to remove' };
      }
      // The tombstone: the item Bazar last received, marked out of stock.
      return {
        payload: { ...previous, availability: 'out_of_stock' },
        message:
          'Marked out of stock in the Bazar feed (Bazar archives the listing on its next scheduled download)',
        details: { feedItemId: previous.id, availability: 'out_of_stock' },
      };
    },
  };
}

export function createBazarAdapter(options: BazarAdapterOptions = {}): PortalAdapter {
  return createFeedAdapter(bazarFeedSpec(options));
}
