# ImotSync admin panel (`web/`)

Angular admin panel for ImotSync. Right now it has the app shell (top bar and navigation), a
dashboard that shows the API and database status from `GET /api/health`, and placeholder pages for
Properties and Jobs. See the [root README](../README.md) for the project overview and roadmap.

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
offline.

The proxy target is fixed at port 3000, the default `API_PORT`. If you run the API on another port
(by changing `API_PORT` in the root `.env`), change both `target` values in `proxy.conf.json` to
match.

## Scripts

| Script                            | What it does                                                      |
| --------------------------------- | ----------------------------------------------------------------- |
| `npm start`                       | Dev server on port 4200 with the API proxy                        |
| `npm run build`                   | Production build into `dist/imotsync-web/browser`                 |
| `npm test`                        | Unit tests, single run in Node.js with jsdom (no browser needed)  |
| `npm run lint`                    | ESLint with the angular-eslint TypeScript and template a11y rules |
| `npm run format` / `format:check` | Format with Prettier / check formatting                           |

## Structure

```text
src/app/
├── app.ts, app.config.ts, app.routes.ts   root component, providers, lazy-loaded routes
├── core/
│   ├── app-title-strategy.ts              "<page> | ImotSync" browser tab titles
│   ├── dev-hints.ts                       set-up hints shown in development builds only
│   ├── health/health-api.ts               GET /api/health data access
│   └── theme/app-preset.ts                PrimeNG theme: Aura with a higher-contrast primary
├── layout/shell.*                         top bar, navigation, main landmark, footer
├── features/
│   ├── dashboard/                         API and database status
│   ├── properties/, jobs/                 placeholders for the next milestones
│   └── not-found/
└── shared/                                page header, planned-feature list, formatting helpers
```

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

The UI is light-only for now. Dark mode is prepared: adding the `app-dark` class to `<html>`
switches both PrimeNG and Tailwind's `dark:` variant.
