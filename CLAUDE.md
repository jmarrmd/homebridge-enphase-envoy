# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`homebridge-enphase-envoy-matter` — a Homebridge plugin that publishes solar production and home consumption from an Enphase Envoy / IQ Gateway as **Matter electrical sensors**, so they appear in the Apple Home Energy view on iOS 27 and later. Supports gateway firmware v5–v8.

The plugin is deliberately narrow: four sensors per gateway (production, consumption, grid import, grid export), nothing else. `experimentalSensors` adds two opt-in controls for observing Home app behaviour — off by default, and not part of the intended surface. It registers **no HomeKit/HAP accessories** — HAP has no power or energy characteristic, so it cannot drive the Energy view.

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
| [src/gridenergy.js](src/gridenergy.js) | Integrates signed grid power into the two monotonic counters Matter needs; persists them |
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
- Grid is **two one-directional endpoints** by default (`gridSplit`). One endpoint declaring both directions is legal Matter and Homebridge writes both without error, but the iOS 27 Home app read only the exported half and silently ignored import. `gridSplit: false` restores the combined endpoint.
- **All values are milli-units** (mV / mA / mW / mWh) — multiply by 1000
- `serialNumber` and `displayName` must stay within Matter's 32-character bound. Homebridge passes both through unchanged and matter.js rejects the whole accessory when either overflows, so `matterenergy.js` clamps them. A serial that already fits is never rewritten — changing one costs the device its history in the controller.
- Homebridge derives the mandatory attributes itself (`powerMode`, `numberOfMeasurementTypes`, `accuracy`, PowerTopology) and picks the feature-gated `ElectricalEnergyMeasurement` features from which energy attributes are declared at registration. Declare only the readings.
- Declare every power attribute at registration (null where unknown), because features are detected from what is declared then, not from later updates.
- Cumulative energy must be monotonic — `EnvoyClient` holds it at a high-water mark.
- Energy updates are delivered as unthrottled Matter events; push them no more than once a minute.
- Cumulative energy carries `endTimestamp` (Unix seconds — matter.js converts to the Matter epoch itself). Per the spec, `startTimestamp` and `startSystime` **shall be omitted** for cumulative energy, and `endSystime` may be omitted once UTC is known. Do not add them.
- An unchanged total is republished every five minutes (`ENERGY_HEARTBEAT_INTERVAL`). A controller derives each hourly bar by differencing the counter, so it cannot close a bucket without a reading at or after the bucket's end — without the heartbeat, a counter that stops moving (solar overnight) leaves those buckets stuck "in progress".
- Change detection compares the energy totals alone; `endTimestamp` moves every poll and would otherwise make every reading look new.
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
