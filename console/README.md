# StationKit console

The fleet console for [weatherstations.nyuchi.com](https://weatherstations.nyuchi.com):
register a station, receive its one-time credentials with Weather Underground or
Ecowitt setup instructions, submit manual readings from an analog station, and
check when a station was last heard from.

**Status: copied from `mukoko-dev/mukoko-weather` (`station-console/`), not yet the deployed source.**
The live site is served from a Cloudflare Worker whose source and deploy
configuration are not in either repo. Until that is confirmed and cut over, the
copy in `mukoko-weather` stays in place. Do not delete it first.

It is a Next.js app with WorkOS AuthKit sign-in. It calls the station endpoints
of the mukoko weather backend (`/api/py/stations/*` today; the Rust
`mukoko-weather-stations` Worker is the intended target), set by
`NEXT_PUBLIC_WEATHER_API_BASE`. Station keys are kept in the owner's browser
only.

```bash
cd console
npm install
npm run dev   # http://localhost:3001
```

The observation field names and units this console shows follow the contract in
the repo issues (#5, #6), which is still a draft.
