# ImotSync admin panel (`web/`)

Angular admin panel for ImotSync. Brokers sign in, enter a property once with its photos, see what
each portal still needs, publish it to Realistimo, Bazar.bg and the demo portal (one property or
many at once), follow its status on every portal and retry failed jobs. See the
[root README](../README.md) for the project overview and roadmap.

## Screens

| Route                                | What it does                                                                                                                                        |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/login`                             | Sign in; afterwards the user is back on the page they wanted. An expired session is explained                                                       |
| `/dashboard`                         | API and database status, and every portal with the feed URL to register in its import settings                                                      |
| `/properties`                        | Filters, sorting and paging (all kept in the URL), the status on every portal, bulk publish and bulk delete                                         |
| `/properties/new`, `/properties/:id` | The property form; photos (upload with progress, reorder by dragging or with buttons, delete); the pre-publish check per portal; publish and remove |
| `/jobs`                              | The job log with filters, the details of each attempt, and Retry for failed jobs                                                                    |

The property page and the job log refresh themselves every few seconds while the worker still has
a job in flight, so a listing visibly moves from pending to published or error.

## Stack

- Angular 21: standalone components, zoneless change detection, signals, built-in control flow
- PrimeNG 21 with the Aura theme (`@primeuix/themes`) and PrimeIcons 7
- Tailwind CSS 4 through PostCSS (`.postcssrc.json`), with `tailwindcss-primeui` for utilities
  that use the PrimeNG design tokens (`bg-primary`, `text-muted-color`, `border-surface`, ...)
- Vitest with jsdom for unit tests, ESLint with angular-eslint, Prettier (root `.prettierrc.json`)
- TypeScript 5.9. The API uses TypeScript 6.0, but the Angular 21 build tools (`@angular/build`)
  only support TypeScript `>=5.9 <6.0`. The admin panel moves to TypeScript 6 together with
  Angular 22.

## Getting started

Requires Node.js 24 (see the root `.nvmrc`).

```bash
npm ci
npm start
```

The dev server runs on <http://localhost:4200>. Requests to `/api` and `/uploads` are proxied to
the API on <http://localhost:3000> (`proxy.conf.json`), so the app always calls relative URLs and no
CORS setup is needed in development. Start the API first (`npm run dev` in `api/`, or
`docker compose up -d --build` in the repository root); without it the dashboard shows the API as
offline. Sign in with a [demo account](../README.md#demo-accounts).

The proxy target is fixed at port 3000, the default `API_PORT`. If you run the API on another port
(by changing `API_PORT` in the root `.env`), change both `target` values in `proxy.conf.json` to
match.

## Scripts

| Script                            | What it does                                                          |
| --------------------------------- | --------------------------------------------------------------------- |
| `npm start`                       | Dev server on port 4200 with the API proxy                            |
| `npm run build`                   | Production build into `dist/imotsync-web/browser`                     |
| `npm test`                        | Unit tests, single run in Node.js with jsdom (no browser needed)      |
| `npm run lint`                    | ESLint with the angular-eslint TypeScript and template a11y rules     |
| `npm run format` / `format:check` | Format with Prettier / check formatting                               |
| `npm run api:types`               | Regenerates `src/app/core/api/schema.d.ts` from `../api/openapi.json` |

## Talking to the API

The request and response types are not written by hand. `src/app/core/api/schema.d.ts` is
generated with [openapi-typescript](https://openapi-ts.dev/) from `api/openapi.json`, the committed
copy of the API's OpenAPI document, and `core/api/models.ts` gives the types short names. After an
API change:

1. run `npm run openapi:export` in `api/` (a unit test there fails until the copy is current),
2. run `npm run api:types` here (CI fails while `schema.d.ts` is stale).

A changed field then shows up as a type error wherever the admin panel uses it. The value lists
for filters (`PROPERTY_TYPES`, `JOB_STATUSES`, ...) are checked against the generated types as
well, so a new value in the API cannot be missing from a filter.

Every call goes through one data-access class per resource (`PropertiesApi`, `ImagesApi`,
`PublishingApi`, `JobsApi`, `PortalsApi`). `authInterceptor` adds the token, and every failure
becomes one `ApiError` shape (`toApiError`) with the API's `code`, `message` and `details`, which
the forms map onto their fields.

**Sign-in.** The token from `POST /api/auth/login` is kept in `localStorage` with its expiry, so
new tabs stay signed in for its lifetime (8 hours by default; there is no refresh token). The
session ends on sign-out, at expiry, and on any `401`, which sends the user to the login page and
back afterwards. [Authentication](../docs/architecture.md#authentication) explains why the API
uses a bearer token rather than a cookie.

## Structure

```text
src/app/
├── app.ts, app.config.ts, app.routes.ts   root component, providers, lazy-loaded routes
├── core/
│   ├── api/                               generated schema, models, one client per resource, ApiError
│   ├── auth/                              session, interceptor, route guards
│   ├── app-title-strategy.ts              "<page> | ImotSync" browser tab titles
│   ├── dev-hints.ts                       set-up hints shown in development builds only
│   ├── health/health-api.ts               GET /api/health data access
│   └── theme/app-preset.ts                PrimeNG theme: Aura with a higher-contrast primary
├── layout/shell.*                         top bar, navigation, user, toast and confirm dialog
├── features/
│   ├── login/
│   ├── dashboard/                         API status, portal feed URLs
│   ├── properties/                        list, bulk actions, form, photos, publishing panel
│   ├── jobs/                              job log
│   └── not-found/
├── shared/                                list pages, loading state, polling, status tags, page header
└── testing/fixtures.ts                    made-up API objects for specs
```

Both list pages are built on `shared/list-page.ts`: the filters, sort and page live in the URL (a
filtered view can be reloaded and shared), `shared/url-query.ts` checks them against the API's
query fields, and the table and the filter form only ever change the URL.

## Styling notes

PrimeNG writes its component styles into the `primeng` CSS layer. `src/styles.css` declares the
layer order `theme, base, icons, primeng, components, utilities`, so Tailwind's preflight cannot
break PrimeNG components and Tailwind utility classes can still override them. PrimeIcons is
imported into the `icons` layer for the same reason: as an unlayered stylesheet, its `.pi` rules
would win over every utility class. Keep that statement in sync with `cssLayer` in
`app.config.ts`.

The theme is Aura with a darker primary colour (`src/app/core/theme/app-preset.ts`): emerald 700
instead of 500, so white text on primary buttons and primary-coloured text on light backgrounds
meet the WCAG AA contrast ratio of 4.5:1. A unit test checks those pairs.

The initial bundle (about 525 kB, 125 kB compressed) is almost all Angular and the PrimeNG theme;
every page, the layout included, is lazy-loaded. That is why the warning budget in `angular.json`
is 600 kB; the error budget stays at 1 MB.

The UI is light-only for now. Dark mode is prepared: adding the `app-dark` class to `<html>`
switches both PrimeNG and Tailwind's `dark:` variant.
