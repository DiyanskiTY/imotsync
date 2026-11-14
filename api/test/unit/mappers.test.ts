import { describe, expect, it } from 'vitest';
import type { PortalListingRow, PropertyImageRow } from '../../src/db/types.js';
import { toUserDto } from '../../src/modules/auth/auth.mappers.js';
import { toImageDto } from '../../src/modules/images/images.mappers.js';
import {
  toPropertyColumns,
  toPropertyDetail,
  toPropertySummary,
} from '../../src/modules/properties/properties.mappers.js';
import type { PropertyWithCreatorRow } from '../../src/modules/properties/properties.repository.js';
import { expectSchema } from '../support/openapi.js';
import { DEMO_ADMIN } from './helpers.js';

const at = (iso: string) => new Date(iso);

const property: PropertyWithCreatorRow = {
  id: 12,
  ref_code: 'IS-00012',
  title: 'Тристаен апартамент',
  type: 'apartment',
  deal_type: 'sale',
  city: 'Sofia',
  district: 'Lozenets',
  price: 245000.5,
  currency: 'EUR',
  area_m2: 98.25,
  rooms: 3,
  floor: 4,
  total_floors: 6,
  description: 'Описание',
  status: 'active',
  created_by: 2,
  creator_name: 'Demo Broker',
  created_at: at('2026-10-01T08:00:00Z'),
  updated_at: at('2026-10-02T09:30:00Z'),
};

const image = (id: number, sortOrder: number): PropertyImageRow => ({
  id,
  property_id: 12,
  url: `/uploads/properties/12/${id}.jpg`,
  sort_order: sortOrder,
  width: 2048,
  height: 1365,
  size_bytes: 300_000,
  created_at: at('2026-10-01T08:05:00Z'),
});

const listing: PortalListingRow = {
  id: 5,
  property_id: 12,
  portal: 'bazar',
  external_id: 'BZ-123',
  status: 'published',
  last_error: null,
  published_at: at('2026-10-03T10:00:00Z'),
  created_at: at('2026-10-03T09:00:00Z'),
  updated_at: at('2026-10-03T10:00:00Z'),
};

describe('property mappers', () => {
  it('maps a row to the summary: camelCase, ISO dates, numbers, cover and portals', () => {
    const summary = toPropertySummary(property, { url: '/uploads/a.jpg', imageCount: 3 }, [
      listing,
    ]);

    expect(summary).toEqual({
      id: 12,
      refCode: 'IS-00012',
      title: 'Тристаен апартамент',
      type: 'apartment',
      dealType: 'sale',
      city: 'Sofia',
      district: 'Lozenets',
      price: 245000.5,
      currency: 'EUR',
      areaM2: 98.25,
      rooms: 3,
      floor: 4,
      totalFloors: 6,
      status: 'active',
      coverImageUrl: '/uploads/a.jpg',
      imageCount: 3,
      portals: [
        {
          portal: 'bazar',
          status: 'published',
          lastError: null,
          publishedAt: '2026-10-03T10:00:00.000Z',
        },
      ],
      createdBy: { id: 2, fullName: 'Demo Broker' },
      createdAt: '2026-10-01T08:00:00.000Z',
      updatedAt: '2026-10-02T09:30:00.000Z',
    });
    expectSchema(summary, 'PropertySummary');
  });

  it('maps a property without photos, listings or creator', () => {
    const summary = toPropertySummary(
      { ...property, created_by: null, creator_name: null, price: null },
      undefined,
      [],
    );

    expect(summary).toMatchObject({
      coverImageUrl: null,
      imageCount: 0,
      portals: [],
      createdBy: null,
      price: null,
    });
    expectSchema(summary, 'PropertySummary');
  });

  it('maps the detail with photos in the given order and full listings', () => {
    const detail = toPropertyDetail(property, [image(8, 0), image(3, 1)], [listing]);

    expect(detail).toMatchObject({
      description: 'Описание',
      coverImageUrl: '/uploads/properties/12/8.jpg',
      imageCount: 2,
      images: [
        { id: 8, sortOrder: 0 },
        { id: 3, sortOrder: 1 },
      ],
      portals: [
        {
          id: 5,
          portal: 'bazar',
          status: 'published',
          externalId: 'BZ-123',
          lastError: null,
          publishedAt: '2026-10-03T10:00:00.000Z',
          updatedAt: '2026-10-03T10:00:00.000Z',
        },
      ],
    });
    expectSchema(detail, 'PropertyDetail');
  });

  it('maps input fields to columns and leaves absent fields out', () => {
    expect(
      toPropertyColumns({
        dealType: 'rent',
        areaM2: 50,
        totalFloors: null,
        title: null,
        refCode: 'IGNORED',
      }),
    ).toEqual({ deal_type: 'rent', area_m2: 50, total_floors: null, title: null });
    expect(toPropertyColumns({})).toEqual({});
  });
});

describe('image and user mappers', () => {
  it('maps a photo row', () => {
    const dto = toImageDto(image(4, 2));

    expect(dto).toEqual({
      id: 4,
      url: '/uploads/properties/12/4.jpg',
      sortOrder: 2,
      width: 2048,
      height: 1365,
      sizeBytes: 300_000,
      createdAt: '2026-10-01T08:05:00.000Z',
    });
    expectSchema(dto, 'PropertyImage');
  });

  it('maps a user without the password hash', () => {
    const dto = toUserDto(DEMO_ADMIN);

    expect(dto).toEqual({
      id: 1,
      email: 'admin@imotsync.local',
      fullName: 'Demo Admin',
      role: 'admin',
    });
    expectSchema(dto, 'User');
  });
});
