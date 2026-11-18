import { HttpClient, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { map, Observable } from 'rxjs';

import type {
  BulkDeleteItem,
  BulkDeleteRequest,
  BulkDeleteResponse,
  BulkPublishItem,
  BulkPublishRequest,
  BulkPublishResponse,
  PropertyCreate,
  PropertyDetail,
  PropertyList,
  PropertyUpdate,
} from './models';

export const PROPERTIES_URL = '/api/properties';

/** What DELETE /api/properties/{id} did: deleted at once, or archived until a feed lets it go. */
export type PropertyDeleteResult = 'deleted' | 'deletion_scheduled';

/** Properties and the bulk actions on them. */
@Injectable({ providedIn: 'root' })
export class PropertiesApi {
  private readonly http = inject(HttpClient);

  /** `params` must hold only fields of GET /api/properties (see PROPERTY_LIST_QUERY). */
  list(params: HttpParams): Observable<PropertyList> {
    return this.http.get<PropertyList>(PROPERTIES_URL, { params });
  }

  get(id: number): Observable<PropertyDetail> {
    return this.http.get<PropertyDetail>(`${PROPERTIES_URL}/${id}`);
  }

  create(body: PropertyCreate): Observable<PropertyDetail> {
    return this.http.post<PropertyDetail>(PROPERTIES_URL, body);
  }

  update(id: number, body: PropertyUpdate): Observable<PropertyDetail> {
    return this.http.patch<PropertyDetail>(`${PROPERTIES_URL}/${id}`, body);
  }

  delete(id: number): Observable<PropertyDeleteResult> {
    return this.http
      .delete(`${PROPERTIES_URL}/${id}`, { observe: 'response' })
      .pipe(map((response) => (response.status === 202 ? 'deletion_scheduled' : 'deleted')));
  }

  bulkPublish(propertyIds: number[], portals: string[]): Observable<BulkPublishItem[]> {
    const body: BulkPublishRequest = { propertyIds, portals };
    return this.http
      .post<BulkPublishResponse>(`${PROPERTIES_URL}/bulk/publish`, body)
      .pipe(map((response) => response.data));
  }

  bulkDelete(propertyIds: number[]): Observable<BulkDeleteItem[]> {
    const body: BulkDeleteRequest = { propertyIds };
    return this.http
      .post<BulkDeleteResponse>(`${PROPERTIES_URL}/bulk/delete`, body)
      .pipe(map((response) => response.data));
  }
}
