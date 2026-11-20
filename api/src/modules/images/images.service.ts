import { randomUUID } from 'node:crypto';
import type { Knex } from 'knex';
import type { PropertyImageRow } from '../../db/types.js';
import { enqueueUpdatesForProperty } from '../../jobs/enqueue.js';
import { queueTransaction } from '../../jobs/transaction.js';
import {
  conflict,
  HttpError,
  notFound,
  validationError,
  type FieldIssue,
} from '../../lib/http-error.js';
import type { FileStorage } from '../../lib/storage.js';
import type { Logger } from '../../logger.js';
import { createPropertyRepository } from '../properties/properties.repository.js';
import {
  ACCEPTED_FORMATS_TEXT,
  inspectImage,
  DEFAULT_UPLOAD_LIMITS,
  processImage,
  RejectedImageError,
  UnsupportedImageError,
  type ProcessedImage,
  type UploadLimits,
} from './image-processing.js';
import { toImageDto, type PropertyImageDto } from './images.mappers.js';
import { createImageRepository } from './images.repository.js';
import { displayName, PHOTO_FIELD, type UploadedPhoto } from './photo-upload.js';
import { propertyPhotoFolder } from './stored-files.js';

/** Stands in for an upload's bytes once its JPEG exists. */
const RELEASED = Buffer.alloc(0);

/** One file that cannot be accepted, e.g. name "notes.jpg", reason "is not a JPEG, ... image". */
interface FileProblem {
  name: string;
  field: string;
  reason: string;
}

const toIssue = ({ name, field, reason }: FileProblem): FieldIssue => ({
  field,
  message: `"${name}" ${reason}`,
});

const quote = (names: string[]) => names.map((name) => `"${name}"`).join(', ');

function tooManyPhotos(maxPerProperty: number, existing: number, adding: number): HttpError {
  const room = Math.max(0, maxPerProperty - existing);
  return conflict(
    `A property can have at most ${maxPerProperty} photos. It has ${existing}, ` +
      `so ${room === 0 ? 'no more can be added' : `at most ${room} more can be added`} (this request has ${adding}).`,
  );
}

function unsupportedMedia(problems: FileProblem[]): HttpError {
  const [first] = problems;
  const message =
    problems.length === 1 && first
      ? `Photo ${toIssue(first).message}`
      : `${problems.length} files are not readable ${ACCEPTED_FORMATS_TEXT} images: ${quote(problems.map((p) => p.name))}`;
  return new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', message, {
    details: problems.map(toIssue),
  });
}

export function createImagesService(deps: {
  db: Knex;
  storage: FileStorage;
  logger: Logger;
  /** This deployment's upload limits (default DEFAULT_UPLOAD_LIMITS; lower on the demo). */
  uploadLimits?: UploadLimits;
}) {
  const { db, storage, logger } = deps;
  const uploadLimits = deps.uploadLimits ?? DEFAULT_UPLOAD_LIMITS;
  const { maxPerProperty } = uploadLimits;

  /** Checks every file before any work is done, so all problems are reported at once. */
  async function checkFiles(files: readonly UploadedPhoto[]): Promise<void> {
    const unsupported: FileProblem[] = [];
    const rejected: FileProblem[] = [];
    for (const [index, file] of files.entries()) {
      const name = displayName(file.originalName, index);
      try {
        await inspectImage(file.buffer);
      } catch (error) {
        const field = `${PHOTO_FIELD}[${index}]`;
        if (error instanceof UnsupportedImageError) {
          unsupported.push({ name, field, reason: error.message });
        } else if (error instanceof RejectedImageError) {
          rejected.push({ name, field, reason: error.message });
        } else {
          throw error;
        }
      }
    }
    if (unsupported.length > 0) throw unsupportedMedia(unsupported);
    if (rejected.length > 0) {
      const [first] = rejected;
      throw validationError(
        rejected.map(toIssue),
        rejected.length === 1 && first
          ? `Photo ${toIssue(first).message}`
          : `${rejected.length} photos do not meet the requirements: ${quote(rejected.map((p) => p.name))}`,
      );
    }
  }

  /**
   * One photo at a time, because each decode can use a lot of memory. Each upload is let
   * go as soon as its (much smaller) JPEG exists, so the request holds less and less.
   */
  async function processAll(files: readonly UploadedPhoto[]): Promise<ProcessedImage[]> {
    const processed: ProcessedImage[] = [];
    for (const [index, file] of files.entries()) {
      try {
        processed.push(await processImage(file.buffer));
      } catch (error) {
        if (!(error instanceof UnsupportedImageError)) throw error;
        const name = displayName(file.originalName, index);
        throw unsupportedMedia([
          { name, field: `${PHOTO_FIELD}[${index}]`, reason: error.message },
        ]);
      }
      file.buffer = RELEASED;
    }
    return processed;
  }

  return {
    /** The limits uploads are received and stored under (the router's receiver uses them). */
    uploadLimits,

    /** 404 NOT_FOUND unless the property exists (checked before a large upload is read). */
    async assertPropertyExists(propertyId: number): Promise<void> {
      if (!(await createPropertyRepository(db).findById(propertyId))) {
        throw notFound(`Property ${propertyId} does not exist`);
      }
    },

    /**
     * Validates, normalises and stores the photos, then appends them after the property's
     * current last photo. Files are written before the rows; if writing them or the
     * transaction that adds the rows fails, the files written so far are removed again.
     * Once the rows are committed their files are never touched, whatever happens next.
     *
     * Takes over the photos' buffers: each is replaced by an empty one once processed.
     */
    async upload(propertyId: number, files: readonly UploadedPhoto[]): Promise<PropertyImageDto[]> {
      if (files.length === 0) {
        throw validationError([{ field: PHOTO_FIELD, message: 'must contain at least one photo' }]);
      }
      const existing = await createImageRepository(db).countForProperty(propertyId);
      if (existing + files.length > maxPerProperty) {
        throw tooManyPhotos(maxPerProperty, existing, files.length);
      }

      await checkFiles(files);
      const processed = await processAll(files);

      const folder = propertyPhotoFolder(propertyId);
      const savedKeys: string[] = [];
      let inserted: PropertyImageRow[];
      try {
        const rows: { key: string; image: ProcessedImage }[] = [];
        for (const image of processed) {
          const key = `${folder}/${randomUUID()}.jpg`;
          await storage.save(key, image.data);
          savedKeys.push(key);
          rows.push({ key, image });
        }

        inserted = await queueTransaction(db, async (trx) => {
          const properties = createPropertyRepository(trx);
          const images = createImageRepository(trx);
          // The lock serialises uploads to one property, so the count and the sort order
          // below cannot be raced by a parallel upload.
          if (!(await properties.findForUpdate(propertyId))) {
            throw notFound(`Property ${propertyId} does not exist`);
          }
          const count = await images.countForProperty(propertyId);
          if (count + rows.length > maxPerProperty) {
            throw tooManyPhotos(maxPerProperty, count, rows.length);
          }
          let sortOrder = ((await images.maxSortOrder(propertyId)) ?? -1) + 1;
          const ids: number[] = [];
          for (const { key, image } of rows) {
            ids.push(
              await images.insert({
                property_id: propertyId,
                url: storage.publicUrl(key),
                sort_order: sortOrder++,
                width: image.width,
                height: image.height,
                size_bytes: image.sizeBytes,
              }),
            );
          }
          await properties.touch(propertyId);
          // Published listings get the new photos through update jobs.
          await enqueueUpdatesForProperty(trx, propertyId);
          // Read back inside the transaction, so no query runs after the commit: a failure
          // there would delete the files of rows that are already saved.
          return images.findByIds(ids);
        });
      } catch (error) {
        for (const key of savedKeys) {
          await storage.delete(key).catch((deleteError: unknown) => {
            logger.error(
              { err: deleteError, key },
              'Could not remove a photo after a failed upload',
            );
          });
        }
        throw error;
      }
      return inserted.map(toImageDto);
    },

    /** Sets the display order. `imageIds` must list every photo of the property exactly once. */
    async reorder(propertyId: number, imageIds: readonly number[]): Promise<PropertyImageDto[]> {
      const rows = await queueTransaction(db, async (trx) => {
        const properties = createPropertyRepository(trx);
        const images = createImageRepository(trx);
        if (!(await properties.findForUpdate(propertyId))) {
          throw notFound(`Property ${propertyId} does not exist`);
        }

        const current = await images.lockForProperty(propertyId);
        const currentIds = new Set(current.map((image) => image.id));
        const requested = new Set(imageIds);
        const missing = [...currentIds].filter((id) => !requested.has(id));
        const foreign = imageIds.filter((id) => !currentIds.has(id));
        if (missing.length > 0 || foreign.length > 0) {
          const problems = [
            missing.length > 0 ? `missing photo ids: ${missing.join(', ')}` : '',
            foreign.length > 0 ? `not photos of this property: ${foreign.join(', ')}` : '',
          ].filter((text) => text !== '');
          throw validationError([
            {
              field: 'imageIds',
              message: `must list every photo of the property exactly once (${problems.join('; ')})`,
            },
          ]);
        }

        const sortOrders = new Map(current.map((image) => [image.id, image.sort_order]));
        for (const [index, id] of imageIds.entries()) {
          if (sortOrders.get(id) !== index) await images.setSortOrder(id, index);
        }
        await properties.touch(propertyId);
        // Portals show the photos in this order (the first is the main photo).
        const orderChanged = current.some((image, index) => image.id !== imageIds[index]);
        if (orderChanged) await enqueueUpdatesForProperty(trx, propertyId);
        return images.listForProperty(propertyId);
      });
      return rows.map(toImageDto);
    },

    /**
     * Deletes one photo of the property: the row, and update jobs for the listings that show
     * it. The file stays until the worker's photo sweep deletes it: a stored feed payload
     * links to it until an update job replaces that payload (or for good, if the job fails).
     */
    async remove(propertyId: number, imageId: number): Promise<void> {
      await queueTransaction(db, async (trx) => {
        const properties = createPropertyRepository(trx);
        const images = createImageRepository(trx);
        if (!(await properties.findForUpdate(propertyId))) {
          throw notFound(`Property ${propertyId} does not exist`);
        }
        const image = await images.findInProperty(propertyId, imageId);
        if (!image) {
          throw notFound(`Photo ${imageId} does not exist or belongs to another property`);
        }
        await images.delete(imageId);
        await properties.touch(propertyId);
        await enqueueUpdatesForProperty(trx, propertyId);
      });
    },
  };
}

export type ImagesService = ReturnType<typeof createImagesService>;
