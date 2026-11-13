import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Knex } from 'knex';
import { hashPassword } from '../../lib/password.js';
import type { NewJob, NewPortalListing, NewProperty, NewPropertyImage, NewUser } from '../types.js';
import { DEMO_PROPERTIES, DEMO_USERS, refCodeFor } from './demo-data.js';
import { createPlaceholderPhoto } from './placeholder-photos.js';

/** Demo photos live in their own folder under UPLOAD_DIR, which the seed owns completely. */
export const DEMO_PHOTO_FOLDER = 'demo';

export interface DemoSeedOptions {
  /** Absolute UPLOAD_DIR; photos are written to <uploadDir>/demo/. */
  uploadDir: string;
  /** Password for both demo accounts. */
  demoPassword: string;
  /** Reference time for the relative timestamps (default: now). */
  now?: Date;
}

export interface DemoSeedSummary {
  users: number;
  properties: number;
  propertyImages: number;
  portalListings: number;
  jobs: number;
}

const REQUIRED_TABLES = ['users', 'properties', 'property_images', 'portal_listings', 'jobs'];

/**
 * Replaces all data with the demo data set.
 *
 * Rows get fixed ids, so running the seed twice produces the same data (and the same
 * IS-00001... reference codes). Photos are generated first; the wipe and all inserts then
 * run in one transaction, so a failure leaves the previous data in place.
 */
export async function runDemoSeed(db: Knex, options: DemoSeedOptions): Promise<DemoSeedSummary> {
  for (const table of REQUIRED_TABLES) {
    if (!(await db.schema.hasTable(table))) {
      throw new Error(
        `Table "${table}" is missing. Run the migrations first (npm run db:migrate).`,
      );
    }
  }

  const now = options.now ?? new Date();
  const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000);

  const users: NewUser[] = [];
  for (const user of DEMO_USERS) {
    const createdAt = minutesAgo(90 * 24 * 60);
    users.push({
      id: user.id,
      email: user.email,
      password_hash: await hashPassword(options.demoPassword),
      full_name: user.fullName,
      role: user.role,
      created_at: createdAt,
      updated_at: createdAt,
    });
  }

  const photoDir = path.join(options.uploadDir, DEMO_PHOTO_FOLDER);
  await rm(photoDir, { recursive: true, force: true });
  await mkdir(photoDir, { recursive: true });

  const properties: NewProperty[] = [];
  const images: NewPropertyImage[] = [];
  const listings: NewPortalListing[] = [];
  const jobs: NewJob[] = [];

  for (const [index, demo] of DEMO_PROPERTIES.entries()) {
    const id = index + 1;
    const refCode = refCodeFor(id);
    const createdAt = minutesAgo(demo.createdAgo);

    properties.push({
      id,
      ref_code: refCode,
      title: demo.title,
      type: demo.type,
      deal_type: demo.dealType,
      city: demo.city,
      district: demo.district,
      price: demo.price,
      currency: 'EUR',
      area_m2: demo.areaM2,
      rooms: demo.rooms,
      floor: demo.floor,
      total_floors: demo.totalFloors,
      description: demo.description,
      status: demo.status,
      created_by: demo.createdBy,
      created_at: createdAt,
      updated_at: createdAt,
    });

    for (let number = 1; number <= demo.photoCount; number++) {
      const fileName = `${refCode.toLowerCase()}-${number}.jpg`;
      const photo = await createPlaceholderPhoto({
        filePath: path.join(photoDir, fileName),
        refCode,
        photoNumber: number,
        photoCount: demo.photoCount,
        // Golden-angle steps keep neighbouring properties visibly different.
        hue: (index * 137) % 360,
      });
      images.push({
        id: images.length + 1,
        property_id: id,
        url: `/uploads/${DEMO_PHOTO_FOLDER}/${fileName}`,
        sort_order: number - 1,
        width: photo.width,
        height: photo.height,
        size_bytes: photo.sizeBytes,
        created_at: createdAt,
      });
    }

    for (const listing of demo.listings) {
      const listingId = listings.length + 1;
      const listingCreatedAt = minutesAgo(listing.createdAgo);
      const lastJob = listing.jobs?.at(-1);
      listings.push({
        id: listingId,
        property_id: id,
        portal: listing.portal,
        external_id: listing.externalId ?? null,
        status: listing.status,
        last_error: listing.lastError ?? null,
        published_at: listing.publishedAgo === undefined ? null : minutesAgo(listing.publishedAgo),
        created_at: listingCreatedAt,
        updated_at: minutesAgo(lastJob?.finishedAgo ?? lastJob?.createdAgo ?? listing.createdAgo),
      });

      for (const job of listing.jobs ?? []) {
        // Only a running job holds a worker's lock.
        const isLocked = job.lockedAgo !== undefined && job.lockedBy !== undefined;
        if (isLocked !== (job.status === 'running')) {
          throw new Error(
            `Demo job for ${refCode} on ${listing.portal}: a ${job.status} job ` +
              `${isLocked ? 'must not have' : 'needs'} lockedAgo and lockedBy.`,
          );
        }
        const jobCreatedAt = minutesAgo(job.createdAgo);
        const lockedAt = job.lockedAgo === undefined ? null : minutesAgo(job.lockedAgo);
        const finishedAt = job.finishedAgo === undefined ? null : minutesAgo(job.finishedAgo);
        jobs.push({
          id: jobs.length + 1,
          portal_listing_id: listingId,
          action: job.action,
          status: job.status,
          attempts: job.attempts,
          max_attempts: job.maxAttempts ?? 5,
          run_after: job.runAfterIn === undefined ? jobCreatedAt : minutesAgo(-job.runAfterIn),
          locked_at: lockedAt,
          locked_by: job.lockedBy ?? null,
          result: job.result === undefined ? null : JSON.stringify(job.result),
          last_error: job.lastError ?? null,
          finished_at: finishedAt,
          created_at: jobCreatedAt,
          updated_at: finishedAt ?? lockedAt ?? jobCreatedAt,
        });
      }
    }
  }

  await db.transaction(async (trx) => {
    // Children first, so no foreign key is ever violated.
    await trx('jobs').delete();
    await trx('portal_listings').delete();
    await trx('property_images').delete();
    await trx('properties').delete();
    await trx('users').delete();

    await trx('users').insert(users);
    await trx('properties').insert(properties);
    await trx('property_images').insert(images);
    await trx('portal_listings').insert(listings);
    await trx('jobs').insert(jobs);
  });

  return {
    users: users.length,
    properties: properties.length,
    propertyImages: images.length,
    portalListings: listings.length,
    jobs: jobs.length,
  };
}
