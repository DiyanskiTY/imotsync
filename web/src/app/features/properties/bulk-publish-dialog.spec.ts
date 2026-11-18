import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';

import type { PropertySummary } from '../../core/api/models';
import { PortalsApi } from '../../core/api/portals-api';
import { BulkPublishDialog } from './bulk-publish-dialog';
import { PORTALS, propertySummary } from '../../testing/fixtures';

@Component({
  imports: [BulkPublishDialog],
  template: `<app-bulk-publish-dialog
    [(visible)]="visible"
    [properties]="properties()"
    (finished)="finished = finished + 1"
  />`,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
class Host {
  readonly visible = signal(true);
  readonly properties = signal<PropertySummary[]>([
    propertySummary({ id: 1, refCode: 'IS-00001' }),
    propertySummary({ id: 2, refCode: 'IS-00002' }),
  ]);
  finished = 0;
}

describe('BulkPublishDialog', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: PortalsApi, useValue: { portals$: of(PORTALS) } },
      ],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  async function render() {
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    return { fixture, body: document.body };
  }

  function checkbox(key: string): HTMLInputElement {
    const input = document.body.querySelector<HTMLInputElement>(`#bulk-portal-${key}`);
    if (!input) {
      throw new Error(`checkbox for ${key} not found`);
    }
    return input;
  }

  it('publishes the selected properties to the chosen portals', async () => {
    const { fixture, body } = await render();
    expect(body.textContent).toContain('Publish 2 properties');

    checkbox('demo').click();
    await fixture.whenStable();
    body.querySelector<HTMLElement>('[data-testid="bulk-publish-submit"] button')?.click();

    const request = http.expectOne('/api/properties/bulk/publish');
    expect(request.request.body).toEqual({ propertyIds: [1, 2], portals: ['realistimo', 'bazar'] });
    request.flush({
      data: [
        { propertyId: 1, ok: true, jobs: [] },
        {
          propertyId: 2,
          ok: false,
          error: { code: 'NOT_READY', message: 'Not ready for every portal.' },
          issues: [{ portal: 'bazar', field: 'title', message: 'Bazar.bg needs Cyrillic.' }],
        },
      ],
    });
    await fixture.whenStable();

    const results = body.querySelector('[data-testid="bulk-publish-results"]');
    expect(results?.textContent).toContain('1 of 2 properties queued for publishing.');
    expect(results?.textContent).toContain('IS-00002');
    expect(results?.textContent).toContain('Bazar.bg: Bazar.bg needs Cyrillic.');
  });

  it('needs at least one portal', async () => {
    const { fixture, body } = await render();
    // Every portal starts ticked, so "all" unticks them all.
    checkbox('all').click();
    await fixture.whenStable();

    const submit = body.querySelector<HTMLButtonElement>(
      '[data-testid="bulk-publish-submit"] button',
    );
    expect(submit?.disabled).toBe(true);
  });

  it('tells the page to reload when it is closed after publishing', async () => {
    const { fixture, body } = await render();
    body.querySelector<HTMLElement>('[data-testid="bulk-publish-submit"] button')?.click();
    http.expectOne('/api/properties/bulk/publish').flush({
      data: [
        { propertyId: 1, ok: true },
        { propertyId: 2, ok: true },
      ],
    });
    await fixture.whenStable();

    body.querySelector<HTMLElement>('[data-testid="bulk-publish-close"] button')?.click();
    await fixture.whenStable();

    expect(fixture.componentInstance.finished).toBe(1);
    expect(fixture.componentInstance.visible()).toBe(false);
  });
});
