import { HttpEventType, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Confirmation, ConfirmationService, MessageService } from 'primeng/api';

import type { PropertyImage } from '../../core/api/models';
import { propertyDetail } from '../../testing/fixtures';
import { PhotoManager } from './photo-manager';

@Component({
  imports: [PhotoManager],
  template: `<app-photo-manager
    [propertyId]="7"
    [images]="images()"
    (changed)="changes = changes + 1"
  />`,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
class Host {
  readonly images = signal<PropertyImage[]>(propertyDetail().images);
  changes = 0;
}

describe('PhotoManager', () => {
  let http: HttpTestingController;
  let fixture: ComponentFixture<Host>;

  beforeEach(async () => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        MessageService,
        ConfirmationService,
      ],
    });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
  });

  afterEach(() => http.verify());

  const root = () => fixture.nativeElement as HTMLElement;
  const photoIds = () =>
    Array.from(root().querySelectorAll<HTMLElement>('[data-photo-id]')).map((el) =>
      Number(el.dataset['photoId']),
    );
  const click = (selector: string) =>
    root().querySelector<HTMLElement>(`${selector} button, button${selector}`)?.click();

  it('shows the photos in order and marks the cover', () => {
    expect(photoIds()).toEqual([11, 12]);
    expect(root().querySelector('[data-photo-id="11"]')?.textContent).toContain('Cover');
    expect(root().querySelector('[data-photo-id="12"]')?.textContent).not.toContain('Cover');
  });

  it('moves a photo and saves the new order', async () => {
    click('[data-testid="move-later-11"]');
    await fixture.whenStable();
    expect(photoIds()).toEqual([12, 11]);

    const request = http.expectOne('/api/properties/7/images/order');
    expect(request.request.body).toEqual({ imageIds: [12, 11] });
    const [first, second] = propertyDetail().images;
    request.flush({
      data: [
        { ...second, sortOrder: 0 },
        { ...first, sortOrder: 1 },
      ],
    });
    await fixture.whenStable();

    expect(photoIds()).toEqual([12, 11]);
    expect(fixture.componentInstance.changes).toBe(1);
  });

  it('keeps a new order when a reload brings the same photos while it is saved', async () => {
    click('[data-testid="move-later-11"]');
    await fixture.whenStable();
    fixture.componentInstance.images.set(propertyDetail().images);
    await fixture.whenStable();
    expect(photoIds()).toEqual([12, 11]);

    const [first, second] = propertyDetail().images;
    http.expectOne('/api/properties/7/images/order').flush({
      data: [
        { ...second, sortOrder: 0 },
        { ...first, sortOrder: 1 },
      ],
    });
  });

  it('puts the order back when saving it fails', async () => {
    const toast = vi.spyOn(TestBed.inject(MessageService), 'add');
    click('[data-testid="move-earlier-12"]');
    await fixture.whenStable();

    http
      .expectOne('/api/properties/7/images/order')
      .flush(
        { error: { code: 'VALIDATION_ERROR', message: 'Order is out of date.' } },
        { status: 400, statusText: 'Bad Request' },
      );
    await fixture.whenStable();

    expect(photoIds()).toEqual([11, 12]);
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ detail: 'Order is out of date.' }),
    );
  });

  it('uploads the chosen files with progress and lists the refused ones', async () => {
    const input = root().querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) {
      throw new Error('file input not found');
    }
    const files = [
      new File(['x'], 'kitchen.jpg', { type: 'image/jpeg' }),
      new File(['x'], 'plan.pdf', { type: 'application/pdf' }),
    ];
    Object.defineProperty(input, 'files', { value: files });
    input.dispatchEvent(new Event('change'));
    await fixture.whenStable();

    expect(root().textContent).toContain('plan.pdf: not a JPEG, PNG, WebP or AVIF image');
    const request = http.expectOne('/api/properties/7/images');
    expect((request.request.body as FormData).getAll('photos')).toHaveLength(1);

    request.event({ type: HttpEventType.UploadProgress, loaded: 0, total: 1 });
    await fixture.whenStable();
    expect(root().querySelector('[data-testid="upload-progress"]')).not.toBeNull();

    const uploaded: PropertyImage = { ...propertyDetail().images[0], id: 13, sortOrder: 2 };
    request.flush({ data: [uploaded] }, { status: 201, statusText: 'Created' });
    await fixture.whenStable();

    expect(photoIds()).toEqual([11, 12, 13]);
    expect(root().querySelector('[data-testid="upload-progress"]')).toBeNull();
    expect(fixture.componentInstance.changes).toBe(1);
  });

  it('shows the API message when an upload is refused', async () => {
    const input = root().querySelector<HTMLInputElement>('input[type="file"]');
    Object.defineProperty(input, 'files', {
      value: [new File(['x'], 'tiny.jpg', { type: 'image/jpeg' })],
    });
    input?.dispatchEvent(new Event('change'));
    http.expectOne('/api/properties/7/images').flush(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'tiny.jpg is too small: at least 400 px on the short side.',
        },
      },
      { status: 400, statusText: 'Bad Request' },
    );
    await fixture.whenStable();

    expect(root().querySelector('[data-testid="upload-error"]')?.textContent).toContain(
      'tiny.jpg is too small',
    );
    expect(photoIds()).toEqual([11, 12]);
  });

  it('deletes a photo after confirmation', async () => {
    const confirmations: Confirmation[] = [];
    vi.spyOn(TestBed.inject(ConfirmationService), 'confirm').mockImplementation((c) => {
      confirmations.push(c);
      return TestBed.inject(ConfirmationService);
    });
    click('[data-testid="delete-photo-12"]');
    confirmations[0].accept?.();

    http.expectOne('/api/properties/7/images/12').flush(null, {
      status: 204,
      statusText: 'No Content',
    });
    await fixture.whenStable();

    expect(photoIds()).toEqual([11]);
    expect(fixture.componentInstance.changes).toBe(1);
  });
});
