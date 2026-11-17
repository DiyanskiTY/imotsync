import { createFeedAdapter, type FeedAdapterSpec } from '../feed-adapter.js';
import {
  PortalError,
  type PortalAdapter,
  type PortalProperty,
  type ValidationIssue,
} from '../types.js';
import type { GeoResolution, GeoResolver } from './geo.js';
import {
  buildRealistimoOffer,
  realistimoLastUpdate,
  realistimoPrice,
  type RealistimoOfferPayload,
} from './offer.js';

/*
 * Realistimo (realistimo.com) imports listings from an XML feed that the agency hosts
 * (pull). publish and update therefore only store the <offer> the feed serves from now on;
 * Realistimo picks it up on its next scheduled import, or sooner when the optional REST
 * sync (sync.ts) asks it to import. An offer that is missing from the feed is taken down,
 * so remove takes the offer out of the feed: its payload becomes null. The worker still
 * records when that happened (payload_updated_at), and the feed's <updated> moves with it, so
 * Realistimo does not skip the import that takes the offer down.
 */

export const REALISTIMO_KEY = 'realistimo';
export const REALISTIMO_DISPLAY_NAME = 'Realistimo';

export interface RealistimoAdapterOptions {
  /** The agency's source id in Realistimo (<agency_uid>), configured by Realistimo. */
  agencyUid: string;
  /** Resolves a property's city and district to a Realistimo geo internal_id. */
  geo: GeoResolver;
}

function locationIssue(city: string, resolution: GeoResolution): ValidationIssue | null {
  if (resolution.ok) return null;
  if (resolution.reason === 'ambiguous-city') {
    return {
      field: 'city',
      message:
        `Realistimo has several places named "${city}" (${resolution.candidates.join(', ')}) ` +
        'and cannot tell which one is meant.',
    };
  }
  return {
    field: 'city',
    message: `Realistimo cannot find "${city}" in its list of locations; check the city name.`,
  };
}

/** Realistimo's rules for a property; an empty list means the offer can go into the feed. */
export function validateForRealistimo(
  property: PortalProperty,
  geo: GeoResolver,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (property.title === null || property.title.trim() === '') {
    issues.push({ field: 'title', message: 'Realistimo needs a title.' });
  }
  if (property.description === null || property.description.trim() === '') {
    issues.push({
      field: 'description',
      message:
        'Realistimo needs a description: it marks the description as strongly recommended for publication.',
    });
  }
  if (property.price === null || !(property.price > 0)) {
    issues.push({ field: 'price', message: 'Realistimo needs a price above 0.' });
  } else if (Number(realistimoPrice(property.price)) <= 1) {
    issues.push({
      field: 'price',
      message: 'Realistimo shows a price of 0 or 1 as "price on request"; enter the full price.',
    });
  }
  if (property.currency.toUpperCase() !== 'EUR') {
    issues.push({ field: 'currency', message: 'Realistimo accepts prices in euros (EUR) only.' });
  }
  // Realistimo stores a garage or parking space without an area as 18 m².
  if ((property.areaM2 === null || !(property.areaM2 > 0)) && property.type !== 'garage') {
    issues.push({ field: 'areaM2', message: 'Realistimo needs the floor area (m²).' });
  } else if (property.type === 'land' && property.areaM2 !== null && property.areaM2 < 1) {
    // For land, Realistimo reads a <surface> between 0 and 1 as decares (0.8 = 800 m²).
    issues.push({
      field: 'areaM2',
      message: 'Realistimo reads a land area below 1 as decares; enter the area in m².',
    });
  }
  const location = locationIssue(property.city, geo.resolve(property.city, property.district));
  if (location !== null) issues.push(location);
  if (property.images.length === 0) {
    issues.push({ field: 'images', message: 'Realistimo needs at least one photo.' });
  }
  if (property.broker === null) {
    issues.push({
      field: 'createdBy',
      message:
        'Realistimo needs a broker for every offer, and this property has no creator to name.',
    });
  }
  return issues;
}

/** Realistimo as a feed adapter spec: plain functions, no I/O (see createFeedAdapter). */
export function realistimoFeedSpec(options: RealistimoAdapterOptions): FeedAdapterSpec {
  const { agencyUid, geo } = options;
  return {
    key: REALISTIMO_KEY,
    displayName: REALISTIMO_DISPLAY_NAME,
    messages: {
      publish: 'Added to the Realistimo feed (next import picks it up)',
      update: 'Updated in the Realistimo feed (next import picks it up)',
    },

    validate: (property) => validateForRealistimo(property, geo),

    buildPayload(property, previousPayload, now) {
      const location = geo.resolve(property.city, property.district);
      if (!location.ok) throw new PortalError('Realistimo location not found', false);
      const payload: RealistimoOfferPayload = buildRealistimoOffer(property, location.internalId);
      // Realistimo skips most fields of an offer whose <last_update> is not newer than what it
      // imported, so it moves on with every change of the offer, whatever caused it.
      payload.last_update = realistimoLastUpdate(payload, previousPayload, now);
      return {
        payload,
        details: {
          agencyUid,
          offerUid: payload.offer_uid,
          internalId: location.internalId,
          location: location.label,
          locationLevel: location.level,
        },
      };
    },

    buildRemoval(previousPayload, property) {
      if (previousPayload === null) {
        // Nothing of this listing was ever served, so there is nothing to take down.
        return {
          payload: null,
          message: 'Not in the Realistimo feed; nothing to remove',
          details: { agencyUid, offerUid: property?.refCode ?? null },
        };
      }
      // The offer leaves <offers>: Realistimo takes it down at its next import.
      const previousUid = previousPayload.offer_uid;
      const offerUid =
        typeof previousUid === 'string' && previousUid !== ''
          ? previousUid
          : (property?.refCode ?? null);
      return {
        payload: null,
        message: 'Removed from the Realistimo feed (next import takes the offer down)',
        details: { agencyUid, offerUid },
      };
    },
  };
}

export function createRealistimoAdapter(options: RealistimoAdapterOptions): PortalAdapter {
  return createFeedAdapter(realistimoFeedSpec(options));
}
