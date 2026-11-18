import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';

import { AuthSession } from './auth-session';

export const HOME_URL = '/dashboard';

/** Pages behind the login: a signed-out user goes to /login and comes back afterwards. */
export const authGuard: CanActivateFn = (_route, state) =>
  inject(AuthSession).isAuthenticated() ||
  inject(Router).createUrlTree(['/login'], { queryParams: { returnUrl: state.url } });

/** The login page itself: a signed-in user has nothing to do there. */
export const guestGuard: CanActivateFn = () =>
  !inject(AuthSession).isAuthenticated() || inject(Router).parseUrl(HOME_URL);

/**
 * A return URL from the query string, accepted only as a path inside this app. Anything else
 * (another origin, a protocol-relative "//host", the login page itself) falls back to home, so
 * the login page cannot be used to send someone to another site.
 */
export function safeReturnUrl(url: string | null): string {
  if (!url || !url.startsWith('/') || url.startsWith('//') || url.startsWith('/\\')) {
    return HOME_URL;
  }
  if (url === '/login' || url.startsWith('/login?') || url.startsWith('/login/')) {
    return HOME_URL;
  }
  return url;
}
