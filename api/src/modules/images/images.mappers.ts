import type { PropertyImageRow } from '../../db/types.js';

export interface PropertyImageDto {
  id: number;
  url: string;
  sortOrder: number;
  width: number | null;
  height: number | null;
  sizeBytes: number | null;
  createdAt: string;
}

export function toImageDto(row: PropertyImageRow): PropertyImageDto {
  return {
    id: row.id,
    url: row.url,
    sortOrder: row.sort_order,
    width: row.width,
    height: row.height,
    sizeBytes: row.size_bytes,
    createdAt: row.created_at.toISOString(),
  };
}
