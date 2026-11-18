import { DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { takeUntilDestroyed, toObservable, toSignal } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { MessageService } from 'primeng/api';
import { ButtonModule } from 'primeng/button';
import { CheckboxModule } from 'primeng/checkbox';
import { MessageModule } from 'primeng/message';
import { SkeletonModule } from 'primeng/skeleton';
import { finalize, map, merge, Observable, Subject } from 'rxjs';

import { ApiError, toApiError } from '../../core/api/api-error';
import type {
  ListingStatus,
  Portal,
  PortalCheck,
  PortalListing,
  PropertyDetail,
} from '../../core/api/models';
import { injectPortals } from '../../core/api/portals-api';
import { PublishingApi } from '../../core/api/publishing-api';
import { injectConfirmDestructive } from '../../shared/confirm-destructive';
import { remoteState } from '../../shared/remote-state';
import { StatusTag } from '../../shared/status-tag';
import { portalSelection } from './portal-selection';

/** Listing states in which the property is, or is about to be, on the portal. */
const REMOVABLE: ReadonlySet<ListingStatus> = new Set(['pending', 'published', 'error']);

/**
 * Listing states in which publishing again only re-sends the same listing (the API turns it into
 * an update; a portal never gets a duplicate). Edits already send updates by themselves, so these
 * portals start unticked. A listing in error stays ticked: publishing again is how it is fixed.
 */
const ALREADY_SENT: ReadonlySet<ListingStatus> = new Set(['pending', 'published']);

interface PortalRow {
  portal: Portal;
  check: PortalCheck | null;
  listing: PortalListing | null;
}

/**
 * The pre-publish check and the publish controls of one property: every portal with the
 * property's status on it and, from GET /checks, what it still needs. The check runs again
 * whenever the property changes (its updatedAt moves on every save and photo change).
 */
@Component({
  selector: 'app-publishing-panel',
  imports: [
    DatePipe,
    FormsModule,
    RouterLink,
    ButtonModule,
    CheckboxModule,
    MessageModule,
    SkeletonModule,
    StatusTag,
  ],
  templateUrl: './publishing-panel.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PublishingPanel {
  private readonly api = inject(PublishingApi);
  private readonly confirmDestructive = injectConfirmDestructive();
  private readonly messages = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly rechecks = new Subject<void>();

  readonly property = input.required<PropertyDetail>();
  /** Something was queued: the page reloads the property to show the new listing states. */
  readonly changed = output();
  /** Fields the page can show the user (a "Fix" link appears for issues about them). */
  readonly fixableFields = input<ReadonlySet<string>>(new Set());
  /** The user wants to fix an issue about this field. */
  readonly fixField = output<string>();

  protected readonly portals = injectPortals();

  private readonly propertyVersion = computed(
    () => `${this.property().id}@${this.property().updatedAt}`,
  );
  protected readonly checks = toSignal(
    remoteState(
      merge(toObservable(this.propertyVersion), this.rechecks).pipe(map(() => this.property().id)),
      (id) => this.api.checks(id),
    ),
    { requireSync: true },
  );

  protected readonly rows = computed<PortalRow[]>(() => {
    const checks = new Map((this.checks().data ?? []).map((check) => [check.portal, check]));
    const listings = new Map(this.property().portals.map((listing) => [listing.portal, listing]));
    return this.portals.portals().map((portal) => ({
      portal,
      check: checks.get(portal.key) ?? null,
      listing: listings.get(portal.key) ?? null,
    }));
  });

  /** Ready portals; those the property is not on yet start ticked. */
  protected readonly selection = portalSelection(
    computed(() =>
      this.rows()
        .filter((row) => row.check?.ready)
        .map((row) => ({ key: row.portal.key, chosenByDefault: !this.alreadySent(row) })),
    ),
  );
  /** What the publish button does with the chosen portals. */
  protected readonly publishLabel = computed(() => {
    const chosen = new Set(this.selection.chosen());
    const rows = this.rows().filter((row) => chosen.has(row.portal.key));
    const updates = rows.filter((row) => this.alreadySent(row)).length;
    const count = rows.length;
    const portals = `${count} ${count === 1 ? 'portal' : 'portals'}`;
    if (count === 0) return 'Publish';
    if (updates === 0) return `Publish to ${portals}`;
    return updates === count ? `Update ${portals}` : `Publish or update ${portals}`;
  });
  protected readonly hasReadyPortal = computed(() => this.rows().some((row) => row.check?.ready));
  /** The property is already on (or on its way to) every portal it is ready for. */
  protected readonly onEveryReadyPortal = computed(() => {
    const ready = this.rows().filter((row) => row.check?.ready);
    return ready.length > 0 && ready.every((row) => this.alreadySent(row));
  });
  protected readonly archived = computed(() => this.property().status === 'archived');
  protected readonly busy = signal(false);
  protected readonly publishError = signal<ApiError | null>(null);

  private alreadySent(row: PortalRow): boolean {
    return row.listing !== null && ALREADY_SENT.has(row.listing.status);
  }

  protected canFix(field: string): boolean {
    return this.fixableFields().has(field);
  }

  protected isRemovable(row: PortalRow): boolean {
    return row.listing !== null && REMOVABLE.has(row.listing.status);
  }

  protected recheck(): void {
    this.rechecks.next();
  }

  protected publish(): void {
    const portals = this.selection.chosen();
    const names = portals.map((key) => this.portals.displayName(key)).join(', ');
    this.run(this.api.publish(this.property().id, portals), {
      summary: 'Publishing queued',
      detail: `${this.property().refCode} goes to ${names}. The worker sends it now.`,
    });
  }

  protected confirmUnpublish(row: PortalRow): void {
    this.confirmDestructive({
      header: `Remove from ${row.portal.displayName}?`,
      message: `${this.property().refCode} will be taken off ${row.portal.displayName}. You can publish it again later.`,
      icon: 'pi pi-eye-slash',
      acceptLabel: 'Remove',
      accept: () =>
        this.run(this.api.unpublish(this.property().id, [row.portal.key]), {
          summary: 'Removal queued',
          detail: `${this.property().refCode} is being removed from ${row.portal.displayName}.`,
        }),
    });
  }

  private run(request: Observable<unknown>, success: { summary: string; detail: string }): void {
    this.busy.set(true);
    this.publishError.set(null);
    request
      .pipe(
        finalize(() => this.busy.set(false)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: () => {
          this.messages.add({ severity: 'success', ...success });
          this.changed.emit();
        },
        error: (error: unknown) => {
          const apiError = toApiError(error);
          this.publishError.set(apiError);
          if (apiError.code === 'NOT_READY') {
            this.rechecks.next();
          }
        },
      });
  }
}
