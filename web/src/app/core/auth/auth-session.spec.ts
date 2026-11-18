import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import type { LoginResponse, User } from '../api/models';
import { AUTH_STORAGE_KEY, AuthSession, LOGIN_URL } from './auth-session';

const broker: User = {
  id: 2,
  email: 'broker@example.test',
  fullName: 'Demo Broker',
  role: 'broker',
};
const NOW = new Date('2026-11-17T10:00:00Z').getTime();

function loginResponse(expiresIn = 3600): LoginResponse {
  return { accessToken: 'token-123', tokenType: 'Bearer', expiresIn, user: broker };
}

describe('AuthSession', () => {
  let http: HttpTestingController;

  function createSession(): AuthSession {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
    return TestBed.inject(AuthSession);
  }

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    localStorage.clear();
  });

  afterEach(() => {
    http.verify();
    vi.useRealTimers();
    localStorage.clear();
  });

  it('starts signed out without a stored session', () => {
    const session = createSession();
    expect(session.isAuthenticated()).toBe(false);
    expect(session.user()).toBeNull();
    expect(session.token()).toBeNull();
  });

  it('logs in, keeps the token and user, and stores them for other tabs', () => {
    const session = createSession();
    let user: User | undefined;
    session.login('Broker@Example.test ', 'secret').subscribe((u) => (user = u));

    const request = http.expectOne(LOGIN_URL);
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({ email: 'Broker@Example.test ', password: 'secret' });
    request.flush(loginResponse());

    expect(user).toEqual(broker);
    expect(session.isAuthenticated()).toBe(true);
    expect(session.token()).toBe('token-123');
    expect(session.user()).toEqual(broker);
    expect(JSON.parse(localStorage.getItem(AUTH_STORAGE_KEY) ?? 'null')).toEqual({
      accessToken: 'token-123',
      expiresAt: NOW + 3_600_000,
      user: broker,
    });
  });

  it('restores a stored session that has not expired', () => {
    localStorage.setItem(
      AUTH_STORAGE_KEY,
      JSON.stringify({ accessToken: 'stored', expiresAt: NOW + 60_000, user: broker }),
    );
    const session = createSession();
    expect(session.isAuthenticated()).toBe(true);
    expect(session.token()).toBe('stored');
  });

  it('stops counting a session once it expires, and ending it still reports it as active', () => {
    const session = createSession();
    session.login('a@b.test', 'x').subscribe();
    http.expectOne(LOGIN_URL).flush(loginResponse(60));

    vi.setSystemTime(NOW + 60_000);

    expect(session.isAuthenticated()).toBe(false);
    expect(session.token()).toBeNull();
    // Reading does not end it: the 401 that follows must still send the user to the login page.
    expect(session.end()).toBe(true);
    expect(localStorage.getItem(AUTH_STORAGE_KEY)).toBeNull();
  });

  it.each([
    ['not JSON', '{oops'],
    ['missing fields', JSON.stringify({ accessToken: 'x' })],
    ['an expired session', JSON.stringify({ accessToken: 'x', expiresAt: NOW - 1, user: broker })],
  ])('ignores and removes a stored session that is %s', (_label, stored) => {
    localStorage.setItem(AUTH_STORAGE_KEY, stored);
    const session = createSession();
    expect(session.isAuthenticated()).toBe(false);
    expect(localStorage.getItem(AUTH_STORAGE_KEY)).toBeNull();
  });

  it('ends the session and reports whether one was active', () => {
    const session = createSession();
    session.login('a@b.test', 'x').subscribe();
    http.expectOne(LOGIN_URL).flush(loginResponse());

    expect(session.end()).toBe(true);
    expect(session.isAuthenticated()).toBe(false);
    expect(localStorage.getItem(AUTH_STORAGE_KEY)).toBeNull();
    expect(session.end()).toBe(false);
  });

  it('keeps working in memory when storage is unavailable', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const session = createSession();
    session.login('a@b.test', 'x').subscribe();
    http.expectOne(LOGIN_URL).flush(loginResponse());

    expect(session.isAuthenticated()).toBe(true);
    setItem.mockRestore();
  });
});
