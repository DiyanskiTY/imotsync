import { ChangeDetectionStrategy, Component } from '@angular/core';

/** Shown on every page of the public demo, above everything else. */
@Component({
  selector: 'app-demo-banner',
  template: `
    <aside
      aria-label="About this demo"
      class="border-b border-amber-300 bg-amber-50 px-4 py-2 text-center text-sm text-amber-950"
      data-testid="demo-banner"
    >
      <i class="pi pi-info-circle mr-1.5 align-[-1px]" aria-hidden="true"></i>
      <strong class="font-semibold">Public demo.</strong>
      Every property, name and photo here is made up, nothing is sent to a real portal, and the data
      is reset every night.
    </aside>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DemoBanner {}
