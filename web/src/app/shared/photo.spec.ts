import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { Photo } from './photo';

@Component({
  imports: [Photo],
  template: `<app-photo [src]="src()" alt="Photo 1 of 3" [showLabel]="true" />`,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
class Host {
  readonly src = signal('/uploads/properties/1/a.jpg');
}

describe('Photo', () => {
  async function render() {
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    return { fixture, root: fixture.nativeElement as HTMLElement };
  }

  it('shows the image', async () => {
    const { root } = await render();
    const img = root.querySelector('img');
    expect(img?.getAttribute('src')).toBe('/uploads/properties/1/a.jpg');
    expect(img?.getAttribute('alt')).toBe('Photo 1 of 3');
    expect(root.querySelector('[data-testid="photo-broken"]')).toBeNull();
  });

  it('shows a placeholder when the image cannot be loaded', async () => {
    const { fixture, root } = await render();
    root.querySelector('img')?.dispatchEvent(new Event('error'));
    await fixture.whenStable();

    const placeholder = root.querySelector('[data-testid="photo-broken"]');
    expect(root.querySelector('img')).toBeNull();
    expect(placeholder?.getAttribute('aria-label')).toBe('Photo 1 of 3 could not be loaded');
    expect(placeholder?.textContent).toContain('Photo missing');
  });

  it('tries again when the address changes', async () => {
    const { fixture, root } = await render();
    root.querySelector('img')?.dispatchEvent(new Event('error'));
    await fixture.whenStable();

    fixture.componentInstance.src.set('/uploads/properties/1/b.jpg');
    await fixture.whenStable();
    expect(root.querySelector('img')?.getAttribute('src')).toBe('/uploads/properties/1/b.jpg');
  });
});
