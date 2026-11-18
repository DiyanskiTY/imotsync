import { HttpParams } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { NonNullableFormBuilder } from '@angular/forms';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { Observable, of } from 'rxjs';

import type { PaginationMeta } from '../core/api/models';
import { injectListPage } from './list-page';
import { UrlQuery } from './url-query';

const QUERY = new UrlQuery(
  {
    page: { type: 'integer', min: 1, max: 1000 },
    pageSize: { type: 'integer', min: 1, max: 100 },
    q: { type: 'text', maxLength: 20 },
    status: { type: 'many', values: ['open', 'closed'] },
    sort: { type: 'one', values: ['name', '-name', '-createdAt'] },
  } as const,
  { page: 1, pageSize: 20, sort: '-createdAt' },
);

interface Item {
  id: number;
}
interface ItemPage {
  data: Item[];
  meta: PaginationMeta;
}

let requests: string[] = [];
let respond: () => Observable<ItemPage> = () =>
  of({ data: [{ id: 1 }], meta: { page: 1, pageSize: 20, total: 45, totalPages: 3 } });

@Component({ template: '', changeDetection: ChangeDetectionStrategy.OnPush })
class ItemsPage {
  readonly filters = inject(NonNullableFormBuilder).group({
    q: '',
    status: [[] as string[]],
  });
  readonly list = injectListPage({
    query: QUERY,
    load: (params: HttpParams) => {
      requests.push(params.toString());
      return respond();
    },
    filters: this.filters,
  });
}

describe('injectListPage', () => {
  let harness: RouterTestingHarness;
  let page: ItemsPage;

  beforeEach(async () => {
    requests = [];
    respond = () =>
      of({ data: [{ id: 1 }], meta: { page: 1, pageSize: 20, total: 45, totalPages: 3 } });
    TestBed.configureTestingModule({
      providers: [provideRouter([{ path: 'items', component: ItemsPage }])],
    });
    harness = await RouterTestingHarness.create();
  });

  async function open(url: string): Promise<void> {
    page = await harness.navigateByUrl(url, ItemsPage);
    await harness.fixture.whenStable();
  }

  const url = () => TestBed.inject(Router).url;
  const settle = async (ms = 0) => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    await harness.fixture.whenStable();
  };

  it('loads what the URL describes, with every value the API needs', async () => {
    await open('/items?status=open&page=2');
    expect(requests).toEqual(['page=2&pageSize=20&status=open&sort=-createdAt']);
    expect(page.list.rows()).toEqual([{ id: 1 }]);
    expect(page.list.total()).toBe(45);
    expect(page.list.first()).toBe(20);
    expect(page.list.sortField()).toBe('createdAt');
    expect(page.list.sortOrder()).toBe(-1);
    expect(page.list.hasFilters()).toBe(true);
  });

  it('claims one more page than the current one until the total is known', async () => {
    respond = () => new Observable<ItemPage>(() => undefined);
    await open('/items?page=3');
    expect(page.list.total()).toBe(61);
  });

  it('pages through the URL', async () => {
    await open('/items');
    page.list.onPage({ first: 40, rows: 20 });
    await settle();
    expect(url()).toBe('/items?page=3');

    page.list.onPage({ first: 0, rows: 50 });
    await settle();
    expect(url()).toBe('/items?pageSize=50');
  });

  it('sorts, going back to page 1, and ignores unchanged or unknown sorts', async () => {
    await open('/items?page=2');
    page.list.onSort({ field: 'createdAt', order: -1 });
    page.list.onSort({ field: 'secret', order: 1 });
    await settle();
    expect(url()).toBe('/items?page=2');

    page.list.onSort({ field: 'name', order: 1 });
    await settle();
    expect(url()).toBe('/items?sort=name');
  });

  it('applies the filter form after a pause and goes back to page 1', async () => {
    await open('/items?page=3');
    page.filters.patchValue({ q: 'flat', status: ['closed'] });
    await settle(400);
    expect(url()).toBe('/items?q=flat&status=closed');
  });

  it('follows the URL into the form (back, forward, links)', async () => {
    await open('/items');
    await harness.navigateByUrl('/items?q=garage&status=open,closed');
    await harness.fixture.whenStable();
    expect(page.filters.getRawValue()).toEqual({ q: 'garage', status: ['open', 'closed'] });
  });

  it('clears the filters but keeps the sort and page size', async () => {
    await open('/items?q=flat&status=open&sort=name&pageSize=50&page=2');
    page.list.clearFilters();
    await settle();
    expect(url()).toBe('/items?pageSize=50&sort=name');
    expect(page.filters.getRawValue()).toEqual({ q: '', status: [] });
    expect(page.list.hasFilters()).toBe(false);
  });

  it('sets filters from outside the form and reloads on request', async () => {
    await open('/items?page=2');
    page.list.patch({ status: ['closed'] });
    await settle();
    expect(url()).toBe('/items?status=closed');

    const before = requests.length;
    page.list.reload();
    await settle();
    expect(requests.length).toBe(before + 1);
  });
});
