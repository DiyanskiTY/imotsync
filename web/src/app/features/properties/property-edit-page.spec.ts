import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ChangeDetectionStrategy, Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { Confirmation, ConfirmationService, MessageService } from 'primeng/api';
import { of } from 'rxjs';

import { PortalsApi } from '../../core/api/portals-api';
import { STATUS_POLL_MS } from '../../shared/polling';
import { PORTALS, portalCheck, propertyDetail } from '../../testing/fixtures';
import { PropertyEditPage } from './property-edit-page';

@Component({ template: 'list', changeDetection: ChangeDetectionStrategy.OnPush })
class ListPage {}

const POLL_MS = 20;

describe('PropertyEditPage', () => {
  let http: HttpTestingController;
  let harness: RouterTestingHarness;

  // The select's overlay asks matchMedia for the viewport; jsdom does not implement it.
  beforeAll(() => {
    window.matchMedia ??= (query: string) =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
      }) satisfies MediaQueryList;
  });

  beforeEach(async () => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'properties', component: ListPage },
          { path: 'properties/new', component: PropertyEditPage },
          { path: 'properties/:id', component: PropertyEditPage },
        ]),
        provideHttpClient(),
        provideHttpClientTesting(),
        MessageService,
        ConfirmationService,
        { provide: PortalsApi, useValue: { portals$: of(PORTALS) } },
        { provide: STATUS_POLL_MS, useValue: POLL_MS },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    harness = await RouterTestingHarness.create();
  });

  afterEach(() => {
    // The publishing panel runs the check whenever the property loads; not under test here.
    http.match((request) => request.url.endsWith('/checks'));
    http.verify();
  });

  const root = () => harness.fixture.nativeElement as HTMLElement;
  const stable = () => harness.fixture.whenStable();

  function input(id: string): HTMLInputElement | HTMLTextAreaElement {
    const element = root().querySelector<HTMLInputElement | HTMLTextAreaElement>(`#${id}`);
    if (!element) {
      throw new Error(`#${id} not found`);
    }
    return element;
  }

  function type(id: string, value: string): void {
    const element = input(id);
    element.value = value;
    element.dispatchEvent(new Event('input'));
    element.dispatchEvent(new Event('blur'));
  }

  function clickTestId(testId: string): void {
    const element = root().querySelector<HTMLElement>(`[data-testid="${testId}"]`);
    (element?.querySelector('button') ?? element)?.click();
  }

  async function chooseOption(selectId: string, label: string): Promise<void> {
    root().querySelector<HTMLElement>(`[data-testid="${selectId}"]`)?.click();
    await stable();
    const option = Array.from(document.body.querySelectorAll<HTMLElement>('[role="option"]')).find(
      (element) => element.textContent?.trim() === label,
    );
    if (!option) {
      throw new Error(`option ${label} not found`);
    }
    option.click();
    await stable();
  }

  async function openExisting(property = propertyDetail()) {
    await harness.navigateByUrl(`/properties/${property.id}`);
    http.expectOne(`/api/properties/${property.id}`).flush(property);
    await stable();
  }

  it('creates a property and continues on its page, where photos can be added', async () => {
    await harness.navigateByUrl('/properties/new');
    expect(root().querySelector('h1')?.textContent).toContain('New property');
    expect(root().querySelector('[data-testid="upload-photos"]')).toBeNull();

    await chooseOption('field-type-select', 'Apartment');
    clickTestId('deal-sale');
    type('field-city', 'Plovdiv');
    type('field-title', 'Sunny studio');
    await stable();
    clickTestId('save');

    const create = http.expectOne('/api/properties');
    expect(create.request.method).toBe('POST');
    expect(create.request.body).toMatchObject({
      type: 'apartment',
      dealType: 'sale',
      city: 'Plovdiv',
      title: 'Sunny studio',
      status: 'draft',
    });
    create.flush(propertyDetail({ id: 7, refCode: 'IS-00007' }), {
      status: 201,
      statusText: 'Created',
    });
    await stable();

    expect(TestBed.inject(Router).url).toBe('/properties/7');
    http.expectOne('/api/properties/7').flush(propertyDetail({ id: 7, refCode: 'IS-00007' }));
    await stable();
    expect(root().querySelector('[data-testid="upload-photos"]')).not.toBeNull();
  });

  it('does not send an incomplete form', async () => {
    await harness.navigateByUrl('/properties/new');
    clickTestId('save');
    await stable();

    expect(root().querySelector('[data-testid="error-field-city"]')?.textContent).toContain(
      'Required.',
    );
    http.expectNone('/api/properties');
  });

  it('loads a property and saves only what changed', async () => {
    await openExisting();
    expect(root().querySelector('h1')?.textContent).toContain('IS-00001');
    expect(input('field-city').value).toBe('Sofia');

    type('field-district', 'Center');
    await stable();
    clickTestId('save');

    const patch = http.expectOne('/api/properties/1');
    expect(patch.request.method).toBe('PATCH');
    expect(patch.request.body).toEqual({ district: 'Center' });
    patch.flush(propertyDetail({ district: 'Center', updatedAt: '2026-11-17T10:00:00Z' }));
    await stable();
    expect(input('field-district').value).toBe('Center');
  });

  it('shows the API validation errors on their fields', async () => {
    await openExisting();
    type('field-title', 'New title');
    await stable();
    clickTestId('save');
    http.expectOne('/api/properties/1').flush(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid request.',
          details: [{ field: 'title', message: 'is not acceptable' }],
        },
      },
      { status: 400, statusText: 'Bad Request' },
    );
    await stable();

    expect(root().querySelector('[data-testid="error-field-title"]')?.textContent).toContain(
      'Is not acceptable.',
    );
  });

  it('refreshes while a listing is pending, until the worker has finished', async () => {
    const pending = propertyDetail({
      portals: [
        {
          id: 21,
          portal: 'bazar',
          status: 'pending',
          externalId: null,
          lastError: null,
          publishedAt: null,
          lastSentAt: null,
          updatedAt: '2026-11-17T10:00:00Z',
        },
      ],
    });
    await openExisting(pending);

    await new Promise((resolve) => setTimeout(resolve, POLL_MS * 3));
    http.expectOne('/api/properties/1').flush(propertyDetail());
    await stable();

    await new Promise((resolve) => setTimeout(resolve, POLL_MS * 3));
    http.expectNone('/api/properties/1');
  });

  it('follows the update jobs a save queues', async () => {
    await openExisting();
    type('field-district', 'Center');
    await stable();
    clickTestId('save');
    const pendingAfterSave = propertyDetail({
      district: 'Center',
      portals: [{ ...propertyDetail().portals[0], status: 'pending' }],
    });
    http.expectOne('/api/properties/1').flush(pendingAfterSave);
    await stable();

    await new Promise((resolve) => setTimeout(resolve, POLL_MS * 3));
    http.expectOne('/api/properties/1').flush(propertyDetail({ district: 'Center' }));
    await stable();
  });

  it('shows a property that does not exist', async () => {
    await harness.navigateByUrl('/properties/999');
    http
      .expectOne('/api/properties/999')
      .flush(
        { error: { code: 'NOT_FOUND', message: 'Property 999 not found.' } },
        { status: 404, statusText: 'Not Found' },
      );
    await stable();
    expect(root().textContent).toContain('Property 999 not found.');
  });

  it('deletes the property after confirmation and goes back to the list', async () => {
    const confirmations: Confirmation[] = [];
    vi.spyOn(TestBed.inject(ConfirmationService), 'confirm').mockImplementation((c) => {
      confirmations.push(c);
      return TestBed.inject(ConfirmationService);
    });
    await openExisting();
    clickTestId('delete-property');
    confirmations[0].accept?.();

    http.expectOne('/api/properties/1').flush(null, { status: 204, statusText: 'No Content' });
    await stable();
    expect(TestBed.inject(Router).url).toBe('/properties');
  });

  it('warns when Archived would leave the property online', async () => {
    await openExisting();
    expect(root().querySelector('[data-testid="status-warning"]')).toBeNull();

    const archived = Array.from(
      root().querySelectorAll<HTMLElement>('[data-testid="status-select"] [role="button"]'),
    ).find((button) => button.textContent?.trim() === 'Archived');
    archived?.click();
    await stable();

    expect(root().querySelector('[data-testid="status-warning"]')?.textContent).toContain(
      'Still online on Realistimo',
    );
  });

  it('explains a scheduled deletion', async () => {
    await openExisting(
      propertyDetail({
        status: 'archived',
        deletion: {
          requestedAt: '2026-11-18T09:00:00Z',
          state: 'feed_retention',
          portals: ['bazar'],
          deletesAfter: '2026-12-17T10:00:00Z',
        },
      }),
    );
    expect(root().querySelector('[data-testid="deletion-notice"]')?.textContent).toContain(
      'Scheduled for deletion on 17 Dec 2026',
    );
  });

  it('stays on the page and shows the schedule when the deletion has to wait', async () => {
    const confirmations: Confirmation[] = [];
    vi.spyOn(TestBed.inject(ConfirmationService), 'confirm').mockImplementation((c) => {
      confirmations.push(c);
      return TestBed.inject(ConfirmationService);
    });
    const toast = vi.spyOn(TestBed.inject(MessageService), 'add');
    await openExisting();
    clickTestId('delete-property');
    confirmations[0].accept?.();

    http
      .expectOne('/api/properties/1')
      .flush({ data: { result: 'deletion_scheduled' } }, { status: 202, statusText: 'Accepted' });
    await stable();

    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ summary: 'IS-00001 scheduled for deletion' }),
    );
    expect(TestBed.inject(Router).url).toBe('/properties/1');
    http.expectOne('/api/properties/1').flush(
      propertyDetail({
        status: 'archived',
        deletion: {
          requestedAt: '2026-11-18T09:00:00Z',
          state: 'feed_retention',
          portals: ['bazar'],
          deletesAfter: '2026-12-17T10:00:00Z',
        },
      }),
    );
    await stable();
    expect(root().querySelector('[data-testid="deletion-notice"]')).not.toBeNull();
  });

  it('runs the pre-publish check for the loaded property', async () => {
    await openExisting();
    http
      .expectOne('/api/properties/1/checks')
      .flush({ data: [portalCheck({ ready: false, issues: [{ field: 'price', message: 'x' }] })] });
    await stable();
    expect(root().querySelector('[data-testid="portal-realistimo"]')?.textContent).toContain('x');
  });
});
