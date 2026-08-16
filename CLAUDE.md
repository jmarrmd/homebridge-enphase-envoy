# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`homebridge-enphase-envoy-matter` — a Homebridge plugin that publishes solar production and home consumption from an Enphase Envoy / IQ Gateway as **Matter electrical sensors**, so they appear in the Apple Home Energy view on iOS 27 and later. Supports gateway firmware v5–v8.

The plugin is deliberately narrow: two sensors per gateway, nothing else. It registers **no HomeKit/HAP accessories** — HAP has no power or energy characteristic, so it cannot drive the Energy view.

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
| [src/matterenergy.js](src/matterenergy.js) | Matter cluster mapping and registration; all `api.matter` use lives here |
| [src/constants.js](src/constants.js) | Endpoint paths, part-number → model map, plugin identifiers |
| [src/envoytoken.js](src/envoytoken.js) | JWT generation via Enlighten credentials |
| [src/digestauth.js](src/digestauth.js) | HTTP Digest Authentication for firmware v5/v6 |

## Matter mapping

`api.matter` is only defined on Homebridge >= 2.4.0 with Matter enabled on the child bridge. Everything in `matterenergy.js` is feature-detected via `isSupported()`, which returns a reason string when unsupported.

- Device type: `api.matter.deviceTypes.ElectricalSensor` (0x0510)
- Production: `activePower` + `cumulativeEnergyExported`
- Consumption: `activePower` + `cumulativeEnergyImported`
- **All values are milli-units** (mV / mA / mW / mWh) — multiply by 1000
- Homebridge derives the mandatory attributes itself (`powerMode`, `numberOfMeasurementTypes`, `accuracy`, PowerTopology) and picks the feature-gated `ElectricalEnergyMeasurement` features from which energy attributes are declared at registration. Declare only the readings.
- Declare every power attribute at registration (null where unknown), because features are detected from what is declared then, not from later updates.
- Cumulative energy must be monotonic — `EnvoyClient` holds it at a high-water mark.
- Energy updates are delivered as unthrottled Matter events; push them no more than once a minute.

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
