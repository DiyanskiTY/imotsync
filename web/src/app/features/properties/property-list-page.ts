import { CurrencyPipe, DatePipe, DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { MessageService } from 'primeng/api';
import { ButtonModule } from 'primeng/button';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { InputNumberModule } from 'primeng/inputnumber';
import { InputTextModule } from 'primeng/inputtext';
import { MessageModule } from 'primeng/message';
import { MultiSelectModule } from 'primeng/multiselect';
import { SelectModule } from 'primeng/select';
import { TableModule } from 'primeng/table';

import { toApiError } from '../../core/api/api-error';
import {
  PORTAL_KEYS,
  type DealType,
  type ListingStatus,
  type PortalKey,
  type PropertyStatus,
  type PropertySummary,
  type PropertyType,
} from '../../core/api/models';
import { injectPortals } from '../../core/api/portals-api';
import { PropertiesApi } from '../../core/api/properties-api';
import { injectConfirmDestructive } from '../../shared/confirm-destructive';
import { injectListPage } from '../../shared/list-page';
import { PageHeader } from '../../shared/page-header';
import { Photo } from '../../shared/photo';
import { pollWhile } from '../../shared/polling';
import { RowType } from '../../shared/row-type';
import { StatusTag } from '../../shared/status-tag';
import { BulkPublishDialog } from './bulk-publish-dialog';
import { summarizeBulkDelete } from './bulk-delete-summary';
import {
  DEAL_LABELS,
  DEAL_OPTIONS,
  LISTING_STATUS_OPTIONS,
  STATUS_OPTIONS,
  TYPE_LABELS,
  TYPE_OPTIONS,
} from './property-labels';
import { PROPERTY_LIST_QUERY } from './property-list-query';

/** The property list: filters, sort and page live in the URL; bulk publish and delete. */
@Component({
  selector: 'app-property-list-page',
  imports: [
    CurrencyPipe,
    DatePipe,
    DecimalPipe,
    ReactiveFormsModule,
    RouterLink,
    ButtonModule,
    IconFieldModule,
    InputIconModule,
    InputNumberModule,
    InputTextModule,
    MessageModule,
    MultiSelectModule,
    SelectModule,
    TableModule,
    BulkPublishDialog,
    PageHeader,
    Photo,
    RowType,
    StatusTag,
  ],
  templateUrl: './property-list-page.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PropertyListPage {
  private readonly api = inject(PropertiesApi);
  private readonly confirmDestructive = injectConfirmDestructive();
  private readonly messages = inject(MessageService);

  protected readonly filters = inject(NonNullableFormBuilder).group({
    q: '',
    city: '',
    status: [[] as PropertyStatus[]],
    type: [[] as PropertyType[]],
    dealType: [[] as DealType[]],
    portal: [null as PortalKey | null],
    portalStatus: [[] as ListingStatus[]],
    priceMin: [null as number | null],
    priceMax: [null as number | null],
  });

  protected readonly list = injectListPage({
    query: PROPERTY_LIST_QUERY,
    load: (params) => this.api.list(params),
    filters: this.filters,
  });

  protected readonly portals = injectPortals();
  /** The property list filters by the portals the API knows (PORTAL_KEYS). */
  protected readonly portalOptions = computed(() =>
    this.portals
      .options()
      .filter((option) => (PORTAL_KEYS as readonly string[]).includes(option.value)),
  );

  protected readonly selection = signal<PropertySummary[]>([]);
  protected readonly bulkPublishVisible = signal(false);
  protected readonly deleting = signal(false);

  protected readonly typeLabels = TYPE_LABELS;
  protected readonly dealLabels = DEAL_LABELS;
  protected readonly statusOptions = STATUS_OPTIONS;
  protected readonly typeOptions = TYPE_OPTIONS;
  protected readonly dealOptions = DEAL_OPTIONS;
  protected readonly listingStatusOptions = LISTING_STATUS_OPTIONS;

  constructor() {
    // Follow the worker while a listing on this page is pending.
    pollWhile(
      computed(
        () =>
          !this.list.result().loading &&
          this.list.rows().some((row) => row.portals.some((l) => l.status === 'pending')),
      ),
      () => this.list.reload(),
    );
  }

  protected afterBulkPublish(): void {
    this.selection.set([]);
    this.list.reload();
  }

  protected confirmBulkDelete(): void {
    const properties = this.selection();
    const count = properties.length;
    this.confirmDestructive({
      header: `Delete ${count} ${count === 1 ? 'property' : 'properties'}?`,
      message:
        'Properties that are online are first removed from every portal, then deleted. ' +
        'This cannot be undone.',
      accept: () => this.bulkDelete(properties.map((property) => property.id)),
    });
  }

  private bulkDelete(ids: number[]): void {
    this.deleting.set(true);
    this.api.bulkDelete(ids).subscribe({
      next: (items) => {
        this.deleting.set(false);
        const { severity, detail } = summarizeBulkDelete(items);
        this.messages.add({ severity, summary: 'Bulk delete', detail });
        this.selection.set([]);
        this.list.reload();
      },
      error: (error: unknown) => {
        this.deleting.set(false);
        this.messages.add({
          severity: 'error',
          summary: 'Bulk delete failed',
          detail: toApiError(error).message,
        });
      },
    });
  }
}
