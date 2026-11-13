import { ChangeDetectionStrategy, Component } from '@angular/core';

import { PageHeader } from '../../shared/page-header';
import { PlannedFeatureList } from '../../shared/planned-feature-list';

@Component({
  selector: 'app-properties-page',
  imports: [PageHeader, PlannedFeatureList],
  template: `
    <app-page-header
      heading="Properties"
      description="Every listing the agency manages, prepared once and published to many portals."
    />
    <app-planned-feature-list
      icon="pi pi-building"
      heading="Property management is coming next"
      summary="Brokers will create and edit properties here and choose the portals to publish them to."
      [features]="features"
    />
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PropertiesPage {
  protected readonly features: readonly string[] = [
    'Property list with filters and the status on each portal at a glance',
    'Property form with photo upload and drag-and-drop reordering',
    'Pre-publish check that lists the missing fields for each portal',
    'Bulk publish and bulk remove for selected properties',
  ];
}
