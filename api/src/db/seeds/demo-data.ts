import type {
  DealType,
  JobAction,
  JobStatus,
  Portal,
  PortalListingStatus,
  PropertyStatus,
  PropertyType,
  UserRole,
} from '../types.js';

/*
 * Demo data. Every property, price, reference and portal id below is made up.
 * Titles and descriptions are in Bulgarian, as an agency would write them for
 * Bulgarian portals (and to exercise utf8mb4 storage).
 *
 * Times are relative to the moment the seed runs ("minutes ago"), so a nightly
 * reset of the demo always shows recent activity.
 */

const HOUR = 60;
const DAY = 24 * HOUR;

/** Appended to every description so nobody mistakes a demo listing for a real one. */
const DEMO_NOTE = 'Демонстрационна обява с измислени данни.';

export interface DemoUser {
  id: number;
  email: string;
  fullName: string;
  role: UserRole;
}

export interface DemoJob {
  action: JobAction;
  status: JobStatus;
  attempts: number;
  maxAttempts?: number;
  /** Minutes before the seed time when the job was created. */
  createdAgo: number;
  /** Minutes from the seed time until the job may run; negative is in the past. */
  runAfterIn?: number;
  /** Minutes before the seed time when a worker claimed the job (running jobs only). */
  lockedAgo?: number;
  /** The worker holding the job (running jobs only). */
  lockedBy?: string;
  /** Minutes before the seed time when the job finished. */
  finishedAgo?: number;
  result?: Record<string, unknown>;
  lastError?: string;
}

export interface DemoListing {
  portal: Portal;
  status: PortalListingStatus;
  createdAgo: number;
  externalId?: string;
  publishedAgo?: number;
  lastError?: string;
  jobs?: DemoJob[];
}

export interface DemoProperty {
  title: string | null;
  type: PropertyType;
  dealType: DealType;
  city: string;
  district: string | null;
  /** EUR. For rentals: per month. */
  price: number | null;
  areaM2: number | null;
  rooms: number | null;
  floor: number | null;
  totalFloors: number | null;
  description: string | null;
  status: PropertyStatus;
  createdBy: number;
  createdAgo: number;
  photoCount: number;
  listings: DemoListing[];
}

export const DEMO_USERS: readonly DemoUser[] = [
  { id: 1, email: 'admin@imotsync.local', fullName: 'Demo Admin', role: 'admin' },
  { id: 2, email: 'broker@imotsync.local', fullName: 'Demo Broker', role: 'broker' },
];

const ADMIN = 1;
const BROKER = 2;

/*
 * The job history below uses the words the adapters use (src/portals/<key>/), so the job
 * log of the demo reads like one the worker wrote. Feed portals (Realistimo, Bazar) assign
 * no id of their own: they recognise a listing by its reference code. Only the demo portal
 * returns an external id ("demo-" + the property id, six digits).
 */

/** The message a successful job leaves in jobs.result. */
function successMessage(portal: Portal, action: JobAction, externalId?: string): string {
  switch (portal) {
    case 'realistimo':
      return {
        publish: 'Added to the Realistimo feed (next import picks it up)',
        update: 'Updated in the Realistimo feed (next import picks it up)',
        remove: 'Removed from the Realistimo feed (next import takes the offer down)',
      }[action];
    case 'bazar':
      return {
        publish: 'Added to the Bazar feed (Bazar picks it up on its next scheduled download)',
        update: 'Updated in the Bazar feed (Bazar applies it on its next scheduled download)',
        remove:
          'Marked out of stock in the Bazar feed (Bazar archives the listing on its next scheduled download)',
      }[action];
    case 'demo': {
      const id = externalId ?? 'the listing';
      return {
        publish: `Published on the demo portal as ${id} (simulated)`,
        update: `Updated ${id} on the demo portal (simulated)`,
        remove: `Removed ${id} from the demo portal (simulated)`,
      }[action];
    }
  }
}

/** A job that succeeded; `attempts` > 1 when earlier attempts failed and were retried. */
function succeeded(
  portal: Portal,
  action: JobAction,
  createdAgo: number,
  options: { externalId?: string; attempts?: number; tookMinutes?: number } = {},
): DemoJob {
  const { externalId, attempts = 1, tookMinutes = 2 } = options;
  return {
    action,
    status: 'succeeded',
    attempts,
    createdAgo,
    finishedAgo: createdAgo - tookMinutes,
    result: {
      message: successMessage(portal, action, externalId),
      ...(externalId === undefined ? {} : { externalId }),
    },
  };
}

/**
 * A listing that is live on a portal, with the job that published it. `externalId` only
 * for the demo portal.
 */
function live(portal: Portal, createdAgo: number, externalId?: string): DemoListing {
  return {
    portal,
    status: 'published',
    createdAgo,
    ...(externalId === undefined ? {} : { externalId }),
    publishedAgo: createdAgo - 2,
    jobs: [succeeded(portal, 'publish', createdAgo, { externalId })],
  };
}

/** What the demo portal answers when it is "down" (src/portals/demo/demo-adapter.ts). */
const DEMO_OUTAGE = 'The demo portal answered HTTP 503 Service Unavailable (simulated outage)';
const DEMO_RATE_LIMITED =
  'The demo portal answered HTTP 429 Too Many Requests (simulated); it asks to retry after 5 s';
const DEMO_REJECTED =
  'The demo portal rejected the listing: the listing text failed its automatic content check (HTTP 422, simulated)';
/** What the worker records when validate() fails (src/jobs/failure.ts, Bazar's rules). */
const BAZAR_CONTACT_REJECTED =
  'Validation failed: description: Bazar does not allow e-mail addresses in the description (found "office@agency.example").';

export const DEMO_PROPERTIES: readonly DemoProperty[] = [
  {
    // IS-00001: on all three portals; the price was changed later (update job).
    title: 'Тристаен апартамент в Лозенец с гледка към Витоша',
    type: 'apartment',
    dealType: 'sale',
    city: 'Sofia',
    district: 'Lozenets',
    price: 245_000,
    areaM2: 98,
    rooms: 3,
    floor: 4,
    totalFloors: 6,
    description:
      'Светъл тристаен апартамент на четвърти етаж в нова сграда с асансьор. Две спални, ' +
      'просторна дневна с кухненски бокс и две тераси с гледка към Витоша. Подземно паркомясто ' +
      `срещу доплащане. ${DEMO_NOTE}`,
    status: 'active',
    createdBy: ADMIN,
    createdAgo: 25 * DAY,
    photoCount: 4,
    listings: [
      {
        ...live('realistimo', 24 * DAY),
        jobs: [
          succeeded('realistimo', 'publish', 24 * DAY),
          succeeded('realistimo', 'update', 3 * DAY, { tookMinutes: 1 }),
        ],
      },
      live('bazar', 24 * DAY),
      {
        ...live('demo', 24 * DAY, 'demo-000001'),
        // Published on the second attempt, after a simulated outage.
        jobs: [
          succeeded('demo', 'publish', 24 * DAY, {
            externalId: 'demo-000001',
            attempts: 2,
            tookMinutes: 3,
          }),
        ],
      },
    ],
  },
  {
    // IS-00002: queued for Bazar, failed for good on the demo portal.
    title: 'Двустаен апартамент под наем до метростанция в Младост 1',
    type: 'apartment',
    dealType: 'rent',
    city: 'Sofia',
    district: 'Mladost 1',
    price: 750,
    areaM2: 65,
    rooms: 2,
    floor: 7,
    totalFloors: 12,
    description:
      'Обзаведен двустаен апартамент на седми етаж, на пет минути пеша от метростанцията. ' +
      `Консумативите са за сметка на наемателя, депозитът е един месечен наем. ${DEMO_NOTE}`,
    status: 'active',
    createdBy: BROKER,
    createdAgo: 22 * DAY,
    photoCount: 3,
    listings: [
      live('realistimo', 21 * DAY),
      {
        portal: 'bazar',
        status: 'pending',
        createdAgo: 2,
        jobs: [{ action: 'publish', status: 'queued', attempts: 0, createdAgo: 2 }],
      },
      {
        portal: 'demo',
        status: 'error',
        createdAgo: 21 * DAY,
        lastError: `Gave up after 5 attempts: ${DEMO_OUTAGE}`,
        jobs: [
          {
            action: 'publish',
            status: 'failed',
            attempts: 5,
            createdAgo: 21 * DAY,
            finishedAgo: 21 * DAY - 2 * HOUR,
            result: {
              error: DEMO_OUTAGE,
              retryable: true,
              httpStatus: 503,
              code: 'DEMO_UNAVAILABLE',
            },
            lastError: DEMO_OUTAGE,
          },
        ],
      },
    ],
  },
  {
    // IS-00003: office for rent, live on two portals; a worker is publishing it to the
    // demo portal right now (running job holding a lock).
    title: 'Офис в центъра на София за до 12 работни места',
    type: 'office',
    dealType: 'rent',
    city: 'Sofia',
    district: 'Center',
    price: 2_100,
    areaM2: 140,
    rooms: 4,
    floor: 2,
    totalFloors: 5,
    description:
      'Офис с четири помещения на втори етаж в реновирана сграда. Климатизация, оптичен ' +
      `интернет и рецепция на партера. ${DEMO_NOTE}`,
    status: 'active',
    createdBy: ADMIN,
    createdAgo: 21 * DAY,
    photoCount: 3,
    listings: [
      live('realistimo', 20 * DAY),
      live('bazar', 20 * DAY),
      {
        portal: 'demo',
        status: 'pending',
        createdAgo: 4,
        jobs: [
          {
            action: 'publish',
            status: 'running',
            attempts: 1,
            createdAgo: 4,
            lockedAgo: 3,
            lockedBy: 'demo-worker-1',
          },
        ],
      },
    ],
  },
  {
    // IS-00004: live on Realistimo; the demo portal publish job failed four times with
    // temporary errors and waits for its fifth and last attempt (retry back-off).
    title: 'Двуетажна къща с двор в Остромила',
    type: 'house',
    dealType: 'sale',
    city: 'Plovdiv',
    district: 'Ostromila',
    price: 289_000,
    areaM2: 180,
    rooms: 5,
    floor: null,
    totalFloors: 2,
    description:
      'Къща с разгъната застроена площ 180 кв.м и двор от 600 кв.м в тих квартал в южната част ' +
      `на Пловдив. Три спални, две бани, камина и гараж. ${DEMO_NOTE}`,
    status: 'active',
    createdBy: BROKER,
    createdAgo: 18 * DAY,
    photoCount: 5,
    listings: [
      live('realistimo', 17 * DAY),
      {
        portal: 'demo',
        status: 'pending',
        createdAgo: 6,
        jobs: [
          {
            action: 'publish',
            status: 'queued',
            attempts: 4,
            createdAgo: 6,
            runAfterIn: 3,
            result: {
              error: DEMO_RATE_LIMITED,
              retryable: true,
              httpStatus: 429,
              code: 'DEMO_RATE_LIMITED',
              retryInSeconds: 200,
            },
            lastError: DEMO_RATE_LIMITED,
          },
        ],
      },
    ],
  },
  {
    // IS-00005: rejected by the demo portal's validation (not retried).
    title: 'Двустаен апартамент в Капана след основен ремонт',
    type: 'apartment',
    dealType: 'sale',
    city: 'Plovdiv',
    district: 'Kapana',
    price: 119_000,
    areaM2: 58,
    rooms: 2,
    floor: 3,
    totalFloors: 4,
    description:
      'Апартамент на трети етаж в сграда в квартал Капана. Изцяло ремонтиран през 2025 г., ' +
      `с ново обзавеждане в кухнята и банята. ${DEMO_NOTE}`,
    status: 'active',
    createdBy: BROKER,
    createdAgo: 16 * DAY,
    photoCount: 3,
    listings: [
      live('bazar', 15 * DAY),
      {
        portal: 'demo',
        status: 'error',
        createdAgo: 15 * DAY,
        lastError: DEMO_REJECTED,
        jobs: [
          {
            action: 'publish',
            status: 'failed',
            attempts: 1,
            createdAgo: 15 * DAY,
            finishedAgo: 15 * DAY - 1,
            result: {
              error: DEMO_REJECTED,
              retryable: false,
              httpStatus: 422,
              code: 'DEMO_REJECTED',
            },
            lastError: DEMO_REJECTED,
          },
        ],
      },
    ],
  },
  {
    // IS-00006: incomplete draft (no description), portals selected but not published.
    title: 'Магазин под наем на главна търговска улица в Пловдив',
    type: 'shop',
    dealType: 'rent',
    city: 'Plovdiv',
    district: 'Center',
    price: 900,
    areaM2: 45,
    rooms: 1,
    floor: 0,
    totalFloors: 4,
    description: null,
    status: 'draft',
    createdBy: BROKER,
    createdAgo: 2 * DAY,
    photoCount: 2,
    listings: [
      { portal: 'realistimo', status: 'draft', createdAgo: 2 * DAY },
      { portal: 'bazar', status: 'draft', createdAgo: 2 * DAY },
    ],
  },
  {
    // IS-00007: the Bazar publish job failed for good: when it ran, the description gave an
    // e-mail address, which Bazar's terms forbid (never retried). The text has been fixed
    // since; publishing again would go through.
    title: 'Тристаен апартамент в Чайка с морска панорама',
    type: 'apartment',
    dealType: 'sale',
    city: 'Varna',
    district: 'Chaika',
    price: 189_000,
    areaM2: 85,
    rooms: 3,
    floor: 5,
    totalFloors: 8,
    description:
      'Тристаен апартамент на пети етаж с гледка към морето, на десет минути пеша от плажа. ' +
      `Южно изложение, газово отопление, обзаведен. ${DEMO_NOTE}`,
    status: 'active',
    createdBy: BROKER,
    createdAgo: 14 * DAY,
    photoCount: 4,
    listings: [
      live('realistimo', 13 * DAY),
      {
        portal: 'bazar',
        status: 'error',
        createdAgo: 13 * DAY,
        lastError: BAZAR_CONTACT_REJECTED,
        jobs: [
          {
            action: 'publish',
            status: 'failed',
            attempts: 1,
            createdAgo: 13 * DAY,
            finishedAgo: 13 * DAY - 1,
            result: { error: BAZAR_CONTACT_REJECTED, retryable: false, code: 'VALIDATION' },
            lastError: BAZAR_CONTACT_REJECTED,
          },
        ],
      },
      live('demo', 13 * DAY, 'demo-000007'),
    ],
  },
  {
    // IS-00008: archived (rented out) and removed from the portals.
    title: 'Обзаведено студио под наем в кв. Левски',
    type: 'apartment',
    dealType: 'rent',
    city: 'Varna',
    district: 'Levski',
    price: 450,
    areaM2: 38,
    rooms: 1,
    floor: 2,
    totalFloors: 6,
    description:
      'Уютно студио с кухненски бокс и тераса, подходящо за един човек или двойка. Близо до ' +
      `спирки на градския транспорт. ${DEMO_NOTE}`,
    status: 'archived',
    createdBy: BROKER,
    createdAgo: 70 * DAY,
    photoCount: 2,
    listings: (['realistimo', 'bazar'] as const).map((portal): DemoListing => ({
      portal,
      status: 'removed',
      createdAgo: 69 * DAY,
      publishedAgo: 69 * DAY - 2,
      jobs: [
        succeeded(portal, 'publish', 69 * DAY),
        succeeded(portal, 'remove', 5 * DAY, { tookMinutes: 1 }),
      ],
    })),
  },
  {
    // IS-00009: incomplete draft (no price, no photos).
    title: 'Парцел във Виница с панорамна гледка към морето',
    type: 'land',
    dealType: 'sale',
    city: 'Varna',
    district: 'Vinitsa',
    price: null,
    areaM2: 1_200,
    rooms: null,
    floor: null,
    totalFloors: null,
    description:
      'Равен парцел с лице към асфалтов път, ток и вода на границата на имота. Цена при ' +
      `запитване. ${DEMO_NOTE}`,
    status: 'draft',
    createdBy: BROKER,
    createdAgo: DAY,
    photoCount: 0,
    listings: [{ portal: 'demo', status: 'draft', createdAgo: DAY }],
  },
  {
    // IS-00010: demo portal publish scheduled for later.
    title: 'Двустаен апартамент в Лазур, на 5 минути от плажа',
    type: 'apartment',
    dealType: 'sale',
    city: 'Burgas',
    district: 'Lazur',
    price: 132_000,
    areaM2: 67,
    rooms: 2,
    floor: 6,
    totalFloors: 9,
    description:
      'Двустаен апартамент на шести етаж в сграда с асансьор, напълно обзаведен. Подходящ за ' +
      `живеене или за отдаване под наем през лятото. ${DEMO_NOTE}`,
    status: 'active',
    createdBy: ADMIN,
    createdAgo: 10 * DAY,
    photoCount: 3,
    listings: [
      live('realistimo', 9 * DAY),
      live('bazar', 9 * DAY),
      {
        portal: 'demo',
        status: 'pending',
        createdAgo: 5,
        jobs: [{ action: 'publish', status: 'queued', attempts: 0, createdAgo: 5, runAfterIn: 30 }],
      },
    ],
  },
  {
    // IS-00011: barely started draft (no title, description or photos).
    title: null,
    type: 'garage',
    dealType: 'sale',
    city: 'Burgas',
    district: 'Meden Rudnik',
    price: 15_500,
    areaM2: 18,
    rooms: null,
    floor: -1,
    totalFloors: null,
    description: null,
    status: 'draft',
    createdBy: BROKER,
    createdAgo: 3 * HOUR,
    photoCount: 0,
    listings: [],
  },
  {
    // IS-00012: mountain town; Realistimo job ready to run.
    title: 'Двустаен апартамент в Банско на 400 м от кабинковия лифт',
    type: 'apartment',
    dealType: 'sale',
    city: 'Bansko',
    district: null,
    price: 89_000,
    areaM2: 72,
    rooms: 2,
    floor: 3,
    totalFloors: 5,
    description:
      'Апартамент в затворен комплекс с рецепция, спа зона и ски гардероб. Таксата за ' +
      `поддръжка е 12 евро на кв.м годишно. ${DEMO_NOTE}`,
    status: 'active',
    createdBy: ADMIN,
    createdAgo: 6 * DAY,
    photoCount: 4,
    listings: [
      {
        portal: 'realistimo',
        status: 'pending',
        createdAgo: 1,
        jobs: [{ action: 'publish', status: 'queued', attempts: 0, createdAgo: 1 }],
      },
      live('demo', 5 * DAY, 'demo-000012'),
    ],
  },
];

/** "IS-00001" for id 1. */
export const refCodeFor = (id: number) => `IS-${String(id).padStart(5, '0')}`;
