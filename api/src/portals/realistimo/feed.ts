import { XMLBuilder } from 'fast-xml-parser';
import type { FeedItem, FeedPayload, FeedRenderer } from '../types.js';
import { REALISTIMO_OFFER_FIELDS, type RealistimoBroker } from './offer.js';
import { formatSofiaDateTime, formatSofiaStartOfDay, sofiaStartOfDay } from './time.js';

/*
 * The Realistimo import feed: one full snapshot of the agency's live offers, in the layout
 * of Realistimo's XML documentation:
 *
 *   <feed>
 *     <updated>, <agency_uid>
 *     <Brokers> one <Broker> (BrokerID, BrokerName, BrokerEmail) per agent of the offers
 *     <offers>  one <offer> per published listing
 *
 * Realistimo skips the whole import when <updated> has not changed since its last successful
 * sync, and stops processing a feed whose <updated> is older than 30 days.
 */

export const REALISTIMO_FEED_CONTENT_TYPE = 'application/xml; charset=utf-8';

const DAY_MS = 24 * 60 * 60 * 1000;

/** <updated> never lags more than this behind the current day (Realistimo's limit is 30 days). */
export const FEED_UPDATED_MAX_AGE_MS = 7 * DAY_MS;

export interface RealistimoFeedRendererOptions {
  /** The agency's source id in Realistimo (<agency_uid>). */
  agencyUid: string;
}

/*
 * Characters XML 1.0 does not allow (C0 controls other than tab, line feed and carriage
 * return; U+FFFE, U+FFFF; unpaired surrogates). Escaping cannot represent them, so they are
 * dropped.
 */
// eslint-disable-next-line no-control-regex
const XML_INVALID = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

function xmlText(value: unknown): string | null {
  let text: string;
  if (typeof value === 'string') text = value;
  else if (typeof value === 'number' && Number.isFinite(value)) text = String(value);
  else return null;
  text = text.replace(XML_INVALID, '').replace(LONE_SURROGATE, '');
  return text.trim() === '' ? null : text;
}

/**
 * The feed's <updated>: the newest payloadUpdatedAt of all items, or ctx.lastChangedAt when
 * later (a removal leaves no item behind: its payload becomes null, but its date is
 * recorded), in Bulgarian time. When that is more than 7 days old, or there are no items,
 * the start of the current day is used instead, so the feed never falls behind Realistimo's
 * 30-day limit.
 *
 * `lastChangedAt` is a change the items cannot show, such as a listing whose row was deleted
 * with its property after the removal: without it <updated> could fall back to an earlier
 * value and Realistimo would skip the import that takes the offer down.
 */
export function realistimoFeedUpdated(
  items: readonly FeedItem[],
  now: Date,
  lastChangedAt: Date | null = null,
): string {
  const newest = newestChange(items, lastChangedAt);
  if (newest === null || isTooOld(newest, now)) return formatSofiaStartOfDay(now);
  return formatSofiaDateTime(newest);
}

function newestChange(items: readonly FeedItem[], lastChangedAt: Date | null): Date | null {
  let newest: Date | null = lastChangedAt;
  for (const item of items) {
    if (newest === null || item.payloadUpdatedAt.getTime() > newest.getTime()) {
      newest = item.payloadUpdatedAt;
    }
  }
  return newest;
}

const isTooOld = (newest: Date, now: Date) =>
  now.getTime() - newest.getTime() > FEED_UPDATED_MAX_AGE_MS;

/**
 * When the rendered feed last changed (Last-Modified): the newest change, or, once <updated>
 * has switched to the start of the current day, the moment it last switched (7 days after
 * the newest change, then every midnight in Bulgarian time).
 */
export function realistimoFeedLastModified(
  items: readonly FeedItem[],
  now: Date,
  lastChangedAt: Date | null = null,
): Date {
  const newest = newestChange(items, lastChangedAt);
  const startOfDay = sofiaStartOfDay(now);
  if (newest === null) return startOfDay;
  if (!isTooOld(newest, now)) return newest;
  const switchedAt = newest.getTime() + FEED_UPDATED_MAX_AGE_MS;
  return new Date(Math.max(switchedAt, startOfDay.getTime()));
}

type XmlOffer = Record<string, string>;

/** Code-unit order: the same on every machine, unlike localeCompare. */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The offer's elements in the documented order, skipping empty and unknown values. */
function offerElements(payload: FeedPayload, refCode: string): XmlOffer {
  const offer: XmlOffer = {};
  for (const field of REALISTIMO_OFFER_FIELDS) {
    const text = xmlText(payload[field]) ?? (field === 'offer_uid' ? xmlText(refCode) : null);
    if (text !== null) offer[field] = text;
  }
  return offer;
}

function brokerOf(payload: FeedPayload): RealistimoBroker | null {
  const raw = payload.broker;
  if (raw === null || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const id = xmlText(record.BrokerID);
  if (id === null) return null;
  const name = xmlText(record.BrokerName) ?? id;
  const email = xmlText(record.BrokerEmail);
  return { BrokerID: id, BrokerName: name, ...(email === null ? {} : { BrokerEmail: email }) };
}

export function createRealistimoFeedRenderer(options: RealistimoFeedRendererOptions): FeedRenderer {
  const builder = new XMLBuilder({ format: true, indentBy: '  ', processEntities: true });

  return {
    contentType: REALISTIMO_FEED_CONTENT_TYPE,

    render(items, ctx) {
      const live = items
        .filter((item) => item.status === 'published')
        .map((item) => ({ item, offer: offerElements(item.payload, item.refCode) }))
        .sort((a, b) => compareText(a.offer.offer_uid ?? '', b.offer.offer_uid ?? ''));

      // One <Broker> per agent; if an agent's details differ between offers, the most
      // recently stored payload wins.
      const brokers = new Map<string, { broker: RealistimoBroker; at: number }>();
      for (const { item } of live) {
        const broker = brokerOf(item.payload);
        if (broker === null) continue;
        const at = item.payloadUpdatedAt.getTime();
        const known = brokers.get(broker.BrokerID);
        if (known === undefined || at > known.at) brokers.set(broker.BrokerID, { broker, at });
      }
      const brokerList = [...brokers.values()]
        .map(({ broker }) => broker)
        .sort((a, b) => compareText(a.BrokerID, b.BrokerID));

      const document = {
        feed: {
          updated: realistimoFeedUpdated(items, ctx.now, ctx.lastChangedAt ?? null),
          agency_uid: xmlText(options.agencyUid) ?? '',
          Brokers: { Broker: brokerList },
          offers: { offer: live.map(({ offer }) => offer) },
        },
      };
      return `<?xml version="1.0" encoding="UTF-8"?>\n${builder.build(document)}`;
    },

    lastModified(items, ctx) {
      return realistimoFeedLastModified(items, ctx.now, ctx.lastChangedAt ?? null);
    },
  };
}
