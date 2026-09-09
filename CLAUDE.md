# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`homebridge-enphase-envoy-matter` — a Homebridge plugin that publishes solar production and home consumption from an Enphase Envoy / IQ Gateway as **Matter electrical sensors**, so they appear in the Apple Home Energy view on iOS 27 and later. Supports gateway firmware v5–v8.

The plugin is deliberately narrow: three sensors per gateway (production, consumption, grid), nothing else. `gridSplit` swaps the single grid sensor for a one-directional import/export pair, which is the only shape choice on offer. It registers **no HomeKit/HAP accessories** — HAP has no power or energy characteristic, so it cannot drive the Energy view.

It is a reduced derivative of `homebridge-enphase-envoy` v10.7.7 (whose history is still in [CHANGELOG.md](CHANGELOG.md)) and is **designed to run alongside it, not replace it**. The plugin name, platform alias (`enphaseEnvoyMatter`), child bridge and token cache directory are all deliberately distinct — see `PluginName` / `PlatformName` / `StorageDir` in [src/constants.js](src/constants.js). Do not "align" these back to the original's values; the divergence is load-bearing.

## Commands

There is no build step — the plugin uses native ES modules and is published as-is.

```bash
npm install          # install dependencies
npm test             # (no tests configured)
```

To test locally in Homebridge, install with `npm install -g .`, enable Matter on the plugin's child bridge, and restart Homebridge.

## Architecture

**Entry point**: [index.js](index.js) — registers `EnvoyPlatform` and holds `EnvoyEnergyDevice`, the per-gateway orchestrator.

**Data flow**:
1. `EnvoyPlatform` reads config and creates one `EnvoyEnergyDevice` per configured gateway
2. `EnvoyClient` ([src/envoyclient.js](src/envoyclient.js)) reads `/info.xml`, authenticates, and returns normalized production/consumption readings
3. `MatterEnergyBridge` ([src/matterenergy.js](src/matterenergy.js)) registers the readings as Matter `ElectricalSensor` accessories via `api.matter` and pushes updates
4. `EnvoyEnergyDevice` polls on an interval and forwards each reading to the bridge

| File | Role |
|------|------|
| [index.js](index.js) | Platform + per-device orchestration: config validation, connect/retry, poll loop, cached-accessory cleanup |
| [src/envoyclient.js](src/envoyclient.js) | Auth (JWT for v7+, Digest for v5/v6) and the two data endpoints; normalizes readings |
| [src/gridenergy.js](src/gridenergy.js) | Keeps the two monotonic grid counters Matter needs, from measured register differences where possible and integrated power otherwise; persists them |
| [src/dailyenergy.js](src/dailyenergy.js) | Closes the grid counters out once a local day and reports the deltas, so the integration can be checked against an outside figure |
| [src/baseline.js](src/baseline.js) | Publishes cumulative energy from when a sensor went live rather than from the gateway's lifetime total (`resetHistory`) |
| [src/jsonstore.js](src/jsonstore.js) | Atomic JSON read/write shared by the grid counters and the baselines |
| [src/matterenergy.js](src/matterenergy.js) | Matter cluster mapping and registration; all `api.matter` use lives here |
| [src/constants.js](src/constants.js) | Endpoint paths, part-number → model map, plugin identifiers |
| [src/envoytoken.js](src/envoytoken.js) | JWT generation via Enlighten credentials |
| [src/digestauth.js](src/digestauth.js) | HTTP Digest Authentication for firmware v5/v6 |

## Matter mapping

`api.matter` is only defined on Homebridge >= 2.4.0 with Matter enabled on the child bridge. Everything in `matterenergy.js` is feature-detected via `isSupported()`, which returns a reason string when unsupported.

- Device type: `api.matter.deviceTypes.ElectricalSensor` (0x0510)
- Production: `activePower` + `cumulativeEnergyExported`
- Consumption: `activePower` + `cumulativeEnergyImported`
- Grid import: `activePower` (positive when drawing, 0 when exporting) + `cumulativeEnergyImported`
- Grid export: `activePower` (positive when pushing, 0 when importing) + `cumulativeEnergyExported`
- Grid is **one endpoint declaring both directions** by default — the shape the Matter spec describes for a grid connection. `gridSplit: true` publishes it as two one-directional endpoints instead. That split was the default from v1.4.0 to v1.8.2, because the August 2026 iOS 27 build read only the exported half of the combined endpoint and silently ignored import; by September it read both, though it appears to display their difference rather than gross import. Do not treat either shape as obsolete — both are live options and both have been observed to matter.
- **All values are milli-units** (mV / mA / mW / mWh) — multiply by 1000
- `serialNumber` and `displayName` must stay within Matter's 32-character bound. Homebridge passes both through unchanged and matter.js rejects the whole accessory when either overflows, so `matterenergy.js` clamps them. A serial that already fits is never rewritten — changing one costs the device its history in the controller.
- Homebridge derives the mandatory attributes itself (`powerMode`, `numberOfMeasurementTypes`, `accuracy`, PowerTopology) and picks the feature-gated `ElectricalEnergyMeasurement` features from which energy attributes are declared at registration. Declare only the readings.
- Declare every power attribute at registration (null where unknown), because features are detected from what is declared then, not from later updates.
- Cumulative energy must be monotonic — `EnvoyClient` holds it at a high-water mark.
- Energy updates are delivered as unthrottled Matter events; push them no more than once a minute.
- Cumulative energy carries `endTimestamp` (Unix seconds — matter.js converts to the Matter epoch itself). Per the spec, `startTimestamp` and `startSystime` **shall be omitted** for cumulative energy, and `endSystime` may be omitted once UTC is known. Do not add them.
- An unchanged total is republished every five minutes (`ENERGY_HEARTBEAT_INTERVAL`). A controller derives each hourly bar by differencing the counter, so it cannot close a bucket without a reading at or after the bucket's end — without the heartbeat, a counter that stops moving (solar overnight) leaves those buckets stuck "in progress".
- Change detection compares the energy totals alone; `endTimestamp` moves every poll and would otherwise make every reading look new.
- `periodicEnergyTest` (default off) publishes one extra grid sensor declaring **periodic energy only** — no cumulative counter beside it, so whether the Home app populates it is an unambiguous answer. Periodic carries `startTimestamp` **and** `endTimestamp`, the inverse of the cumulative rule: the cluster spec forbids `startTimestamp` on cumulative and requires it on periodic (Matter 1.6 Cluster § 2.12.5.2.2-3). Its value is a difference against what that sensor last *published*, so the anchor advances inside the publish gate, never per poll — and takes the timestamp actually published, so periods abut exactly. A period must span **at least one second**: `EndTimestamp` carries `min startTimestamp + 1` in matter.js's data model, and a zero-length one fails the entire accessory with `Behaviors have errors`, not just that reading. The step detector and the opening-value notice both skip periodic fields: a periodic value is already a difference, so falling is ordinary and there is no opening bar.
- Production energy comes from the **production CT whenever one is fitted**, and only otherwise from the microinverters. `activeCount` alone is not a safe test — it says whether the CT is reporting *now*, and it goes to zero overnight, which was never a reason to read a different counter. A CT that has ever accumulated a lifetime is installed, so `parseProduction` prefers it on `activeCount > 0 || whLifetime > 0`. Selecting per reading is what caused the overnight export spikes; pinning alone did not fix it, because a restart at night pinned to the microinverters and then rejected the CT at sunrise.
- Lifetime energy is additionally **pinned to the register it was first read from** (`pinEnergySource()`), as a backstop for the switches the selection rule cannot prevent — an entry's own total going missing and the sum of its `lines` being taken instead, or `/api/v1/production` standing in. A gateway offers production's lifetime from four different counters — the CT entry's own `whLifetime`, the sum of that entry's `lines`, the microinverters' entry, and `/api/v1/production` — with four different values, and the plugin chooses between them per reading (by `activeCount`, and by which fields are present). Switching mid-run steps a monotonic counter, and the high-water floor does not catch it because it clamps decreases while a switch upward is an increase. That was survivable while each sensor published only its own register; since grid energy became `consumption - production` it lands in the grid counters one-directionally, reading as export. Observed live as large overnight export bars. Power is deliberately **not** pinned — it is instantaneous, and switching sources for it is correct.
- Grid energy is **measured, not integrated**, wherever house load is measured: `netEnergy = consumption.energyLifetime - production.energyLifetime`, differenced per poll and sorted by sign (`GridEnergy.measure()`). Both registers are floored to a high-water mark *before* `readGrid()` sees them, because a dip in either would read as flow that never happened and inflate both counters. Integrating `wNow` is the fallback for gateways without a `total-consumption` CT only (`GridEnergy.integrate()`), and it is strictly worse: `wNow` is unbounded, and one transient reading of a few hundred kW fabricates tens of kWh — observed live as a 23 kWh "export" at 5 a.m. Do not route energy through power again. The two paths keep **separate clocks** (`lastAt` vs `lastNetAt`); the integrated one must not advance its clock on an unreadable sample, or the energy either side of the gap is silently dropped.
- Grid counters are **gross-directional**: `accumulate()` splits each interval by sign, so `imported` and `exported` mean the same thing the Enphase app's daily Imported and Exported mean. Neither is net. A controller showing something near their difference is netting them itself — check against the daily summary line before changing anything here.
- A generation is load-bearing in **both** directions: bumping one starts a sensor's history over, and *holding* one is how a sensor re-adopts a device the controller already has after its shape changes. Setting a generation to `0` is not "no reset" — it removes the baseline, so the sensor publishes raw counters, which is a step of the baseline's whole size. Confirmed on a live system: a `grid` generation moved 1 → 0 → 1 produced ~50 kWh bars in the Home app.
- Steps in a published counter are caught in `matterenergy.js`, not left for a chart: `reportOpeningEnergy()` says what each sensor opens at (that value is the controller's first bar), and `reportEnergyStep()` warns when a published total implies more than `IMPLAUSIBLE_POWER`, or moves backwards. The per-poll debug line in `index.js` follows `publishedKinds`, so it reports the sensors actually registered — with a per-sensor reset in play, `grid` and `gridImport` read the same counters but publish different numbers.
- `resetHistory` (default 0), and `resetHistoryPerSensor` for individual sensors, fold a generation into each accessory's UUID and serial number and publish cumulative energy from a baseline captured at first sight. Bumping one starts that sensor's history over; leaving it alone publishes the gateway's lifetime totals unchanged. Baselines are keyed by **sensor and field**, because grid import, grid export and the combined endpoint share the same counters and must reset independently — `readingsByKind()` applies them per sensor. Never re-capture a baseline at an unchanged generation; that rewinds a counter the controller has already seen.

## Module System

All files use native ES modules (`"type": "module"` in package.json). Use `import`/`export`, not `require`/`module.exports`. Node.js ≥20 required.

## Authentication

- **Firmware < v7**: usually unauthenticated; HTTP Digest with the `envoy` account (password = last six digits of the serial, override via `envoyPasswd`) answers a challenge if one comes
- **Firmware v7+**: JWT via `envoytoken.js` from Enlighten credentials (cached under Homebridge's storage path, renewed an hour before expiry), or a token supplied in config; exchanged for a session cookie at `/auth/check_jwt`

## Data endpoints

Only two are used. Do not reach for the wider Envoy API — the scope reduction is the point.

- `/production.json?details=1` — production and consumption in one call
- `/api/v1/production` — production-only fallback

## Configuration Schema

[config.schema.json](config.schema.json) defines the Homebridge UI form: address, authentication, sensor names/toggles, refresh interval (default 30 s), log levels.
