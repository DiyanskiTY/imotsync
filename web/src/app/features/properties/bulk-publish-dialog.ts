import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  model,
  output,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { CheckboxModule } from 'primeng/checkbox';
import { DialogModule } from 'primeng/dialog';
import { MessageModule } from 'primeng/message';
import { finalize } from 'rxjs';

import { toApiError } from '../../core/api/api-error';
import type { BulkPublishItem, PropertySummary } from '../../core/api/models';
import { injectPortals } from '../../core/api/portals-api';
import { PropertiesApi } from '../../core/api/properties-api';
import { portalSelection } from './portal-selection';

interface Failure {
  propertyId: number;
  refCode: string;
  message: string;
  issues: string[];
}

/**
 * Publishes the selected properties to the chosen portals in one request. The API checks each
 * property on its own, so the result lists what was queued and why the others were not.
 */
@Component({
  selector: 'app-bulk-publish-dialog',
  imports: [FormsModule, ButtonModule, CheckboxModule, DialogModule, MessageModule],
  templateUrl: './bulk-publish-dialog.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BulkPublishDialog {
  private readonly api = inject(PropertiesApi);

  readonly visible = model(false);
  readonly properties = input.required<PropertySummary[]>();
  /** Emitted when the dialog closes after a publish, so the list can reload. */
  readonly finished = output();

  protected readonly portals = injectPortals();
  /** Every portal is chosen, except those the user unticked. */
  protected readonly selection = portalSelection(
    // Publishing again only updates a listing a portal already has, so every portal starts ticked.
    computed(() =>
      this.portals.portals().map((portal) => ({ key: portal.key, chosenByDefault: true })),
    ),
  );
  protected readonly submitting = signal(false);
  protected readonly results = signal<BulkPublishItem[] | null>(null);
  protected readonly error = signal<string | null>(null);

  protected readonly count = computed(() => this.properties().length);
  protected readonly queued = computed(() => this.results()?.filter((r) => r.ok).length ?? 0);
  protected readonly failures = computed(() => this.describeFailures(this.results() ?? []));

  protected publish(): void {
    const ids = this.properties().map((property) => property.id);
    this.submitting.set(true);
    this.error.set(null);
    this.api
      .bulkPublish(ids, this.selection.chosen())
      .pipe(finalize(() => this.submitting.set(false)))
      .subscribe({
        next: (items) => this.results.set(items),
        error: (error: unknown) => this.error.set(toApiError(error).message),
      });
  }

  protected close(): void {
    const published = this.results() !== null;
    this.results.set(null);
    this.error.set(null);
    this.visible.set(false);
    if (published) {
      this.finished.emit();
    }
  }

  private describeFailures(items: BulkPublishItem[]): Failure[] {
    const refCodes = new Map(this.properties().map((p) => [p.id, p.refCode]));
    return items
      .filter((item) => !item.ok)
      .map((item) => ({
        propertyId: item.propertyId,
        refCode: refCodes.get(item.propertyId) ?? `#${item.propertyId}`,
        message: item.error?.message ?? 'Not published.',
        issues: (item.issues ?? []).map(
          (issue) => `${this.portals.displayName(issue.portal ?? '')}: ${issue.message}`,
        ),
      }));
  }
}
