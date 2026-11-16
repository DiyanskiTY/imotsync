import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createGeoResolver, type GeoResolver } from '../../../../src/portals/realistimo/geo.js';
import type {
  AdapterContext,
  PortalListingInfo,
  PortalProperty,
} from '../../../../src/portals/types.js';

/** The committed subset only, whether or not api/data/realistimo_geo_db.csv exists locally. */
export const subsetGeo: GeoResolver = createGeoResolver({ csvPath: null });

/** A property every Realistimo rule accepts (Sofia / Lozenets, 3 rooms, 2 photos). */
export function makeProperty(overrides: Partial<PortalProperty> = {}): PortalProperty {
  return {
    id: 1,
    refCode: 'IS-00001',
    title: 'Тристаен апартамент в Лозенец',
    type: 'apartment',
    dealType: 'sale',
    city: 'Sofia',
    district: 'Lozenets',
    price: 245_000,
    currency: 'EUR',
    areaM2: 98,
    rooms: 3,
    floor: 4,
    totalFloors: 6,
    description: 'Светъл тристаен апартамент с гледка към Витоша.',
    status: 'active',
    broker: { id: 2, fullName: 'Demo Broker', email: 'broker@imotsync.local' },
    // 10:30:00 UTC is 12:30:00 in Sofia (EET, UTC+2) in January.
    updatedAt: new Date('2026-01-15T10:30:00Z'),
    images: [
      {
        url: 'http://localhost:3000/uploads/properties/1/b.jpg',
        width: 2048,
        height: 1536,
        sizeBytes: 300_000,
        sortOrder: 1,
      },
      {
        url: 'http://localhost:3000/uploads/properties/1/a.jpg',
        width: 2048,
        height: 1536,
        sizeBytes: 310_000,
        sortOrder: 0,
      },
    ],
    ...overrides,
  };
}

export function makeListing(overrides: Partial<PortalListingInfo> = {}): PortalListingInfo {
  return {
    id: 10,
    portal: 'realistimo',
    status: 'pending',
    externalId: null,
    publishedAt: null,
    payload: null,
    payloadUpdatedAt: null,
    ...overrides,
  };
}

export function makeContext(overrides: Partial<AdapterContext> = {}): AdapterContext {
  return {
    now: new Date('2026-01-15T11:00:00Z'),
    signal: new AbortController().signal,
    attempt: 1,
    ...overrides,
  };
}

export interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}

export type FakeHandler = (request: RecordedRequest, response: ServerResponse) => void;

export interface FakeServer {
  baseUrl: string;
  requests: RecordedRequest[];
  /** Replaces the handler for the next requests. */
  handle(handler: FakeHandler): void;
  close(): Promise<void>;
}

/** A local HTTP server on an ephemeral port that stands in for a remote API in tests. */
export async function startFakeServer(handler: FakeHandler): Promise<FakeServer> {
  let current = handler;
  const requests: RecordedRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const recorded: RecordedRequest = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      requests.push(recorded);
      current(recorded, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    handle(next) {
      current = next;
    },
    close() {
      server.closeAllConnections();
      return new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

export function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}
