import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
  TestRequest,
} from '@angular/common/http/testing';
import { ChangeDetectionStrategy, Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { MessageService } from 'primeng/api';
import { of } from 'rxjs';
import type { MockInstance } from 'vitest';

import type { Job, JobList } from '../../core/api/models';
import { PortalsApi } from '../../core/api/portals-api';
import { STATUS_POLL_MS } from '../../shared/polling';
import { job, PORTALS } from '../../testing/fixtures';
import { JobLogPage } from './job-log-page';

@Component({ template: 'property', changeDetection: ChangeDetectionStrategy.OnPush })
class BlankPage {}

const POLL_MS = 20;

function list(jobs: Job[], total = 100): JobList {
  return { data: jobs, meta: { page: 1, pageSize: 20, total, totalPages: 5 } };
}

describe('JobLogPage', () => {
  let http: HttpTestingController;
  let harness: RouterTestingHarness;
  let toast: MockInstance<MessageService['add']>;

  beforeEach(async () => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'jobs', component: JobLogPage },
          { path: 'properties/:id', component: BlankPage },
        ]),
        provideHttpClient(),
        provideHttpClientTesting(),
        MessageService,
        { provide: PortalsApi, useValue: { portals$: of(PORTALS) } },
        { provide: STATUS_POLL_MS, useValue: POLL_MS },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    toast = vi.spyOn(TestBed.inject(MessageService), 'add');
    harness = await RouterTestingHarness.create();
  });

  afterEach(() => http.verify());

  const root = () => harness.fixture.nativeElement as HTMLElement;
  const stable = () => harness.fixture.whenStable();
  const expectList = (): TestRequest => http.expectOne((request) => request.url === '/api/jobs');

  async function open(url: string, jobs: Job[]): Promise<TestRequest> {
    await harness.navigateByUrl(url);
    const request = expectList();
    request.flush(list(jobs));
    await stable();
    return request;
  }

  it('loads the jobs the URL asks for', async () => {
    const request = await open('/jobs?status=failed&propertyId=1', [job()]);
    expect(request.request.params.toString()).toBe(
      'page=1&pageSize=20&status=failed&propertyId=1&sort=-createdAt',
    );
    expect(root().querySelector('[data-testid="property-filter"]')?.textContent).toContain(
      'IS-00001',
    );
  });

  it('shows each job with its portal, action, status and attempts', async () => {
    await open('/jobs', [job()]);
    const row = root().querySelector('[data-testid="job-row-101"]');
    expect(row?.textContent).toContain('IS-00001');
    expect(row?.textContent).toContain('Demo portal');
    expect(row?.textContent).toContain('Publish');
    expect(row?.textContent).toContain('Failed');
    expect(row?.textContent).toContain('5/5');
    expect(row?.textContent).toContain('Gave up after 5 attempts');
  });

  it('offers Retry only for failed jobs', async () => {
    await open('/jobs', [job(), job({ id: 102, status: 'succeeded', lastError: null })]);
    expect(root().querySelector('[data-testid="retry-101"]')).not.toBeNull();
    expect(root().querySelector('[data-testid="retry-102"]')).toBeNull();
  });

  it('retries a failed job and reloads the log', async () => {
    await open('/jobs', [job()]);
    root().querySelector<HTMLElement>('[data-testid="retry-101"] button')?.click();

    http
      .expectOne('/api/jobs/101/retry')
      .flush(
        { data: job({ id: 102, status: 'queued', attempts: 0 }) },
        { status: 202, statusText: 'Accepted' },
      );
    await stable();

    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ severity: 'success', detail: 'Job 102 is queued.' }),
    );
    expectList().flush(list([]));
  });

  it('explains why a job cannot be retried', async () => {
    await open('/jobs', [job()]);
    root().querySelector<HTMLElement>('[data-testid="retry-101"] button')?.click();
    http.expectOne('/api/jobs/101/retry').flush(
      {
        error: {
          code: 'CONFLICT',
          message: 'A newer job exists for this listing.',
        },
      },
      { status: 409, statusText: 'Conflict' },
    );
    await stable();

    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: 'warn',
        detail: 'A newer job exists for this listing.',
      }),
    );
  });

  it('removes the property filter', async () => {
    await open('/jobs?propertyId=1&status=failed', [job()]);
    root().querySelector<HTMLElement>('[data-testid="property-filter"] button')?.click();
    await stable();

    expect(TestBed.inject(Router).url).toBe('/jobs?status=failed');
    expectList().flush(list([]));
  });

  it('refreshes while jobs are queued or running, and stops when none are', async () => {
    await open('/jobs', [job({ status: 'running', lastError: null })]);

    await new Promise((resolve) => setTimeout(resolve, POLL_MS * 3));
    expectList().flush(list([job()]));
    await stable();

    await new Promise((resolve) => setTimeout(resolve, POLL_MS * 3));
    http.expectNone((request) => request.url === '/api/jobs');
  });
});
