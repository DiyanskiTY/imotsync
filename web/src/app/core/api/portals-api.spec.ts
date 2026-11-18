import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import type { Portal } from './models';
import { PORTALS_URL, PortalsApi } from './portals-api';

const portals: Portal[] = [
  { key: 'realistimo', displayName: 'Realistimo', mode: 'feed', feedUrl: 'http://x/feeds/r.xml' },
  { key: 'demo', displayName: 'Demo portal', mode: 'push', feedUrl: null },
];

describe('PortalsApi', () => {
  let api: PortalsApi;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    api = TestBed.inject(PortalsApi);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('loads the portal list once and shares it', () => {
    const seen: Portal[][] = [];
    api.portals$.subscribe((list) => seen.push(list));
    http.expectOne(PORTALS_URL).flush({ data: portals });
    api.portals$.subscribe((list) => seen.push(list));

    http.expectNone(PORTALS_URL);
    expect(seen).toEqual([portals, portals]);
  });

  it('tries again after a failure', () => {
    api.portals$.subscribe({ error: () => undefined });
    http.expectOne(PORTALS_URL).flush({}, { status: 500, statusText: 'Server Error' });

    let loaded: Portal[] | undefined;
    api.portals$.subscribe((list) => (loaded = list));
    http.expectOne(PORTALS_URL).flush({ data: portals });
    expect(loaded).toEqual(portals);
  });
});
