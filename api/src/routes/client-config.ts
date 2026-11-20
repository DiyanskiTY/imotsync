import { Router } from 'express';
import type { UploadLimits } from '../modules/images/image-processing.js';

/** Body of GET /api/client-config: what the admin panel adapts to before anyone signs in. */
export interface ClientConfigResponse {
  /** The public demo: show the banner and the "Try the demo" button. */
  demoMode: boolean;
  /** This deployment's photo upload limits, for the checks before an upload. */
  uploadLimits: UploadLimits;
}

/** GET /client-config (public): one static admin panel build serves every deployment. */
export function createClientConfigRouter(config: ClientConfigResponse): Router {
  const body: ClientConfigResponse = {
    demoMode: config.demoMode,
    uploadLimits: { ...config.uploadLimits },
  };
  const router = Router();
  router.get('/client-config', (_req, res) => {
    res.json(body);
  });
  return router;
}
