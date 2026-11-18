import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Title } from '@angular/platform-browser';
import { provideRouter, Router, TitleStrategy } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { ConfirmationService, MessageService } from 'primeng/api';

import { routes } from './app.routes';
import { AppTitleStrategy } from './core/app-title-strategy';
import { AUTH_STORAGE_KEY } from './core/auth/auth-session';
import { HEALTH_URL, HealthReport } from './core/health/health-api';

function signIn(): void {
  localStorage.setItem(
    AUTH_STORAGE_KEY,
    JSON.stringify({
      accessToken: 'token',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 1, email: 'a@example.test', fullName: 'Demo Admin', role: 'admin' },
    }),
  );
}

describe('app routes', () => {
  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({
      providers: [
        MessageService,
        ConfirmationService,
        provideRouter(routes),
        { provide: TitleStrategy, useClass: AppTitleStrategy },
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    });
  });

  afterEach(() => {
    TestBed.inject(HttpTestingController).verify();
    localStorage.clear();
  });

  it('sends a signed-out visitor to the login page', async () => {
    const root = await navigate('/properties');

    expect(TestBed.inject(Router).url).toBe('/login?returnUrl=%2Fproperties');
    expect(TestBed.inject(Title).getTitle()).toBe('Sign in | ImotSync');
    expect(root.querySelector('h1')?.textContent).toContain('Sign in');
  });

  async function navigate(url: string): Promise<HTMLElement> {
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl(url);
    return harness.fixture.nativeElement as HTMLElement;
  }

  it('redirects the root URL to the dashboard', async () => {
    signIn();
    const root = await navigate('/');

    expect(TestBed.inject(Router).url).toBe('/dashboard');
    expect(TestBed.inject(Title).getTitle()).toBe('Dashboard | ImotSync');
    expect(root.querySelector('h1')?.textContent).toContain('Dashboard');
    TestBed.inject(HttpTestingController)
      .expectOne(HEALTH_URL)
      .flush({ status: 'ok', db: 'up', version: '0.1.0', uptimeSeconds: 1 } satisfies HealthReport);
    TestBed.inject(HttpTestingController).match(() => true);
  });

  it.each([
    ['/properties', 'Properties'],
    ['/jobs', 'Jobs'],
  ])('lazy-loads %s with its page title', async (url, heading) => {
    signIn();
    const root = await navigate(url);

    expect(TestBed.inject(Title).getTitle()).toBe(`${heading} | ImotSync`);
    expect(root.querySelector('h1')?.textContent).toContain(heading);
    // The pages load their data; this spec is only about routing.
    TestBed.inject(HttpTestingController).match(() => true);
  });

  it('shows a not-found page for unknown URLs', async () => {
    signIn();
    const root = await navigate('/no-such-page');

    expect(TestBed.inject(Title).getTitle()).toBe('Page not found | ImotSync');
    expect(root.querySelector('h1')?.textContent).toContain('Page not found');
  });
});
