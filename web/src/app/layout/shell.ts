import { ChangeDetectionStrategy, Component, ElementRef, viewChild } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';

export interface NavItem {
  label: string;
  path: string;
  /** PrimeIcons class, e.g. "pi pi-building". */
  icon: string;
}

/** App layout: skip link, top bar with the brand and main navigation, page content, footer. */
@Component({
  selector: 'app-shell',
  imports: [RouterLink, RouterLinkActive, RouterOutlet],
  templateUrl: './shell.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Shell {
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
}
