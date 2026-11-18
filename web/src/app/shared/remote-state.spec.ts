import { HttpErrorResponse } from '@angular/common/http';
import { Observable, Subject, throwError } from 'rxjs';

import { RemoteState, remoteState } from './remote-state';

describe('remoteState', () => {
  function collect<T>(source: Observable<RemoteState<T>>): RemoteState<T>[] {
    const states: RemoteState<T>[] = [];
    source.subscribe((state) => states.push(state));
    return states;
  }

  it('reports loading, then the data', () => {
    const requests = new Subject<void>();
    const response = new Subject<string>();
    const states = collect(remoteState(requests, () => response));

    requests.next();
    response.next('rows');

    expect(states).toEqual([
      { loading: true, data: null, error: null },
      { loading: true, data: null, error: null },
      { loading: false, data: 'rows', error: null },
    ]);
  });

  it('keeps the previous data while reloading and after an error', () => {
    const requests = new Subject<number>();
    let next = new Subject<string>();
    const states = collect(remoteState(requests, () => next));

    requests.next(1);
    next.next('page 1');
    next = new Subject<string>();
    requests.next(2);
    expect(states.at(-1)).toEqual({ loading: true, data: 'page 1', error: null });

    next.error(
      new HttpErrorResponse({
        status: 404,
        error: { error: { code: 'NOT_FOUND', message: 'Gone' } },
      }),
    );
    expect(states.at(-1)).toMatchObject({
      loading: false,
      data: 'page 1',
      error: { code: 'NOT_FOUND', message: 'Gone' },
    });
  });

  it('cancels the previous request when a new one starts', () => {
    const requests = new Subject<number>();
    const first = new Subject<string>();
    const second = new Subject<string>();
    const states = collect(remoteState(requests, (n) => (n === 1 ? first : second)));

    requests.next(1);
    requests.next(2);
    first.next('stale');
    second.next('fresh');

    expect(states.map((s) => s.data)).not.toContain('stale');
    expect(states.at(-1)).toEqual({ loading: false, data: 'fresh', error: null });
  });

  it('clears an earlier error once a load succeeds', () => {
    const requests = new Subject<boolean>();
    const states = collect(
      remoteState(requests, (fail) =>
        fail ? throwError(() => new Error('boom')) : new Observable<string>((s) => s.next('ok')),
      ),
    );
    requests.next(true);
    requests.next(false);
    expect(states.at(-1)).toEqual({ loading: false, data: 'ok', error: null });
  });
});
