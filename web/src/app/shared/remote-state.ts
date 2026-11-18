import { catchError, map, Observable, of, scan, startWith, switchMap } from 'rxjs';

import { ApiError, toApiError } from '../core/api/api-error';

/**
 * Data loaded from the API, as a page shows it. `data` keeps the last successful result while a
 * reload runs or after it fails, so tables do not flicker empty between pages or refreshes.
 */
export interface RemoteState<T> {
  loading: boolean;
  data: T | null;
  error: ApiError | null;
}

type Step<T> =
  { kind: 'loading' } | { kind: 'loaded'; data: T } | { kind: 'failed'; error: ApiError };

const INITIAL = { loading: true, data: null, error: null } as const;

/** Runs `load` for every request from `requests`, cancelling the one still running. */
export function remoteState<R, T>(
  requests: Observable<R>,
  load: (request: R) => Observable<T>,
): Observable<RemoteState<T>> {
  return requests.pipe(
    switchMap((request) =>
      load(request).pipe(
        map((data): Step<T> => ({ kind: 'loaded', data })),
        catchError((error: unknown) => of<Step<T>>({ kind: 'failed', error: toApiError(error) })),
        startWith<Step<T>>({ kind: 'loading' }),
      ),
    ),
    scan((state: RemoteState<T>, step: Step<T>): RemoteState<T> => {
      switch (step.kind) {
        case 'loading':
          return { loading: true, data: state.data, error: null };
        case 'loaded':
          return { loading: false, data: step.data, error: null };
        case 'failed':
          return { loading: false, data: state.data, error: step.error };
      }
    }, INITIAL),
    startWith<RemoteState<T>>(INITIAL),
  );
}
