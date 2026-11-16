import { describe, expect, it } from 'vitest';
import { DEMO_PROPERTIES } from '../../../../src/db/seeds/demo-data.js';
import { createBazarAdapter } from '../../../../src/portals/bazar/adapter.js';
import { validateForBazar } from '../../../../src/portals/bazar/validation.js';
import { photo, readyProperty } from './fixtures.js';

const fieldsOf = (issues: { field: string }[]) => issues.map((issue) => issue.field);

describe('validateForBazar', () => {
  it('accepts a property that meets every rule', () => {
    expect(validateForBazar(readyProperty())).toEqual([]);
  });

  it('is the adapter validate()', () => {
    const adapter = createBazarAdapter();
    expect(adapter.validate(readyProperty({ title: null }))).toEqual(
      validateForBazar(readyProperty({ title: null })),
    );
  });

  describe('title and description', () => {
    it.each([null, '', '   '])('requires a title (%j)', (title) => {
      expect(validateForBazar(readyProperty({ title }))).toEqual([
        { field: 'title', message: 'Bazar needs a title.' },
      ]);
    });

    it.each([null, '', ' \n '])('requires a description (%j)', (description) => {
      expect(validateForBazar(readyProperty({ description }))).toEqual([
        { field: 'description', message: 'Bazar needs a description.' },
      ]);
    });

    it('requires Bulgarian (Cyrillic) text in the title and the description', () => {
      const issues = validateForBazar(
        readyProperty({
          title: 'Three-bedroom apartment in Lozenets',
          description: 'Bright apartment on the fourth floor, 98 sq m.',
        }),
      );
      expect(issues).toEqual([
        { field: 'title', message: 'Bazar requires the title in Bulgarian (Cyrillic letters).' },
        {
          field: 'description',
          message: 'Bazar requires the description in Bulgarian (Cyrillic letters).',
        },
      ]);
    });

    it('accepts mixed Bulgarian and Latin text', () => {
      expect(
        validateForBazar(readyProperty({ title: 'Апартамент в комплекс Sky Fort, Wi-Fi' })),
      ).toEqual([]);
    });

    it('rejects a phone number in the title, quoting it', () => {
      expect(validateForBazar(readyProperty({ title: 'Тристаен в Лозенец 0888 123 456' }))).toEqual(
        [
          {
            field: 'title',
            message: 'Bazar does not allow phone numbers in the title (found "0888 123 456").',
          },
        ],
      );
    });

    it('reports each kind of contact detail once per field, listing what it found', () => {
      const issues = validateForBazar(
        readyProperty({
          description:
            'Светъл апартамент. Тел. 0888 123 456 или +359 2 123 4567, 0888 123 456. ' +
            'Пишете на office@agency.bg, още снимки на www.agency.bg.',
        }),
      );
      expect(issues).toEqual([
        {
          field: 'description',
          message:
            'Bazar does not allow phone numbers in the description (found "0888 123 456", "+359 2 123 4567").',
        },
        {
          field: 'description',
          message:
            'Bazar does not allow e-mail addresses in the description (found "office@agency.bg").',
        },
        {
          field: 'description',
          message: 'Bazar does not allow web addresses in the description (found "www.agency.bg").',
        },
      ]);
    });

    it('quotes at most three findings', () => {
      const description =
        'Телефони: 0888 111 111, 0888 222 222, 0888 333 333, 0888 444 444, 02 123 4567.';
      expect(validateForBazar(readyProperty({ description }))).toEqual([
        {
          field: 'description',
          message:
            'Bazar does not allow phone numbers in the description (found "0888 111 111", "0888 222 222", "0888 333 333", 2 more).',
        },
      ]);
    });

    it('does not mistake prices, areas, years and floors for phone numbers', () => {
      const description =
        'Апартамент 98 кв.м на 4/6 етаж, строен 2019 г., цена 1 050 000 €, такса 12 евро на кв.м.';
      expect(validateForBazar(readyProperty({ description }))).toEqual([]);
    });
  });

  describe('price', () => {
    it.each([null, 0, -5])('requires a price above 0 (%j)', (price) => {
      expect(validateForBazar(readyProperty({ price }))).toEqual([
        { field: 'price', message: 'Bazar requires a concrete price in euro.' },
      ]);
    });

    it('requires the price in euro', () => {
      expect(validateForBazar(readyProperty({ currency: 'BGN' }))).toEqual([
        { field: 'currency', message: 'Bazar requires the price in euro (EUR), not BGN.' },
      ]);
    });
  });

  describe('photos', () => {
    it('requires at least one photo', () => {
      expect(validateForBazar(readyProperty({ images: [] }))).toEqual([
        { field: 'images', message: 'Bazar needs at least one photo.' },
      ]);
    });

    it('rejects photos smaller than 250 x 250 px, by display position', () => {
      const images = [
        photo(2, { width: 249, height: 600 }),
        photo(0),
        photo(1, { width: 800, height: 200 }),
      ];
      expect(validateForBazar(readyProperty({ images }))).toEqual([
        {
          field: 'images',
          message:
            'Bazar needs photos of at least 250×250 px (photo 2 is 800×200, photo 3 is 249×600).',
        },
      ]);
    });

    it('checks only the photos the feed carries: the first one and 10 more', () => {
      // 15 photos: the 12th to 15th (by display order) are never sent to Bazar.
      const images = Array.from({ length: 15 }, (_, index) =>
        index >= 11 ? photo(index, { width: 200, height: 150 }) : photo(index),
      );
      expect(validateForBazar(readyProperty({ images }))).toEqual([]);

      // The 11th photo is sent, so it must be large enough.
      const sent = images.map((image, index) =>
        index === 10 ? photo(index, { width: 200, height: 150 }) : image,
      );
      expect(validateForBazar(readyProperty({ images: sent }))).toEqual([
        {
          field: 'images',
          message: 'Bazar needs photos of at least 250×250 px (photo 11 is 200×150).',
        },
      ]);
    });

    it('accepts photos of exactly 250 x 250 px and photos of unknown size', () => {
      const images = [
        photo(0, { width: 250, height: 250 }),
        photo(1, { width: null, height: null }),
        photo(2, { width: 100, height: null }),
      ];
      expect(validateForBazar(readyProperty({ images }))).toEqual([]);
    });
  });

  it('reports every problem at once', () => {
    const issues = validateForBazar(
      readyProperty({ title: null, description: 'Call 0888 123 456', price: null, images: [] }),
    );
    expect(fieldsOf(issues)).toEqual(['title', 'description', 'description', 'price', 'images']);
  });

  it('accepts the titles and descriptions of the seeded properties listed on Bazar', () => {
    const seeded = DEMO_PROPERTIES.filter((demo) =>
      demo.listings.some((listing) => listing.portal === 'bazar' && listing.status !== 'draft'),
    );
    expect(seeded.length).toBeGreaterThan(0);
    for (const demo of seeded) {
      const issues = validateForBazar(
        readyProperty({
          title: demo.title,
          description: demo.description,
          city: demo.city,
          district: demo.district,
          price: demo.price,
        }),
      );
      expect(issues, demo.title ?? '(no title)').toEqual([]);
    }
  });
});
