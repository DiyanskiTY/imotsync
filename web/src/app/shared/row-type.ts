import { Directive, input } from '@angular/core';

/**
 * Types the row variable of a PrimeNG table template, which PrimeNG leaves as `any`:
 * `<ng-template #body let-property [appRowType]="rows()">`. Strict templates then check every
 * use of `property` against the row type.
 */
/** What PrimeNG passes to body and expanded-row templates. */
export interface RowContext<T> {
  $implicit: T;
  rowIndex: number;
  expanded: boolean;
}

@Directive({ selector: 'ng-template[appRowType]' })
export class RowType<T> {
  /** The table's rows; only their type is used. */
  readonly appRowType = input.required<readonly T[]>();

  static ngTemplateContextGuard<T>(
    _directive: RowType<T>,
    context: unknown,
  ): context is RowContext<T> {
    return typeof context === 'object' && context !== null;
  }
}
