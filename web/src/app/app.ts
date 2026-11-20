import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';

import { ClientConfigStore } from './core/client-config/client-config';
import { DemoBanner } from './core/client-config/demo-banner';

/**
 * Root component. The visible layout lives in Shell, so pages such as login can opt out of it;
 * the public demo's banner sits above both, so it is on every page.
 */
@Component({
  selector: 'app-root',
  imports: [RouterOutlet, DemoBanner],
  template: `
    @if (demoMode()) {
      <app-demo-banner />
    }
    <router-outlet />
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App {
  protected readonly demoMode = inject(ClientConfigStore).demoMode;
}
