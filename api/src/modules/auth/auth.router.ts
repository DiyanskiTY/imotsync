import { Router, type RequestHandler } from 'express';
import { jsonObjectBody, validate, validated } from '../../lib/validation.js';
import type { AuthService } from './auth.service.js';
import { loginValidators, type LoginBody } from './auth.validators.js';
import { currentUser } from './require-auth.js';

export interface AuthRouterDeps {
  auth: AuthService;
  requireAuth: RequestHandler;
  loginRateLimiter: RequestHandler;
}

/** POST /auth/login (public, rate limited) and GET /auth/me. */
export function createAuthRouter({ auth, requireAuth, loginRateLimiter }: AuthRouterDeps): Router {
  const router = Router();

  router.post(
    '/auth/login',
    loginRateLimiter,
    jsonObjectBody(),
    validate(loginValidators),
    async (req, res) => {
      const { email, password } = validated<LoginBody>(req, 'body');
      const result = await auth.login(email, password);
      res.set('Cache-Control', 'no-store').json(result);
    },
  );

  router.get('/auth/me', requireAuth, (req, res) => {
    res.json({ user: currentUser(req) });
  });

  return router;
}
