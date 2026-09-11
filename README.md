# StationKit

> The solar-powered weather and soil station behind mukoko weather — open hardware and firmware for African smallholder agriculture.

[![Lint](https://github.com/nyuchi/stationkit/actions/workflows/lint.yml/badge.svg)](https://github.com/nyuchi/stationkit/actions/workflows/lint.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
![Status](https://img.shields.io/badge/repo-specification%20only-lightgrey?style=flat-square)
![Target hardware](https://img.shields.io/badge/ESP32--C3-ESP--IDF%20v5.x-E7352C?style=flat-square&logo=espressif&logoColor=white)

**Product page:** [nyuchi.com/stationkit](https://nyuchi.com/stationkit) | **Pilot signup:** [nyuchi.com/stationkit/signup](https://nyuchi.com/stationkit/signup) | **Station console:** [weatherstations.nyuchi.com](https://weatherstations.nyuchi.com) | **Forecasts:** [weather.mukoko.com](https://weather.mukoko.com)

---

## Read this first

**This repository contains no firmware and no hardware designs yet.** Its whole
tree today is a licence, the org lint gate, and this file. The `firmware/` and
`hardware/` directories described on the product page do not exist here.

That is not a gap in the product — the network is live, it is just built
elsewhere for now. The parts that run in production are the pilot signup on
[nyuchi.com](https://nyuchi.com/stationkit/signup), the fleet console at
[weatherstations.nyuchi.com](https://weatherstations.nyuchi.com), and the
station ingest and quality-control pipeline inside
[mukoko weather](https://weather.mukoko.com). This repo is the home reserved
for the device side: the ESP-IDF firmware and the open hardware designs.

The specification for both is written down and tracked here as issues, not as
code:

| Issue                                                                                                          | What it covers                                         |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| [#3](https://github.com/nyuchi/stationkit/issues/3) Hardware                                                   | Spec, BOM, schematics, enclosure                       |
| [#4](https://github.com/nyuchi/stationkit/issues/4) Firmware                                                   | ESP-IDF project — sensor read, flash buffer, sync, OTA |
| [#5](https://github.com/nyuchi/stationkit/issues/5) API contract                                               | How a station submits readings                         |
| [#6](https://github.com/nyuchi/stationkit/issues/6) Data schema                                                | Observation fields, units, and the QC pipeline         |
| [#1](https://github.com/nyuchi/stationkit/issues/1) / [#2](https://github.com/nyuchi/stationkit/issues/2) Docs | Drafted project overview and contributing guide        |

Those issues are drafts and carry their own `TODO` markers. Treat them as the
design record, not as documentation of shipped behaviour.

## What StationKit is

A StationKit is a solar-powered, sealed, offline-first sensor station built
around an ESP32-C3. It reads local weather and soil conditions, buffers them to
flash, and syncs them to the Nyuchi platform when connectivity is available.
Validated observations feed the [Bundu Foundation](https://bundu.org) open
agricultural data commons and are published onward to
[Open-Meteo](https://open-meteo.com). Farmers get hyperlocal forecasts and
Shamwari advisory back, in Shona, Ndebele or English.

The station is one link in a chain that already works end to end:

```text
station observes  →  Bundu commons        →  mukoko weather      →  Shamwari advisory
                     (validate, blend,       (hyperlocal            (what to do,
                      open the data)          forecast)              and when)
```

**You do not need StationKit hardware to join.** Any weather station of any
make can push readings into the same commons and get the same forecasts back.
Consumer stations that speak the Weather Underground or Ecowitt "custom upload"
protocols point at the mukoko weather ingest endpoints directly; analog
stations — a rain gauge and a thermometer — submit readings by hand through the
console. There is no vendor lock-in, and there is no requirement to buy
anything.

## Target specification

Everything in this section is **specification, not measurement.** No hardware
has been built from this repository. The figures are the design targets from
the product brief; they are reproduced here so the interface contracts are
visible, and they are the thing issues [#3](https://github.com/nyuchi/stationkit/issues/3)
and [#4](https://github.com/nyuchi/stationkit/issues/4) exist to confirm.

| Target           | Value                         |
| ---------------- | ----------------------------- |
| MCU              | ESP32-C3 (RISC-V, WiFi + BLE) |
| Framework        | ESP-IDF v5.x — not Arduino    |
| Power            | 5 V 1 W solar + 18650 Li-ion  |
| Sleep current    | ~10 µA in deep sleep          |
| Read interval    | 5 min, configurable           |
| Sync interval    | Hourly batches of 12 readings |
| Local buffer     | ~48 h in flash                |
| Connectivity     | WiFi / BLE, GSM add-on        |
| Enclosure        | IP65 weatherproof             |
| Firmware updates | OTA, dual app partitions      |

Two tiers are planned: **Basic** (temperature, humidity and pressure from a
BME280) and **Full** (adds a tipping-bucket rain gauge, anemometer and vane,
capacitive soil moisture, and an optional UV sensor). Indicative kit prices are
on the [product page](https://nyuchi.com/stationkit); delivered price into
Zimbabwe depends on freight and duty, and pilot hosting is subsidised.

## Why it is open

Observations from every station go into a commons the Bundu Foundation
governs — a Zimbabwean company limited by guarantee — so the data cannot be
acquired or relicensed away from the farmers who produced it. The firmware and
hardware designs are MIT-licensed for the same reason: a station you cannot
inspect is a station you cannot trust to be measuring your own field honestly.

_My station improves your forecast. Your station improves mine._

## Ecosystem

| Repo / service                                                   | What it is                                                                  |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------- |
| [weather.mukoko.com](https://weather.mukoko.com)                 | Consumer forecasts; hosts the station ingest and QC pipeline                |
| [weatherstations.nyuchi.com](https://weatherstations.nyuchi.com) | Fleet console — register a station, get credentials, submit manual readings |
| [nyuchi.com/stationkit](https://nyuchi.com/stationkit)           | Product page and pilot signup                                               |
| [bundu.org](https://bundu.org)                                   | The foundation that governs the data commons                                |
| [open-meteo.com](https://open-meteo.com)                         | Where validated observations are published onward                           |

## Contributing

Firmware, hardware, documentation, translations and field testing are all
useful. The most valuable contribution right now is confirming a `TODO` in one
of the open issues against a real build, because nothing downstream can be
written until those contracts settle.

Open an issue or a pull request. This repo has no `CONTRIBUTING.md` yet; a
draft is in [issue #2](https://github.com/nyuchi/stationkit/issues/2).

## Licence

Licensed under the [MIT License](LICENSE).

Firmware and hardware designs are MIT. Validated weather observations are a
separate thing from the code: they are published to the open agricultural data
commons under the governance of the Bundu Foundation.
