import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { StatusTag, statusSeverity, type DisplayStatus } from './status-tag';

describe('statusSeverity', () => {
  it.each<[DisplayStatus, string]>([
    ['draft', 'secondary'],
    ['active', 'success'],
    ['archived', 'warn'],
    ['pending', 'info'],
    ['published', 'success'],
    ['error', 'danger'],
    ['removed', 'contrast'],
    ['queued', 'secondary'],
    ['running', 'info'],
    ['succeeded', 'success'],
    ['failed', 'danger'],
  ])('%s → %s', (status, severity) => {
    expect(statusSeverity(status)).toBe(severity);
  });
});

@Component({
  imports: [StatusTag],
  template: `<app-status-tag [status]="status()" [detail]="detail()" [prefix]="prefix()" />`,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
class Host {
  readonly status = signal<DisplayStatus>('error');
  readonly detail = signal<string | null>('Gave up after 5 attempts: timeout');
  readonly prefix = signal<string | null>('Bazar.bg');
}

describe('StatusTag', () => {
  it('shows the label and exposes the detail to assistive technology', async () => {
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;

    expect(root.textContent).toContain('Bazar.bg: Error');
    expect(root.querySelector('[aria-label]')?.getAttribute('aria-label')).toBe(
      'Bazar.bg: Error. Gave up after 5 attempts: timeout',
    );
  });

  it('shows the plain label without a prefix or detail', async () => {
    const fixture = TestBed.createComponent(Host);
    fixture.componentInstance.status.set('published');
    fixture.componentInstance.detail.set(null);
    fixture.componentInstance.prefix.set(null);
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;

    expect(root.textContent?.trim()).toBe('Published');
  });
});
