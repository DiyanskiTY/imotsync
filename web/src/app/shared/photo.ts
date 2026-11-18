import { ChangeDetectionStrategy, Component, input, linkedSignal } from '@angular/core';

/**
 * A property photo that admits when it is missing: if the file cannot be loaded (deleted,
 * moved, a broken upload), a placeholder says so instead of the browser's broken-image icon.
 * Size it with classes on the element, e.g. `<app-photo class="h-12 w-16" ... />`.
 */
@Component({
  selector: 'app-photo',
  template: `
    @if (broken()) {
      <span
        data-testid="photo-broken"
        role="img"
        [attr.aria-label]="(alt() || 'Photo') + ' could not be loaded'"
        [title]="'Could not load ' + src()"
        class="flex h-full w-full flex-col items-center justify-center gap-1 bg-surface-100 text-muted-color"
      >
        <i class="pi pi-exclamation-triangle text-orange-600" aria-hidden="true"></i>
        @if (showLabel()) {
          <span class="text-xs" aria-hidden="true">Photo missing</span>
        }
      </span>
    } @else {
      <img
        [src]="src()"
        [alt]="alt()"
        loading="lazy"
        class="h-full w-full object-cover"
        (error)="broken.set(true)"
      />
    }
  `,
  host: { class: 'block overflow-hidden' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Photo {
  readonly src = input.required<string>();
  readonly alt = input('');
  /** Adds "Photo missing" under the icon; for tiles large enough to hold it. */
  readonly showLabel = input(false);

  /** Reset for every new address, so a re-uploaded or moved photo gets another try. */
  protected readonly broken = linkedSignal(() => {
    this.src();
    return false;
  });
}
