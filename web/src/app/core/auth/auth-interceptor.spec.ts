import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import type { MockInstance } from 'vitest';

import { authInterceptor } from './auth-interceptor';
import { AuthSession } from './auth-session';

describe('authInterceptor', () => {
  let http: HttpClient;
  let backend: HttpTestingController;
  let token: string | null;
  let end: ReturnType<typeof vi.fn<() => boolean>>;
  let navigate: MockInstance<Router['navigate']>;

  beforeEach(() => {
    token = 'token-123';
    end = vi.fn(() => {
      const wasActive = token !== null;
      token = null;
      return wasActive;
    });
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        provideHttpClient(withInterceptors([authInterceptor])),
        provideHttpClientTesting(),
        { provide: AuthSession, useValue: { token: () => token, end } },
      ],
    });
    http = TestBed.inject(HttpClient);
    backend = TestBed.inject(HttpTestingController);
    navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
  });

  afterEach(() => backend.verify());

  it('adds the bearer token to API calls', () => {
    http.get('/api/properties').subscribe();
    const request = backend.expectOne('/api/properties');
    expect(request.request.headers.get('Authorization')).toBe('Bearer token-123');
    request.flush({});
  });

  it.each(['/api/auth/login', '/api/health', '/uploads/properties/1/a.jpg', '/assets/x.json'])(
    'leaves %s without a token',
    (url) => {
      http.get(url).subscribe();
      const request = backend.expectOne(url);
      expect(request.request.headers.has('Authorization')).toBe(false);
      request.flush({});
    },
  );

  it('sends API calls without a header when signed out', () => {
    token = null;
    http.get('/api/jobs').subscribe({ error: () => undefined });
    const request = backend.expectOne('/api/jobs');
    expect(request.request.headers.has('Authorization')).toBe(false);
    request.flush({}, { status: 401, statusText: 'Unauthorized' });
  });

  it('ends the session on a 401 and sends the user to the login page once', () => {
    const errors: unknown[] = [];
    http.get('/api/properties').subscribe({ error: (e: unknown) => errors.push(e) });
    http.get('/api/jobs').subscribe({ error: (e: unknown) => errors.push(e) });

    const unauthorized = { status: 401, statusText: 'Unauthorized' };
    const body = { error: { code: 'UNAUTHORIZED', message: 'Token has expired' } };
    backend.expectOne('/api/properties').flush(body, unauthorized);
    backend.expectOne('/api/jobs').flush(body, unauthorized);

    expect(errors).toHaveLength(2);
    expect(end).toHaveBeenCalledTimes(2);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith(['/login'], {
      queryParams: { returnUrl: '/', reason: 'expired' },
    });
  });

  it('sends the user to the login page when their expired session meets a 401', () => {
    token = null; // expired: no token to send, but the session is still held
    end.mockReturnValue(true);
    http.get('/api/jobs').subscribe({ error: () => undefined });
    backend.expectOne('/api/jobs').flush({}, { status: 401, statusText: 'Unauthorized' });

    expect(navigate).toHaveBeenCalledWith(['/login'], {
      queryParams: { returnUrl: '/', reason: 'expired' },
    });
  });

  it('does not redirect on a failed login (401 INVALID_CREDENTIALS)', () => {
    http.post('/api/auth/login', {}).subscribe({ error: () => undefined });
    backend.expectOne('/api/auth/login').flush(
      { error: { code: 'INVALID_CREDENTIALS', message: 'Wrong' } },
      {
        status: 401,
        statusText: 'Unauthorized',
      },
    );
    expect(end).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('passes other errors through untouched', () => {
    http.get('/api/properties/9').subscribe({ error: () => undefined });
    backend.expectOne('/api/properties/9').flush({}, { status: 404, statusText: 'Not Found' });
    expect(end).not.toHaveBeenCalled();
  });
});
