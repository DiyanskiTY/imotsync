import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { map, Observable } from 'rxjs';

import type {
  PortalCheck,
  PortalCheckList,
  PublishRequest,
  PublishResponse,
  PublishResult,
  UnpublishRequest,
} from './models';
import { PROPERTIES_URL } from './properties-api';

/** The pre-publish check and publishing one property. */
@Injectable({ providedIn: 'root' })
export class PublishingApi {
  private readonly http = inject(HttpClient);

  /** Each portal's verdict on the property's current data. Changes nothing. */
  checks(propertyId: number): Observable<PortalCheck[]> {
    return this.http
      .get<PortalCheckList>(`${PROPERTIES_URL}/${propertyId}/checks`)
      .pipe(map((response) => response.data));
  }

  /** 422 NOT_READY (with per-portal details) when any portal reports an issue; nothing is queued then. */
  publish(propertyId: number, portals: string[]): Observable<PublishResult> {
    const body: PublishRequest = { portals };
    return this.http
      .post<PublishResponse>(`${PROPERTIES_URL}/${propertyId}/publish`, body)
      .pipe(map((response) => response.data));
  }

  unpublish(propertyId: number, portals: string[]): Observable<PublishResult> {
    const body: UnpublishRequest = { portals };
    return this.http
      .post<PublishResponse>(`${PROPERTIES_URL}/${propertyId}/unpublish`, body)
      .pipe(map((response) => response.data));
  }
}
