import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
  TestRequest,
} from '@angular/common/http/testing';
import { ChangeDetectionStrategy, Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { Confirmation, ConfirmationService, MessageService } from 'primeng/api';
import { of } from 'rxjs';

import type { PropertyList, PropertySummary } from '../../core/api/models';
import { PortalsApi } from '../../core/api/portals-api';
import { PORTALS, propertySummary } from '../../testing/fixtures';
import { PropertyListPage } from './property-list-page';

@Component({ template: 'other page', changeDetection: ChangeDetectionStrategy.OnPush })
class BlankPage {}

function page(rows: PropertySummary[], total = rows.length): PropertyList {
  return { data: rows, meta: { page: 1, pageSize: 20, total, totalPages: 1 } };
}

describe('PropertyListPage', () => {
  let http: HttpTestingController;
  let harness: RouterTestingHarness;

  beforeEach(async () => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'properties', component: PropertyListPage },
          { path: 'properties/:id', component: BlankPage },
        ]),
        provideHttpClient(),
        provideHttpClientTesting(),
        MessageService,
        ConfirmationService,
        { provide: PortalsApi, useValue: { portals$: of(PORTALS.slice(0, 2)) } },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    harness = await RouterTestingHarness.create();
  });

  afterEach(() => http.verify());

  const root = () => harness.fixture.nativeElement as HTMLElement;
  const url = () => TestBed.inject(Router).url;

  function expectList(): TestRequest {
    return http.expectOne((request) => request.url === '/api/properties');
  }

  async function open(path: string, rows: PropertySummary[] = [propertySummary()], total = 100) {
    await harness.navigateByUrl(path);
    const request = expectList();
    request.flush(page(rows, total));
    await harness.fixture.whenStable();
    return request;
  }

  async function settle(ms = 0): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
    await harness.fixture.whenStable();
  }

  it('loads the page the URL describes', async () => {
    const request = await open('/properties?status=draft,active&portal=bazar&page=2');
    expect(request.request.params.toString()).toBe(
      'page=2&pageSize=20&status=draft,active&portal=bazar&sort=-updatedAt',
    );
  });

  it('shows each property with its status on every portal', async () => {
    await open('/properties');
    const row = root().querySelector('[data-testid="property-row-1"]');
    expect(row?.textContent).toContain('IS-00001');
    expect(row?.textContent).toContain('Two-bedroom flat near the park');
    expect(row?.textContent).toContain('Sofia');
    expect(row?.textContent).toContain('Realistimo: Published');
    expect(row?.textContent).toContain('Bazar.bg: Error');
    expect(row?.querySelector('a[href="/properties/1"]')).not.toBeNull();
  });

  it('applies the search after a short pause and goes back to page 1', async () => {
    await open('/properties?page=3');
    const search = root().querySelector<HTMLInputElement>('[data-testid="filter-q"]');
    if (!search) {
      throw new Error('search input not found');
    }
    search.value = 'Lozenets';
    search.dispatchEvent(new Event('input'));
    await settle(400);

    expect(url()).toBe('/properties?q=Lozenets');
    expectList().flush(page([]));
  });

  it('keeps what the user is typing when the URL catches up', async () => {
    await open('/properties');
    const search = root().querySelector<HTMLInputElement>('[data-testid="filter-q"]');
    if (!search) {
      throw new Error('search input not found');
    }
    search.value = 'Sofia ';
    search.dispatchEvent(new Event('input'));
    await settle(400);
    expectList().flush(page([]));
    await harness.fixture.whenStable();

    expect(search.value).toBe('Sofia ');
  });

  it('sorts by a column when its header is clicked', async () => {
    await open('/properties?page=2');
    root().querySelector<HTMLElement>('[data-testid="sort-price"]')?.click();
    await settle();

    expect(url()).toBe('/properties?sort=price');
    expectList().flush(page([]));
  });

  it('says when nothing matches', async () => {
    await open('/properties?q=nothing', [], 0);
    expect(root().textContent).toContain('No properties match these filters.');
  });

  it('shows the API error', async () => {
    await harness.navigateByUrl('/properties');
    expectList().flush(
      { error: { code: 'INTERNAL_ERROR', message: 'Database unavailable.' } },
      { status: 500, statusText: 'Server Error' },
    );
    await harness.fixture.whenStable();
    expect(root().querySelector('[data-testid="list-error"]')?.textContent).toContain(
      'Database unavailable.',
    );
  });

  it('deletes the selected properties after confirmation and reports the result', async () => {
    const confirmations: Confirmation[] = [];
    vi.spyOn(TestBed.inject(ConfirmationService), 'confirm').mockImplementation((c) => {
      confirmations.push(c);
      return TestBed.inject(ConfirmationService);
    });
    const toast = vi.spyOn(TestBed.inject(MessageService), 'add');
    await open('/properties', [propertySummary(), propertySummary({ id: 2, refCode: 'IS-00002' })]);

    root().querySelector<HTMLInputElement>('[data-testid="select-1"] input')?.click();
    root().querySelector<HTMLInputElement>('[data-testid="select-2"] input')?.click();
    await harness.fixture.whenStable();
    expect(root().querySelector('[data-testid="selection-count"]')?.textContent).toContain(
      '2 selected',
    );

    root().querySelector<HTMLElement>('[data-testid="bulk-delete"] button')?.click();
    expect(confirmations).toHaveLength(1);
    confirmations[0].accept?.();

    const request = http.expectOne('/api/properties/bulk/delete');
    expect(request.request.body).toEqual({ propertyIds: [1, 2] });
    request.flush({
      data: [
        { propertyId: 1, result: 'deleted' },
        { propertyId: 2, result: 'removal_queued' },
      ],
    });
    await harness.fixture.whenStable();

    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: 'success',
        detail: '1 deleted. 1 being removed from the portals first, then deleted.',
      }),
    );
    expectList().flush(page([]));
    await harness.fixture.whenStable();
    expect(root().querySelector('[data-testid="selection-count"]')).toBeNull();
  });
});
