import type { Knex } from 'knex';

/*
 * Row types for the five tables, exactly as the mysql2 driver returns them:
 * DATETIME -> Date (UTC), DECIMAL -> number, nullable columns -> T | null.
 */

export const USER_ROLES = ['admin', 'broker'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const PROPERTY_TYPES = [
  'apartment',
  'house',
  'office',
  'shop',
  'land',
  'garage',
  'other',
] as const;
export type PropertyType = (typeof PROPERTY_TYPES)[number];

export const DEAL_TYPES = ['sale', 'rent'] as const;
export type DealType = (typeof DEAL_TYPES)[number];

export const PROPERTY_STATUSES = ['draft', 'active', 'archived'] as const;
export type PropertyStatus = (typeof PROPERTY_STATUSES)[number];

/** Adapter keys. Stored as VARCHAR, so adding a portal needs no migration. */
export const PORTALS = ['realistimo', 'bazar', 'demo'] as const;
export type Portal = (typeof PORTALS)[number];

export const PORTAL_LISTING_STATUSES = [
  'draft',
  'pending',
  'published',
  'error',
  'removed',
] as const;
export type PortalListingStatus = (typeof PORTAL_LISTING_STATUSES)[number];

export const JOB_ACTIONS = ['publish', 'update', 'remove'] as const;
export type JobAction = (typeof JOB_ACTIONS)[number];

export const JOB_STATUSES = ['queued', 'running', 'succeeded', 'failed'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export interface UserRow {
  id: number;
  email: string;
  password_hash: string;
  full_name: string;
  role: UserRole;
  created_at: Date;
  updated_at: Date;
}

export interface PropertyRow {
  id: number;
  /** Agency reference such as "IS-00001"; portals use it to match re-imported listings. */
  ref_code: string;
  title: string | null;
  type: PropertyType;
  deal_type: DealType;
  city: string;
  district: string | null;
  price: number | null;
  currency: string;
  area_m2: number | null;
  rooms: number | null;
  floor: number | null;
  total_floors: number | null;
  description: string | null;
  status: PropertyStatus;
  created_by: number | null;
  created_at: Date;
  updated_at: Date;
}

export interface PropertyImageRow {
  id: number;
  property_id: number;
  url: string;
  sort_order: number;
  width: number | null;
  height: number | null;
  size_bytes: number | null;
  created_at: Date;
}

export interface PortalListingRow {
  id: number;
  property_id: number;
  portal: string;
  external_id: string | null;
  status: PortalListingStatus;
  last_error: string | null;
  published_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/** What an adapter reports for one attempt (external id, HTTP status, message, ...). */
export type JobResult = Record<string, unknown>;

export interface JobRow {
  id: number;
  portal_listing_id: number;
  action: JobAction;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  run_after: Date;
  locked_at: Date | null;
  locked_by: string | null;
  /**
   * Outcome of the last attempt. MariaDB 11 reports the column as JSON, so mysql2 returns
   * it already parsed. Writes must pass JSON text (see NewJob).
   */
  result: JobResult | null;
  last_error: string | null;
  finished_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/** Columns the database fills in when an insert leaves them out. */
type Optional<Row, Keys extends keyof Row> = Omit<Row, Keys> & Partial<Pick<Row, Keys>>;

export type NewUser = Optional<UserRow, 'id' | 'role' | 'created_at' | 'updated_at'>;

export type NewProperty = Optional<
  PropertyRow,
  | 'id'
  | 'title'
  | 'district'
  | 'price'
  | 'currency'
  | 'area_m2'
  | 'rooms'
  | 'floor'
  | 'total_floors'
  | 'description'
  | 'status'
  | 'created_by'
  | 'created_at'
  | 'updated_at'
>;

export type NewPropertyImage = Optional<
  PropertyImageRow,
  'id' | 'sort_order' | 'width' | 'height' | 'size_bytes' | 'created_at'
>;

export type NewPortalListing = Optional<
  PortalListingRow,
  'id' | 'external_id' | 'status' | 'last_error' | 'published_at' | 'created_at' | 'updated_at'
>;

export type NewJob = Optional<
  Omit<JobRow, 'result'>,
  | 'id'
  | 'status'
  | 'attempts'
  | 'max_attempts'
  | 'run_after'
  | 'locked_at'
  | 'locked_by'
  | 'last_error'
  | 'finished_at'
  | 'created_at'
  | 'updated_at'
> & {
  /** JSON text (JSON.stringify); mysql2 would expand a plain object into "key = value" pairs. */
  result?: string | null;
};

/**
 * Update shape that may also set a column to an SQL expression, e.g. updated_at to
 * db.fn.now() (CURRENT_TIMESTAMP, the database clock in UTC).
 */
export type UpdateWithRaw<Row> = { [Key in keyof Row]?: Row[Key] | Knex.Raw };

// Typed query builders: db('properties') knows its row, insert and update shapes.
declare module 'knex/types/tables.js' {
  interface Tables {
    users: Knex.CompositeTableType<UserRow, NewUser, Partial<NewUser>>;
    properties: Knex.CompositeTableType<PropertyRow, NewProperty, UpdateWithRaw<NewProperty>>;
    property_images: Knex.CompositeTableType<
      PropertyImageRow,
      NewPropertyImage,
      Partial<NewPropertyImage>
    >;
    portal_listings: Knex.CompositeTableType<
      PortalListingRow,
      NewPortalListing,
      Partial<NewPortalListing>
    >;
    jobs: Knex.CompositeTableType<JobRow, NewJob, Partial<NewJob>>;
  }
}
