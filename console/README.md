# StationKit console

The fleet console for [StationKit](https://nyuchi.com/stationkit), a Nyuchi
product: register a weather station, get its credentials once, see the setup
text for Wunderground and Ecowitt hardware, log manual readings from an analog
station, and check status. It is served at `weatherstations.nyuchi.com`.

_Rima uchiziva. Farm knowing._

This is a **Nyuchi** application (the B2B and B2G platform side). It is
separate from the consumer Mukoko apps and does not call any Mukoko host. The
only API it talks to is `api.nyuchi.com`.

## Status: read this first

| Piece                                   | State                                                                                                                                                                                                                     |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UI, BFF, auth wiring                    | Built. Tested against the mock backend, and against a fake Nyuchi API with the real client                                                                                                                                |
| Real client (`STATIONS_BACKEND=nyuchi`) | Built against the Nyuchi API's contract: register, list, status, manual readings, rotate the key and claim a legacy station (nyuchi-api B1, pull requests 540, 541 and 542). **Never run against the real API or WorkOS** |
| Station routes on `api.nyuchi.com`      | Built in nyuchi-api `staging`. Not deployed or applied: until the owner applies the station indexes every route answers `503 stations_unavailable`, which the console shows as "Station registration is not live yet"     |
| The console's own key for the API       | **Owner step.** The real client acts for a person with it; without it those actions answer the same "not live yet" and make no call (a station's own key still opens its status and readings)                             |
| Real WorkOS sign-in                     | Wired, **not exercised**: needs the owner-registered redirect URI and credentials                                                                                                                                         |
| Cloudflare Workers deploy               | Config only (`workers_dev` and `preview_urls` off). Nothing is deployed from this repository, and the production domain is not attached                                                                                   |

`STATIONS_BACKEND=mock` is the default in development and is **refused in a
production runtime**; a production runtime defaults to `nyuchi`.

## The Nyuchi client

The browser calls only the same-origin BFF. On the server the BFF resolves the
session and calls `NyuchiStationsClient`
(`src/lib/stations/nyuchi-client.ts`), which talks to `api.nyuchi.com` and to
nothing else (a guard test pins the routes in `API_ROUTES`):

| Console action          | Nyuchi API                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------ |
| Sign-in to API identity | `POST /v1/auth/token` (RFC 8693 token exchange), `POST /v1/identity/persons/ensure` (once) |
| Register                | `POST /v1/stations` (the ingest key comes back once, with the upload target in `ingest`)   |
| My stations             | `GET /v1/stations`                                                                         |
| Status                  | `GET /v1/stations/{id}` (`latestMetrics`)                                                  |
| Manual reading          | `POST /v1/stations/{id}/readings` (one reading; wind in km/h as `windSpeedKph`)            |
| Rotate the key          | `POST /v1/stations/{id}/rotate-key` (the new key comes back once)                          |
| Claim a legacy station  | `POST /v1/stations/{id}/claim` (with the station's key)                                    |

How a person is identified to the API (docs/AUTH.md in nyuchi-api):

- The console holds its own **internal key** (scopes `identity` and `stations`)
  as two Worker secrets, `NYUCHI_CONSOLE_CLIENT_ID` and
  `NYUCHI_CONSOLE_CLIENT_SECRET`. Both or neither; a half-set pair stops the
  console with a configuration error that names the settings, not the values.
- For each signed-in person the BFF trades their AuthKit access token for a
  15 minute API token with `scope=stations`, and calls `/v1/stations*` with it.
  That token reaches the station routes and nothing else. On
  `404 person_not_found` the BFF provisions the person once and exchanges again.
- The API token lives in the Worker's memory only, keyed by a SHA-256 of the
  AuthKit token it came from, until it expires (less a margin). It is never in
  a cookie, a response or a log. Requests for one person that arrive together
  share one exchange; one the API stops accepting is exchanged again, once.
- A station's own key (from this browser's store, for a legacy station) is sent
  as the bearer for that station's status and readings only, never in a URL.

What the person sees. Every failure is fixed text; the API's own words, codes
and detail are never forwarded, and an upstream 401 or 403 is never shown as
"signed out" (the browser signs people in again on a 401, and a console whose
own key is wrong would send everyone round in a circle).

| The API answers                        | The console says                                                  |
| -------------------------------------- | ----------------------------------------------------------------- |
| `503 stations_unavailable`             | Station registration is not live yet                              |
| `409 station_limit_reached`            | You already have the most stations one person can register.       |
| `429`                                  | Too many requests. Try again later.                               |
| `404 station_not_found`                | Station not found (the same for a station that is someone else's) |
| A station key that opens nothing       | That station key was not accepted.                                |
| `403 invalid_station_key` (claim)      | That is not this station's key.                                   |
| A reading refused (`200`, `rejected`)  | Rejected by quality checks: temperature is out of range           |
| Anything else, or the key not accepted | The station service could not complete that request.              |

Known limits, said plainly:

- **Token exchange budget.** For an internal key that is not the Nyuchi
  Console's, the exchange is limited to 30 a minute for the whole key
  (`token_endpoint_limit` in nyuchi-api), not per person. The cache, the shared
  exchange and a browser that asks for statuses four at a time keep a page load
  to about one exchange; a Worker that starts cold on many isolates at once
  could still reach it. Unmeasured. The fix is the API's: a ceiling for this key
  like the console backend's.
- **Legacy key-only reads share a bucket.** At the API a station-key request is
  counted against the caller's address (the Worker's, shared by everyone) and
  a person's own against that person, so people who read legacy stations by
  key share 120 reads a minute. Claiming a station moves it to its owner's
  bucket. Unmeasured.
- **Upload target after a rotation.** The API names it at registration only
  (`ingest`). A rotated key's setup text uses `NYUCHI_INGEST_HOST` and the path
  hardware already uses (`/stations/ingest`).
- **Country.** The register form asks for it and the BFF refuses a registration
  without one: the API files an omitted country under `ZW`.

## Shape

- Astro 7 and TypeScript on `@astrojs/cloudflare`. No React.
- The browser calls only the same-origin BFF (`src/pages/api/stations/*`). The
  BFF resolves the session on the server and calls a `StationsClient`
  (`src/lib/stations/`): `MockStationsClient` (development) or
  `NyuchiStationsClient` (`api.nyuchi.com`). Upstream detail and status codes
  are mapped to fixed text, upstream 401/403 become 502 (or 403 for a station
  key that opens nothing), and every upstream call has a timeout and never
  follows redirects.
- Logic is plain TypeScript under `src/lib` with Vitest tests. The `.astro`
  files only compose Mzizi components.
- Station keys stay in the owner's browser (`localStorage`, key
  `mws-console-stations`, same shape as the earlier Next.js console). Keys
  saved by that console only carry over on the **same origin**; another
  hostname starts with an empty list.
- Hardware setup text: Wunderground (GET) and Ecowitt (POST) are pointed where
  the API says at registration (its `ingest` field). Where it says nothing (a
  rotated key) the console shows `NYUCHI_INGEST_HOST`, by default
  `weather-ingest.nyuchi.com`, path `/stations/ingest`. That host and path are
  confirmed against the stations Worker source and a live probe, and the owner
  should confirm them as the published ingest host.

## Authentication

WorkOS AuthKit, Nyuchi Console app (client id `client_01KQBBSMQTSMTBN7HEC9KQBJC0`,
a public plain var; `https://weatherstations.nyuchi.com/callback` is already
registered on it). The package is `@workos/authkit-astro` (pinned).

The package's own integration reads its settings from build-time `astro:env`
strings, which cannot take a Cloudflare Secrets Store binding, so
`integrations/workos-auth.mjs` injects the same routes
(`/auth/signin`, `/callback`, `/auth/logout`) and a middleware that resolves
the settings **at runtime** (`src/auth/workos-config.ts`) and then runs the
package's `authkitMiddleware`:

| Setting                  | Where it lives                                                                                                                                       |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WORKOS_CLIENT_ID`       | plain var in `wrangler.jsonc` (public)                                                                                                               |
| `WORKOS_REDIRECT_URI`    | plain var in `wrangler.jsonc` (public)                                                                                                               |
| WorkOS API key           | Secrets Store secret `CONSOLE_WORKOS_API_KEY`, bound as `CONSOLE_WORKOS_API_KEY`, read with `await env.CONSOLE_WORKOS_API_KEY.get()` on each request |
| `WORKOS_COOKIE_PASSWORD` | a separate Worker secret (`wrangler secret put WORKOS_COOKIE_PASSWORD`), 32+ characters                                                              |

**Owner action:** `wrangler.jsonc` carries the placeholder store id
`REPLACE_WITH_SECRETS_STORE_ID`. The deploy workflow substitutes
`vars.CONSOLE_SECRETS_STORE_ID` into the built config; for a manual deploy
replace it yourself. Nothing is invented: neither the store id nor any value is
in the repository, and no value is ever logged.

Details that matter:

- The library reads `process.env` before anything it is given, so a leftover
  plain Worker secret named `WORKOS_API_KEY` (or `WORKOS_CLIENT_ID`,
  `WORKOS_REDIRECT_URI`, `WORKOS_COOKIE_PASSWORD`) could beat the Secrets Store
  value. The middleware replaces the library's environment source, so none of
  them can. Still, **delete any `WORKOS_API_KEY` Worker secret**; only the
  Secrets Store entry should exist.
- The Secrets Store read is cached for 2 minutes (a rotation takes effect within
  that), dropped on a failed read, and skipped for prerendered pages. A plain
  string key (`.dev.vars`) is accepted in development only.
- Session cookie: `__Host-wos-session` over https (a week, not the library's 400
  days); the library's default name over plain-http local dev.
- Fail closed, per request: if the key or any setting is missing or invalid,
  `/api/*` answers a JSON 500 (with the security headers), every other request
  continues with no session, and `/auth/signin`, `/callback` and `/auth/logout`
  refuse with a 500 even if an earlier request in the same isolate configured
  AuthKit. No value is ever logged or named in an answer.
- `/callback` failures answer a fixed message; the WorkOS `error`,
  `error_description` and exception text are never reflected.
- The happy path with a real Secrets Store key cannot run in a local preview. It
  is covered by behavioural tests that run the package's real middleware (store
  value configured, leftover `process.env` ignored, anonymous `/api/stations`
  is 401 for `Accept: application/json` and 302 for HTML, missing config is a 500) and by the post-deploy smoke.

`AUTH_MODE=mock` replaces WorkOS with a cookie session for development and
tests; it is refused on Workers Builds and answers 500 in any production bundle,
which is the guard for deploys outside Workers Builds. Sign-out is POST only
end to end: the account menu posts to `/auth/signout`, which forwards with a 307
to `POST /auth/logout`, so Astro's origin check protects it and a link on
another site cannot sign anyone out.

## Deploying

`.github/workflows/deploy.yml` runs on a manual dispatch or a push to `main`
(never on a pull request), in the `production` GitHub Environment. It repeats
the console checks, builds, substitutes the store id, deploys with
`cloudflare/wrangler-action` (pinned to a commit), then runs
`scripts/post-deploy-smoke.mjs` against `vars.CONSOLE_SMOKE_URL` (skipped with a
warning if unset). It reads only: secret `CLOUDFLARE_API_TOKEN`, and vars
`CLOUDFLARE_ACCOUNT_ID`, `CONSOLE_SECRETS_STORE_ID`, `CONSOLE_SMOKE_URL`. It
adds no route or custom domain: `workers_dev` and `preview_urls` are off, so
the Worker is unreachable until the domain is attached at cutover.

## Security headers

`src/lib/headers.ts` (headers as data) is applied by a `pre` middleware that is
registered **before** AuthKit, so AuthKit's own 401s and redirects carry the
headers too. Astro emits a strict CSP with hashes for its own inline code
(`self` only; the fonts are self-hosted from `@fontsource`, so no third-party request); `frame-ancestors 'none'` is
appended. The BFF, auth routes, `/callback` and the console page are
`no-store`.

## Mzizi

Components are vendored with `npx @nyuchi/mzizi-cli add <name> --target astro`
into `src/components/mzizi/`. Tokens are the upstream default `globals.css`
(`src/styles/mzizi-globals.css`), unedited, with `data-brand="nyuchi"` (gold).
Local divergence goes in `src/styles/global.css`. Gaps to file upstream: the
default globals do not define `.card`; the segmented control's unselected text
is 4.41:1 in dark mode; `app-button`, `app-label` and `app-card` do not forward
attributes; there is no Astro app header or footer. The seven-mineral ribbon is
the Mzizi strip (vertical, left edge).

## Commands

```bash
npm ci
npm run dev        # mock backend, mock session, http://localhost:4321
npm run dev:workos # real WorkOS (needs .dev.vars, see .env.example)
npm run check      # astro check
npm run lint       # tsc over the TypeScript
npm test           # Vitest
npm run test:prod  # builds as deployed; WorkOS fail-closed JSON 500 + headers, mock refused, CSP
npm run test:e2e   # Playwright smoke against the mock (Chromium required)
npm run test:e2e:nyuchi # Playwright with the real Nyuchi client against a fake Nyuchi API
```

The fake Nyuchi API (`e2e/support/fake-nyuchi-api.ts`) answers in the shapes of
the API's OpenAPI examples, with no network to production, and keeps a log of
what reached it. Vitest drives the client against it over local HTTP, and
`test:e2e:nyuchi` starts it beside `astro dev` (the dev runtime reads settings
from `.dev.vars` ahead of `wrangler.jsonc`, so the runner writes a throwaway one
and puts back any you had). It is not the API: it keeps everything in memory and
does not model every limit.

`.npmrc` sets `legacy-peer-deps=true` because npm 10 crashes resolving the
optional `react` peer of `@workos/authkit-astro` (the console has no React).
It also sets `min-release-age=7` (do not resolve versions published in the last
7 days). That option exists from npm 11.10; npm 10 ignores it, so CI on Node 22
(npm 10) does not enforce it yet. It is there for npm 11 and for the Semgrep
rule that asks for it.

`@workos/authkit-astro` is the official WorkOS package (MIT, repository
`workos/authkit-astro`, published by WorkOS maintainers with npm SLSA
provenance); it is pinned to 0.2.1 and `npm audit signatures` verifies it.

## Configuration

Names only; see `.env.example`. `STATIONS_BACKEND`, `NYUCHI_API_URL` and
`NYUCHI_INGEST_HOST` are runtime values (not inlined at build). The Worker's
non-secret values are in `wrangler.jsonc`. The WorkOS API key is the Secrets
Store binding `CONSOLE_WORKOS_API_KEY`; the cookie password is a Worker secret
(`wrangler secret put WORKOS_COOKIE_PASSWORD`). The console's own key for the
Nyuchi API is two Worker secrets, `NYUCHI_CONSOLE_CLIENT_ID` and
`NYUCHI_CONSOLE_CLIENT_SECRET` (`wrangler secret put`), following owner decision
O-S4 (plain Worker secrets for the Astro Workers, which `astro:env` reads
directly); the owner mints the key (scopes `identity` and `stations`) and sets
them. Nothing here holds a value.
