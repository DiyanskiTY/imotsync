import { XMLBuilder } from 'fast-xml-parser';
import type { FeedItem, FeedRenderContext, FeedRenderer } from '../types.js';
import { readBazarPayload, type BazarItemPayload } from './payload.js';
import { xmlSafe } from './text.js';

/** Namespace of the Google Merchant elements (g:id, g:price, ...). */
export const GOOGLE_MERCHANT_NAMESPACE = 'http://base.google.com/ns/1.0';

export const BAZAR_FEED_CONTENT_TYPE = 'application/xml; charset=utf-8';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface BazarFeedRendererOptions {
  /** PUBLIC_BASE_URL; the channel <link>. The render context's publicBaseUrl wins if set. */
  publicBaseUrl: string;
  /**
   * BAZAR_REMOVED_RETENTION_DAYS: how long a removed listing stays in the feed as
   * out_of_stock. Bazar archives an out-of-stock item, but stops the whole import when
   * the feed suddenly shrinks by more than 30%, so removed items are phased out slowly
   * instead of vanishing at once.
   */
  removedRetentionDays: number;
}

const builder = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  format: true,
  indentBy: '  ',
  suppressEmptyNode: true,
});

/** RFC 822 date for RSS, e.g. 'Mon, 16 Nov 2026 08:30:00 GMT'. */
const rssDate = (date: Date) => date.toUTCString();

/** One <item>, children in the Google Merchant order; null values are left out. */
function itemElement(payload: BazarItemPayload, removed: boolean): Record<string, unknown> {
  const element: Record<string, string | string[]> = {};
  const add = (name: string, value: string | readonly string[] | null) => {
    if (value === null || value.length === 0) return;
    element[name] = typeof value === 'string' ? xmlSafe(value) : value.map(xmlSafe);
  };

  add('g:id', payload.id);
  add('title', payload.title);
  add('description', payload.description);
  add('link', payload.link);
  add('g:image_link', payload.imageLink);
  add('g:additional_image_link', payload.additionalImageLinks);
  add('g:price', payload.price);
  // The listing's status decides, so a stale payload can never revive a removed listing.
  add('g:availability', removed ? 'out_of_stock' : 'in_stock');
  add('g:product_type', payload.productType);
  add('g:custom_label_0', payload.customLabel0);
  add('g:custom_label_1', payload.customLabel1);
  add('g:custom_label_2', payload.customLabel2);
  add('g:custom_label_3', payload.customLabel3);
  return element;
}

/**
 * Renders the Bazar feed: Google Merchant RSS 2.0 with one <item> per listing.
 *
 * Served: every 'published' item (in_stock), and 'removed' items (out_of_stock) whose
 * payload changed within the last `removedRetentionDays` days. Items whose payload is not
 * a Bazar item are skipped. Items are sorted by g:id, so the same listings always give
 * byte-identical output (stable ETag).
 */
export function createBazarFeedRenderer(options: BazarFeedRendererOptions): FeedRenderer {
  const { removedRetentionDays } = options;
  if (!Number.isFinite(removedRetentionDays) || removedRetentionDays < 0) {
    throw new RangeError('removedRetentionDays must be a number of days, 0 or more');
  }

  return {
    contentType: BAZAR_FEED_CONTENT_TYPE,

    render(items: FeedItem[], ctx: FeedRenderContext): string {
      const keepRemovedSince = ctx.now.getTime() - removedRetentionDays * DAY_MS;
      const served = items
        .filter(
          (item) =>
            item.status === 'published' ||
            (item.status === 'removed' && item.payloadUpdatedAt.getTime() >= keepRemovedSince),
        )
        .flatMap((item) => {
          const payload = readBazarPayload(item.payload);
          return payload ? [{ item, payload }] : [];
        })
        .sort((a, b) => (a.payload.id < b.payload.id ? -1 : a.payload.id > b.payload.id ? 1 : 0));

      const baseUrl = (ctx.publicBaseUrl || options.publicBaseUrl).replace(/\/+$/, '');
      const newest = served.reduce<Date | null>(
        (latest, { item }) =>
          latest === null || item.payloadUpdatedAt > latest ? item.payloadUpdatedAt : latest,
        null,
      );

      const channel: Record<string, unknown> = {
        title: 'ImotSync – обяви за имоти',
        link: xmlSafe(baseUrl),
        description: 'Real estate listings published through ImotSync (Google Merchant feed).',
      };
      if (newest) channel.lastBuildDate = rssDate(newest);
      channel.item = served.map(({ item, payload }) =>
        itemElement(payload, item.status === 'removed'),
      );

      return builder.build({
        '?xml': { '@_version': '1.0', '@_encoding': 'UTF-8' },
        rss: {
          '@_version': '2.0',
          '@_xmlns:g': GOOGLE_MERCHANT_NAMESPACE,
          channel,
        },
      });
    },

    /**
     * The newest change: a stored payload, ctx.lastChangedAt, or a removed item dropping out of
     * the feed when its retention period ended (which happens at any time of day).
     */
    lastModified(items: FeedItem[], ctx: FeedRenderContext): Date | null {
      const retentionMs = removedRetentionDays * DAY_MS;
      let latest = ctx.lastChangedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
      for (const item of items) {
        latest = Math.max(latest, item.payloadUpdatedAt.getTime());
        const droppedAt = item.payloadUpdatedAt.getTime() + retentionMs;
        if (item.status === 'removed' && droppedAt < ctx.now.getTime()) {
          latest = Math.max(latest, droppedAt);
        }
      }
      return Number.isFinite(latest) ? new Date(latest) : null;
    },
  };
}
