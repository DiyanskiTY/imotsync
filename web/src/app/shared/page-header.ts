import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/** Page heading with an optional description and a slot for page actions. */
@Component({
  selector: 'app-page-header',
  template: `
    <div class="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div class="min-w-0">
        <h1 class="text-2xl font-semibold tracking-tight text-color">{{ heading() }}</h1>
        @if (description()) {
          <p class="mt-1 text-muted-color">{{ description() }}</p>
        }
      </div>
      <div class="flex items-center gap-2">
        <ng-content />
      </div>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PageHeader {
  readonly heading = input.required<string>();
  readonly description = input<string>();
}
