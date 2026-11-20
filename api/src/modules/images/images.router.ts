import { Router } from 'express';
import { createConcurrencyLimit } from '../../lib/concurrency-limit.js';
import { HttpError } from '../../lib/http-error.js';
import {
  idParam,
  intParam,
  jsonObjectBody,
  validate,
  validated,
  validateParams,
} from '../../lib/validation.js';
import type { ImagesService } from './images.service.js';
import { reorderImagesValidators, type ReorderImagesBody } from './images.validators.js';
import { createPhotoReceiver, DEFAULT_UPLOAD_BODY_TIMEOUT_MS } from './photo-upload.js';

/** Photo uploads handled at the same time by default (each may hold 300 MB in memory). */
export const DEFAULT_MAX_CONCURRENT_UPLOADS = 2;

/** Seconds a client is asked to wait when every upload slot is taken. */
export const UPLOAD_RETRY_AFTER_SECONDS = 10;

export interface ImagesRouterDeps {
  images: ImagesService;
  /** Uploads received and processed at the same time; more are answered with 429. */
  maxConcurrentUploads?: number;
  /**
   * Milliseconds an upload's body has to arrive in (default 60 s); a slower upload is
   * answered with 408 and gives its slot back.
   */
  uploadBodyTimeoutMs?: number;
}

/** Photos of a property. Mounted behind requireAuth. */
export function createImagesRouter({
  images,
  maxConcurrentUploads = DEFAULT_MAX_CONCURRENT_UPLOADS,
  uploadBodyTimeoutMs = DEFAULT_UPLOAD_BODY_TIMEOUT_MS,
}: ImagesRouterDeps): Router {
  const router = Router();
  // The same limits the service stores under: one policy, set where the service is built.
  const receivePhotos = createPhotoReceiver({
    bodyTimeoutMs: uploadBodyTimeoutMs,
    limits: images.uploadLimits,
  });
  const uploadSlots = createConcurrencyLimit(maxConcurrentUploads);

  router.post('/properties/:id/images', validateParams(idParam('id')), async (req, res) => {
    const propertyId = intParam(req, 'id');
    // Both before the body is read: it can be 300 MB.
    await images.assertPropertyExists(propertyId);
    const release = uploadSlots.tryAcquire();
    if (!release) {
      throw new HttpError(
        429,
        'TOO_MANY_REQUESTS',
        `Too many photo uploads are in progress. Try again in ${UPLOAD_RETRY_AFTER_SECONDS} seconds.`,
        { headers: { 'Retry-After': String(UPLOAD_RETRY_AFTER_SECONDS) } },
      );
    }
    // The slot is held until the photos are stored or the upload has failed, even if the
    // client goes away in the meantime: that is how long their memory is in use. Receiving
    // the body has a deadline, so a client that sends it slowly, or stops sending it, cannot
    // keep the slot for long. This finally block is the only place the slot is given back,
    // so it is given back exactly once, however the upload ends.
    try {
      const photos = await receivePhotos(req, res);
      res.status(201).json({ data: await images.upload(propertyId, photos) });
    } finally {
      release();
    }
  });

  router.put(
    '/properties/:id/images/order',
    validateParams(idParam('id')),
    jsonObjectBody(),
    validate(reorderImagesValidators),
    async (req, res) => {
      const { imageIds } = validated<ReorderImagesBody>(req, 'body');
      res.json({ data: await images.reorder(intParam(req, 'id'), imageIds) });
    },
  );

  router.delete(
    '/properties/:id/images/:imageId',
    validateParams(idParam('id'), idParam('imageId')),
    async (req, res) => {
      await images.remove(intParam(req, 'id'), intParam(req, 'imageId'));
      res.status(204).end();
    },
  );

  return router;
}
