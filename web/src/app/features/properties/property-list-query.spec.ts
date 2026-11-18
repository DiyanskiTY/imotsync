import { convertToParamMap } from '@angular/router';

import { PROPERTY_LIST_QUERY } from './property-list-query';

const readPropertyListState = PROPERTY_LIST_QUERY.fromParams.bind(PROPERTY_LIST_QUERY);

describe('property list query', () => {
  it('reads filters, sort and page from the URL', () => {
    const state = readPropertyListState(
      convertToParamMap({
        status: 'draft,active',
        portal: 'bazar',
        portalStatus: 'error',
        sort: '-price',
        page: '2',
      }),
    );
    expect(state).toEqual({
      page: 2,
      pageSize: 20,
      sort: '-price',
      status: ['draft', 'active'],
      portal: 'bazar',
      portalStatus: ['error'],
    });
  });

  it('drops a maximum price below the minimum', () => {
    const state = readPropertyListState(convertToParamMap({ priceMin: '500', priceMax: '100' }));
    expect(state.priceMin).toBe(500);
    expect(state.priceMax).toBeUndefined();
  });

  it('sends only the API query fields', () => {
    const params = PROPERTY_LIST_QUERY.toHttpParams(
      readPropertyListState(convertToParamMap({ q: 'flat', unknown: 'x' })),
    );
    expect(params.toString()).toBe('page=1&pageSize=20&q=flat&sort=-updatedAt');
  });
});
