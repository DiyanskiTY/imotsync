import type { Knex } from 'knex';

/*
 * Row types for the application tables, exactly as the mysql2 driver returns them:
 * DATETIME -> Date (UTC), DECIMAL -> number, JSON -> parsed value, nullable columns -> T | null.
 */

/** A JSON object column. MariaDB 11 reports JSON columns as such, so mysql2 parses them. */
export type JsonObject = Record<string, unknown>;

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
  /** Set by bulk delete; the worker deletes the property once every portal removed it. */
  delete_requested_at: Date | null;
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
  /** When the listing was first published successfully. */
  published_at: Date | null;
  /** Feed portals: what the feed serves for this listing (portal-specific), or null. */
  payload: JsonObject | null;
  payload_updated_at: Date | null;
  /** When the last successful remove went through; null once published again. */
  removed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/** Per-portal state that is not about one listing (e.g. the Realistimo import trigger). */
export interface PortalSyncStateRow {
  portal: string;
  last_triggered_at: Date | null;
  last_trigger_message: string | null;
  last_log_date: Date | null;
  last_result: JsonObject | null;
  /**
   * The newest feed change of listings that were deleted together with their property (their
   * payload_updated_at), which no listing row records any more. Keeps feed dates such as
   * Realistimo's <updated> from falling back.
   */
  feed_changed_at: Date | null;
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
  | 'delete_requested_at'
  | 'created_by'
  | 'created_at'
  | 'updated_at'
>;

export type NewPropertyImage = Optional<
  PropertyImageRow,
  'id' | 'sort_order' | 'width' | 'height' | 'size_bytes' | 'created_at'
>;

export type NewPortalListing = Optional<
  Omit<PortalListingRow, 'payload'>,
  | 'id'
  | 'external_id'
  | 'status'
  | 'last_error'
  | 'published_at'
  | 'payload_updated_at'
  | 'removed_at'
  | 'created_at'
  | 'updated_at'
> & {
  /** JSON text (JSON.stringify), as for jobs.result. */
  payload?: string | null;
};

export type NewPortalSyncState = Optional<
  Omit<PortalSyncStateRow, 'last_result'>,
  | 'last_triggered_at'
  | 'last_trigger_message'
  | 'last_log_date'
  | 'feed_changed_at'
  | 'created_at'
  | 'updated_at'
> & {
  /** JSON text (JSON.stringify). */
  last_result?: string | null;
};

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
      UpdateWithRaw<NewPortalListing>
    >;
    jobs: Knex.CompositeTableType<JobRow, NewJob, UpdateWithRaw<NewJob>>;
    portal_sync_state: Knex.CompositeTableType<
      PortalSyncStateRow,
      NewPortalSyncState,
      UpdateWithRaw<NewPortalSyncState>
    >;
  }
}
