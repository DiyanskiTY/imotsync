import { Router } from 'express';
import type { Knex } from 'knex';
import { withTimeout } from '../lib/with-timeout.js';
import { APP_VERSION } from '../version.js';

export interface HealthResponse {
  status: 'ok' | 'degraded';
  db: 'up' | 'down';
  version: string;
  uptimeSeconds: number;
}

export interface HealthRouterOptions {
  db: Knex;
  /** Upper bound for the database check, so a dead database can never hang the request. */
  timeoutMs: number;
}

/** GET /health: 200 when the database answers, 503 when it does not (or is too slow). */
export function createHealthRouter({ db, timeoutMs }: HealthRouterOptions): Router {
  const router = Router();

  router.get('/health', async (req, res) => {
    let dbUp = true;
    try {
      await withTimeout(db.raw('SELECT 1'), timeoutMs, 'Database health check');
    } catch (error) {
      dbUp = false;
      req.log.warn({ err: error }, 'Database health check failed');
    }

    const body: HealthResponse = {
      status: dbUp ? 'ok' : 'degraded',
      db: dbUp ? 'up' : 'down',
      version: APP_VERSION,
      uptimeSeconds: Math.floor(process.uptime()),
    };
    res
      .status(dbUp ? 200 : 503)
      .set('Cache-Control', 'no-store')
      .json(body);
  });

  return router;
}
