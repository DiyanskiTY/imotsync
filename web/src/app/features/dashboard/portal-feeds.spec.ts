import { TestBed } from '@angular/core/testing';
import { MessageService } from 'primeng/api';
import { of, throwError } from 'rxjs';

import type { Portal } from '../../core/api/models';
import { PortalsApi } from '../../core/api/portals-api';
import { PortalFeeds } from './portal-feeds';

const portals: Portal[] = [
  {
    key: 'realistimo',
    displayName: 'Realistimo',
    mode: 'feed',
    feedUrl: 'https://demo.example/feeds/realistimo/token.xml',
  },
  { key: 'demo', displayName: 'Demo portal', mode: 'push', feedUrl: null },
];

describe('PortalFeeds', () => {
  function render(portals$ = of(portals)) {
    TestBed.configureTestingModule({
      providers: [MessageService, { provide: PortalsApi, useValue: { portals$ } }],
    });
    const fixture = TestBed.createComponent(PortalFeeds);
    fixture.detectChanges();
    return { fixture, root: fixture.nativeElement as HTMLElement };
  }

  it('shows the feed URL of each feed portal and explains push portals', () => {
    const { root } = render();
    const feedInput = root.querySelector<HTMLInputElement>('#feed-url-realistimo');
    expect(feedInput?.value).toBe('https://demo.example/feeds/realistimo/token.xml');
    expect(feedInput?.readOnly).toBe(true);
    expect(root.querySelector('[data-testid="portal-demo"]')?.textContent).toContain(
      'Pushed by the worker',
    );
  });

  it('copies a feed URL', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const { fixture, root } = render();
    const toast = vi.spyOn(TestBed.inject(MessageService), 'add');

    root.querySelector<HTMLElement>('[data-testid="copy-realistimo"] button')?.click();
    await fixture.whenStable();

    expect(writeText).toHaveBeenCalledWith('https://demo.example/feeds/realistimo/token.xml');
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ severity: 'success' }));
  });

  it('says when the portals cannot be loaded', () => {
    const { root } = render(throwError(() => new Error('down')));
    expect(root.textContent).toContain('Something went wrong');
  });
});
