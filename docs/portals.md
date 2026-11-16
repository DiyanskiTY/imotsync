# Portals

How ImotSync publishes to each portal: the official import method it uses, what it sends and how, how listings are identified, updated and removed, and what still has to be agreed with the portal before a real agency goes live. The publishing core (queue, worker, feed endpoint) is described in [architecture.md](architecture.md#publishing-pipeline); this document covers the portal side.

Every Realistimo and Bazar.bg fact below comes from the portal's own public documentation, linked in each section and read in November 2026. Where the documentation is silent, this document says so and lists the point under **To confirm during onboarding** instead of guessing. imot.bg is described only as far as its access conditions go, since its API documentation is not available to this project.

## Overview

| Portal                      | Key          | Mode   | How the portal receives listings                                                                              | State                                                        |
| --------------------------- | ------------ | ------ | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| [Realistimo](#realistimo)   | `realistimo` | `feed` | Downloads an XML feed in Realistimo's documented format; an optional REST call asks it to import the feed now | Built; a live import needs onboarding with Realistimo        |
| [Bazar.bg](#bazarbg)        | `bazar`      | `feed` | Downloads a Google Merchant (RSS 2.0) product feed, which Bazar's Premium import accepts directly             | Built; a live import needs onboarding with Bazar.bg          |
| [Demo portal](#demo-portal) | `demo`       | `push` | An in-process fake portal that answers like a remote API, slowly and with deliberate failures                 | Built                                                        |
| [imot.bg](#imotbg)          | none yet     |        | Official API, available only to authorised agencies                                                           | Next adapter, not built: authorization + 500 active listings |

The two kinds of adapter (`mode` in [`api/src/portals/types.ts`](../api/src/portals/types.ts)):

- **Feed portals** download a feed from ImotSync on their own schedule. A `publish` or `update` job does not call the portal: the adapter builds the listing's entry (its _payload_) and the worker stores it on the `portal_listings` row. `GET /feeds/<key>/<FEED_TOKEN>.xml` renders the stored payloads into the feed document. A `remove` job replaces the entry with one that leaves the listing out of the feed (Realistimo) or marks it as gone (Bazar.bg). A listing whose update is pending or has failed keeps its last successful entry in the feed.
- **Push portals** are called during the job and answer straight away; the answer becomes the job's result and the listing's `external_id`.

For a feed portal, `published` in ImotSync therefore means "in the feed", not "confirmed live on the portal": the portal picks the change up at its next download. Realistimo can report import results back (see [Import results over the REST API](#import-results-over-the-rest-api-optional)); Bazar.bg documents no result channel, so its results are visible only in the seller's Bazar.bg account.

### Feed URLs

`GET /api/portals` lists each portal with its feed URL, built as `PUBLIC_BASE_URL` + `/feeds/<key>/` + `FEED_TOKEN` + `.xml`; locally that is `http://localhost:3000/feeds/realistimo/dev-only-feed-token.xml` and `http://localhost:3000/feeds/bazar/dev-only-feed-token.xml`. The feed and the photos must be reachable by the portal's servers, so for a real agency `PUBLIC_BASE_URL` is the API's public HTTPS origin. Neither portal documents a way to authenticate the feed request, so the token in the path is what keeps the URL from being guessed: a wrong token gets the same `404` as an unknown portal. Changing `FEED_TOKEN` changes the URL, which then has to be registered with the portals again.

Changing `PUBLIC_BASE_URL` changes the feed URLs too, and it has a second effect: the stored entries keep the absolute photo URLs that their jobs built, so the feeds go on serving photos from the old address until every live listing gets a new entry. After restarting the API and the worker with the new value, publish the live properties again, one portal at a time: `GET /api/properties?portal=<key>&portalStatus=published` lists them, and `POST /api/properties/bulk/publish` with their ids (up to 100 per request) and `"portals": ["<key>"]` queues an `update` job for each, which stores a fresh entry. Removed Bazar.bg items, kept in the feed as out of stock, keep the old URLs until their retention period ends. With the demo data, `npm run db:reset` rebuilds every entry.

### Demo data never reaches the live portals

**The demo's made-up listings are never imported into the live portals.** Every property, broker, address and price in the demo seed is made up. The demo never registers its feed URLs with Realistimo or Bazar.bg and never calls their APIs: the feeds are served only to whoever has the URL, the Realistimo REST sync is off unless `REALISTIMO_API_KEY` is set, and the tests use local fake servers on ephemeral ports instead of the real hosts. Importing these listings would also be wrong on both portals: a Realistimo import publishes live offers under a real agency's id, and Bazar.bg's General Terms (Art. 17) require a listing to describe the offered property accurately. Connecting a real agency is an onboarding step done together with the portal, with that agency's real listings.

## Realistimo

### Official sources

- XML feed specification: [Bulgarian](https://realistimo.com/bg/docs/import/xml/), [English](https://realistimo.com/en/docs/import/xml/) (the format is called `realistimo_import` in the [docs index](https://realistimo.com/bg/docs/import/))
- REST API for imports: [Bulgarian](https://realistimo.com/bg/docs/import/rest-api/), [English](https://realistimo.com/en/docs/import/rest-api/)
- [Sample feed](https://realistimo.com/integration/imoti-raketa.xml) (three offers)
- [Geo reference list](https://static.realistimo.com/build/media/blog-assets/integration-files/geo-db/realistimo_geo_db.csv) (CSV; a PostgreSQL dump of the same data sits next to it)

No XSD, sandbox or terms of use for the integration are published; the specification page and the sample feed are the reference.

### Integration method

A pull feed. The agency hosts one XML file at a public HTTPS URL that servers can reach (no interactive Cloudflare challenge) and registers it by e-mail with Realistimo (`agent@realistimo.com`), which also sets the agency and its agents up. Realistimo imports the feed automatically on a schedule whose frequency is not documented. Optionally, `POST /rest-api/import/start` asks for an import now and `POST /rest-api/import/latest-log` returns the result; ImotSync's worker can do this ([below](#import-results-over-the-rest-api-optional)). Listings are never pushed one by one: the REST API only starts and reports imports of the registered feed.

### What ImotSync sends

The feed is UTF-8 XML with the root `<feed>`:

| Element              | Value                                                                                                                                                                                                    |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `updated`            | Feed version: the newest change of the feed (an offer stored or removed, or a property with an offer deleted), as `YYYY-MM-DD HH:MM:SS` in Bulgarian time, never older than 7 days ([Updates](#updates)) |
| `agency_uid`         | `REALISTIMO_AGENCY_UID` (default `imotsync-demo`, a placeholder that Realistimo does not know)                                                                                                           |
| `Brokers` > `Broker` | One per distinct broker of the offers in the feed, sorted by `BrokerID`: `BrokerID`, `BrokerName`, `BrokerEmail`                                                                                         |
| `offers` > `offer`   | One per listing that is on Realistimo (its last successful job published or updated it), sorted by `offer_uid`, with the children below in the documented order                                          |

Each `<offer>`:

| Element       | Realistimo's rule                                                                         | ImotSync value                                                                                   |
| ------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `offer_uid`   | Required; stable id that must not change when the offer is edited                         | `refCode`, which cannot be changed after the property is created                                 |
| `last_update` | Recommended; see [Updates](#updates)                                                      | When the offer's content last changed, as `YYYY-MM-DD HH:MM:SS` in Bulgarian time (Europe/Sofia) |
| `offer_code`  | Optional reference code                                                                   | `refCode`                                                                                        |
| `title`       | Optional                                                                                  | `title`                                                                                          |
| `description` | Recommended, strongly desirable for publication                                           | `description`                                                                                    |
| `images`      | Required; photo URLs separated by `;`                                                     | Absolute photo URLs (`PUBLIC_BASE_URL` + `/uploads/...`) in display order, joined with `;`       |
| `price`       | Required; digits only, everything after the first `,` or `.` is cut off                   | Price rounded to whole euros, digits only                                                        |
| `surface`     | Required for most types; a garage or parking space without one is recorded as 18 m²       | `areaM2` in m², with a dot decimal; left out for a garage without an area                        |
| `currency`    | Required; `eur` is the only documented value                                              | `eur`                                                                                            |
| `category`    | `продажби` (sale) or `наеми` (rent)                                                       | From `dealType`                                                                                  |
| `subcategory` | Exact upper-case value from Realistimo's list; an unknown value stops that offer's import | From `type` and `rooms` ([table below](#property-types))                                         |
| `internal_id` | Required; a city, village or neighbourhood id from the geo list                           | Resolved from `city` and `district` ([Locations](#locations))                                    |
| `floor`       | Optional; 0 is ignored                                                                    | `floor`; left out when it is not set or 0                                                        |
| `floorAll`    | Optional; floors in the building                                                          | `totalFloors`, when it is set and above 0                                                        |
| `rooms_count` | Optional; for apartments Realistimo derives it from the subcategory                       | `rooms`, sent explicitly for apartments, houses and offices when it is set and above 0           |
| `broker_id`   | Required; must match an agent linked to the agency, or the offer is not imported          | `imotsync-` + the id of the user who created the property, the same value as that `BrokerID`     |

The adapter keeps the broker (`BrokerID`, `BrokerName`, `BrokerEmail`) in the stored payload as well, so the renderer can build `<Brokers>` without another query. Text is escaped as XML requires; Cyrillic is written as is.

Not sent, because ImotSync has no data for them yet: `surface_parcel`, `construction_type`, `building_condition`, `build_year`, `furnished`, `heating_ids`, `parking_ids`, `bedroom_count`, `bath_count`, `exterior_ids`, `construction_id`, video and virtual-tour links, `Exclusive`, and the agency and broker phone, photo and contact tags. Realistimo then applies its documented defaults (for example heating "electricity" and furnishing "not sure"; the documentation recommends always sending `furnished`, a candidate for a later property field). `result_url` is not sent either: the optional REST sync polls for results instead of waiting for a one-shot callback.

#### Property types

| ImotSync `type` | `subcategory`                                                                                                      |
| --------------- | ------------------------------------------------------------------------------------------------------------------ |
| `apartment`     | By `rooms`: 1 `1-СТАЕН`, 2 `2-СТАЕН`, 3 `3-СТАЕН`, 4 `4-СТАЕН`, 5 or more `МНОГОСТАЕН`; rooms unknown `АПАРТАМЕНТ` |
| `house`         | `КЪЩА`                                                                                                             |
| `office`        | `ОФИС`                                                                                                             |
| `shop`          | `МАГАЗИН`                                                                                                          |
| `land`          | `ПАРЦЕЛ` (a plot; agricultural land, `ЗЕМЕДЕЛСКА ЗЕМЯ`, would need a land-use field ImotSync does not have)        |
| `garage`        | `ГАРАЖ`                                                                                                            |
| `other`         | `ДРУГО`                                                                                                            |

Realistimo's list is longer (studios, maisonettes, villas, warehouses, new-build projects and more); these values cover ImotSync's seven types with the closest general entry.

### Identification

Realistimo matches offers across imports by `offer_uid`, which must stay the same through edits. ImotSync uses the property's `refCode`, which is fixed once the property exists, so re-imports and retries update the same offer instead of creating a duplicate. The import log lists offers with their `offer_uid` (under `offerSourceData`) and their errors, which is how the REST sync finds the listing an error belongs to. Brokers are matched by `broker_id` / `BrokerID` against the source ids of agents already linked to the agency in Realistimo.

### Updates

The feed is a full snapshot reconciled by `offer_uid`. Realistimo checks two dates:

- **`updated`**, the feed's version. If it has not changed since the last successful import, the whole import is skipped; if it is older than 30 days, processing stops. ImotSync uses the feed's last change (`lastChangedAt` in the renderer's context): the newest `payload_updated_at` of every Realistimo listing, removed ones included (a removal leaves no offer behind, its payload is `null`, but the worker still dates it), so it moves whenever a job adds, changes or removes an offer. Deleting a property takes its listing rows with it, so their newest change date is kept separately (`portal_sync_state.feed_changed_at`) and counts as well; without it, `updated` could fall back to an earlier value and Realistimo would take the feed for an older one. A feed with no changes for weeks would hit the 30-day stop, so `updated` is never allowed to fall more than 7 days behind: past that (or for an empty feed), it becomes the start of the current day in Bulgarian time. The value then changes at most once a day, and the unchanged offers are skipped thanks to `last_update`.
- **`last_update`**, per offer. For an offer that is already published, a `last_update` that is not newer than the last imported change makes Realistimo skip most fields (price, broker and description are still updated). So `last_update` is the time the offer's content last changed, whatever changed it: when a job builds an offer that differs from the one stored for the listing (an edit, a photo change, a more precise location once the full geo list is installed, new photo URLs after a change of `PUBLIC_BASE_URL`, a change in the mapping), it is dated with the job's time; an identical offer keeps the date it had. An offer that nothing changes keeps its old date, so its `last_update` can be months old. The documentation's minimal example asks for dates no older than 30 days and puts `last_update` in that example, but it states a consequence only for an old `updated` (processing stops), not for an old `last_update`; ImotSync keeps sending the real change time and lists the point under [onboarding](#to-confirm-during-onboarding).

An `update` job rebuilds the offer from the property's current data; the change reaches Realistimo at its next import, or sooner when the REST sync triggers one. While an update is pending, or after it failed, the feed keeps serving the offer the last successful job stored, so the offer never drops out of the feed by accident (which would make Realistimo take it down).

### Removal

Realistimo has no delete flag or delete endpoint: an offer that is missing from the feed is taken down or archived at the next import. ImotSync's `remove` therefore returns no payload (`null`), which leaves the offer out of the feed, and the listing becomes `removed`. The worker still records the time of the removal on the listing (`payload_updated_at`), and that time moves `updated`: without it, removing an offer would leave `updated` unchanged, and Realistimo would skip the import that is meant to take the offer down. (The import log counts `removed_offers` and `deleted_offers` separately; the documentation does not explain the difference.)

### Photos

Photos go by URL only, all in the one `images` element. ImotSync sends every photo of the property in display order, cover first, as absolute URLs under `PUBLIC_BASE_URL`; the files are the processed JPEGs from the [photo pipeline](architecture.md#photo-pipeline) (at most 2048 px, no metadata). Realistimo states no limits on count, size or format and does not say which photo it shows first.

### Locations

Realistimo takes the location as an id, not as text: `internal_id` is a value from the `internal_id` column (not the `id` column) of its geo CSV, for a city, village or neighbourhood. If it is missing or wrong, Realistimo looks for the place in the description, and if it finds nothing the offer stays unpublished. The CSV has 6,035 rows (28 regions, 261 cities, 4,895 villages, 851 neighbourhoods); the files carry recent modification dates, so the list can change over time.

ImotSync stores `city` and `district` as text, so the adapter resolves them:

- **Data.** [`api/src/portals/realistimo/geo-subset.json`](../api/src/portals/realistimo/geo-subset.json) is a subset built from the official CSV, with a header that names the source URL, the download date and the CSV's last-modified date: every city row (261) plus the neighbourhood rows of Sofia, Plovdiv, Varna, Burgas and Bansko (302, where the CSV has any), each with its `internal_id`, Bulgarian names and `location_type`. When the full CSV is present at `api/data/realistimo_geo_db.csv` (not committed), the resolver uses it instead, which adds the villages and the other cities' neighbourhoods. `npm run geo:realistimo` in `api/` downloads it ([`download-geo.ts`](../api/src/portals/realistimo/download-geo.ts)); `npm run geo:realistimo -- --subset` also regenerates the subset, after which `npm run format` restores the JSON's formatting. The download only replaces the file once the new CSV parses with the known layout. The list changes over time, so run it again now and then.
- **Matching.** Input may be Cyrillic or Latin. Latin names are compared with the Bulgarian Streamlined System transliteration of the Cyrillic names (София → Sofia), ignoring case, accents, spaces, hyphens and other punctuation and treating `y` and `i` alike, so `Sofia`, `sofiya` and `София` all match, and so do `Mladost 1` and `Младост-1`. A leading kind-of-place prefix (`ж.к.`, `кв.`, `к.к.`, `гр.`, `с.` and their Latin forms) is ignored when the whole name does not match. Aliases cover the common English forms of the centre (`Center`, `Centre`, `City Center`, `City Centre`, `Centar` for `Център`). With the full CSV, a name that is not a city may still match a single village.
- **Fallback.** The district resolves to its neighbourhood id when the list has it; otherwise the city's id is used. A city that cannot be found, or that matches several places with no way to tell them apart, is a validation issue. Region-level ids are never sent, since the documentation does not say they are accepted.

The demo seed's locations (Sofia: Lozenets, Mladost 1, Center; Plovdiv: Ostromila, Kapana, Center; Varna: Chaika, Levski, Vinitsa; Burgas: Lazur, Meden Rudnik; Bansko) all resolve, at the neighbourhood where the list has it and otherwise at the city.

### Validation

`validate()` runs in the pre-publish check, in `POST /api/properties/{id}/publish` and again in the worker before a `publish` or `update`. Every message names Realistimo, for example "Realistimo needs the floor area (m²)." The issues name the fields `price`, `currency`, `areaM2`, `city`, `images`, `createdBy` (the broker), `description` and `title`.

| Check                                              | Why                                                                                                                        |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Price set, and above 1 once rounded to whole euros | `price` is required, and Realistimo reads 0 or 1 as "price on request"                                                     |
| Currency is EUR                                    | `eur` is the only documented currency; without it Realistimo shows the price at about half its value                       |
| Floor area set, except for a garage                | `surface` is required for most types; for a garage Realistimo records 18 m² when it is missing                             |
| City resolves to exactly one geo id                | `internal_id` is required, and an offer whose location cannot be resolved stays unpublished                                |
| At least one photo                                 | `images` is required                                                                                                       |
| A broker (the property has a creator)              | `broker_id` is required; an offer without a matching agent is not imported                                                 |
| Description set                                    | Recommended and strongly desirable for publication; Realistimo also reads it for details the tags do not carry             |
| Title set                                          | ImotSync's own rule: Realistimo's `title` is optional, but a listing without a headline is not one an agency would publish |

### Import results over the REST API (optional)

Off by default; it runs only when `REALISTIMO_API_KEY` is set. The client, `createRealistimoClient({ apiKey, baseUrl, fetch?, timeoutMs? })` in [`api/src/portals/realistimo/api-client.ts`](../api/src/portals/realistimo/api-client.ts), sends `POST` requests to `REALISTIMO_API_BASE_URL` with the key in the `API-KEY` header (the older `apikey` query parameter is deprecated by Realistimo, since keys in URLs end up in logs) and `Accept: application/json`.

`start()` asks Realistimo to import the feed. Realistimo answers these cases with HTTP 200 and a message in the body, so the client reads the body, not the status:

| Realistimo's answer                              | Outcome            | Meaning                                                                |
| ------------------------------------------------ | ------------------ | ---------------------------------------------------------------------- |
| `import-in-queue`                                | `queued`           | Accepted, or already waiting                                           |
| `import-is-allowed-between-the-time`             | `outside-window`   | Manual imports are accepted only from 08:00 to 20:59 Bulgarian time    |
| `import-in-progress`                             | `in-progress`      | An import is already running (one per agency)                          |
| `import-request-cooldown-is-time-given`          | `cooldown`         | Less than 30 minutes since the last import, scheduled imports included |
| `error-while-importing`                          | `no-feed`          | No feed is configured for the agency                                   |
| `{"error": "Agency not found"}` (an `error` key) | `agency-not-found` | The key is not linked to an agency                                     |
| Anything else                                    | `unknown`          |                                                                        |

The messages are compared case-insensitively with spaces read as hyphens, so the test key's `Import in queue` also counts as `queued`. HTTP 401 means the key is missing, unknown, inactive or expired, or its user is inactive or expired; the client throws a `PortalError` that is not retryable, with Realistimo's message. Network errors, timeouts (15 s by default), HTTP 429 and 5xx, and an answer without a JSON body throw a retryable `PortalError`; any other HTTP error is not retryable. The client never follows a redirect, since the key in its header would go along to wherever the redirect points (and a `POST` would turn into a `GET`): a `3xx` answer is a permanent `PortalError` that names the target. With `NODE_ENV=production`, `REALISTIMO_API_BASE_URL` must be an `https://` origin, so the key never travels in clear text.

`latestLog()` returns the latest import, interpreted: its state (`pending`, `in_progress`, `completed`, or `none` when Realistimo has no log yet), `logDate`, the overall result (`success`, `success_with_warnings` or `null`), the counters (offers found, imported, published, not published, removed, deleted, updated), the error types with their counts, the offers the log lists as `{offerUid, errors}`, and an early-stop message when Realistimo stopped before reaching the offers (feed unchanged or older than 30 days). Realistimo's test key returns `logResult` and `logOffers` as JSON strings instead of objects; the client accepts both. Two helpers encode the documented limits: `isWithinImportWindow(now)` (08:00 to 20:59 in Europe/Sofia) and the 30-minute cooldown.

The sync runs in the worker, one cycle every `REALISTIMO_SYNC_INTERVAL_SECONDS` (default 900), with its state in the `portal_sync_state` row for `realistimo`:

1. **Read the import log.** When `latestLog()` shows a completed import it has not processed yet, it stores the log date and the interpreted result and moves every Realistimo listing whose `offer_uid` (its `refCode`) came back with errors to `error`, with `last_error` starting `Realistimo import:` and listing the errors.
2. **Trigger an import** with `start()` only when all of these hold: the feed has changed (a newer `payloadUpdatedAt`, removals included, or a newer `feed_changed_at` from a deleted property) since the last import ImotSync queued; no import is pending or running; the time is inside the import window; and 30 minutes have passed since the latest import ImotSync knows of, its own or one the log shows (scheduled imports included). The answer is recorded as the last trigger message; `last_triggered_at` moves only when the import was queued.

A `cooldown` answer is still possible (ImotSync sees a scheduled import only once it is in the log); it is recorded, and a later cycle tries again. The answers that need a person instead of a retry (`agency-not-found`, `no-feed`, and `unknown`) are logged as warnings that point to `REALISTIMO_AGENCY_UID` and the feed registered at Realistimo, and `start()` is not called again until the feed changes or an hour has passed. With several workers, one cycle runs at a time: each cycle holds a MariaDB user lock (`GET_LOCK('imotsync:realistimo-sync')`) while it runs, and a worker that finds it taken skips its cycle, so two workers never both start an import. Realistimo does not publish the list of error types or the shape of a per-offer error, so they are stored as reported. The client is tested against a local fake HTTP server (401, every message, redirects, the test key's string-encoded bodies, timeouts) and the sync cycle with a fake client and injected clocks; neither ever calls realistimo.com, and a test-wide guard fails any test that would connect to a host other than this machine.

### To confirm during onboarding

- **Agency id:** the source id Realistimo configures for the agency goes into `REALISTIMO_AGENCY_UID`.
- **Broker ids:** every broker must be linked to the agency in Realistimo with a source id. ImotSync sends `imotsync-<user id>`; agree these ids with Realistimo (or map them to the ids the agency already has), and ask how a fallback agent is configured, which the documentation mentions but does not explain.
- **Feed registration:** e-mail the public HTTPS feed URL; check that the URL with its token works for Realistimo's servers (the documentation asks only for a public URL without an interactive challenge).
- **API key:** how a production key and a test key are obtained, and whether they cost anything, is not documented. The test key never runs an import and answers `start()` with the text `Import in queue` instead of the slug.
- **Not documented, to ask:** how often scheduled imports run; the time zone of `updated` and `last_update` (ImotSync sends Bulgarian time); whether an offer whose `last_update` is older than 30 days is treated differently (the minimal example asks for recent dates, and ImotSync sends the time the offer's content last changed, which can be months old); whether the 30-minute cooldown counts from the start or the end of the last import; photo limits and which photo becomes the main one; whether a rent price is per month and how VAT is shown; length limits and HTML in `title` and `description`; the difference between removed and deleted offers, and whether an offer comes back when its `offer_uid` reappears; whether `ДРУГО` suits every property ImotSync calls `other`; the list of import error types and the shape of a per-offer error.

## Bazar.bg

### Official sources

- [Импорт на обяви](https://bazar.bg/help/%D0%98%D0%BC%D0%BF%D0%BE%D1%80%D1%82-%D0%BD%D0%B0-%D0%BE%D0%B1%D1%8F%D0%B2%D0%B8) (listing import), in the [help centre](https://bazar.bg/help)
- [Premium plans](https://bazar.bg/premium)
- [Общи условия](https://bazar.bg/help/%D0%BE%D0%B1%D1%89%D0%B8-%D1%83%D1%81%D0%BB%D0%BE%D0%B2%D0%B8%D1%8F) (General Terms), articles 7, 8, 17, 18, 19 and 34 in particular
- Support: the [contact form](https://bazar.bg/contacts)

The exact columns, sample files and detailed instructions are shown only inside a logged-in Premium account; the public pages publish no schema.

### Integration method

Bazar.bg's import is a Premium feature with two methods: uploading a spreadsheet (Excel or CSV, with photos) and a product feed whose URL is entered once in the account. ImotSync uses the feed. Bazar.bg accepts Google Shopping / Google Merchant feeds and eMAG product XML directly, and reads the structure of a custom XML or JSON feed; CSV by URL and compressed files are not supported. Up to 5 feeds per account. After the URL is added, Bazar.bg analyses the feed without publishing anything, the seller maps the feed's categories to Bazar.bg categories once (the mapping is remembered), the catalogue goes live, and the feed is re-read every 24 hours on Premium or every 6 or 12 hours on Premium Плюс (the page's banner promises every 6 hours, its plan table says otherwise). No API is documented.

ImotSync sends a Google Merchant feed because that is the format Bazar.bg says works directly, which leaves only the documented one-time category mapping. Google's product format has no fields for real estate, so the property details that matter for that mapping go into the category path and custom labels.

### What ImotSync sends

An RSS 2.0 document with the Google namespace (`xmlns:g="http://base.google.com/ns/1.0"`). The channel's link is `PUBLIC_BASE_URL`, with a fixed title and description and a `lastBuildDate`. One `<item>` per listing, sorted by `g:id`:

| Element                   | ImotSync value                                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `g:id`                    | `refCode`                                                                                                                 |
| `title`                   | `title` on one line, at most 150 characters; a longer one is cut at a word boundary and ends in `…`                       |
| `description`             | `description`, at most 5,000 characters, cut the same way                                                                 |
| `link`                    | Only when `PUBLIC_LISTING_URL_TEMPLATE` is set: the template with `{refCode}` replaced                                    |
| `g:image_link`            | The first photo (absolute URL)                                                                                            |
| `g:additional_image_link` | Up to 10 more photos, in display order, one element each                                                                  |
| `g:price`                 | Price with two decimals and the currency, for example `245000.00 EUR`                                                     |
| `g:availability`          | `in_stock`; `out_of_stock` once the listing is removed (taken from the listing's state, not from the stored entry)        |
| `g:product_type`          | Bulgarian category path for the mapping, for example `Имоти > Продажби > Апартаменти`                                     |
| `g:custom_label_0`        | City, in Bulgarian when known (a small Latin-to-Cyrillic map of common cities, otherwise as entered)                      |
| `g:custom_label_1`        | District, when set: in Bulgarian when Realistimo's geo list knows it (`Lozenets` becomes `Лозенец`), otherwise as entered |
| `g:custom_label_2`        | Area, for example `98 м²` or `98,5 м²`, when set                                                                          |
| `g:custom_label_3`        | Rooms, when set                                                                                                           |

The category path joins `Имоти`, the deal type (`Продажби` for sale, `Наеми` for rent) and the property type with `>` separators, as in `Имоти > Наеми > Офиси`, which gives 14 values to map once:

| ImotSync `type` | Path segment     |
| --------------- | ---------------- |
| `apartment`     | `Апартаменти`    |
| `house`         | `Къщи`           |
| `office`        | `Офиси`          |
| `shop`          | `Магазини`       |
| `land`          | `Парцели и земя` |
| `garage`        | `Гаражи`         |
| `other`         | `Други`          |

The length limits (150 and 5,000 characters) and the 10 additional photos are the limits of Google's product format, which ImotSync applies because Bazar.bg publishes no limits of its own; a cut is noted in the job's result. Characters that XML cannot carry (control characters pasted from word processors) are dropped. The adapter stores these computed values as the listing's payload, so the feed renderer is a pure function of the stored payloads. Items are sorted by `g:id`, so the same listings always give the same document.

### Identification

Bazar.bg recognises listings by the seller's own product code, so a second upload updates a listing instead of duplicating it. The import page states this for the spreadsheet method; for feeds it does not say which element carries the code. ImotSync sends `refCode` as `g:id`, the Google format's product id, and lists the point under onboarding.

### Updates

At every check Bazar.bg applies changes to the price, title, description, photos and stock status. An `update` job rewrites the stored payload, and Bazar.bg picks it up at its next download of the feed.

### Removal

Bazar.bg archives a listing whose product is out of stock (keeping its statistics and history) and reactivates it when the product is back. It also has a safeguard: if a feed suddenly returns over 30 % fewer products, or downloads fail repeatedly, it stops the import and notifies the seller instead of archiving. That a product missing from the feed is archived is implied but never stated.

ImotSync therefore removes explicitly. A `remove` job stores the previous payload with `g:availability` set to `out_of_stock` and the listing becomes `removed` (for a listing that never reached the feed, there is nothing to store). The feed keeps serving removed items for `BAZAR_REMOVED_RETENTION_DAYS` (default 30) after the removal, long enough for Bazar.bg to archive them at a daily check, and leaves them out afterwards. Removing many listings at once therefore does not make the feed shrink: the archived items leave it only when their retention period is over. That holds for deleted properties too: the out-of-stock entry lives in the listing row, which goes with its property, so a property whose Bazar.bg removal is still being served is not deleted until the period has passed (bulk delete answers `deletion_scheduled`, `DELETE` answers `202`, and the worker deletes it later; see [Deleting a property](architecture.md#deleting-a-property)). Its photo files stay as long as the entry links to them. Publishing a removed listing again puts it back as `in_stock`.

### Photos

`g:image_link` carries the cover photo and `g:additional_image_link` up to 10 more, in display order, so at most 11 photos reach Bazar.bg. Bazar.bg's photo requirements (stated for the spreadsheet method): JPG, PNG, GIF, WEBP or HEIC, at least 250 × 250 px, at most 50 MB. ImotSync's processed photos are JPEGs of at least 400 px on the short side and at most 2048 px, so they meet these; the validation still checks the 250 × 250 px minimum for the photos the feed carries (the first 11 in display order) whose size is recorded. A small 12th photo, which never reaches Bazar.bg, does not block publishing.

### Locations

Bazar.bg describes location only for the spreadsheet method (region and city come from the seller's profile when missing) and publishes no location list, so how a feed should carry the location is unknown. ImotSync puts the city and the district into custom labels, next to the area and rooms, as the inputs for the mapping in Bazar.bg's interface. Bazar.bg expects Bulgarian text (Art. 7), so both are given in Cyrillic when a Bulgarian name is known: the adapter looks them up in Realistimo's geo list (the same data, through a small shared helper, `placeNamesFrom` in the registry), falls back to its own map of common cities for the city, and uses a district it cannot find as entered.

### Validation

From Bazar.bg's General Terms and import page. Every message names Bazar, for example "Bazar requires the title in Bulgarian (Cyrillic letters)."; contact details that are found are quoted in the message.

| Check                                                                                                                                                                                                                                                                                                                                                                                                 | Why                                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Title set and contains Cyrillic                                                                                                                                                                                                                                                                                                                                                                       | Art. 7: titles and texts must be in Bulgarian (Cyrillic); another language is allowed only next to the same Bulgarian text                             |
| Description set and contains Cyrillic                                                                                                                                                                                                                                                                                                                                                                 | Art. 7, as above                                                                                                                                       |
| No phone numbers (Bulgarian ones in national and international form, other countries' in international form such as `+44 20 7946 0958` or `0049 30 1234567`), e-mail addresses (also written as `name (at) example.bg`) or web addresses in the title or description, while prices, areas, dates, floors, opening hours and cadastral or other dotted identifiers (`идентификатор 07079.618.86`) pass | Art. 18 forbids contact details and links in the title and text                                                                                        |
| Price set, above 0, in EUR                                                                                                                                                                                                                                                                                                                                                                            | Art. 8: every listing shows a concrete final price in euro; "price on request" is not allowed                                                          |
| At least one photo                                                                                                                                                                                                                                                                                                                                                                                    | ImotSync's own rule: every item needs a main image for `g:image_link`; Bazar.bg's public pages do not say whether a listing without photos is accepted |
| The photos the feed carries (the first 11), when their size is recorded, are at least 250 × 250 px                                                                                                                                                                                                                                                                                                    | Bazar.bg's photo requirements, stated for the spreadsheet import (that they apply to feeds is assumed)                                                 |

### To confirm during onboarding

- **Account and feed registration:** a Premium (СТАНДАРТ or ПЛЮС) business profile, where the feed URL is entered; the plan decides the refresh interval.
- **Category mapping:** map each `g:product_type` path to the right category under ИМОТИ, once. Bazar.bg does not publish which elements it reads from a Google feed, so check how it treats the custom labels (city, district, area, rooms) and `g:id`, whether a listing left out of the feed is archived, whether archived items leaving the feed after the retention period count towards the 30 % safeguard, and whether the photo requirements stated for the spreadsheet import also apply to feed images.
- **ИМОТИ limits:** the Premium listing quotas (500 or 3,000 listings per 30 days) do not apply to ИМОТИ, which has its own rules (Art. 34): 3 free listings per 30 days in zones 1 to 3 (unlimited in zone 4), then paid listings; each listing runs for a fixed 30 days that editing or renewing does not extend; a listing ended early cannot be replaced by another free one, and republishing counts as a new listing. How a feed's archive-and-reactivate cycle fits the fixed 30-day term is not documented.
- **General Terms on accurate listings:** each listing must sit in its proper section and its title and text must describe the property accurately and clearly (Art. 17); the same or a similar listing must not appear in several sections or for several locations, and photos must show the property itself (Art. 18); a user with more than 3 active ИМОТИ listings cannot be a private person, and a business profile next to a personal one requires Premium (Art. 17, 19).
- **Results:** Bazar.bg documents no per-listing error report, only a notification when an import is stopped, so the agency follows the outcome in its Bazar.bg account.

## Demo portal

An in-process fake (`mode: 'push'`), so the queue, retries and statuses can be shown without any real portal. It makes no network calls.

- **Validation:** a title, a price and at least one photo.
- **Latency:** `publish`, `update` and `remove` first wait `DEMO_PORTAL_LATENCY_MS` (default 400 ms), like a remote call. The wait listens to the job's `AbortSignal`, so a timeout or a worker shutdown cuts it short.
- **Failures:** each call then fails with probability `DEMO_PORTAL_FAILURE_RATE` (default 0.3). Five failures in six are retryable, as HTTP 503 or as HTTP 429 asking for a 5-second wait (`retryAfterMs`); one in six is permanent, HTTP 422 with a message starting "The demo portal rejected the listing:". With the defaults and 5 attempts per job, about 7 % of jobs end as `failed`; the rest succeed, many after a retry or two.
- **Success:** the external id is `demo-` plus the property id padded to 6 digits (`demo-000042`), with a short message for the job log.
- **Tuning:** `DEMO_PORTAL_FAILURE_RATE=0` makes every call succeed (CI runs the compiled worker this way), `1` makes every call fail. The adapter takes a `random()` function (by default `Math.random`), so the tests choose the outcome of every call.

## imot.bg

The next adapter, not built.

**Why not.** API access requires authorization from imot.bg and at least 500 active listings. A portfolio project with made-up listings has neither, and this project does not build adapters against formats it cannot read in the portal's own documentation, nor fall back to scraping or automated logins.

**What the adapter would need**, once an agency has that access:

1. The authorization, the official API documentation and the agency's credentials from imot.bg.
2. From that documentation, the facts this document records for the other portals: the required fields and how ImotSync's type, deal type and location map onto imot.bg's own lists, how a listing is identified on update (ImotSync would send `refCode`), how it is removed, the photo rules, and which errors are temporary.
3. An adapter in `api/src/portals/imotbg/` implementing `PortalAdapter`. If the API receives listings directly (the documentation decides), it is a `push` adapter like the demo portal: `publish`, `update` and `remove` call the API with the job's `AbortSignal`, return the portal's id as `externalId`, and throw `PortalError` (retryable for network errors, timeouts, HTTP 5xx and 429, permanent for rejected listings).
4. Its credentials as new optional settings, and unit tests against a local fake server.

The README's [Adding a new portal](../README.md#adding-a-new-portal) walks through these steps with imot.bg as the example.
