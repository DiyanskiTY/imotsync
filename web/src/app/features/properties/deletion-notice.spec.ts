import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';

import type { PortalListing, ScheduledDeletion } from '../../core/api/models';
import { PortalsApi } from '../../core/api/portals-api';
import { PORTALS, propertyDetail } from '../../testing/fixtures';
import { DeletionNotice } from './deletion-notice';

@Component({
  imports: [DeletionNotice],
  template: `<app-deletion-notice
    [deletion]="deletion()"
    [listings]="listings()"
    [propertyId]="7"
  />`,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
class Host {
  readonly deletion = signal<ScheduledDeletion>({
    requestedAt: '2026-11-18T09:00:00Z',
    state: 'feed_retention',
    portals: ['bazar'],
    deletesAfter: '2026-12-17T10:00:00Z',
  });
  readonly listings = signal<PortalListing[]>(propertyDetail().portals);
}

const listing = (overrides: Partial<PortalListing>): PortalListing => ({
  ...propertyDetail().portals[0],
  ...overrides,
});

describe('DeletionNotice', () => {
  async function render(deletion?: ScheduledDeletion, listings?: PortalListing[]) {
    TestBed.configureTestingModule({
      providers: [provideRouter([]), { provide: PortalsApi, useValue: { portals$: of(PORTALS) } }],
    });
    const fixture = TestBed.createComponent(Host);
    if (deletion) fixture.componentInstance.deletion.set(deletion);
    if (listings) fixture.componentInstance.listings.set(listings);
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    return { root, text: root.textContent?.replace(/\s+/g, ' ') ?? '' };
  }

  it('says when a property waiting for a feed will be deleted, and how to cancel', async () => {
    const { text } = await render();
    expect(text).toContain('Scheduled for deletion on 17 Dec 2026');
    expect(text).toContain('Bazar.bg keeps showing the removal in its feed until then');
    expect(text).toContain('Set the status to Draft or Active and save');
  });

  it('points to the job log when a removal failed', async () => {
    const { root, text } = await render(
      {
        requestedAt: '2026-11-18T09:00:00Z',
        state: 'removing',
        portals: ['demo'],
        deletesAfter: null,
      },
      [listing({ portal: 'demo', status: 'error', lastError: 'Rejected' })],
    );
    expect(text).toContain('Removing it from Demo portal failed');
    expect(root.querySelector('a[href="/jobs?propertyId=7"]')?.textContent).toContain('job log');
  });

  it('says the removal is still running', async () => {
    const { text } = await render(
      {
        requestedAt: '2026-11-18T09:00:00Z',
        state: 'removing',
        portals: ['realistimo'],
        deletesAfter: null,
      },
      [listing({ status: 'pending' })],
    );
    expect(text).toContain('It is being removed from Realistimo first');
  });

  it('says the deletion is about to happen', async () => {
    const { text } = await render({
      requestedAt: '2026-11-18T09:00:00Z',
      state: 'due',
      portals: [],
      deletesAfter: null,
    });
    expect(text).toContain('deleted within a minute');
  });
});
