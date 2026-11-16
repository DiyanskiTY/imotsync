import { Router } from 'express';
import {
  idParam,
  intParam,
  jsonObjectBody,
  validate,
  validated,
  validateParams,
} from '../../lib/validation.js';
import type { JobsService } from './jobs.service.js';
import { listJobsValidators, type ListJobsQuery } from './jobs.validators.js';

/** The job log. Mounted behind requireAuth. */
export function createJobsRouter({ jobs }: { jobs: JobsService }): Router {
  const router = Router();

  router.get('/jobs', validate(listJobsValidators, { exact: ['query'] }), async (req, res) => {
    res.json(await jobs.list(validated<ListJobsQuery>(req, 'query')));
  });

  router.get('/jobs/:id', validateParams(idParam('id')), async (req, res) => {
    res.json({ data: await jobs.get(intParam(req, 'id')) });
  });

  // Takes no body; any field sent is rejected like an unknown field elsewhere.
  router.post(
    '/jobs/:id/retry',
    validateParams(idParam('id')),
    jsonObjectBody(),
    validate([]),
    async (req, res) => {
      res.status(202).json({ data: await jobs.retry(intParam(req, 'id')) });
    },
  );

  return router;
}
