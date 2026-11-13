import { InjectionToken, isDevMode } from '@angular/core';

/**
 * Whether the UI may show developer set-up hints, such as how to start the API or the database.
 * True in development builds only, so admin users of a production build never see them.
 */
export const SHOW_DEV_HINTS = new InjectionToken<boolean>('SHOW_DEV_HINTS', {
  providedIn: 'root',
  factory: () => isDevMode(),
});
