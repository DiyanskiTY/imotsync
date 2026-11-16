/*
 * Where uploaded photos are stored. Their files are deleted only by the worker's photo sweep
 * (src/jobs/photo-gc.ts), once no photo row and no stored feed payload refers to them.
 */

/** The storage folder that holds the uploaded photos of every property. */
export const UPLOADED_PHOTOS_FOLDER = 'properties';

/** The storage folder of a property's uploaded photos, e.g. "properties/12". */
export const propertyPhotoFolder = (propertyId: number) =>
  `${UPLOADED_PHOTOS_FOLDER}/${propertyId}`;
