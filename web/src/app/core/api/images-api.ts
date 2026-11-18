import { HttpClient, HttpEventType } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { filter, map, Observable } from 'rxjs';

import type { PropertyImage, PropertyImageList, PropertyImageOrder } from './models';
import { PROPERTIES_URL } from './properties-api';

/** Progress of one upload request: bytes sent so far, then the stored photos. */
export type UploadProgress =
  { kind: 'progress'; loaded: number } | { kind: 'done'; images: PropertyImage[] };

/** A property's photos. */
@Injectable({ providedIn: 'root' })
export class ImagesApi {
  private readonly http = inject(HttpClient);

  /** One multipart request with up to 20 files in the "photos" field. */
  upload(propertyId: number, files: readonly File[]): Observable<UploadProgress> {
    const body = new FormData();
    for (const file of files) {
      body.append('photos', file, file.name);
    }
    return this.http
      .post<PropertyImageList>(`${PROPERTIES_URL}/${propertyId}/images`, body, {
        observe: 'events',
        reportProgress: true,
      })
      .pipe(
        map((event): UploadProgress | null => {
          if (event.type === HttpEventType.UploadProgress) {
            return { kind: 'progress', loaded: event.loaded };
          }
          if (event.type === HttpEventType.Response) {
            return { kind: 'done', images: event.body?.data ?? [] };
          }
          return null;
        }),
        filter((event): event is UploadProgress => event !== null),
      );
  }

  /** Must list every photo id of the property exactly once; the first becomes the cover. */
  reorder(propertyId: number, imageIds: number[]): Observable<PropertyImage[]> {
    return this.http
      .put<PropertyImageList>(`${PROPERTIES_URL}/${propertyId}/images/order`, {
        imageIds,
      } satisfies PropertyImageOrder)
      .pipe(map((response) => response.data));
  }

  delete(propertyId: number, imageId: number): Observable<void> {
    return this.http
      .delete(`${PROPERTIES_URL}/${propertyId}/images/${imageId}`)
      .pipe(map(() => undefined));
  }
}
