import { Router, type RequestHandler } from 'express';
import { DEMO_ACCOUNT_EMAIL } from '../../db/seeds/demo-data.js';
import { notFound } from '../../lib/http-error.js';
import type { LoginResponse } from '../auth/auth.mappers.js';
import type { UserRepository } from '../auth/auth.repository.js';
import { issueSession } from '../auth/auth.service.js';
import type { TokenService } from '../auth/tokens.js';

/** Signs in the shared demo account; nothing else. */
export type DemoSessionIssuer = () => Promise<LoginResponse>;

/**
 * The public demo's sign-in without a password, for the seeded demo broker only: it can never
 * sign anyone in as the admin. Fails with a plain Error (500) while the demo data is not loaded.
 */
export function createDemoSessionIssuer(deps: {
  users: UserRepository;
  tokens: TokenService;
}): DemoSessionIssuer {
  return async () => {
    const user = await deps.users.findByEmail(DEMO_ACCOUNT_EMAIL);
    if (user?.role !== 'broker') {
      throw new Error(
        `The demo account ${DEMO_ACCOUNT_EMAIL} is missing or not a broker; load the demo data (deploy/demo-reset.sh)`,
      );
    }
    return issueSession(deps.tokens, user);
  };
}

/**
 * POST /auth/demo, public. With no demo (null) it answers 404 like any unknown route: the route
 * is documented for every deployment, and works on the public demo only.
 */
export function createDemoLoginRouter(
  demo: { issue: DemoSessionIssuer; guard: RequestHandler } | null,
): Router {
  const router = Router();
  if (!demo) {
    router.post('/auth/demo', () => {
      throw notFound('This deployment is not the public demo');
    });
    return router;
  }
  router.post('/auth/demo', demo.guard, async (_req, res) => {
    res.set('Cache-Control', 'no-store').json(await demo.issue());
  });
  return router;
}
