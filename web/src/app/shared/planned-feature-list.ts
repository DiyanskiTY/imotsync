import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/** Empty state for a section that is not built yet: says what will land there. */
@Component({
  selector: 'app-planned-feature-list',
  template: `
    <section
      class="rounded-xl border border-dashed border-surface-300 bg-surface-0 p-6 sm:p-8"
      [attr.aria-labelledby]="headingId"
    >
      <div class="flex items-start gap-4">
        <span
          class="flex size-12 shrink-0 items-center justify-center rounded-full bg-highlight text-2xl"
          aria-hidden="true"
        >
          <i [class]="icon()"></i>
        </span>
        <div class="min-w-0">
          <h2 [id]="headingId" class="text-lg font-semibold text-color">{{ heading() }}</h2>
          <p class="mt-1 text-muted-color">{{ summary() }}</p>
        </div>
      </div>

      <ul class="mt-6 grid gap-3 sm:grid-cols-2">
        @for (feature of features(); track feature) {
          <li class="flex items-start gap-3 rounded-lg bg-surface-50 p-3 text-sm text-color">
            <i class="pi pi-check-circle mt-0.5 text-primary" aria-hidden="true"></i>
            <span>{{ feature }}</span>
          </li>
        }
      </ul>
    </section>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PlannedFeatureList {
  private static nextId = 0;

  readonly icon = input.required<string>();
  readonly heading = input.required<string>();
  readonly summary = input.required<string>();
  readonly features = input.required<readonly string[]>();

  protected readonly headingId = `planned-features-${PlannedFeatureList.nextId++}`;
}
