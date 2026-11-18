import { HttpParams } from '@angular/common/http';
import { computed, effect, inject, Signal } from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { FormGroup } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { combineLatest, debounceTime, map, Observable, startWith, Subject } from 'rxjs';

import type { PaginationMeta } from '../core/api/models';
import { RemoteState, remoteState } from './remote-state';
import { QueryField, QueryFields, QueryState, UrlQuery } from './url-query';

const FILTER_DEBOUNCE_MS = 300;

/** The fields every list query has besides its filters. */
type ListFields = QueryFields & {
  readonly page: { readonly type: 'integer' };
  readonly pageSize: { readonly type: 'integer' };
  readonly sort: { readonly type: 'one'; readonly values: readonly string[] };
};
const LIST_FIELDS: ReadonlySet<string> = new Set(['page', 'pageSize', 'sort']);

/** A list state seen through its paging fields (and the filters as plain values). */
type ListState = Record<string, unknown> & { page?: number; pageSize?: number; sort?: string };

interface Page<T> {
  data: T[];
  meta: PaginationMeta;
}

export interface ListPageOptions<S extends ListFields, T> {
  query: UrlQuery<S>;
  load: (params: HttpParams) => Observable<Page<T>>;
  /**
   * The page's filter form. Its controls are named like the query fields they edit; an empty
   * value ('' / [] / null) means "no filter". Changes reach the URL after a short pause.
   */
  filters?: FormGroup;
}

/**
 * Everything a paginated, sortable, filterable list page shares: its state lives in the URL
 * (so a view can be reloaded and shared), it loads the page the URL describes, and the table's
 * paging and sorting and the filter form all change the URL rather than the data directly.
 * Call it in a field initializer (it injects the router).
 */
export function injectListPage<S extends ListFields, T>(options: ListPageOptions<S, T>) {
  const { query: codec, load, filters } = options;
  const router = inject(Router);
  const route = inject(ActivatedRoute);
  const reloads = new Subject<void>();

  const state$ = route.queryParamMap.pipe(map((params) => codec.fromParams(params)));
  const query = toSignal(state$, { requireSync: true });
  const result: Signal<RemoteState<Page<T>>> = toSignal(
    remoteState(
      combineLatest([state$, reloads.pipe(startWith(undefined))]).pipe(map(([state]) => state)),
      (state) => load(codec.toHttpParams(state)),
    ),
    { requireSync: true },
  );

  // S extends ListFields, so page, pageSize and sort have these types.
  const list = (): ListState => query() as ListState;
  const pageSize = computed(() => list().pageSize ?? (codec.defaults as ListState).pageSize ?? 20);
  const first = computed(() => ((list().page ?? 1) - 1) * pageSize());
  const sort = computed(() => list().sort ?? '');

  const navigate = (state: ListState): void => {
    void router.navigate([], {
      relativeTo: route,
      queryParams: codec.toQueryParams(state as QueryState<S>),
    });
  };
  /** Changes some fields; any filter change goes back to page 1. */
  const patch = (values: ListState): void => navigate({ ...list(), ...values, page: 1 });

  if (filters) {
    bindFilterForm(filters, codec, query, patch);
  }

  return {
    query,
    result,
    rows: computed(() => result().data?.data ?? []),
    /**
     * Until the first page arrives the total is unknown; claiming one more page than the current
     * one keeps the paginator from clamping the page from the URL back to 1.
     */
    total: computed(() => result().data?.meta.total ?? first() + pageSize() + 1),
    first,
    pageSize,
    sortField: computed(() => sort().replace(/^-/, '')),
    sortOrder: computed(() => (sort().startsWith('-') ? -1 : 1)),
    hasFilters: computed(() =>
      Object.entries(list()).some(([key, value]) => !LIST_FIELDS.has(key) && value !== undefined),
    ),

    reload: () => reloads.next(),
    clearFilters: () => navigate({ pageSize: list().pageSize, sort: list().sort }),
    /** Sets filters from outside the form (a link, a chip); back to page 1. */
    patch: (values: QueryState<S>) => patch(values as ListState),

    onPage: (event: { first: number; rows: number }) => {
      const page = Math.floor(event.first / event.rows) + 1;
      if (page !== list().page || event.rows !== pageSize()) {
        navigate({ ...list(), page, pageSize: event.rows });
      }
    },

    /** The table also emits this when [sortField] changes, so an unchanged sort is ignored. */
    onSort: (event: { field?: string; order?: number }) => {
      const next = `${event.order === -1 ? '-' : ''}${event.field ?? ''}`;
      if (next !== sort() && codec.fields.sort.values.includes(next)) {
        patch({ sort: next });
      }
    },
  };
}

/**
 * Keeps a filter form and the URL state in step. Form → URL after a pause; URL → form only when
 * the URL says something else than the form already does (back/forward, a link, Clear filters),
 * so the user's typing is never overwritten by its own normalised echo ("Sofia " → "Sofia").
 */
function bindFilterForm<S extends ListFields>(
  form: FormGroup,
  codec: UrlQuery<S>,
  query: Signal<QueryState<S>>,
  patch: (values: ListState) => void,
): void {
  const keys = Object.keys(form.controls);
  const formFilters = (): ListState => {
    const value = form.getRawValue() as Record<string, unknown>;
    return Object.fromEntries(
      keys.map((key) => [key, value[key] === null || value[key] === '' ? undefined : value[key]]),
    );
  };

  effect(() => {
    const state = query();
    const fromForm = { ...state, ...formFilters() } as QueryState<S>;
    if (!codec.equivalent(fromForm, state)) {
      const fields = codec.fields as QueryFields;
      const list = state as ListState;
      const value = Object.fromEntries(
        keys.map((key) => [key, toFormValue(fields[key], list[key])]),
      );
      form.setValue(value, { emitEvent: false });
    }
  });

  form.valueChanges
    .pipe(debounceTime(FILTER_DEBOUNCE_MS), takeUntilDestroyed())
    .subscribe(() => patch(formFilters()));
}

function toFormValue(field: QueryField | undefined, value: unknown): unknown {
  switch (field?.type) {
    case 'text':
      return value ?? '';
    case 'many':
      return [...((value as readonly unknown[] | undefined) ?? [])];
    default:
      return value ?? null;
  }
}
