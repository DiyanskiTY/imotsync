import { Router, type RequestHandler } from 'express';
import helmet from 'helmet';
import swaggerUi from 'swagger-ui-express';
import { notFound } from '../lib/http-error.js';
import { OPENAPI_JSON_PATH } from './document.js';
import type { OpenApiDocument } from './types.js';

/** GET /openapi.json (public). */
export function createOpenApiRouter(document: OpenApiDocument): Router {
  const router = Router();
  router.get('/openapi.json', (_req, res) => {
    res.set('Cache-Control', 'no-cache').json(document);
  });
  return router;
}

/** The only files of swagger-ui-dist the page needs (not its demo index.html and the like). */
const DOCS_ASSETS = new Set([
  '/swagger-ui.css',
  '/swagger-ui.css.map',
  '/swagger-ui-bundle.js',
  '/swagger-ui-bundle.js.map',
  '/swagger-ui-standalone-preset.js',
  '/swagger-ui-standalone-preset.js.map',
  '/swagger-ui-init.js',
  '/favicon-32x32.png',
  '/favicon-16x16.png',
]);

/**
 * Swagger UI, for app.use('/api/docs', ...). It loads the document from /api/openapi.json
 * (a fixed URL, so a ?url= link cannot make the page render someone else's document) and
 * keeps the token entered under "Authorize" across reloads (persistAuthorization).
 *
 * Helmet's default Content-Security-Policy already allows the page: its scripts and
 * styles are same-origin files, and its few inline styles are allowed by helmet's
 * style-src. The one change, for this path only, is dropping upgrade-insecure-requests,
 * which would otherwise break the page when the API is opened over plain HTTP on a
 * LAN address (testing from a phone, for example).
 */
export function createDocsHandlers(): RequestHandler[] {
  const options: swaggerUi.SwaggerUiOptions = {
    swaggerUrl: OPENAPI_JSON_PATH,
    customSiteTitle: 'ImotSync API docs',
    swaggerOptions: {
      persistAuthorization: true,
      displayRequestDuration: true,
      // No badge image from validator.swagger.io (the document is checked in the tests).
      validatorUrl: null,
    },
  };
  const html = swaggerUi.generateHTML(undefined, options);
  const assets = swaggerUi.serveFiles(undefined, options);

  const docsCsp = helmet.contentSecurityPolicy({
    useDefaults: true,
    directives: { upgradeInsecureRequests: null },
  });

  const page: RequestHandler = (req, res, next) => {
    if (req.path !== '/' || (req.method !== 'GET' && req.method !== 'HEAD')) {
      next();
      return;
    }
    // The page loads "./swagger-ui.css" and friends, so it must be served at /api/docs/.
    // The target is built from the mount path, never from the request target, which may
    // be in absolute form ("GET http://other.example/api/docs") and name another host.
    const [pathname = '', query] = req.originalUrl.split('?', 2);
    if (!pathname.endsWith('/')) {
      res.redirect(301, `${req.baseUrl}/${query === undefined ? '' : `?${query}`}`);
      return;
    }
    res.set('Cache-Control', 'no-cache').type('html').send(html);
  };

  const onlyKnownAssets: RequestHandler = (req, _res, next) => {
    next(
      DOCS_ASSETS.has(req.path) ? undefined : notFound(`No route matches GET ${req.originalUrl}`),
    );
  };

  return [docsCsp, page, onlyKnownAssets, ...assets];
}
