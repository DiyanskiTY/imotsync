import { query, type ValidationChain } from 'express-validator';
import { JOB_ACTIONS, JOB_STATUSES, type JobAction, type JobStatus } from '../../db/types.js';
import { MAX_ID } from '../../lib/validation.js';
import { JOB_SORT_COLUMNS, type JobSort, type JobSortField } from './jobs.repository.js';

export const JOB_LIST_LIMITS = { pageMax: 1_000_000, pageSizeMax: 100 } as const;
export const DEFAULT_JOB_PAGE_SIZE = 20;
export const DEFAULT_JOB_SORT = '-createdAt';

/** Every accepted sort value: "createdAt" ascending, "-createdAt" descending. */
export const JOB_SORT_VALUES: readonly string[] = Object.keys(JOB_SORT_COLUMNS).flatMap((field) => [
  field,
  `-${field}`,
]);

/** "-runAfter" -> {field: "runAfter", direction: "desc"}; anything unknown -> null. */
export function parseJobSort(value: string): JobSort | null {
  const direction = value.startsWith('-') ? 'desc' : 'asc';
  const field = direction === 'desc' ? value.slice(1) : value;
  return Object.hasOwn(JOB_SORT_COLUMNS, field)
    ? { field: field as JobSortField, direction }
    : null;
}

/** Shape of a portal key (portal_listings.portal); unknown keys simply match nothing. */
export const PORTAL_KEY_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

const isString = (value: unknown): value is string => typeof value === 'string';

/** "1".."max" given once -> number. */
function intQuery(name: string, max: number): ValidationChain {
  return query(name)
    .optional()
    .custom(
      (value: unknown) => isString(value) && /^[1-9]\d{0,9}$/.test(value) && Number(value) <= max,
    )
    .withMessage(`must be an integer from 1 to ${max}`)
    .bail()
    .toInt();
}

/** "a,b" (or ?x=a&x=b) -> ["a", "b"], each passing `check`. */
function listQuery(name: string, check: (item: string) => boolean, message: string) {
  return query(name)
    .optional()
    .customSanitizer((value: unknown) => (Array.isArray(value) ? value.join(',') : value))
    .custom(isString)
    .withMessage(message)
    .bail()
    .customSanitizer((value: string) =>
      value
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0),
    )
    .custom((items: string[]) => items.every(check))
    .withMessage(message);
}

const oneOf = (values: readonly string[]) => (item: string) => values.includes(item);

/** GET /jobs. */
export const listJobsValidators: ValidationChain[] = [
  intQuery('page', JOB_LIST_LIMITS.pageMax),
  intQuery('pageSize', JOB_LIST_LIMITS.pageSizeMax),
  listQuery(
    'status',
    oneOf(JOB_STATUSES),
    `must be a comma-separated list of: ${JOB_STATUSES.join(', ')}`,
  ),
  listQuery(
    'action',
    oneOf(JOB_ACTIONS),
    `must be a comma-separated list of: ${JOB_ACTIONS.join(', ')}`,
  ),
  listQuery(
    'portal',
    (item) => PORTAL_KEY_PATTERN.test(item),
    'must be a comma-separated list of portal keys',
  ),
  intQuery('propertyId', MAX_ID),
  query('sort')
    .optional()
    .custom((value: unknown) => isString(value) && JOB_SORT_VALUES.includes(value))
    .withMessage(`must be one of: ${JOB_SORT_VALUES.join(', ')}`),
];

export interface ListJobsQuery {
  page?: number;
  pageSize?: number;
  status?: JobStatus[];
  action?: JobAction[];
  portal?: string[];
  propertyId?: number;
  sort?: string;
}
