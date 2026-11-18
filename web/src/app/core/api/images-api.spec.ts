import { HttpEventType, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { propertyDetail } from '../../testing/fixtures';
import { ImagesApi, UploadProgress } from './images-api';

describe('ImagesApi', () => {
  let api: ImagesApi;
  let http: HttpTestingController;
  const images = propertyDetail().images;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    api = TestBed.inject(ImagesApi);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('uploads files in the "photos" field and reports progress, then the new photos', () => {
    const events: UploadProgress[] = [];
    const files = [new File(['a'], 'a.jpg', { type: 'image/jpeg' })];
    api.upload(7, files).subscribe((event) => events.push(event));

    const request = http.expectOne('/api/properties/7/images');
    expect(request.request.method).toBe('POST');
    const body = request.request.body as FormData;
    expect(body.getAll('photos')).toHaveLength(1);
    expect(request.request.reportProgress).toBe(true);

    request.event({ type: HttpEventType.UploadProgress, loaded: 50, total: 100 });
    request.flush({ data: images }, { status: 201, statusText: 'Created' });

    expect(events).toEqual([
      { kind: 'progress', loaded: 50 },
      { kind: 'done', images },
    ]);
  });

  it('saves a new order and returns the reordered photos', () => {
    let result: unknown;
    api.reorder(7, [12, 11]).subscribe((r) => (result = r));
    const request = http.expectOne('/api/properties/7/images/order');
    expect(request.request.method).toBe('PUT');
    expect(request.request.body).toEqual({ imageIds: [12, 11] });
    request.flush({ data: images });
    expect(result).toEqual(images);
  });

  it('deletes one photo', () => {
    let done = false;
    api.delete(7, 11).subscribe(() => (done = true));
    const request = http.expectOne('/api/properties/7/images/11');
    expect(request.request.method).toBe('DELETE');
    request.flush(null, { status: 204, statusText: 'No Content' });
    expect(done).toBe(true);
  });
});
