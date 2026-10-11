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

| Piece                                                                                                 | State                                                                                                                                                         |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UI, BFF, auth wiring, tests                                                                           | Built and tested against a mock backend                                                                                                                       |
| `POST /v1/stations/{id}/readings`                                                                     | **Drafted** in [issue 5](https://github.com/nyuchi/stationkit/issues/5) ("TODO: confirm"). The client follows the draft                                       |
| `POST /v1/stations`, `GET /v1/stations`, `GET /v1/stations/{id}`, `POST /v1/stations/{id}/rotate-key` | **Not built.** Proposed by the weather repo's migration plan (issue 293, section 5.3). Live `api.nyuchi.com` answers 404 to `POST /v1/stations` on 2026-10-11 |
| Real WorkOS sign-in                                                                                   | Wired, **not exercised**: needs the owner-registered redirect URI and credentials                                                                             |
| Cloudflare Workers deploy                                                                             | Config only (`workers_dev` and `preview_urls` off). Nothing is deployed from this PR                                                                          |

Until the station endpoints exist, `STATIONS_BACKEND=nyuchi` answers 503
("Station registration is not live yet") for register, list, status and rotate
without calling the network, and the console shows a "Not live yet" notice.
A 404 from list or register is reported as "service unavailable". The mock backend is development-only and is
**refused in a production runtime**.

## Shape

- Astro 7 and TypeScript on `@astrojs/cloudflare`. No React.
- The browser calls only the same-origin BFF (`src/pages/api/stations/*`). The
  BFF resolves the session on the server and calls a `StationsClient`
  (`src/lib/stations/`): `MockStationsClient` (development) or
  `NyuchiStationsClient` (`api.nyuchi.com`). Upstream detail and status codes
  are mapped to fixed text, upstream 401/403 become 502, and every upstream
  call has a timeout and never follows redirects.
- Logic is plain TypeScript under `src/lib` with Vitest tests. The `.astro`
  files only compose Mzizi components.
- Station keys stay in the owner's browser (`localStorage`, key
  `mws-console-stations`, same shape as the earlier Next.js console). Keys
  saved by that console only carry over on the **same origin**; another
  hostname starts with an empty list.
- Hardware setup text: Wunderground (GET) and Ecowitt (POST) are pointed at
  `weather-ingest.nyuchi.com`, path `/stations/ingest`. That host and path are
  confirmed against the stations Worker source and a live probe, and the owner
  should confirm them as the published ingest host.

## Authentication

`@workos/authkit-astro` (pinned) with the shared Nyuchi WorkOS credentials.
Register `https://weatherstations.nyuchi.com/callback` (and any preview alias)
as a redirect URI. `AUTH_MODE=mock` replaces it with a cookie session for
development and tests. Mock auth is refused on Workers Builds and answers 500
in any production bundle, which is the guard for deploys outside Workers
Builds. `/auth/signout` takes POST only. The upstream `/auth/logout` route is
GET only and stays reachable by URL, a known limit of the integration.

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
npm run dev:workos # real WorkOS (needs the WORKOS_* variables)
npm run check      # astro check
npm run lint       # tsc over the TypeScript
npm test           # Vitest
npm run test:prod  # builds as deployed; WorkOS 401 + headers, mock refused, CSP
npm run test:e2e   # Playwright smoke against the mock (Chromium required)
```

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
non-secret values are in `wrangler.jsonc`; WorkOS values are secrets
(`wrangler secret put`).
