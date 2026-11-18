import { HttpClient } from '@angular/common/http';
import { computed, inject, Injectable } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { map, Observable, of, shareReplay } from 'rxjs';

import { remoteState } from '../../shared/remote-state';

import type { Portal, PortalList } from './models';

export const PORTALS_URL = '/api/portals';

/** The portals this deployment publishes to. They only change with a deployment, so one load is shared. */
@Injectable({ providedIn: 'root' })
export class PortalsApi {
  private readonly http = inject(HttpClient);

  readonly portals$: Observable<Portal[]> = this.http.get<PortalList>(PORTALS_URL).pipe(
    map((response) => response.data),
    // A failed load is not cached (shareReplay resets on error), so the next subscriber retries.
    shareReplay({ bufferSize: 1, refCount: false }),
  );
}

/**
 * The portals for a component: loaded once per app (PortalsApi caches them), with the load
 * state, a name lookup that falls back to the key, and select options. A failed load is retried
 * by the next component that asks, since the cache does not keep errors.
 * Call it in an injection context.
 */
export function injectPortals() {
  const api = inject(PortalsApi);
  const state = toSignal(
    remoteState(of(null), () => api.portals$),
    { requireSync: true },
  );
  const portals = computed(() => state().data ?? []);
  const names = computed(
    () => new Map(portals().map((portal) => [portal.key, portal.displayName])),
  );
  return {
    state,
    portals,
    error: computed(() => state().error),
    options: computed(() =>
      portals().map((portal) => ({ value: portal.key, label: portal.displayName })),
    ),
    displayName: (key: string): string => names().get(key) ?? key,
  };
}
