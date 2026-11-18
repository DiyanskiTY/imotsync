import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, throwError } from 'rxjs';

import { HEALTH_URL } from '../health/health-api';
import { AuthSession, LOGIN_URL } from './auth-session';

/** API calls that work without a token (and whose 401 does not mean "session ended"). */
const PUBLIC_API_URLS: readonly string[] = [LOGIN_URL, HEALTH_URL];

function needsToken(url: string): boolean {
  return url.startsWith('/api/') && !PUBLIC_API_URLS.includes(url);
}

/**
 * Sends the session's token with every protected API call. A 401 means the token expired or the
 * user no longer exists: the session ends and the user goes to the login page, which brings them
 * back afterwards. Several calls failing together redirect only once.
 */
export const authInterceptor: HttpInterceptorFn = (request, next) => {
  if (!needsToken(request.url)) {
    return next(request);
  }
  const session = inject(AuthSession);
  const router = inject(Router);
  const token = session.token();
  const authorized = token
    ? request.clone({ setHeaders: { Authorization: `Bearer ${token}` } })
    : request;

  return next(authorized).pipe(
    catchError((error: unknown) => {
      if (error instanceof HttpErrorResponse && error.status === 401 && session.end()) {
        void router.navigate(['/login'], {
          queryParams: { returnUrl: router.url, reason: 'expired' },
        });
      }
      return throwError(() => error);
    }),
  );
};
