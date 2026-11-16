import { body, query, type ValidationChain } from 'express-validator';
import { MAX_ID } from '../../lib/validation.js';

/** Properties one bulk request may name. */
export const BULK_MAX_PROPERTIES = 100;

const isId = (value: unknown) =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_ID;

const unique = (items: unknown[]) => new Set(items).size === items.length;

/**
 * Chains for the publishing endpoints. Portal keys are checked against the registered
 * adapters, so the chains are built once the registry is known.
 */
export function createPublishingValidators(portalKeys: readonly string[]) {
  const known = (items: unknown[]) =>
    items.every((item) => typeof item === 'string' && portalKeys.includes(item));
  const knownMessage = `must list portals from: ${portalKeys.join(', ')}`;

  /** A JSON array of distinct, registered portal keys. */
  function portalsBody(required: boolean): ValidationChain {
    const start = required
      ? body('portals').exists().withMessage('is required').bail()
      : body('portals').optional();
    return start
      .custom((value: unknown) => Array.isArray(value))
      .withMessage('must be an array of portal keys')
      .bail()
      .custom((items: unknown[]) => items.length >= 1)
      .withMessage('must name at least one portal')
      .bail()
      .custom(known)
      .withMessage(knownMessage)
      .bail()
      .custom(unique)
      .withMessage('must not name a portal twice');
  }

  const propertyIdsBody = body('propertyIds')
    .exists()
    .withMessage('is required')
    .bail()
    .custom((value: unknown) => Array.isArray(value))
    .withMessage('must be an array of property ids')
    .bail()
    .custom((ids: unknown[]) => ids.length >= 1 && ids.length <= BULK_MAX_PROPERTIES)
    .withMessage(`must contain 1 to ${BULK_MAX_PROPERTIES} ids`)
    .bail()
    .custom((ids: unknown[]) => ids.every(isId))
    .withMessage('must contain only positive integer ids')
    .bail()
    .custom(unique)
    .withMessage('must not contain an id twice');

  return {
    /** GET /properties/:id/checks?portals=a,b */
    checks: [
      query('portals')
        .optional()
        .custom((value: unknown) => typeof value === 'string')
        .withMessage('must be given once, as a comma-separated list')
        .bail()
        .customSanitizer((value: string) =>
          value
            .split(',')
            .map((item) => item.trim())
            .filter((item) => item.length > 0),
        )
        .custom((items: string[]) => items.length >= 1)
        .withMessage('must name at least one portal')
        .bail()
        .custom(known)
        .withMessage(knownMessage)
        .bail()
        .custom(unique)
        .withMessage('must not name a portal twice'),
    ],
    publish: [portalsBody(true)],
    unpublish: [portalsBody(false)],
    bulkPublish: [propertyIdsBody, portalsBody(true)],
    bulkDelete: [propertyIdsBody],
  };
}

export interface PortalsBody {
  portals: string[];
}

export interface OptionalPortalsBody {
  portals?: string[];
}

export interface BulkPublishBody {
  propertyIds: number[];
  portals: string[];
}

export interface BulkDeleteBody {
  propertyIds: number[];
}

export interface ChecksQuery {
  portals?: string[];
}
