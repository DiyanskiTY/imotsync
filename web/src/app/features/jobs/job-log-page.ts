import { DatePipe, JsonPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { MessageService } from 'primeng/api';
import { ButtonModule } from 'primeng/button';
import { MessageModule } from 'primeng/message';
import { MultiSelectModule } from 'primeng/multiselect';
import { TableModule } from 'primeng/table';
import { finalize } from 'rxjs';

import { toApiError } from '../../core/api/api-error';
import { JobsApi } from '../../core/api/jobs-api';
import {
  JOB_ACTIONS,
  JOB_STATUSES,
  type Job,
  type JobAction,
  type JobStatus,
} from '../../core/api/models';
import { injectPortals } from '../../core/api/portals-api';
import { injectListPage } from '../../shared/list-page';
import { PageHeader } from '../../shared/page-header';
import { pollWhile } from '../../shared/polling';
import { RowType } from '../../shared/row-type';
import { StatusTag, statusLabel } from '../../shared/status-tag';
import { JOB_LIST_QUERY } from './job-list-query';

const ACTION_LABELS: Readonly<Record<JobAction, string>> = {
  publish: 'Publish',
  update: 'Update',
  remove: 'Remove',
};

/** The job log: every attempt to publish, update or remove a listing, with Retry for failures. */
@Component({
  selector: 'app-job-log-page',
  imports: [
    DatePipe,
    JsonPipe,
    ReactiveFormsModule,
    RouterLink,
    ButtonModule,
    MessageModule,
    MultiSelectModule,
    TableModule,
    PageHeader,
    RowType,
    StatusTag,
  ],
  templateUrl: './job-log-page.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class JobLogPage {
  private readonly api = inject(JobsApi);
  private readonly messages = inject(MessageService);

  protected readonly filters = inject(NonNullableFormBuilder).group({
    status: [[] as JobStatus[]],
    action: [[] as JobAction[]],
    portal: [[] as string[]],
  });

  protected readonly list = injectListPage({
    query: JOB_LIST_QUERY,
    load: (params) => this.api.list(params),
    filters: this.filters,
  });

  protected readonly portals = injectPortals();
  protected readonly statusOptions = JOB_STATUSES.map((value) => ({
    value,
    label: statusLabel(value),
  }));
  protected readonly actionOptions = JOB_ACTIONS.map((value) => ({
    value,
    label: ACTION_LABELS[value],
  }));
  protected readonly actionLabels = ACTION_LABELS;

  protected readonly propertyId = computed(() => this.list.query().propertyId);
  /** The filtered property by its reference code once its jobs are loaded, else by id. */
  protected readonly propertyLabel = computed(() => {
    const id = this.propertyId();
    const property = this.list.rows().find((job) => job.property?.id === id)?.property;
    return property ? property.refCode : `Property #${id}`;
  });
  protected readonly retrying = signal<number | null>(null);

  /** The worker is busy with something on this page: follow it until it is done. */
  private readonly active = computed(
    () =>
      !this.list.result().loading &&
      this.list.rows().some((job) => job.status === 'queued' || job.status === 'running'),
  );

  constructor() {
    pollWhile(this.active, () => this.list.reload());
  }

  /**
   * Retry helps only for a failed job whose listing is still in error: once anything newer was
   * queued for the listing (a retry, a publish), the API refuses it.
   */
  protected canRetry(job: Job): boolean {
    return job.status === 'failed' && job.listing.status === 'error';
  }

  protected clearPropertyFilter(): void {
    this.list.patch({ propertyId: undefined });
  }

  protected retry(job: Job): void {
    this.retrying.set(job.id);
    this.api
      .retry(job.id)
      .pipe(finalize(() => this.retrying.set(null)))
      .subscribe({
        next: (queued) => {
          this.messages.add({
            severity: 'success',
            summary: 'Retry queued',
            detail: `Job ${queued.id} is queued.`,
          });
          this.list.reload();
        },
        error: (error: unknown) => {
          const apiError = toApiError(error);
          this.messages.add({
            severity: apiError.code === 'CONFLICT' ? 'warn' : 'error',
            summary: 'Not retried',
            detail: apiError.message,
            life: 8000,
          });
        },
      });
  }
}
