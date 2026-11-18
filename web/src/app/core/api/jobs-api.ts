import { HttpClient, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { map, Observable } from 'rxjs';

import type { Job, JobList, JobResponse } from './models';

export const JOBS_URL = '/api/jobs';

/** The job log: every publish, update and remove attempt per portal listing. */
@Injectable({ providedIn: 'root' })
export class JobsApi {
  private readonly http = inject(HttpClient);

  /** `params` must hold only fields of GET /api/jobs (see JOB_LIST_QUERY). */
  list(params: HttpParams): Observable<JobList> {
    return this.http.get<JobList>(JOBS_URL, { params });
  }

  /**
   * Queues a new job for the failed one's listing and action (the failed job stays in the log).
   * 409 when the job is not its listing's newest, or something else is queued for the listing.
   */
  retry(id: number): Observable<Job> {
    return this.http
      .post<JobResponse>(`${JOBS_URL}/${id}/retry`, null)
      .pipe(map((response) => response.data));
  }
}
