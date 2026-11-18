import { HttpParams, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { job } from '../../testing/fixtures';
import { JobsApi } from './jobs-api';
import type { Job, JobList } from './models';

describe('JobsApi', () => {
  let api: JobsApi;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    api = TestBed.inject(JobsApi);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('lists jobs with the given query', () => {
    const list: JobList = {
      data: [job()],
      meta: { page: 1, pageSize: 20, total: 1, totalPages: 1 },
    };
    let result: JobList | undefined;
    api.list(new HttpParams().set('status', 'failed')).subscribe((r) => (result = r));
    const request = http.expectOne((r) => r.url === '/api/jobs');
    expect(request.request.params.get('status')).toBe('failed');
    request.flush(list);
    expect(result).toEqual(list);
  });

  it('retries a failed job and returns the new one', () => {
    const queued = job({ id: 102, status: 'queued', attempts: 0 });
    let result: Job | undefined;
    api.retry(101).subscribe((r) => (result = r));
    const request = http.expectOne('/api/jobs/101/retry');
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toBeNull();
    request.flush({ data: queued }, { status: 202, statusText: 'Accepted' });
    expect(result).toEqual(queued);
  });
});
