import { JOB_ACTIONS, JOB_SORTS, JOB_STATUSES, type JobListQuery } from '../../core/api/models';
import { QueryField, QueryState, UrlQuery } from '../../shared/url-query';

/**
 * The job log's filters, sort and page. Matches GET /api/jobs exactly (`satisfies` fails the
 * build on a missing or unknown field), because the API answers 400 for an unknown parameter.
 */
export const JOB_LIST_QUERY = new UrlQuery(
  {
    page: { type: 'integer', min: 1, max: 1_000_000 },
    pageSize: { type: 'integer', min: 1, max: 100 },
    status: { type: 'many', values: JOB_STATUSES },
    action: { type: 'many', values: JOB_ACTIONS },
    // Any key: the log also holds jobs of portals that are no longer registered.
    portal: { type: 'many' },
    propertyId: { type: 'integer', min: 1, max: 4_294_967_295 },
    sort: { type: 'one', values: JOB_SORTS },
  } as const satisfies Record<keyof JobListQuery, QueryField>,
  { page: 1, pageSize: 20, sort: '-createdAt' },
);

export type JobListState = QueryState<typeof JOB_LIST_QUERY.fields>;
