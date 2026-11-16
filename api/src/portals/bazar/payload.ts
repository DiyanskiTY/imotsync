import { z } from 'zod';
import type { FeedPayload } from '../types.js';

/** Google Merchant availability values Bazar acts on: out of stock archives the listing. */
export const BAZAR_AVAILABILITY = ['in_stock', 'out_of_stock'] as const;
export type BazarAvailability = (typeof BAZAR_AVAILABILITY)[number];

/**
 * What the Bazar feed serves for one listing, stored in portal_listings.payload. Every value
 * is already computed and formatted, so rendering the feed is a pure function of the
 * stored payloads. Each key is one element of the Google Merchant <item>.
 */
export const bazarItemPayloadSchema = z.object({
  /** g:id: the property's ref code, the stable product code Bazar recognises the listing by. */
  id: z.string().min(1),
  /** title: at most 150 characters (Google Merchant limit). */
  title: z.string().min(1),
  /** description: at most 5000 characters (Google Merchant limit). */
  description: z.string().min(1),
  /** link: the listing on the agency's site, or null when PUBLIC_LISTING_URL_TEMPLATE is empty. */
  link: z.string().min(1).nullable(),
  /** g:image_link: the main (first) photo, absolute URL. */
  imageLink: z.string().min(1),
  /** g:additional_image_link: up to 10 more photos, in display order. */
  additionalImageLinks: z.array(z.string().min(1)).max(10),
  /** g:price, e.g. '245000.00 EUR'. */
  price: z.string().min(1),
  /** g:availability: 'in_stock' while published, 'out_of_stock' once removed. */
  availability: z.enum(BAZAR_AVAILABILITY),
  /** g:product_type: Bulgarian category path, e.g. 'Имоти > Продажби > Апартаменти'. */
  productType: z.string().min(1),
  /** g:custom_label_0: town, in Bulgarian when known ('София'). */
  customLabel0: z.string().min(1),
  /** g:custom_label_1: district / neighbourhood, in Bulgarian when known ('Лозенец'), or null. */
  customLabel1: z.string().min(1).nullable(),
  /** g:custom_label_2: floor area, e.g. '98 м²', or null. */
  customLabel2: z.string().min(1).nullable(),
  /** g:custom_label_3: number of rooms, e.g. '3', or null. */
  customLabel3: z.string().min(1).nullable(),
});

export type BazarItemPayload = z.infer<typeof bazarItemPayloadSchema>;

/** The stored payload as a Bazar item, or null when it is missing or not a Bazar item. */
export function readBazarPayload(payload: FeedPayload | null | undefined): BazarItemPayload | null {
  if (payload === null || payload === undefined) return null;
  const parsed = bazarItemPayloadSchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}
