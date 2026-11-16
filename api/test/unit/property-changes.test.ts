import { describe, expect, it } from 'vitest';
import type { PropertyRow } from '../../src/db/types.js';
import { changesPortalContent } from '../../src/modules/properties/properties.service.js';

const AT = new Date('2026-11-01T10:00:00Z');

const current: PropertyRow = {
  id: 1,
  ref_code: 'IS-00001',
  title: 'Апартамент',
  type: 'apartment',
  deal_type: 'sale',
  city: 'Sofia',
  district: 'Lozenets',
  price: 245_000,
  currency: 'EUR',
  area_m2: 98,
  rooms: 3,
  floor: 4,
  total_floors: 6,
  description: 'Описание',
  status: 'active',
  delete_requested_at: null,
  created_by: 1,
  created_at: AT,
  updated_at: AT,
};

describe('changesPortalContent (which edits queue update jobs)', () => {
  it('is true when a field portals show gets a new value', () => {
    expect(changesPortalContent(current, { price: 239_000 })).toBe(true);
    expect(changesPortalContent(current, { title: 'Нов текст' })).toBe(true);
    expect(changesPortalContent(current, { district: null })).toBe(true);
    expect(changesPortalContent(current, { floor: 5, total_floors: 6 })).toBe(true);
  });

  it('is false when the values stay the same', () => {
    expect(changesPortalContent(current, { price: 245_000, title: 'Апартамент' })).toBe(false);
    expect(changesPortalContent(current, {})).toBe(false);
  });

  it('ignores the status and the reference code, which portals do not show as content', () => {
    expect(changesPortalContent(current, { status: 'archived' })).toBe(false);
    expect(changesPortalContent(current, { ref_code: 'AG-1' })).toBe(false);
  });
});
