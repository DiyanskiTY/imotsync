import { HttpParams, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import type { BulkDeleteItem, BulkPublishItem, PropertyDetail, PropertyList } from './models';
import { PropertiesApi } from './properties-api';

describe('PropertiesApi', () => {
  let api: PropertiesApi;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    api = TestBed.inject(PropertiesApi);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('lists properties with the given query', () => {
    const page: PropertyList = {
      data: [],
      meta: { page: 2, pageSize: 20, total: 21, totalPages: 2 },
    };
    let result: PropertyList | undefined;
    api.list(new HttpParams().set('page', '2').set('status', 'draft,active')).subscribe((r) => {
      result = r;
    });

    const request = http.expectOne((r) => r.url === '/api/properties');
    expect(request.request.method).toBe('GET');
    expect(request.request.params.toString()).toBe('page=2&status=draft,active');
    request.flush(page);
    expect(result).toEqual(page);
  });

  it('creates, reads and updates a property (bare bodies)', () => {
    const detail = { id: 7, refCode: 'IS-00007' } as PropertyDetail;
    const seen: PropertyDetail[] = [];

    api
      .create({ type: 'apartment', dealType: 'sale', city: 'Sofia' })
      .subscribe((p) => seen.push(p));
    const create = http.expectOne('/api/properties');
    expect(create.request.method).toBe('POST');
    create.flush(detail, { status: 201, statusText: 'Created' });

    api.get(7).subscribe((p) => seen.push(p));
    http.expectOne('/api/properties/7').flush(detail);

    api.update(7, { price: 1000 }).subscribe((p) => seen.push(p));
    const patch = http.expectOne('/api/properties/7');
    expect(patch.request.method).toBe('PATCH');
    expect(patch.request.body).toEqual({ price: 1000 });
    patch.flush(detail);

    expect(seen).toEqual([detail, detail, detail]);
  });

  it.each([
    [204, null, 'deleted'],
    [202, { data: { result: 'deletion_scheduled' } }, 'deletion_scheduled'],
  ] as const)('reports a %i delete as %s', (status, body, expected) => {
    let result: string | undefined;
    api.delete(7).subscribe((r) => (result = r));
    const request = http.expectOne('/api/properties/7');
    expect(request.request.method).toBe('DELETE');
    request.flush(body, { status, statusText: 'OK' });
    expect(result).toBe(expected);
  });

  it('runs the bulk actions and unwraps their results', () => {
    const published: BulkPublishItem[] = [{ propertyId: 1, ok: true, jobs: [] }];
    const deleted: BulkDeleteItem[] = [{ propertyId: 1, result: 'removal_queued' }];
    let publishResult: BulkPublishItem[] | undefined;
    let deleteResult: BulkDeleteItem[] | undefined;

    api.bulkPublish([1, 2], ['bazar']).subscribe((r) => (publishResult = r));
    const publish = http.expectOne('/api/properties/bulk/publish');
    expect(publish.request.body).toEqual({ propertyIds: [1, 2], portals: ['bazar'] });
    publish.flush({ data: published });

    api.bulkDelete([1]).subscribe((r) => (deleteResult = r));
    const remove = http.expectOne('/api/properties/bulk/delete');
    expect(remove.request.body).toEqual({ propertyIds: [1] });
    remove.flush({ data: deleted });

    expect(publishResult).toEqual(published);
    expect(deleteResult).toEqual(deleted);
  });
});
