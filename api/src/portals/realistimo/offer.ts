import { isDeepStrictEqual } from 'node:util';
import type { DealType, PropertyType } from '../../db/types.js';
import type { FeedPayload, PortalBroker, PortalProperty } from '../types.js';
import { formatSofiaDateTime } from './time.js';

/*
 * One Realistimo <offer>, built from a property. Element names, values and their order
 * follow Realistimo's XML import documentation (realistimo.com/bg/docs/import/xml/).
 * Values are kept as the exact strings the feed serves, so the feed renderer is a pure
 * function of the stored payloads.
 */

/** <category>: the deal type. */
export const REALISTIMO_CATEGORIES: Readonly<Record<DealType, string>> = {
  sale: 'продажби',
  rent: 'наеми',
};

/** <subcategory> per property type; apartments are refined by their number of rooms. */
export const REALISTIMO_SUBCATEGORIES: Readonly<Record<PropertyType, string>> = {
  apartment: 'АПАРТАМЕНТ',
  house: 'КЪЩА',
  office: 'ОФИС',
  shop: 'МАГАЗИН',
  land: 'ПАРЦЕЛ',
  garage: 'ГАРАЖ',
  other: 'ДРУГО',
};

/** Types for which Realistimo fills in rooms (not land, garage, ...); rooms_count is sent explicitly. */
const TYPES_WITH_ROOMS: readonly PropertyType[] = ['apartment', 'house', 'office'];

/** Prefix of <broker_id>/<BrokerID>: the agent's source id is 'imotsync-' + the user id. */
export const REALISTIMO_BROKER_ID_PREFIX = 'imotsync-';

/** The <offer> children ImotSync sends, in the order of Realistimo's documentation. */
export const REALISTIMO_OFFER_FIELDS = [
  'offer_uid',
  'last_update',
  'offer_code',
  'title',
  'description',
  'images',
  'price',
  'surface',
  'currency',
  'category',
  'subcategory',
  'internal_id',
  'floor',
  'floorAll',
  'rooms_count',
  'broker_id',
] as const;

export type RealistimoOfferField = (typeof REALISTIMO_OFFER_FIELDS)[number];

/** A <Broker> in <Brokers>. */
export interface RealistimoBroker {
  BrokerID: string;
  BrokerName: string;
  BrokerEmail?: string;
}

/** Offer elements that are left out when the property has no value for them. */
type OptionalOfferField = 'surface' | 'floor' | 'floorAll' | 'rooms_count';

/** portal_listings.payload of a Realistimo listing that the feed serves. */
export type RealistimoOfferPayload = Record<
  Exclude<RealistimoOfferField, OptionalOfferField>,
  string
> &
  Partial<Record<OptionalOfferField, string>> & {
    /** Kept next to the offer so the renderer can list the offer's agent in <Brokers>. */
    broker: RealistimoBroker;
  };

/** <subcategory> for a property: apartments by rooms (1-СТАЕН ... МНОГОСТАЕН), else by type. */
export function realistimoSubcategory(type: PropertyType, rooms: number | null): string {
  if (type !== 'apartment' || rooms === null || rooms < 1) return REALISTIMO_SUBCATEGORIES[type];
  return rooms >= 5 ? 'МНОГОСТАЕН' : `${Math.floor(rooms)}-СТАЕН`;
}

export function realistimoBrokerId(userId: number): string {
  return `${REALISTIMO_BROKER_ID_PREFIX}${userId}`;
}

export function realistimoBroker(broker: PortalBroker): RealistimoBroker {
  return {
    BrokerID: realistimoBrokerId(broker.id),
    BrokerName: broker.fullName,
    ...(broker.email === '' ? {} : { BrokerEmail: broker.email }),
  };
}

/** Whole euros, digits only: Realistimo cuts everything after the first '.' or ','. */
export function realistimoPrice(price: number): string {
  return String(Math.round(price));
}

/** Square metres with a dot decimal and at most two decimals ("98", "98.5"). */
export function realistimoSurface(areaM2: number): string {
  return String(Number(areaM2.toFixed(2)));
}

/** Photo URLs in display order, separated by ';' (a ';' inside a URL is percent-encoded). */
export function realistimoImages(images: PortalProperty['images']): string {
  return [...images]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((image) => image.url.replaceAll(';', '%3B'))
    .join(';');
}

/** The offer without <last_update>, for comparing two versions of it. */
function withoutLastUpdate(payload: FeedPayload): FeedPayload {
  const { last_update: _lastUpdate, ...rest } = payload;
  return rest;
}

/**
 * <last_update>: when the offer's content last changed. Realistimo skips most fields of an
 * offer whose <last_update> is not newer than the change it last imported, so the date must
 * move with every change of what the offer says, including changes that are not edits of the
 * property (a more precise location once the full geo list is installed, new photo URLs after
 * a change of PUBLIC_BASE_URL, a change in the mapping). A job that builds an offer whose
 * content differs from the stored one dates it with the job's time (now); an identical
 * offer keeps the date it had.
 */
export function realistimoLastUpdate(
  offer: FeedPayload,
  previous: FeedPayload | null,
  now: Date,
): string {
  const previousDate = previous?.last_update;
  if (
    previous !== null &&
    typeof previousDate === 'string' &&
    previousDate !== '' &&
    isDeepStrictEqual(withoutLastUpdate(offer), withoutLastUpdate(previous))
  ) {
    return previousDate;
  }
  return formatSofiaDateTime(now);
}

/**
 * The payload for a property that passed validation. The caller resolves the location
 * (internalId) and guarantees title, description, price and broker are present.
 */
export function buildRealistimoOffer(
  property: PortalProperty,
  internalId: number,
): RealistimoOfferPayload {
  const { broker, areaM2, floor, totalFloors, rooms } = property;
  if (broker === null || property.price === null) {
    throw new Error(`Property ${property.refCode} is not ready for Realistimo`);
  }
  const hasRooms = TYPES_WITH_ROOMS.includes(property.type) && rooms !== null && rooms > 0;
  // Written in the documented order, so the stored payload reads like the feed.
  return {
    offer_uid: property.refCode,
    last_update: formatSofiaDateTime(property.updatedAt),
    offer_code: property.refCode,
    title: property.title ?? '',
    description: property.description ?? '',
    images: realistimoImages(property.images),
    price: realistimoPrice(property.price),
    // A garage without an area is stored as 18 m² by Realistimo, so <surface> may be left out.
    ...(areaM2 !== null && areaM2 > 0 ? { surface: realistimoSurface(areaM2) } : {}),
    currency: 'eur',
    category: REALISTIMO_CATEGORIES[property.dealType],
    subcategory: realistimoSubcategory(property.type, rooms),
    internal_id: String(internalId),
    // Realistimo ignores floor 0, so it is left out like an unknown floor.
    ...(floor !== null && floor !== 0 ? { floor: String(floor) } : {}),
    ...(totalFloors !== null && totalFloors > 0 ? { floorAll: String(totalFloors) } : {}),
    ...(hasRooms ? { rooms_count: String(rooms) } : {}),
    broker_id: realistimoBrokerId(broker.id),
    broker: realistimoBroker(broker),
  };
}
