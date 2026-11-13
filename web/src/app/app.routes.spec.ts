import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Title } from '@angular/platform-browser';
import { provideRouter, Router, TitleStrategy } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';

import { routes } from './app.routes';
import { AppTitleStrategy } from './core/app-title-strategy';
import { HEALTH_URL, HealthReport } from './core/health/health-api';

describe('app routes', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter(routes),
        { provide: TitleStrategy, useClass: AppTitleStrategy },
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    });
  });

  afterEach(() => TestBed.inject(HttpTestingController).verify());

  async function navigate(url: string): Promise<HTMLElement> {
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl(url);
    return harness.fixture.nativeElement as HTMLElement;
  }

  it('redirects the root URL to the dashboard', async () => {
    const root = await navigate('/');

    expect(TestBed.inject(Router).url).toBe('/dashboard');
    expect(TestBed.inject(Title).getTitle()).toBe('Dashboard | ImotSync');
    expect(root.querySelector('h1')?.textContent).toContain('Dashboard');
    TestBed.inject(HttpTestingController)
      .expectOne(HEALTH_URL)
      .flush({ status: 'ok', db: 'up', version: '0.1.0', uptimeSeconds: 1 } satisfies HealthReport);
  });

  it.each([
    ['/properties', 'Properties'],
    ['/jobs', 'Jobs'],
  ])('lazy-loads %s with its page title', async (url, heading) => {
    const root = await navigate(url);

    expect(TestBed.inject(Title).getTitle()).toBe(`${heading} | ImotSync`);
    expect(root.querySelector('h1')?.textContent).toContain(heading);
  });

  it('shows a not-found page for unknown URLs', async () => {
    const root = await navigate('/no-such-page');

    expect(TestBed.inject(Title).getTitle()).toBe('Page not found | ImotSync');
    expect(root.querySelector('h1')?.textContent).toContain('Page not found');
  });
});
