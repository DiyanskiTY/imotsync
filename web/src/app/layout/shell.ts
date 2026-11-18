import { ChangeDetectionStrategy, Component, ElementRef, inject, viewChild } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { ToastModule } from 'primeng/toast';

import { AuthSession } from '../core/auth/auth-session';

export interface NavItem {
  label: string;
  path: string;
  /** PrimeIcons class, e.g. "pi pi-building". */
  icon: string;
}

/**
 * App layout for signed-in users: skip link, top bar with the brand, main navigation and the user,
 * page content, footer, and the app-wide toast and confirmation dialog.
 */
@Component({
  selector: 'app-shell',
  imports: [
    RouterLink,
    RouterLinkActive,
    RouterOutlet,
    ButtonModule,
    ConfirmDialogModule,
    ToastModule,
  ],
  templateUrl: './shell.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Shell {
  private readonly session = inject(AuthSession);
  private readonly router = inject(Router);

  protected readonly user = this.session.user;

  protected readonly navItems: readonly NavItem[] = [
    { label: 'Dashboard', path: '/dashboard', icon: 'pi pi-objects-column' },
    { label: 'Properties', path: '/properties', icon: 'pi pi-building' },
    { label: 'Jobs', path: '/jobs', icon: 'pi pi-sync' },
  ];

  private readonly mainContent = viewChild.required<ElementRef<HTMLElement>>('mainContent');

  /**
   * Moves keyboard focus to the main landmark. The browser cannot follow the link by itself:
   * index.html sets <base href="/">, so "#main-content" resolves to "/#main-content" and would load
   * the root page instead of jumping within the current one.
   */
  protected skipToMainContent(event: Event): void {
    event.preventDefault();
    this.mainContent().nativeElement.focus();
  }

  protected logout(): void {
    this.session.end();
    void this.router.navigateByUrl('/login');
  }
}
