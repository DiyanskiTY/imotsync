import { body } from 'express-validator';
import { MAX_ID } from '../../lib/validation.js';
import { PHOTO_LIMITS } from './image-processing.js';

const isId = (value: unknown) =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_ID;

/** PUT /properties/:id/images/order {"imageIds": [3, 1, 2]}. */
export const reorderImagesValidators = [
  body('imageIds')
    .exists()
    .withMessage('is required')
    .bail()
    .custom((value: unknown) => Array.isArray(value))
    .withMessage('must be an array of photo ids')
    .bail()
    .custom((ids: unknown[]) => ids.length <= PHOTO_LIMITS.maxPerProperty)
    .withMessage(`must not list more than ${PHOTO_LIMITS.maxPerProperty} ids`)
    .bail()
    .custom((ids: unknown[]) => ids.every(isId))
    .withMessage('must contain only positive integer ids')
    .bail()
    .custom((ids: number[]) => new Set(ids).size === ids.length)
    .withMessage('must not contain an id twice'),
];

export interface ReorderImagesBody {
  imageIds: number[];
}
