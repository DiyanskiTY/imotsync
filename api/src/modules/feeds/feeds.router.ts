import { Router, type Response } from 'express';
import { isNotModified, type FeedsService } from './feeds.service.js';

/** Mount path of the feeds, outside /api: GET /feeds/<portal>/<FEED_TOKEN>.xml. */
export const FEEDS_PATH = '/feeds';

/**
 * The same plain-text 404 for an unknown portal, a push portal, a wrong token and any other
 * path under /feeds, so a caller cannot tell which part of a guessed URL was wrong.
 */
function feedNotFound(res: Response): void {
  res.status(404).type('text/plain; charset=utf-8').send('Not Found');
}

/**
 * Public feed endpoints for the feed portals (no login: portals download the feed without
 * credentials, so the secret FEED_TOKEN in the path protects it). Mounted at /feeds.
 */
export function createFeedsRouter(deps: { feeds: FeedsService }): Router {
  const { feeds } = deps;
  const router = Router();

  router.get('/:portal/:token.xml', async (req, res) => {
    const portal = String(req.params.portal);
    const renderer = feeds.rendererFor(portal, String(req.params.token));
    if (!renderer) {
      feedNotFound(res);
      return;
    }

    const feed = await feeds.render(portal, renderer);
    // Portals may keep a copy, but must ask (conditionally) before using it again.
    res.set('Cache-Control', 'no-cache');
    res.set('ETag', feed.etag);
    if (feed.lastModified) res.set('Last-Modified', feed.lastModified.toUTCString());
    const conditions = {
      ifNoneMatch: req.get('If-None-Match'),
      ifModifiedSince: req.get('If-Modified-Since'),
    };
    if (isNotModified(conditions, feed)) {
      res.status(304).end();
      return;
    }
    res.status(200).type(feed.contentType).send(feed.body);
  });

  router.use((_req, res) => {
    feedNotFound(res);
  });

  return router;
}
