import { inject, InjectionToken, Signal } from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import { EMPTY, switchMap, timer } from 'rxjs';

/**
 * How often pages refresh while the worker has jobs in flight (a listing `pending`, a job
 * `queued` or `running`). A token so specs can make it a few milliseconds.
 */
export const STATUS_POLL_MS = new InjectionToken<number>('STATUS_POLL_MS', {
  providedIn: 'root',
  factory: () => 4000,
});

/**
 * Calls `refresh` STATUS_POLL_MS after `due` becomes true. `due` should be false while a refresh
 * is loading, so each finished load that still needs one schedules the next; once it stays
 * false, polling stops. Call it in an injection context; it ends with the component.
 */
export function pollWhile(due: Signal<boolean>, refresh: () => void): void {
  const intervalMs = inject(STATUS_POLL_MS);
  toObservable(due)
    .pipe(
      switchMap((isDue) => (isDue ? timer(intervalMs) : EMPTY)),
      takeUntilDestroyed(),
    )
    .subscribe(() => refresh());
}
