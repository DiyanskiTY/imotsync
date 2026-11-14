import type { FileStorage } from '../../lib/storage.js';
import type { Logger } from '../../logger.js';

/** The storage folder that holds the uploaded photos of every property. */
export const UPLOADED_PHOTOS_FOLDER = 'properties';

/** The storage folder of a property's uploaded photos, e.g. "properties/12". */
export const propertyPhotoFolder = (propertyId: number) =>
  `${UPLOADED_PHOTOS_FOLDER}/${propertyId}`;

/**
 * Deletes the files behind photo URLs after their rows are gone. Runs after the database
 * change has committed, so a failure here only leaves an orphaned file behind: it is
 * logged, never reported to the client as a failed request.
 */
export async function deleteStoredPhotos(
  storage: FileStorage,
  logger: Logger,
  urls: readonly string[],
  folder?: string,
): Promise<void> {
  for (const url of urls) {
    const key = storage.keyFromUrl(url);
    if (key === null) {
      logger.warn({ url }, 'Photo URL does not point into the upload storage; file not deleted');
      continue;
    }
    try {
      await storage.delete(key);
    } catch (error) {
      logger.error({ err: error, key }, 'Could not delete a photo file');
    }
  }
  if (folder !== undefined) {
    try {
      await storage.deletePrefix(folder);
    } catch (error) {
      logger.error({ err: error, folder }, 'Could not delete a photo folder');
    }
  }
}
