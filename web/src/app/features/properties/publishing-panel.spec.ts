import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Confirmation, ConfirmationService, MessageService } from 'primeng/api';
import { of } from 'rxjs';
import type { MockInstance } from 'vitest';

import type { PortalCheck, PropertyDetail } from '../../core/api/models';
import { PortalsApi } from '../../core/api/portals-api';
import { PORTALS, portalCheck, propertyDetail } from '../../testing/fixtures';
import { PublishingPanel } from './publishing-panel';

@Component({
  imports: [PublishingPanel],
  template: `<app-publishing-panel
    [property]="property()"
    [fixableFields]="fixable"
    (changed)="changes = changes + 1"
    (fixField)="fixed.push($event)"
  />`,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
class Host {
  readonly property = signal<PropertyDetail>(propertyDetail());
  readonly fixable: ReadonlySet<string> = new Set(['title', 'price', 'images']);
  changes = 0;
  readonly fixed: string[] = [];
}

const checks: PortalCheck[] = [
  portalCheck(),
  portalCheck({
    portal: 'bazar',
    displayName: 'Bazar.bg',
    ready: false,
    issues: [{ field: 'title', message: 'Bazar.bg needs the title in Cyrillic.' }],
  }),
  portalCheck({ portal: 'demo', displayName: 'Demo portal' }),
];

describe('PublishingPanel', () => {
  let http: HttpTestingController;
  let fixture: ComponentFixture<Host>;
  let toast: MockInstance<MessageService['add']>;

  beforeEach(async () => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        MessageService,
        ConfirmationService,
        { provide: PortalsApi, useValue: { portals$: of(PORTALS) } },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    toast = vi.spyOn(TestBed.inject(MessageService), 'add');
    fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    http.expectOne('/api/properties/1/checks').flush({ data: checks });
    await fixture.whenStable();
  });

  afterEach(() => http.verify());

  const root = () => fixture.nativeElement as HTMLElement;
  const card = (portal: string) => root().querySelector(`[data-testid="portal-${portal}"]`);
  const button = (testId: string) =>
    root().querySelector<HTMLButtonElement>(`[data-testid="${testId}"] button`);

  it('shows each portal with its listing status and verdict', () => {
    expect(card('realistimo')?.textContent).toContain('Published');
    expect(card('realistimo')?.textContent).toContain('Ready');
    expect(card('bazar')?.textContent).toContain('Bazar.bg needs the title in Cyrillic.');
    expect(card('bazar')?.textContent).toContain('Not published');
  });

  it('says when the property was last sent to each portal', async () => {
    expect(root().querySelector('[data-testid="last-sent-realistimo"]')?.textContent).toContain(
      'Last sent 11 Nov 2026',
    );
    // No listing on Demo portal yet: nothing to say.
    expect(root().querySelector('[data-testid="last-sent-demo"]')).toBeNull();

    fixture.componentInstance.property.set(
      propertyDetail({
        portals: [{ ...propertyDetail().portals[0], status: 'error', lastSentAt: null }],
      }),
    );
    await fixture.whenStable();
    expect(root().querySelector('[data-testid="last-sent-realistimo"]')?.textContent).toContain(
      'Never sent',
    );
  });

  it('only lets ready portals be chosen', () => {
    expect(root().querySelector<HTMLInputElement>('#publish-realistimo')?.disabled).toBe(false);
    expect(root().querySelector<HTMLInputElement>('#publish-bazar')?.disabled).toBe(true);
  });

  it('publishes to the ready portals it is not on yet', async () => {
    expect(button('publish')?.textContent).toContain('Publish to 1 portal');
    button('publish')?.click();
    const request = http.expectOne('/api/properties/1/publish');
    expect(request.request.body).toEqual({ portals: ['demo'] });
    request.flush({ data: { listings: [], jobs: [] } }, { status: 202, statusText: 'Accepted' });
    await fixture.whenStable();

    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ severity: 'success' }));
    expect(fixture.componentInstance.changes).toBe(1);
  });

  it('shows what is missing when the API refuses to publish', async () => {
    button('publish')?.click();
    http.expectOne('/api/properties/1/publish').flush(
      {
        error: {
          code: 'NOT_READY',
          message: 'The property is not ready for every portal.',
          details: [{ portal: 'demo', field: 'price', message: 'Demo portal needs a price.' }],
        },
      },
      { status: 422, statusText: 'Unprocessable Entity' },
    );
    await fixture.whenStable();

    expect(root().querySelector('[data-testid="publish-error"]')?.textContent).toContain(
      'The property is not ready for every portal.',
    );
    // The check is run again, so the cards show the new issue.
    http.expectOne('/api/properties/1/checks').flush({ data: checks });
  });

  it('leaves a portal it is already on unticked; ticking it sends an update', async () => {
    expect(root().querySelector<HTMLInputElement>('#publish-realistimo')?.checked).toBe(false);
    root().querySelector<HTMLInputElement>('#publish-realistimo')?.click();
    await fixture.whenStable();
    expect(button('publish')?.textContent).toContain('Publish or update 2 portals');

    button('publish')?.click();
    const request = http.expectOne('/api/properties/1/publish');
    expect(request.request.body).toEqual({ portals: ['realistimo', 'demo'] });
    request.flush({ data: { listings: [], jobs: [] } }, { status: 202, statusText: 'Accepted' });
  });

  it('keeps the choices the user made when the property reloads', async () => {
    root().querySelector<HTMLInputElement>('#publish-realistimo')?.click();
    root().querySelector<HTMLInputElement>('#publish-demo')?.click();
    await fixture.whenStable();
    // A poll brings a new copy of the same property (same updatedAt: no new check).
    fixture.componentInstance.property.set(propertyDetail());
    await fixture.whenStable();
    expect(button('publish')?.textContent).toContain('Update 1 portal');

    button('publish')?.click();
    const request = http.expectOne('/api/properties/1/publish');
    expect(request.request.body).toEqual({ portals: ['realistimo'] });
    request.flush({ data: { listings: [], jobs: [] } }, { status: 202, statusText: 'Accepted' });
  });

  it('chooses every ready portal at once, and none', async () => {
    const all = root().querySelector<HTMLInputElement>('#publish-all');
    all?.click();
    await fixture.whenStable();
    expect(button('publish')?.textContent).toContain('Publish or update 2 portals');
    // Bazar.bg is not ready, so "all" leaves it out.
    expect(root().querySelector<HTMLInputElement>('#publish-bazar')?.checked).toBe(false);

    all?.click();
    await fixture.whenStable();
    expect(button('publish')?.disabled).toBe(true);
  });

  it('says when the property is already on every ready portal', async () => {
    const onEveryPortal = propertyDetail({
      portals: ['realistimo', 'demo'].map((portal, i) => ({
        ...propertyDetail().portals[0],
        id: 21 + i,
        portal,
      })),
    });
    fixture.componentInstance.property.set(onEveryPortal);
    await fixture.whenStable();

    expect(button('publish')?.disabled).toBe(true);
    expect(root().querySelector('[data-testid="publish-hint"]')?.textContent).toContain(
      'Already on every ready portal',
    );
  });

  it('asks the page to show the field an issue is about', () => {
    button('fix-bazar-title')?.click();
    expect(fixture.componentInstance.fixed).toEqual(['title']);
  });

  it('removes a listing from its portal after confirmation', async () => {
    const confirmations: Confirmation[] = [];
    vi.spyOn(TestBed.inject(ConfirmationService), 'confirm').mockImplementation((c) => {
      confirmations.push(c);
      return TestBed.inject(ConfirmationService);
    });
    button('unpublish-realistimo')?.click();
    confirmations[0].accept?.();

    const request = http.expectOne('/api/properties/1/unpublish');
    expect(request.request.body).toEqual({ portals: ['realistimo'] });
    request.flush({ data: { listings: [], jobs: [] } }, { status: 202, statusText: 'Accepted' });
    await fixture.whenStable();
    expect(fixture.componentInstance.changes).toBe(1);
  });

  it('runs the check again when the property changes', async () => {
    fixture.componentInstance.property.set(propertyDetail({ updatedAt: '2026-11-17T10:00:00Z' }));
    await fixture.whenStable();
    http.expectOne('/api/properties/1/checks').flush({ data: checks });
  });
});
