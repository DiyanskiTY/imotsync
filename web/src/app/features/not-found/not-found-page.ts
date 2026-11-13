import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';

@Component({
  selector: 'app-not-found-page',
  imports: [RouterLink],
  template: `
    <div class="mx-auto max-w-md py-16 text-center">
      <p class="text-sm font-semibold text-primary">404</p>
      <h1 class="mt-2 text-2xl font-semibold tracking-tight text-color">Page not found</h1>
      <p class="mt-2 text-muted-color">The page you are looking for does not exist.</p>
      <a
        routerLink="/dashboard"
        class="mt-6 inline-flex items-center gap-2 rounded-border bg-primary px-4 py-2 font-medium text-primary-contrast hover:bg-primary-emphasis focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      >
        <i class="pi pi-arrow-left" aria-hidden="true"></i>
        Back to the dashboard
      </a>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class NotFoundPage {}
