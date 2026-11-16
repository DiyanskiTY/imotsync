/*
 * Bazar.bg adapter (key 'bazar', mode 'feed').
 *
 * Bazar imports listings from a product feed registered once in a Bazar Premium account and
 * documents Google Shopping / Merchant feeds as working directly. Bazar publishes no feed
 * schema: which Google elements it reads, its category list and how locations are given are
 * shown only in its logged-in interface, so the field mapping (g:product_type and the
 * custom labels) is confirmed there during onboarding.
 *
 * Wiring (registry):
 *   adapter: createBazarAdapter({
 *     listingUrlTemplate: config.portals.publicListingUrlTemplate,
 *     placeNames: placeNamesFrom(geo), // Bulgarian names from Realistimo's geo list
 *   }),
 *   feedRenderer: createBazarFeedRenderer({
 *     publicBaseUrl: config.publicBaseUrl,
 *     removedRetentionDays: config.portals.bazar.removedRetentionDays,
 *   }),
 */

export {
  BAZAR_DISPLAY_NAME,
  BAZAR_PORTAL_KEY,
  createBazarAdapter,
  type BazarAdapterOptions,
} from './adapter.js';
export { toBulgarianCityName } from './cities.js';
export { findContactDetails, type ContactKind, type ContactMatch } from './contact-detection.js';
export {
  BAZAR_FEED_CONTENT_TYPE,
  GOOGLE_MERCHANT_NAMESPACE,
  createBazarFeedRenderer,
  type BazarFeedRendererOptions,
} from './feed.js';
export {
  BAZAR_ADDITIONAL_IMAGES_MAX,
  BAZAR_DESCRIPTION_MAX,
  BAZAR_TITLE_MAX,
  bazarProductType,
  buildBazarItem,
  formatBazarPrice,
  type BazarItemOptions,
  type BazarPlaceNames,
  type BuiltBazarItem,
} from './mapping.js';
export {
  BAZAR_AVAILABILITY,
  bazarItemPayloadSchema,
  readBazarPayload,
  type BazarAvailability,
  type BazarItemPayload,
} from './payload.js';
export { BAZAR_MIN_PHOTO_SIDE_PX, validateForBazar } from './validation.js';
