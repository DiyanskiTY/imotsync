import { HttpParams } from '@angular/common/http';
import { convertToParamMap, ParamMap, Params } from '@angular/router';

/** One field of a list page's state, as it may appear in the URL and in the API query. */
export type QueryField =
  | { readonly type: 'integer' | 'number'; readonly min: number; readonly max: number }
  | { readonly type: 'text'; readonly maxLength: number }
  /** A single value from a fixed list. */
  | { readonly type: 'one'; readonly values: readonly string[] }
  /** Several values; from a fixed list when `values` is given. Comma-separated in URLs. */
  | { readonly type: 'many'; readonly values?: readonly string[] };

export type QueryFields = Readonly<Record<string, QueryField>>;

type FieldValue<F extends QueryField> = F extends { type: 'integer' | 'number' }
  ? number
  : F extends { type: 'one'; values: readonly (infer V)[] }
    ? V
    : F extends { type: 'many'; values: readonly (infer V)[] }
      ? readonly V[]
      : F extends { type: 'many' }
        ? readonly string[]
        : string;

/** A list page's state: any subset of its fields, each with a valid value. */
export type QueryState<S extends QueryFields> = { -readonly [K in keyof S]?: FieldValue<S[K]> };

type RawValue = string | number | readonly string[];

/**
 * The state of a list page (filters, sort, page) and its three representations:
 * - the URL query, so a filtered view can be reloaded, bookmarked and shared,
 * - the page's state, with every value validated and typed,
 * - the API query, with only the fields the API knows.
 *
 * Anything invalid in the URL (a typo, an old link, a hand-edited value) is dropped instead of
 * being sent to the API, which would answer 400 for it. Rules that span fields (a maximum below
 * the minimum) go in `normalize`, which every conversion applies, reading and writing alike.
 */
export class UrlQuery<S extends QueryFields> {
  constructor(
    readonly fields: S,
    readonly defaults: QueryState<S>,
    private readonly normalize: (state: QueryState<S>) => QueryState<S> = (state) => state,
  ) {}

  fromParams(params: ParamMap): QueryState<S> {
    const state = { ...this.defaults } as Record<string, RawValue>;
    for (const [key, field] of this.entries()) {
      const value = parseField(field, params.getAll(key));
      if (value !== undefined) {
        state[key] = value;
      }
    }
    return this.normalize(state as QueryState<S>);
  }

  /**
   * Whether two states describe the same list once written to a URL and read back, e.g. a filter
   * form whose search has a trailing space and the URL state it produced.
   */
  equivalent(a: QueryState<S>, b: QueryState<S>): boolean {
    return JSON.stringify(this.canonical(a)) === JSON.stringify(this.canonical(b));
  }

  /** Router query params: defaults and empty values left out, lists comma-separated. */
  toQueryParams(state: QueryState<S>): Params {
    const params: Params = {};
    for (const [key, value] of this.setValues(state)) {
      if (!sameValue(value, this.defaults[key])) {
        params[key] = format(value);
      }
    }
    return params;
  }

  /** API query: every set value, defaults included, so the request does not rely on the API's. */
  toHttpParams(state: QueryState<S>): HttpParams {
    let params = new HttpParams();
    for (const [key, value] of this.setValues(state)) {
      params = params.set(key, format(value));
    }
    return params;
  }

  private entries(): [keyof S & string, QueryField][] {
    return Object.entries(this.fields) as [keyof S & string, QueryField][];
  }

  private canonical(state: QueryState<S>): Params {
    return this.toQueryParams(this.fromParams(convertToParamMap(this.toQueryParams(state))));
  }

  private *setValues(input: QueryState<S>): Generator<[keyof S & string, RawValue]> {
    const state = this.normalize(input);
    for (const [key] of this.entries()) {
      const value = state[key] as RawValue | undefined;
      if (value !== undefined && !isEmpty(value)) {
        yield [key, value];
      }
    }
  }
}

function parseField(field: QueryField, raw: string[]): RawValue | undefined {
  switch (field.type) {
    case 'integer':
    case 'number': {
      const value = Number(raw[0]);
      const valid =
        raw[0] !== undefined &&
        raw[0].trim() !== '' &&
        Number.isFinite(value) &&
        (field.type === 'number' || Number.isInteger(value)) &&
        value >= field.min &&
        value <= field.max;
      return valid ? value : undefined;
    }
    case 'text': {
      const value = raw[0]?.trim() ?? '';
      return value.length > 0 && value.length <= field.maxLength ? value : undefined;
    }
    case 'one':
      return raw[0] !== undefined && field.values.includes(raw[0]) ? raw[0] : undefined;
    case 'many': {
      const allowed = field.values;
      const values = raw
        .flatMap((part) => part.split(','))
        .map((part) => part.trim())
        .filter((part) => part.length > 0 && (!allowed || allowed.includes(part)));
      const unique = [...new Set(values)];
      return unique.length > 0 ? unique : undefined;
    }
  }
}

function isEmpty(value: RawValue): boolean {
  return typeof value === 'string' ? value.trim() === '' : Array.isArray(value) && !value.length;
}

function format(value: RawValue): string {
  return typeof value === 'object' ? value.join(',') : String(value);
}

function sameValue(a: RawValue, b: unknown): boolean {
  return b !== undefined && format(a) === format(b as RawValue);
}
