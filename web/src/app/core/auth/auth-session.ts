import { HttpClient } from '@angular/common/http';
import { computed, inject, Injectable, signal } from '@angular/core';
import { map, Observable } from 'rxjs';

import type { LoginRequest, LoginResponse, User } from '../api/models';

export const LOGIN_URL = '/api/auth/login';
export const AUTH_STORAGE_KEY = 'imotsync.session';

interface StoredSession {
  accessToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  user: User;
}

/**
 * The signed-in user and their API token.
 *
 * The token is kept in localStorage so that new tabs stay signed in for its lifetime (8 hours by
 * default, no refresh token). It is readable by the page's JavaScript, which is acceptable
 * because Angular escapes all template output and the API sends a strict Content Security
 * Policy; see docs/architecture.md › Authentication. A session ends on logout, at expiry, and
 * when the API answers 401 (authInterceptor).
 */
@Injectable({ providedIn: 'root' })
export class AuthSession {
  private readonly http = inject(HttpClient);
  private readonly session = signal<StoredSession | null>(readStoredSession());

  /** The signed-in user, for display. */
  readonly user = computed(() => this.current()?.user ?? null);

  login(email: string, password: string): Observable<User> {
    const body: LoginRequest = { email, password };
    return this.http.post<LoginResponse>(LOGIN_URL, body).pipe(
      map((response) => {
        this.save({
          accessToken: response.accessToken,
          expiresAt: Date.now() + response.expiresIn * 1000,
          user: response.user,
        });
        return response.user;
      }),
    );
  }

  /** The token to send, or null when signed out or expired. */
  token(): string | null {
    return this.current()?.accessToken ?? null;
  }

  isAuthenticated(): boolean {
    return this.current() !== null;
  }

  /**
   * Signs out. Returns whether a session was held (expired or not), so the first 401 after
   * expiry still sends the user to the login page, and several failing calls do so only once.
   */
  end(): boolean {
    const held = this.session() !== null;
    this.save(null);
    return held;
  }

  /**
   * The session while it is valid. Reading never writes: an expired session stays held until
   * end(), so these reads are safe in computeds and templates.
   */
  private current(): StoredSession | null {
    const session = this.session();
    return session && session.expiresAt > Date.now() ? session : null;
  }

  private save(session: StoredSession | null): void {
    this.session.set(session);
    try {
      if (session) {
        localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(session));
      } else {
        localStorage.removeItem(AUTH_STORAGE_KEY);
      }
    } catch {
      // Storage blocked (private mode, site data disabled): the session lives in memory only.
    }
  }
}

function readStoredSession(): StoredSession | null {
  let stored: unknown;
  try {
    stored = JSON.parse(localStorage.getItem(AUTH_STORAGE_KEY) ?? 'null');
  } catch {
    stored = undefined;
  }
  if (isStoredSession(stored) && stored.expiresAt > Date.now()) {
    return stored;
  }
  try {
    localStorage.removeItem(AUTH_STORAGE_KEY);
  } catch {
    // Nothing to clean up when storage is unavailable.
  }
  return null;
}

function isStoredSession(value: unknown): value is StoredSession {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const { accessToken, expiresAt, user } = value as Record<string, unknown>;
  return (
    typeof accessToken === 'string' &&
    typeof expiresAt === 'number' &&
    typeof user === 'object' &&
    user !== null &&
    typeof (user as Record<string, unknown>)['fullName'] === 'string'
  );
}
