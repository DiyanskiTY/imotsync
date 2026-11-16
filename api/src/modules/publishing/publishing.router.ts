import { Router } from 'express';
import {
  idParam,
  intParam,
  jsonObjectBody,
  validate,
  validated,
  validateParams,
} from '../../lib/validation.js';
import type { PublishingService } from './publishing.service.js';
import {
  createPublishingValidators,
  type BulkDeleteBody,
  type BulkPublishBody,
  type ChecksQuery,
  type OptionalPortalsBody,
  type PortalsBody,
} from './publishing.validators.js';

/** Portals, pre-publish checks, publish, unpublish and the bulk operations. Behind requireAuth. */
export function createPublishingRouter(deps: {
  publishing: PublishingService;
  portalKeys: readonly string[];
}): Router {
  const { publishing } = deps;
  const validators = createPublishingValidators(deps.portalKeys);
  const router = Router();

  router.get('/portals', (_req, res) => {
    res.json({ data: publishing.listPortals() });
  });

  // Before the /properties/:id/... routes, which would otherwise take "bulk" for an id.
  router.post(
    '/properties/bulk/publish',
    jsonObjectBody(),
    validate(validators.bulkPublish),
    async (req, res) => {
      const { propertyIds, portals } = validated<BulkPublishBody>(req, 'body');
      res.json({ data: await publishing.bulkPublish(propertyIds, portals) });
    },
  );

  router.post(
    '/properties/bulk/delete',
    jsonObjectBody(),
    validate(validators.bulkDelete),
    async (req, res) => {
      const { propertyIds } = validated<BulkDeleteBody>(req, 'body');
      res.json({ data: await publishing.bulkDelete(propertyIds) });
    },
  );

  router.get(
    '/properties/:id/checks',
    validateParams(idParam('id')),
    validate(validators.checks, { exact: ['query'] }),
    async (req, res) => {
      const { portals } = validated<ChecksQuery>(req, 'query');
      res.json({ data: await publishing.checks(intParam(req, 'id'), portals) });
    },
  );

  router.post(
    '/properties/:id/publish',
    validateParams(idParam('id')),
    jsonObjectBody(),
    validate(validators.publish),
    async (req, res) => {
      const { portals } = validated<PortalsBody>(req, 'body');
      res.status(202).json({ data: await publishing.publish(intParam(req, 'id'), portals) });
    },
  );

  router.post(
    '/properties/:id/unpublish',
    validateParams(idParam('id')),
    jsonObjectBody(),
    validate(validators.unpublish),
    async (req, res) => {
      const { portals } = validated<OptionalPortalsBody>(req, 'body');
      res.status(202).json({ data: await publishing.unpublish(intParam(req, 'id'), portals) });
    },
  );

  return router;
}
