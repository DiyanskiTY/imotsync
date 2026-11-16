import type { PortalProperty, ValidationIssue } from '../types.js';
import { findContactDetails, type ContactKind } from './contact-detection.js';
import { BAZAR_ADDITIONAL_IMAGES_MAX } from './mapping.js';

/*
 * Bazar's rules for a listing, from its General Terms and its import page:
 * - Art. 7: titles and texts must be in Bulgarian (Cyrillic).
 * - Art. 8: every listing states a concrete price in euro (no 'price on request').
 * - Art. 18: no contact details, phone numbers or URLs in the title or description.
 * - Import page: photos of at least 250 x 250 px. Bazar states this for its spreadsheet
 *   import; that the same minimum applies to feed images is assumed (to confirm during
 *   onboarding).
 */

/** Smallest photo Bazar accepts, in pixels per side. */
export const BAZAR_MIN_PHOTO_SIDE_PX = 250;

/** Photos the feed carries: the main photo plus up to 10 additional ones. */
const PHOTOS_IN_FEED = 1 + BAZAR_ADDITIONAL_IMAGES_MAX;

const CYRILLIC = /\p{Script=Cyrillic}/u;

const KIND_NAMES: Record<ContactKind, string> = {
  phone: 'phone numbers',
  email: 'e-mail addresses',
  url: 'web addresses',
};

/** How many of the contact details found an issue quotes. */
const MAX_QUOTED = 3;

function textIssues(field: 'title' | 'description', value: string | null): ValidationIssue[] {
  const text = value?.trim() ?? '';
  if (text.length === 0) return [{ field, message: `Bazar needs a ${field}.` }];

  const issues: ValidationIssue[] = [];
  if (!CYRILLIC.test(text)) {
    issues.push({
      field,
      message: `Bazar requires the ${field} in Bulgarian (Cyrillic letters).`,
    });
  }
  const byKind = new Map<ContactKind, Set<string>>();
  for (const match of findContactDetails(text)) {
    const found = byKind.get(match.kind) ?? new Set<string>();
    byKind.set(match.kind, found.add(match.text.trim()));
  }
  for (const [kind, found] of byKind) {
    const quoted = [...found].slice(0, MAX_QUOTED).map((item) => `"${item}"`);
    if (found.size > MAX_QUOTED) quoted.push(`${found.size - MAX_QUOTED} more`);
    issues.push({
      field,
      message: `Bazar does not allow ${KIND_NAMES[kind]} in the ${field} (found ${quoted.join(', ')}).`,
    });
  }
  return issues;
}

/** Checks a property against Bazar's rules. An empty list means it can be published. */
export function validateForBazar(property: PortalProperty): ValidationIssue[] {
  const issues: ValidationIssue[] = [
    ...textIssues('title', property.title),
    ...textIssues('description', property.description),
  ];

  if (property.price === null || !(property.price > 0)) {
    issues.push({ field: 'price', message: 'Bazar requires a concrete price in euro.' });
  } else if (property.currency.toUpperCase() !== 'EUR') {
    issues.push({
      field: 'currency',
      message: `Bazar requires the price in euro (EUR), not ${property.currency}.`,
    });
  }

  if (property.images.length === 0) {
    issues.push({ field: 'images', message: 'Bazar needs at least one photo.' });
  } else {
    // Only the photos the feed carries are checked (the first 11 in display order); photos
    // whose size is unknown (null) are given the benefit of the doubt.
    const tooSmall = [...property.images]
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .slice(0, PHOTOS_IN_FEED)
      .flatMap(({ width, height }, index) =>
        width !== null &&
        height !== null &&
        (width < BAZAR_MIN_PHOTO_SIDE_PX || height < BAZAR_MIN_PHOTO_SIDE_PX)
          ? [`photo ${index + 1} is ${width}×${height}`]
          : [],
      );
    if (tooSmall.length > 0) {
      const list = tooSmall.join(', ');
      issues.push({
        field: 'images',
        message: `Bazar needs photos of at least ${BAZAR_MIN_PHOTO_SIDE_PX}×${BAZAR_MIN_PHOTO_SIDE_PX} px (${list}).`,
      });
    }
  }

  return issues;
}
