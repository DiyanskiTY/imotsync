import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import { AbstractControl } from '@angular/forms';
import { startWith, switchMap } from 'rxjs';

import { describeFieldError } from './property-form';

/**
 * A labelled form field: the label, the projected input, and the control's error once the user
 * has touched it (or tried to save). Follows the control's own events, so it updates under
 * OnPush without the page having to tell it.
 */
@Component({
  selector: 'app-form-field',
  template: `
    <div class="flex flex-col gap-1.5">
      <label [for]="inputId()" class="text-sm font-medium text-color">
        {{ label() }}
        @if (required()) {
          <span class="text-red-700" aria-hidden="true">*</span>
        }
      </label>
      <ng-content />
      @if (error(); as message) {
        <small class="text-red-700" role="alert" [attr.data-testid]="'error-' + inputId()">
          {{ message }}
        </small>
      } @else if (hint()) {
        <small class="text-muted-color">{{ hint() }}</small>
      }
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FormField {
  readonly label = input.required<string>();
  readonly inputId = input.required<string>();
  readonly control = input.required<AbstractControl>();
  readonly hint = input<string>();
  readonly required = input(false);

  private readonly controlEvents = toSignal(
    toObservable(this.control).pipe(switchMap((control) => control.events.pipe(startWith(null)))),
  );

  protected readonly error = computed(() => {
    this.controlEvents();
    const control = this.control();
    return control.invalid && control.touched && control.errors
      ? describeFieldError(control.errors)
      : null;
  });
}
