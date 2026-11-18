import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { ConfirmationService, MessageService } from 'primeng/api';

import type { User } from '../core/api/models';
import { AuthSession } from '../core/auth/auth-session';

import { Shell } from './shell';

@Component({ template: '', changeDetection: ChangeDetectionStrategy.OnPush })
class BlankPage {}

const broker: User = {
  id: 2,
  email: 'broker@example.test',
  fullName: 'Demo Broker',
  role: 'broker',
};

describe('Shell', () => {
  let end: ReturnType<typeof vi.fn<() => boolean>>;

  beforeEach(() => {
    end = vi.fn(() => true);
    TestBed.configureTestingModule({
      providers: [
        MessageService,
        ConfirmationService,
        { provide: AuthSession, useValue: { user: signal(broker), end } },
        provideRouter([
          { path: 'login', component: BlankPage },
          {
            path: '',
            component: Shell,
            children: ['dashboard', 'properties', 'jobs'].map((path) => ({
              path,
              component: BlankPage,
            })),
          },
        ]),
      ],
    });
  });

  async function renderAt(url: string): Promise<HTMLElement> {
    const harness = await RouterTestingHarness.create(url);
    return harness.fixture.nativeElement as HTMLElement;
  }

  function navLinks(root: HTMLElement): HTMLAnchorElement[] {
    return Array.from(root.querySelectorAll<HTMLAnchorElement>('nav[aria-label="Main"] a'));
  }

  it('renders the brand and the main navigation links', async () => {
    const root = await renderAt('/dashboard');

    expect(root.querySelector('header')?.textContent).toContain('ImotSync');
    expect(navLinks(root).map((link) => link.textContent?.trim())).toEqual([
      'Dashboard',
      'Properties',
      'Jobs',
    ]);
    expect(navLinks(root).map((link) => link.getAttribute('href'))).toEqual([
      '/dashboard',
      '/properties',
      '/jobs',
    ]);
  });

  it('marks the link of the current page with aria-current', async () => {
    const root = await renderAt('/jobs');

    expect(navLinks(root).map((link) => link.getAttribute('aria-current'))).toEqual([
      null,
      null,
      'page',
    ]);
  });

  it('provides landmarks and a skip link to the main content', async () => {
    const root = await renderAt('/dashboard');

    expect(root.querySelector('header')).not.toBeNull();
    expect(root.querySelector('main#main-content')).not.toBeNull();
    expect(root.querySelector('footer')).not.toBeNull();
    expect(root.querySelector('a[href="#main-content"]')?.textContent).toContain(
      'Skip to main content',
    );
  });

  it('moves focus to the main content when the skip link is used, without leaving the page', async () => {
    const root = await renderAt('/properties');
    const skipLink = root.querySelector<HTMLAnchorElement>('a[href="#main-content"]');
    const main = root.querySelector<HTMLElement>('main#main-content');
    expect(skipLink).not.toBeNull();
    expect(main).not.toBeNull();

    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    skipLink?.dispatchEvent(click);

    // Following the href would load "/#main-content" (see <base href="/">), so it must not happen.
    expect(click.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(main);
    expect(TestBed.inject(Router).url).toBe('/properties');
  });

  it('shows the signed-in user and signs out', async () => {
    const root = await renderAt('/dashboard');
    expect(root.querySelector('[data-testid="current-user"]')?.textContent).toContain(
      'Demo Broker',
    );

    root.querySelector<HTMLButtonElement>('[data-testid="logout"] button')?.click();
    await TestBed.inject(Router).navigated;
    await new Promise((resolve) => setTimeout(resolve));

    expect(end).toHaveBeenCalledOnce();
    expect(TestBed.inject(Router).url).toBe('/login');
  });
});
