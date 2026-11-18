import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MessageModule } from 'primeng/message';

import type { PortalListing, ScheduledDeletion } from '../../core/api/models';
import { injectPortals } from '../../core/api/portals-api';

/**
 * Explains a requested deletion that has not happened yet: what it waits for, when it happens,
 * and how to cancel it. The API decides the state with the rule the worker deletes by.
 */
@Component({
  selector: 'app-deletion-notice',
  imports: [DatePipe, RouterLink, MessageModule],
  template: `
    <p-message severity="warn" icon="pi pi-clock" styleClass="mb-6" data-testid="deletion-notice">
      <div class="flex flex-col gap-1">
        @switch (deletion().state) {
          @case ('feed_retention') {
            <strong class="font-semibold">
              Scheduled for deletion on {{ deletion().deletesAfter | date: 'd MMM y' }}
            </strong>
            <span>
              It is already off every portal. {{ names() }} keeps showing the removal in its feed
              until then, so that the portal notices it at one of its scheduled downloads; after
              that the property, its photos and its job history are deleted automatically.
            </span>
          }
          @case ('removing') {
            <strong class="font-semibold">Waiting to be deleted</strong>
            @if (failed()) {
              <span>
                Removing it from {{ failed() }} failed, so it may still be online there. Retry it in
                the
                <a
                  [routerLink]="['/jobs']"
                  [queryParams]="{ propertyId: propertyId() }"
                  class="underline"
                  >job log</a
                >; the deletion continues once the removal goes through.
              </span>
            } @else {
              <span>
                It is being removed from {{ names() }} first; the date is known once that is done.
              </span>
            }
          }
          @case ('due') {
            <strong class="font-semibold">Being deleted</strong>
            <span>Nothing holds it back any more; it is deleted within a minute.</span>
          }
        }
        @if (deletion().state !== 'due') {
          <span class="text-sm">
            Changed your mind? Set the status to Draft or Active and save: that cancels the
            deletion, and you can publish it again.
          </span>
        }
      </div>
    </p-message>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DeletionNotice {
  readonly deletion = input.required<ScheduledDeletion>();
  readonly listings = input.required<PortalListing[]>();
  readonly propertyId = input.required<number>();

  private readonly portals = injectPortals();

  protected readonly names = computed(() => this.join(this.deletion().portals));

  /** The waiting portals whose removal failed (listing in error), if any. */
  protected readonly failed = computed(() => {
    const waiting = new Set(this.deletion().portals);
    return this.join(
      this.listings()
        .filter((listing) => waiting.has(listing.portal) && listing.status === 'error')
        .map((listing) => listing.portal),
    );
  });

  private join(keys: readonly string[]): string {
    const names = keys.map((key) => this.portals.displayName(key));
    return names.length > 1
      ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
      : (names[0] ?? '');
  }
}
