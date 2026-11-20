import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { MessageService } from 'primeng/api';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { MessageModule } from 'primeng/message';
import { SkeletonModule } from 'primeng/skeleton';
import { TagModule } from 'primeng/tag';

import { injectPortals } from '../../core/api/portals-api';

/**
 * The portals of this deployment and, for feed portals, the feed URL to register in the
 * portal's import settings. That is the whole "connection": the portal downloads the feed on its
 * own schedule. The token in the URL is what protects the feed, so it stays among signed-in users.
 * The public demo serves no feeds and shows no URLs (feedUrl is null).
 */
@Component({
  selector: 'app-portal-feeds',
  imports: [ButtonModule, InputTextModule, MessageModule, SkeletonModule, TagModule],
  template: `
    @let state = portals.state();
    @if (state.error; as error) {
      <p-message severity="error">{{ error.message }}</p-message>
    } @else if (state.data; as list) {
      <ul class="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        @for (portal of list; track portal.key) {
          <li
            class="flex flex-col gap-3 rounded-xl border border-surface bg-surface-0 p-5"
            [attr.data-testid]="'portal-' + portal.key"
          >
            <div class="flex items-center justify-between gap-2">
              <h3 class="font-semibold text-color">{{ portal.displayName }}</h3>
              <p-tag
                [value]="portal.mode === 'feed' ? 'Import feed' : 'Push'"
                [severity]="portal.mode === 'feed' ? 'info' : 'secondary'"
              />
            </div>
            @if (portal.feedUrl; as url) {
              <label [for]="'feed-url-' + portal.key" class="text-sm text-muted-color">
                Feed URL to register with {{ portal.displayName }}
              </label>
              <div class="flex gap-2">
                <input
                  pInputText
                  [id]="'feed-url-' + portal.key"
                  [value]="url"
                  readonly
                  class="min-w-0 flex-1 font-mono text-xs"
                />
                <p-button
                  [attr.data-testid]="'copy-' + portal.key"
                  icon="pi pi-copy"
                  severity="secondary"
                  [outlined]="true"
                  [ariaLabel]="'Copy the ' + portal.displayName + ' feed URL'"
                  (onClick)="copy(url, portal.displayName)"
                />
              </div>
            } @else if (portal.mode === 'feed') {
              <p class="text-sm text-muted-color" [attr.data-testid]="'feed-closed-' + portal.key">
                The feed is closed on this demo, so its made-up listings never reach
                {{ portal.displayName }}. Publishing still runs every check and job.
              </p>
            } @else {
              <p class="text-sm text-muted-color">
                Pushed by the worker when a job runs; nothing to register.
              </p>
            }
          </li>
        }
      </ul>
    } @else {
      <p-skeleton height="8rem" />
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PortalFeeds {
  private readonly messages = inject(MessageService);
  protected readonly portals = injectPortals();

  protected copy(url: string, portalName: string): void {
    navigator.clipboard.writeText(url).then(
      () =>
        this.messages.add({
          severity: 'success',
          summary: 'Copied',
          detail: `The ${portalName} feed URL is on the clipboard.`,
        }),
      () =>
        this.messages.add({
          severity: 'warn',
          summary: 'Not copied',
          detail: 'Select the URL and copy it by hand.',
        }),
    );
  }
}
