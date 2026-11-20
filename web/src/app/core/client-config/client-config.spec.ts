import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { App } from '../../app';
import type { ClientConfig } from '../api/models';
import { CLIENT_CONFIG_URL, ClientConfigStore, DEFAULT_CLIENT_CONFIG } from './client-config';

const demo: ClientConfig = {
  demoMode: true,
  uploadLimits: { maxFileBytes: 5 * 1024 * 1024, maxFilesPerRequest: 5, maxPerProperty: 12 },
};

describe('ClientConfigStore', () => {
  let http: HttpTestingController;
  let store: ClientConfigStore;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
    store = TestBed.inject(ClientConfigStore);
  });

  afterEach(() => {
    http.verify();
  });

  it('starts with the defaults: not the demo, the API default limits', () => {
    expect(store.demoMode()).toBe(false);
    expect(store.uploadLimits()).toEqual(DEFAULT_CLIENT_CONFIG.uploadLimits);
  });

  it('takes what the API reports', async () => {
    const loading = store.load();
    http.expectOne(CLIENT_CONFIG_URL).flush(demo);
    await loading;

    expect(store.demoMode()).toBe(true);
    expect(store.uploadLimits()).toEqual(demo.uploadLimits);
  });

  it('keeps the defaults when the API fails or answers something else', async () => {
    const failed = store.load();
    http.expectOne(CLIENT_CONFIG_URL).flush('down', { status: 502, statusText: 'Bad Gateway' });
    await failed;
    const odd = store.load();
    http.expectOne(CLIENT_CONFIG_URL).flush({ demoMode: 'yes' });
    await odd;

    expect(store.demoMode()).toBe(false);
  });

  it('shows the demo banner above every page on the demo only', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('[data-testid="demo-banner"]')).toBeNull();

    const loading = store.load();
    http.expectOne(CLIENT_CONFIG_URL).flush(demo);
    await loading;
    await fixture.whenStable();

    expect(root.querySelector('[data-testid="demo-banner"]')?.textContent).toContain(
      'reset every night',
    );
  });
});
