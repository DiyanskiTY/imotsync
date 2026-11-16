import {
  PortalError,
  type AdapterContext,
  type AdapterOutcome,
  type PortalAdapter,
  type PortalListingInfo,
  type PortalProperty,
} from '../types.js';
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

/** Runs synchronous work as a promise, so a throw becomes a rejection like any I/O error. */
function settle<T>(work: () => T): Promise<T> {
  return new Promise((resolve) => {
    resolve(work());
  });
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
 * Nothing here does I/O: the adapter only computes what the feed serves.
 */
export function createBazarAdapter(options: BazarAdapterOptions = {}): PortalAdapter {
  function feedOutcome(
    property: PortalProperty,
    ctx: AdapterContext,
    message: string,
  ): AdapterOutcome {
    ctx.signal.throwIfAborted();
    const issues = validateForBazar(property);
    if (issues.length > 0) {
      const summary = issues.map((issue) => `${issue.field}: ${issue.message}`).join('; ');
      throw new PortalError(`Validation failed: ${summary}`, false, { code: 'VALIDATION_FAILED' });
    }
    const { payload, truncated } = buildBazarItem(property, {
      listingUrlTemplate: options.listingUrlTemplate,
      placeNames: options.placeNames,
    });
    return {
      payload,
      message,
      details: {
        feedItemId: payload.id,
        availability: payload.availability,
        imageCount: 1 + payload.additionalImageLinks.length,
        ...(truncated.length > 0 ? { truncated } : {}),
      },
    };
  }

  function removalOutcome(listing: PortalListingInfo, ctx: AdapterContext): AdapterOutcome {
    ctx.signal.throwIfAborted();
    const previous = readBazarPayload(listing.payload);
    if (!previous) {
      // The feed only ever serves stored payloads, so Bazar never received this listing.
      return { payload: null, message: 'Not in the Bazar feed, nothing to remove' };
    }
    return {
      payload: { ...previous, availability: 'out_of_stock' },
      message:
        'Marked out of stock in the Bazar feed (Bazar archives the listing on its next scheduled download)',
      details: { feedItemId: previous.id, availability: 'out_of_stock' },
    };
  }

  return {
    key: BAZAR_PORTAL_KEY,
    displayName: BAZAR_DISPLAY_NAME,
    mode: 'feed',

    validate: validateForBazar,

    publish(property: PortalProperty, _listing: PortalListingInfo, ctx: AdapterContext) {
      return settle(() =>
        feedOutcome(
          property,
          ctx,
          'Added to the Bazar feed (Bazar picks it up on its next scheduled download)',
        ),
      );
    },

    update(property: PortalProperty, _listing: PortalListingInfo, ctx: AdapterContext) {
      return settle(() =>
        feedOutcome(
          property,
          ctx,
          'Updated in the Bazar feed (Bazar applies it on its next scheduled download)',
        ),
      );
    },

    remove(listing: PortalListingInfo, _property: PortalProperty | null, ctx: AdapterContext) {
      return settle(() => removalOutcome(listing, ctx));
    },
  };
}
