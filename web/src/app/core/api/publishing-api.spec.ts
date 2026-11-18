import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { portalCheck } from '../../testing/fixtures';
import type { PortalCheck, PublishResult } from './models';
import { PublishingApi } from './publishing-api';

describe('PublishingApi', () => {
  let api: PublishingApi;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    api = TestBed.inject(PublishingApi);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('runs the pre-publish check for every portal', () => {
    let checks: PortalCheck[] | undefined;
    api.checks(7).subscribe((c) => (checks = c));
    const request = http.expectOne('/api/properties/7/checks');
    expect(request.request.params.keys()).toEqual([]);
    request.flush({ data: [portalCheck()] });
    expect(checks).toEqual([portalCheck()]);
  });

  it('publishes to and unpublishes from the given portals', () => {
    const result: PublishResult = { listings: [], jobs: [] };
    const seen: PublishResult[] = [];

    api.publish(7, ['bazar', 'demo']).subscribe((r) => seen.push(r));
    const publish = http.expectOne('/api/properties/7/publish');
    expect(publish.request.body).toEqual({ portals: ['bazar', 'demo'] });
    publish.flush({ data: result }, { status: 202, statusText: 'Accepted' });

    api.unpublish(7, ['bazar']).subscribe((r) => seen.push(r));
    const unpublish = http.expectOne('/api/properties/7/unpublish');
    expect(unpublish.request.body).toEqual({ portals: ['bazar'] });
    unpublish.flush({ data: result }, { status: 202, statusText: 'Accepted' });

    expect(seen).toEqual([result, result]);
  });
});
