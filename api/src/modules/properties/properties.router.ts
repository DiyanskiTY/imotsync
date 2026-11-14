import { Router } from 'express';
import {
  idParam,
  intParam,
  jsonObjectBody,
  validate,
  validated,
  validateParams,
} from '../../lib/validation.js';
import { currentUser } from '../auth/require-auth.js';
import type { PropertyInput } from './properties.mappers.js';
import type { CreatePropertyInput, PropertiesService } from './properties.service.js';
import {
  createPropertyValidators,
  listPropertiesValidators,
  updatePropertyValidators,
  type ListPropertiesQuery,
} from './properties.validators.js';

/** /properties CRUD. Mounted behind requireAuth; any signed-in user may read and write. */
export function createPropertiesRouter({ properties }: { properties: PropertiesService }): Router {
  const router = Router();

  router.get(
    '/properties',
    validate(listPropertiesValidators, { exact: ['query'] }),
    async (req, res) => {
      res.json(await properties.list(validated<ListPropertiesQuery>(req, 'query')));
    },
  );

  router.post(
    '/properties',
    jsonObjectBody(),
    validate(createPropertyValidators),
    async (req, res) => {
      const input = validated<CreatePropertyInput>(req, 'body');
      const property = await properties.create(input, currentUser(req).id);
      res.status(201).location(`/api/properties/${property.id}`).json(property);
    },
  );

  router.get('/properties/:id', validateParams(idParam('id')), async (req, res) => {
    res.json(await properties.getDetail(intParam(req, 'id')));
  });

  router.patch(
    '/properties/:id',
    validateParams(idParam('id')),
    jsonObjectBody({ requireFields: true }),
    validate(updatePropertyValidators),
    async (req, res) => {
      const input = validated<PropertyInput>(req, 'body');
      res.json(await properties.update(intParam(req, 'id'), input));
    },
  );

  router.delete('/properties/:id', validateParams(idParam('id')), async (req, res) => {
    await properties.remove(intParam(req, 'id'));
    res.status(204).end();
  });

  return router;
}
