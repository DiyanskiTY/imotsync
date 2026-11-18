/*
 * Made-up API objects for specs. Only specs import this file.
 */

import type { Job, Portal, PortalCheck, PropertyDetail, PropertySummary } from '../core/api/models';

export const PORTALS: Portal[] = [
  { key: 'realistimo', displayName: 'Realistimo', mode: 'feed', feedUrl: null },
  { key: 'bazar', displayName: 'Bazar.bg', mode: 'feed', feedUrl: null },
  { key: 'demo', displayName: 'Demo portal', mode: 'push', feedUrl: null },
];

export function propertySummary(overrides: Partial<PropertySummary> = {}): PropertySummary {
  return {
    id: 1,
    refCode: 'IS-00001',
    title: 'Two-bedroom flat near the park',
    type: 'apartment',
    dealType: 'sale',
    city: 'Sofia',
    district: 'Lozenets',
    price: 185000,
    currency: 'EUR',
    areaM2: 92.5,
    rooms: 3,
    floor: 4,
    totalFloors: 8,
    status: 'active',
    coverImageUrl: '/uploads/demo/1.jpg',
    imageCount: 5,
    portals: [
      { portal: 'realistimo', status: 'published', lastError: null, publishedAt: null },
      {
        portal: 'bazar',
        status: 'error',
        lastError: 'Title must be in Cyrillic',
        publishedAt: null,
      },
    ],
    createdBy: { id: 2, fullName: 'Demo Broker' },
    createdAt: '2026-11-10T09:00:00Z',
    updatedAt: '2026-11-16T09:00:00Z',
    ...overrides,
  };
}

export function propertyDetail(overrides: Partial<PropertyDetail> = {}): PropertyDetail {
  return {
    // The summary's short portal statuses are replaced by full listings below.
    ...propertySummary(),
    description: 'Bright flat with a view of the park.',
    images: [
      {
        id: 11,
        url: '/uploads/demo/1.jpg',
        sortOrder: 0,
        width: 1600,
        height: 1200,
        sizeBytes: 200_000,
        createdAt: '2026-11-10T09:00:00Z',
      },
      {
        id: 12,
        url: '/uploads/demo/2.jpg',
        sortOrder: 1,
        width: 1600,
        height: 1200,
        sizeBytes: 210_000,
        createdAt: '2026-11-10T09:00:00Z',
      },
    ],
    deletion: null,
    portals: [
      {
        id: 21,
        portal: 'realistimo',
        status: 'published',
        externalId: null,
        lastError: null,
        publishedAt: '2026-11-11T09:00:00Z',
        lastSentAt: '2026-11-11T09:05:00Z',
        updatedAt: '2026-11-11T09:00:00Z',
      },
    ],
    ...overrides,
  };
}

export function portalCheck(overrides: Partial<PortalCheck> = {}): PortalCheck {
  return { portal: 'realistimo', displayName: 'Realistimo', ready: true, issues: [], ...overrides };
}

export function job(overrides: Partial<Job> = {}): Job {
  return {
    id: 101,
    action: 'publish',
    status: 'failed',
    attempts: 5,
    maxAttempts: 5,
    runAfter: '2026-11-16T09:00:00Z',
    lockedAt: null,
    lockedBy: null,
    lastError: 'Gave up after 5 attempts: Demo portal timed out',
    result: { error: 'Demo portal timed out', retryable: true },
    finishedAt: '2026-11-16T09:05:00Z',
    createdAt: '2026-11-16T09:00:00Z',
    updatedAt: '2026-11-16T09:05:00Z',
    listing: { id: 21, portal: 'demo', status: 'error' },
    property: { id: 1, refCode: 'IS-00001', title: 'Two-bedroom flat near the park' },
    ...overrides,
  };
}
