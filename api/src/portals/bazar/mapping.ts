import type { DealType, PropertyType } from '../../db/types.js';
import type { PortalProperty } from '../types.js';
import { toBulgarianCityName } from './cities.js';
import type { BazarAvailability, BazarItemPayload } from './payload.js';
import { singleLine, truncate, xmlSafe } from './text.js';

/** Google Merchant limits, which Bazar's Google feed import is assumed to share. */
export const BAZAR_TITLE_MAX = 150;
export const BAZAR_DESCRIPTION_MAX = 5000;
/** Google Merchant allows up to 10 additional_image_link values per item. */
export const BAZAR_ADDITIONAL_IMAGES_MAX = 10;

const DEAL_TYPE_NAMES: Record<DealType, string> = {
  sale: 'Продажби',
  rent: 'Наеми',
};

const PROPERTY_TYPE_NAMES: Record<PropertyType, string> = {
  apartment: 'Апартаменти',
  house: 'Къщи',
  office: 'Офиси',
  shop: 'Магазини',
  land: 'Парцели и земя',
  garage: 'Гаражи',
  other: 'Други',
};

/**
 * The category path in g:product_type, e.g. 'Имоти > Продажби > Апартаменти'. Bazar maps
 * each distinct value to one of its own categories once, in its interface (its category
 * list is not public), so the 14 type / deal combinations are mapped once per agency.
 */
export function bazarProductType(type: PropertyType, dealType: DealType): string {
  return `Имоти > ${DEAL_TYPE_NAMES[dealType]} > ${PROPERTY_TYPE_NAMES[type]}`;
}

/** '245000.00 EUR': Google Merchant price format, two decimals and the ISO currency. */
export function formatBazarPrice(price: number, currency = 'EUR'): string {
  return `${(Math.round(price * 100) / 100).toFixed(2)} ${currency.toUpperCase()}`;
}

/** '98 м²', '98,5 м²' (Bulgarian decimal comma). */
export function formatArea(areaM2: number): string {
  const rounded = Math.round(areaM2 * 100) / 100;
  return `${String(rounded).replace('.', ',')} м²`;
}

/** The agency's own page for the listing, or null when no template is configured. */
export function listingUrl(template: string | null | undefined, refCode: string): string | null {
  const trimmed = template?.trim() ?? '';
  if (trimmed.length === 0) return null;
  return trimmed.replaceAll('{refCode}', encodeURIComponent(refCode));
}

/**
 * Bulgarian (Cyrillic) names of a property's town and district from a list of places, e.g.
 * ('Sofia', 'Lozenets') -> { city: 'София', district: 'Лозенец' }; null for a name the list
 * does not know. The registry wires Realistimo's geo list.
 */
export type BazarPlaceNames = (
  city: string,
  district: string | null,
) => { city: string | null; district: string | null };

export interface BazarItemOptions {
  /** PUBLIC_LISTING_URL_TEMPLATE, e.g. 'https://agency.example/properties/{refCode}'. */
  listingUrlTemplate?: string | null;
  availability?: BazarAvailability;
  /**
   * Bulgarian place names for the custom labels (Bazar expects Bulgarian text). Without it,
   * or for a name it does not know, the town comes from the built-in list of towns and the
   * district is used as entered.
   */
  placeNames?: BazarPlaceNames;
}

export interface BuiltBazarItem {
  payload: BazarItemPayload;
  /** Fields cut to the feed's length limits: 'title', 'description'. */
  truncated: string[];
}

/**
 * Builds the feed item for a property. Expects a property that passed validateForBazar():
 * it throws a TypeError when the title, description, price, town or photos are missing.
 */
export function buildBazarItem(
  property: PortalProperty,
  options: BazarItemOptions = {},
): BuiltBazarItem {
  const images = [...property.images].sort((a, b) => a.sortOrder - b.sortOrder);
  const [main, ...more] = images;
  const titleText = singleLine(xmlSafe(property.title ?? ''));
  const descriptionText = xmlSafe(property.description ?? '').trim();
  const enteredDistrict = singleLine(xmlSafe(property.district ?? ''));
  const known = options.placeNames?.(
    property.city,
    enteredDistrict === '' ? null : enteredDistrict,
  );
  const city = singleLine(xmlSafe(known?.city ?? toBulgarianCityName(property.city)));
  if (!main || property.price === null || !titleText || !descriptionText || !city) {
    throw new TypeError(
      `Property ${property.refCode} is not ready for Bazar (title, description, price, town and a photo are required).`,
    );
  }

  const title = truncate(titleText, BAZAR_TITLE_MAX);
  const description = truncate(descriptionText, BAZAR_DESCRIPTION_MAX);
  const district =
    enteredDistrict === '' ? '' : singleLine(xmlSafe(known?.district ?? enteredDistrict));

  return {
    payload: {
      id: property.refCode,
      title: title.text,
      description: description.text,
      link: listingUrl(options.listingUrlTemplate, property.refCode),
      imageLink: main.url,
      additionalImageLinks: more.slice(0, BAZAR_ADDITIONAL_IMAGES_MAX).map((image) => image.url),
      price: formatBazarPrice(property.price, property.currency),
      availability: options.availability ?? 'in_stock',
      productType: bazarProductType(property.type, property.dealType),
      customLabel0: city,
      customLabel1: district === '' ? null : district,
      customLabel2: property.areaM2 === null ? null : formatArea(property.areaM2),
      customLabel3: property.rooms === null ? null : String(property.rooms),
    },
    truncated: [
      ...(title.truncated ? ['title'] : []),
      ...(description.truncated ? ['description'] : []),
    ],
  };
}
