import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { TagModule } from 'primeng/tag';
import { TooltipModule } from 'primeng/tooltip';

import type { JobStatus, ListingStatus, PropertyStatus } from '../core/api/models';

/** Every status the UI shows: a property's, a portal listing's or a job's. */
export type DisplayStatus = PropertyStatus | ListingStatus | JobStatus;

type Severity = 'success' | 'info' | 'warn' | 'danger' | 'secondary' | 'contrast';

const SEVERITY: Readonly<Record<DisplayStatus, Severity>> = {
  // Property
  draft: 'secondary',
  active: 'success',
  archived: 'warn',
  // Portal listing
  pending: 'info',
  published: 'success',
  error: 'danger',
  removed: 'contrast',
  // Job
  queued: 'secondary',
  running: 'info',
  succeeded: 'success',
  failed: 'danger',
};

export function statusSeverity(status: DisplayStatus): Severity {
  return SEVERITY[status];
}

export function statusLabel(status: DisplayStatus): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

/** A coloured status label, optionally prefixed (a portal name) and with a detail tooltip. */
@Component({
  selector: 'app-status-tag',
  imports: [TagModule, TooltipModule],
  template: `
    <p-tag
      [severity]="severity()"
      [value]="text()"
      [pTooltip]="detail() ?? undefined"
      tooltipPosition="top"
      [attr.aria-label]="ariaLabel()"
      [attr.tabindex]="detail() ? 0 : null"
    />
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class StatusTag {
  readonly status = input.required<DisplayStatus>();
  /** Shown on hover and focus, e.g. the listing's last error. */
  readonly detail = input<string | null>(null);
  readonly prefix = input<string | null>(null);

  protected readonly severity = computed(() => statusSeverity(this.status()));
  protected readonly text = computed(() => {
    const label = statusLabel(this.status());
    const prefix = this.prefix();
    return prefix ? `${prefix}: ${label}` : label;
  });
  protected readonly ariaLabel = computed(() => {
    const detail = this.detail();
    return detail ? `${this.text()}. ${detail}` : null;
  });
}
