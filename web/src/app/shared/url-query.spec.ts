import { convertToParamMap } from '@angular/router';

import { UrlQuery } from './url-query';

const query = new UrlQuery(
  {
    page: { type: 'integer', min: 1, max: 1_000_000 },
    pageSize: { type: 'integer', min: 1, max: 100 },
    q: { type: 'text', maxLength: 10 },
    priceMin: { type: 'number', min: 0, max: 1_000 },
    sort: { type: 'one', values: ['price', '-price', '-updatedAt'] },
    status: { type: 'many', values: ['draft', 'active', 'archived'] },
    portal: { type: 'many' },
  } as const,
  { page: 1, pageSize: 20, sort: '-updatedAt' },
);

describe('UrlQuery', () => {
  describe('fromParams', () => {
    it('reads every kind of field', () => {
      const state = query.fromParams(
        convertToParamMap({
          page: '3',
          pageSize: '50',
          q: ' flat ',
          priceMin: '12.5',
          sort: '-price',
          status: 'draft,active',
          portal: ['bazar', 'demo'],
        }),
      );
      expect(state).toEqual({
        page: 3,
        pageSize: 50,
        q: 'flat',
        priceMin: 12.5,
        sort: '-price',
        status: ['draft', 'active'],
        portal: ['bazar', 'demo'],
      });
    });

    it('fills in the defaults for missing fields', () => {
      expect(query.fromParams(convertToParamMap({}))).toEqual({
        page: 1,
        pageSize: 20,
        sort: '-updatedAt',
      });
    });

    it.each([
      ['page', '0'],
      ['page', '2.5'],
      ['page', 'abc'],
      ['pageSize', '101'],
      ['priceMin', '-1'],
      ['priceMin', '1e9'],
      ['sort', 'refCode'],
      ['q', '   '],
      ['q', 'longer than ten'],
    ])('drops an invalid %s=%j and keeps the default', (key, value) => {
      const state = query.fromParams(convertToParamMap({ [key]: value }));
      expect(state).toEqual({ page: 1, pageSize: 20, sort: '-updatedAt' });
    });

    it('keeps only known values of a list, without duplicates', () => {
      const state = query.fromParams(convertToParamMap({ status: 'draft,bogus,draft,,archived' }));
      expect(state.status).toEqual(['draft', 'archived']);
    });

    it('ignores parameters it does not know', () => {
      expect(query.fromParams(convertToParamMap({ evil: '1' }))).not.toHaveProperty('evil');
    });
  });

  describe('toQueryParams', () => {
    it('writes lists comma-separated and leaves defaults and empty values out', () => {
      expect(
        query.toQueryParams({
          page: 1,
          pageSize: 50,
          q: '',
          sort: '-updatedAt',
          status: ['draft', 'active'],
          portal: [],
        }),
      ).toEqual({ pageSize: '50', status: 'draft,active' });
    });

    it('round-trips through fromParams', () => {
      const state = {
        page: 4,
        pageSize: 20,
        q: 'Sofia',
        priceMin: 100,
        sort: 'price',
        status: ['archived'],
        portal: ['realistimo'],
      } as const;
      const params = convertToParamMap(query.toQueryParams(state));
      expect(query.fromParams(params)).toEqual(state);
    });
  });

  describe('normalize and equivalent', () => {
    const ranged = new UrlQuery(
      {
        min: { type: 'number', min: 0, max: 100 },
        max: { type: 'number', min: 0, max: 100 },
        q: { type: 'text', maxLength: 10 },
      } as const,
      {},
      (state) =>
        state.min !== undefined && state.max !== undefined && state.max < state.min
          ? { ...state, max: undefined }
          : state,
    );

    it('applies the cross-field rule when reading and when writing', () => {
      expect(ranged.fromParams(convertToParamMap({ min: '50', max: '10' }))).toEqual({ min: 50 });
      expect(ranged.toQueryParams({ min: 50, max: 10 })).toEqual({ min: '50' });
      expect(ranged.toHttpParams({ min: 50, max: 10 }).keys()).toEqual(['min']);
    });

    it('treats states that read back the same as equivalent', () => {
      expect(ranged.equivalent({ q: 'Sofia ' }, { q: 'Sofia' })).toBe(true);
      expect(ranged.equivalent({ min: 50, max: 1 }, { min: 50 })).toBe(true);
      expect(ranged.equivalent({ q: 'x'.repeat(11) }, {})).toBe(true);
      expect(ranged.equivalent({ q: 'Sofia' }, { q: 'Varna' })).toBe(false);
    });
  });

  describe('toHttpParams', () => {
    it('sends every set value, including defaults, and nothing else', () => {
      const params = query.toHttpParams({
        page: 2,
        pageSize: 20,
        sort: '-updatedAt',
        status: ['draft', 'active'],
        q: '',
        portal: [],
      });
      expect(params.keys()).toEqual(['page', 'pageSize', 'sort', 'status']);
      expect(params.get('status')).toBe('draft,active');
      expect(params.get('page')).toBe('2');
    });
  });
});
