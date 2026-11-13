import { ChangeDetectionStrategy, Component } from '@angular/core';

import { PageHeader } from '../../shared/page-header';
import { PlannedFeatureList } from '../../shared/planned-feature-list';

@Component({
  selector: 'app-jobs-page',
  imports: [PageHeader, PlannedFeatureList],
  template: `
    <app-page-header
      heading="Jobs"
      description="The publishing queue: one background job per portal and action."
    />
    <app-planned-feature-list
      icon="pi pi-sync"
      heading="The job log is coming next"
      summary="Every publish, update and remove request will show up here while the worker processes it."
      [features]="features"
    />
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class JobsPage {
  protected readonly features: readonly string[] = [
    'Job log with portal, action, status and number of attempts',
    'Automatic retries with increasing back-off between attempts',
    'The last error of each failed job, as reported by the portal',
    'A Retry button for failed jobs',
  ];
}
