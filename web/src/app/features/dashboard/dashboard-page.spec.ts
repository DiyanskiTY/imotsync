import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { SHOW_DEV_HINTS } from '../../core/dev-hints';
import { HEALTH_URL, HealthReport } from '../../core/health/health-api';
import { DashboardPage } from './dashboard-page';

describe('DashboardPage', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [DashboardPage],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
  });

  afterEach(() => TestBed.inject(HttpTestingController).verify());

  /** Creates the page. Tests may override providers until they call this. */
  function render(): ComponentFixture<DashboardPage> {
    const fixture = TestBed.createComponent(DashboardPage);
    http = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
    return fixture;
  }

  function element(fixture: ComponentFixture<DashboardPage>): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  function tileValue(fixture: ComponentFixture<DashboardPage>, label: string): string {
    const tile = element(fixture).querySelector(`[data-testid="tile-value-${label}"]`);
    return tile?.textContent?.trim() ?? '';
  }

  function messages(fixture: ComponentFixture<DashboardPage>): string[] {
    return Array.from(element(fixture).querySelectorAll('p-message')).map(
      (message) => message.textContent?.replace(/\s+/g, ' ').trim() ?? '',
    );
  }

  it('shows a loading state while the health check is running', () => {
    const fixture = render();
    const request = http.expectOne(HEALTH_URL);

    expect(element(fixture).querySelectorAll('p-skeleton').length).toBe(8);
    expect(element(fixture).textContent).toContain('Checking the API');
    expect(messages(fixture)).toEqual([]);

    request.flush({ status: 'ok', db: 'up', version: '0.1.0', uptimeSeconds: 1 });
  });

  it('shows the API and database status when everything is up', async () => {
    const fixture = render();
    const report: HealthReport = { status: 'ok', db: 'up', version: '0.1.0', uptimeSeconds: 3725 };

    http.expectOne(HEALTH_URL).flush(report);
    await fixture.whenStable();

    expect(tileValue(fixture, 'API')).toBe('Online');
    expect(tileValue(fixture, 'Database')).toBe('Up');
    expect(tileValue(fixture, 'Version')).toBe('v0.1.0');
    expect(tileValue(fixture, 'Uptime')).toBe('1h 2m');
    expect(element(fixture).querySelectorAll('p-skeleton').length).toBe(0);
    expect(element(fixture).textContent).toContain('Last checked at');
    expect(messages(fixture)).toEqual([]);
  });

  it('shows a degraded state when the API reports the database as down', async () => {
    const fixture = render();
    const report: HealthReport = {
      status: 'degraded',
      db: 'down',
      version: '0.1.0',
      uptimeSeconds: 12,
    };

    http.expectOne(HEALTH_URL).flush(report, { status: 503, statusText: 'Service Unavailable' });
    await fixture.whenStable();

    expect(tileValue(fixture, 'API')).toBe('Degraded');
    expect(tileValue(fixture, 'Database')).toBe('Down');
    expect(tileValue(fixture, 'Uptime')).toBe('12s');
    expect(messages(fixture)).toEqual([expect.stringContaining('cannot reach the database')]);
    expect(messages(fixture)[0]).toContain('docker compose up -d db');
  });

  it('shows an error state when the API cannot be reached', async () => {
    const fixture = render();

    http.expectOne(HEALTH_URL).error(new ProgressEvent('error'));
    await fixture.whenStable();

    expect(tileValue(fixture, 'API')).toBe('Offline');
    expect(tileValue(fixture, 'Database')).toBe('Unknown');
    expect(tileValue(fixture, 'Version')).toBe('—');
    expect(messages(fixture)).toEqual([expect.stringContaining('The API could not be reached.')]);
    expect(messages(fixture)[0]).toContain('npm run dev');
  });

  it('shows the API error message when the API answers with an error', async () => {
    const fixture = render();
    const body = { error: { code: 'INTERNAL', message: 'Something broke.' } };

    http.expectOne(HEALTH_URL).flush(body, { status: 500, statusText: 'Internal Server Error' });
    await fixture.whenStable();

    expect(tileValue(fixture, 'API')).toBe('Error');
    expect(tileValue(fixture, 'Database')).toBe('Unknown');
    expect(messages(fixture)).toEqual(['Something broke. Refresh to try again.']);
  });

  it('shows an error when a successful response is not a health report', async () => {
    const fixture = render();

    http.expectOne(HEALTH_URL).flush(null);
    await fixture.whenStable();

    expect(tileValue(fixture, 'API')).toBe('Error');
    expect(messages(fixture)).toEqual([
      'The API returned an unexpected health response. Refresh to try again.',
    ]);
  });

  it('leaves out the developer set-up hints in production builds', async () => {
    TestBed.overrideProvider(SHOW_DEV_HINTS, { useValue: false });
    const fixture = render();
    http.expectOne(HEALTH_URL).error(new ProgressEvent('error'));
    await fixture.whenStable();

    expect(tileValue(fixture, 'API')).toBe('Offline');
    expect(messages(fixture)).toEqual(['The API could not be reached. Refresh to try again.']);

    element(fixture).querySelector<HTMLButtonElement>('p-button button')?.click();
    fixture.detectChanges();
    http
      .expectOne(HEALTH_URL)
      .flush(
        { status: 'degraded', db: 'down', version: '0.1.0', uptimeSeconds: 1 },
        { status: 503, statusText: 'Service Unavailable' },
      );
    await fixture.whenStable();

    expect(messages(fixture)).toEqual([
      'The API is running but cannot reach the database. Refresh to check again.',
    ]);
  });

  it('checks again when Refresh is clicked', async () => {
    const fixture = render();
    http.expectOne(HEALTH_URL).error(new ProgressEvent('error'));
    await fixture.whenStable();

    const refresh = element(fixture).querySelector<HTMLButtonElement>('p-button button');
    expect(refresh?.textContent).toContain('Refresh');
    refresh?.click();
    fixture.detectChanges();

    const retry = http.expectOne(HEALTH_URL);
    expect(element(fixture).querySelectorAll('p-skeleton').length).toBe(8);

    retry.flush({ status: 'ok', db: 'up', version: '0.1.0', uptimeSeconds: 5 });
    await fixture.whenStable();

    expect(tileValue(fixture, 'API')).toBe('Online');
    expect(messages(fixture)).toEqual([]);
  });
});
