import type { Knex } from 'knex';
import { PUBLIC_UPLOADS_PATH, type FileStorage } from '../lib/storage.js';
import type { Logger } from '../logger.js';
import { UPLOADED_PHOTOS_FOLDER } from '../modules/images/stored-files.js';

/*
 * Garbage collection of photo files. Deleting a photo, or a whole property, removes the
 * database rows at once but never the files: a feed portal may still be served a stored
 * payload that links to them (until an update job replaces it, or for good when that job
 * fails), and a broken image link can get the listing rejected. This sweep, run by the worker,
 * deletes the files under UPLOAD_DIR/properties/ that nothing refers to any more.
 */

/** A file younger than this is never deleted: an upload saves its files before their rows. */
export const PHOTO_GC_MIN_AGE_MS = 60 * 60 * 1000;

/** The storage key in a photo URL anywhere in a text, e.g. in an absolute URL of a payload. */
const PHOTO_KEY_IN_TEXT = new RegExp(
  `${PUBLIC_UPLOADS_PATH}/(${UPLOADED_PHOTOS_FOLDER}/[A-Za-z0-9._/-]+)`,
  'g',
);

/** "properties/12/x.jpg" -> 12; null for a key outside a property's folder. */
function propertyIdOf(key: string): number | null {
  const match = new RegExp(`^${UPLOADED_PHOTOS_FOLDER}/(\\d+)/`).exec(key);
  return match?.[1] === undefined ? null : Number(match[1]);
}

/** Storage keys of every photo a property_images row or a stored feed payload refers to. */
async function referencedKeys(db: Knex, storage: FileStorage): Promise<Set<string>> {
  const keys = new Set<string>();
  const urls = await db('property_images').pluck('url');
  for (const url of urls) {
    const key = storage.keyFromUrl(url);
    if (key !== null) keys.add(key);
  }
  const payloads = await db('portal_listings').whereNotNull('payload').pluck('payload');
  for (const payload of payloads as unknown[]) {
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
    for (const match of text.matchAll(PHOTO_KEY_IN_TEXT)) {
      if (match[1] !== undefined) keys.add(match[1]);
    }
  }
  return keys;
}

export interface PhotoGcOptions {
  /** Only files at least this old are deleted (default PHOTO_GC_MIN_AGE_MS). */
  minAgeMs?: number;
  /** Clock (tests). */
  now?: Date;
}

export interface PhotoGcResult {
  /** Files deleted. */
  deleted: number;
  /** Files that could not be deleted (logged; tried again by the next sweep). */
  failed: number;
}

/**
 * Deletes the files under UPLOAD_DIR/properties/ that no property_images row and no
 * portal_listings.payload refers to, and that are older than `minAgeMs`. The folder of a
 * property that no longer exists is removed once its last file is gone.
 */
export async function collectUnusedPhotos(
  db: Knex,
  storage: FileStorage,
  logger: Logger,
  options: PhotoGcOptions = {},
): Promise<PhotoGcResult> {
  const now = (options.now ?? new Date()).getTime();
  const minAgeMs = options.minAgeMs ?? PHOTO_GC_MIN_AGE_MS;
  const result: PhotoGcResult = { deleted: 0, failed: 0 };

  const files = await storage.list(UPLOADED_PHOTOS_FOLDER);
  const old = files.filter((file) => now - file.modifiedAt.getTime() >= minAgeMs);
  if (old.length === 0) return result;

  // Read after listing the files: a reference added in between keeps its file.
  const referenced = await referencedKeys(db, storage);
  const remaining = new Map<number, number>();
  for (const file of files) {
    const id = propertyIdOf(file.key);
    if (id !== null) remaining.set(id, (remaining.get(id) ?? 0) + 1);
  }

  for (const file of old) {
    if (referenced.has(file.key)) continue;
    try {
      await storage.delete(file.key);
      result.deleted++;
      const id = propertyIdOf(file.key);
      if (id !== null) remaining.set(id, (remaining.get(id) ?? 1) - 1);
    } catch (error) {
      result.failed++;
      logger.error({ err: error, key: file.key }, 'Could not delete an unused photo file');
    }
  }

  // Folders left empty by a deleted property (an existing property may get new uploads).
  const emptied = [...remaining].filter(([, count]) => count === 0).map(([id]) => id);
  if (emptied.length > 0) {
    const existing = new Set(await db('properties').whereIn('id', emptied).pluck('id'));
    for (const id of emptied) {
      if (existing.has(id)) continue;
      const folder = `${UPLOADED_PHOTOS_FOLDER}/${id}`;
      try {
        await storage.deletePrefix(folder);
      } catch (error) {
        logger.error({ err: error, folder }, 'Could not delete a photo folder');
      }
    }
  }

  if (result.deleted > 0 || result.failed > 0) {
    logger.info({ ...result }, 'Deleted unused photo files');
  }
  return result;
}
