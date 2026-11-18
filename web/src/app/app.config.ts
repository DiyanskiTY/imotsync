import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter, TitleStrategy } from '@angular/router';
import { ConfirmationService, MessageService } from 'primeng/api';
import { providePrimeNG } from 'primeng/config';

import { routes } from './app.routes';
import { AppTitleStrategy } from './core/app-title-strategy';
import { authInterceptor } from './core/auth/auth-interceptor';
import { AppPreset } from './core/theme/app-preset';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    // The default XHR backend is kept on purpose: photo uploads need upload progress events.
    provideHttpClient(withInterceptors([authInterceptor])),
    provideRouter(routes),
    { provide: TitleStrategy, useClass: AppTitleStrategy },
    // App-wide toasts and confirmation dialogs, rendered once in the Shell.
    MessageService,
    ConfirmationService,
    providePrimeNG({
      theme: {
        // Aura with a darker primary colour for WCAG AA contrast, see app-preset.ts.
        preset: AppPreset,
        options: {
          // Light only for now; the class is never set, see styles.css.
          darkModeSelector: '.app-dark',
          // Must match the @layer statement at the top of styles.css.
          cssLayer: { name: 'primeng', order: 'theme, base, icons, primeng' },
        },
      },
    }),
  ],
};
