<span align="center">

# Homebridge Enphase Envoy Matter

Homebridge plugin that publishes **solar production** and **home consumption** from an Enphase Envoy / IQ Gateway as **Matter electrical sensors**, so they appear in the Apple Home **Energy** view on iOS 27 and later.

</span>

> **This plugin does not replace [`homebridge-enphase-envoy`](https://github.com/grzegorz914/homebridge-enphase-envoy).** It installs under a different package name and platform alias, so the two run side by side on the same Homebridge. See [Running alongside the original plugin](#running-alongside-the-original-plugin).

## What this plugin does

It exposes three things per gateway:

| Sensor | Matter device type | Reports |
|--------|--------------------|---------|
| Solar Production | ElectricalSensor (0x0510), or SolarPower (0x17) — see below | live watts, lifetime energy **exported** |
| Home Consumption | ElectricalSensor (0x0510), or ElectricalMeter (0x0514) — see below | live watts, lifetime energy **imported** |
| Grid | ElectricalSensor (0x0510), or ElectricalMeter (0x0514) — see below | live watts (signed), lifetime energy **both directions** |

Import and export are relative to the endpoint: the PV array *delivers* energy, the house *draws* it. That distinction is what lets a controller tell a producer from a load.

### Why Matter and not HomeKit

Apple Home's Energy view is driven by Matter's `ElectricalPowerMeasurement` and `ElectricalEnergyMeasurement` clusters. Classic HomeKit (HAP) has no power or energy characteristic, so no arrangement of HAP services can populate that view — custom "Eve" characteristics only ever show up in Eve-class apps. This plugin therefore registers **no HomeKit accessories at all**; it publishes over Matter only.

## Requirements

- **Homebridge 2.4.0 or later** — earlier builds have no `ElectricalSensor` Matter device type
- **Matter enabled on this plugin's child bridge** — Homebridge UI → plugin settings → Bridge Settings → enable Matter
- Node.js 20 or later
- An Envoy / IQ Gateway on your local network, firmware v5 through v8

Consumption requires consumption CTs installed on the gateway. Without them the plugin publishes the production sensor only and says so in the log.

## Installation

```bash
sudo npm install -g github:jmarrmd/homebridge-enphase-envoy
```

Then:

1. Restart Homebridge. The plugin appears as **Enphase Envoy Matter**.
2. Configure it (see below) and restart again so it gets its own child bridge.
3. Open the plugin's **Bridge Settings** and **enable Matter**. This is per-child-bridge, so it does not affect any other plugin.
4. Restart, then pair the Matter bridge with the Home app using the code Homebridge shows.

On an `hb-service` install (the official Raspberry Pi image), a global npm install may land outside Homebridge's plugin path. If the plugin does not appear after a restart, check the path shown in the Homebridge UI under **Settings → Plugin Path** and install there.

## Running alongside the original plugin

This plugin is built to coexist with `homebridge-enphase-envoy` rather than supersede it. Everything that would collide is deliberately distinct:

| | Original | This plugin |
|---|---|---|
| Package | `homebridge-enphase-envoy` | `homebridge-enphase-envoy-matter` |
| Platform (`platform` key) | `enphaseEnvoy` | `enphaseEnvoyMatter` |
| Child bridge | its own | its own |
| Token cache | `<storage>/enphaseEnvoy/` | `<storage>/enphaseEnvoyMatter/` |

So you keep both platform blocks in `config.json`, enable Matter only on this plugin's child bridge, and leave the original's bridge untouched. Both will poll the same gateway; that is safe, because every request this plugin makes is read-only — it never writes settings or controls devices.

You will see the original plugin's HomeKit accessories and these Matter sensors at the same time in the Home app. That is expected, and is the point: it lets you compare them before deciding whether to keep both.

## Configuration

Configure through the Homebridge UI, or add a platform block by hand:

```json
{
  "platforms": [
    {
      "platform": "enphaseEnvoyMatter",
      "devices": [
        {
          "name": "Envoy",
          "host": "192.168.1.35",
          "envoyFirmware7xxTokenGenerationMode": 1,
          "enlightenUser": "user@example.com",
          "enlightenPasswd": "password",
          "refreshInterval": 30
        }
      ]
    }
  ]
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `name` | — | **Required.** Name for the gateway; prefixes the sensor names. |
| `host` | `envoy.local` | Hostname or IP address of the gateway. |
| `envoyFirmware7xxTokenGenerationMode` | `0` | `0` no token (firmware v5/v6), `1` generate a token from Enlighten credentials, `2` use a token you supply. |
| `enlightenUser` / `enlightenPasswd` | — | Enlighten account, required for mode `1`. |
| `envoyToken` | — | A JWT from [entrez.enphaseenergy.com](https://entrez.enphaseenergy.com), required for mode `2`. |
| `envoyPasswd` | last 6 of serial | Only for firmware v5/v6, if the gateway password is non-default. |
| `productionEnabled` | `true` | Publish the solar production sensor. |
| `productionName` | `<name> Solar Production` | Name of the production sensor. |
| `consumptionEnabled` | `true` | Publish the home consumption sensor. |
| `consumptionName` | `<name> Home Consumption` | Name of the consumption sensor. |
| `gridEnabled` | `true` | Publish the grid sensor — what crosses the service entrance. |
| `gridName` | `<name> Grid` | Name of the grid sensor. |
| `energyDeviceTypes` | `false` | Publish production as `SolarPower` (0x17) and consumption as `ElectricalMeter` (0x0514) instead of plain electrical sensors. Confirmed working — see below. |
| `refreshInterval` | `30` | Seconds between gateway reads. Minimum 5. |
| `log.*` | — | `success`, `info`, `warn`, `error`, `debug` toggles. |

Multiple gateways are supported — add more entries to `devices`.

### Authentication

- **Firmware v5/v6** — no token. Most gateways serve the data endpoints unauthenticated; if yours challenges, the plugin answers with HTTP Digest using the `envoy` account and the last six digits of the serial number (override with `envoyPasswd`).
- **Firmware v7 and later** — a JWT is required. Mode `1` mints one from your Enlighten credentials and caches it under Homebridge's storage path, renewing it an hour before expiry. Mode `2` uses a token you generated yourself.

The plugin detects which is needed from `/info.xml`, and falls back to the other URL scheme if the configured one is unreachable.

## Telling production apart from consumption (`energyDeviceTypes`)

By default both sensors are published as Matter `ElectricalSensor` (0x0510). A controller classifies an endpoint from its **DeviceTypeList**, and `ElectricalSensor` is a **utility** class device type — per the Matter spec, not something meant to stand alone as a device. With both endpoints carrying only that, the Apple Home app may not treat them as two separate devices, and adds them together on the summary tile. The individual values are still correct one level down.

The two settings do different jobs, and you need both: the **device type** is what makes each sensor a separate device, and the **import/export direction** is what decides which column its energy lands in (Exported vs Grid Use).

Setting `"energyDeviceTypes": true` publishes each sensor with the application-class device type that matches what it actually is:

| Sensor | Device type | Why |
|---|---|---|
| Production | `SolarPower` (0x17) | The spec's PV array type. Declares no clusters of its own — it is a semantic tag. |
| Consumption | `ElectricalMeter` (0x0514) | "Meters the electrical energy being imported and/or exported." Its mandatory clusters are exactly the two this plugin declares. |
| Grid | `ElectricalMeter` (0x0514) | The same type, and it describes the grid connection more exactly than it does house load — this is the endpoint that genuinely does both directions. |

Not `ElectricalUtilityMeter` (0x0511): despite the name it models the utility *account* — its mandatory cluster is `MeterIdentification`, not measurement — so it describes the revenue meter at the service entrance, not house load.

Homebridge still attaches the power and energy clusters from the declared state and additionally advertises `ElectricalSensor` as a secondary type, so each endpoint lists both — the shape the Matter specification describes.

One caveat remains:

- **Homebridge does not expose these device types.** Its `api.matter.deviceTypes` list covers 38 entries and omits the energy types, so the plugin reaches into matter.js (installed alongside Homebridge) to get them. If that fails the plugin logs which resolution paths it tried and falls back to `ElectricalSensor` — it never breaks.
- **The Home app does honour them** (confirmed on an iOS 27 beta, August 2026). Production appears as its own device in Electricity Usage, with its energy counted as *exported* — a day of pure generation reads `NET USAGE -32kWh / GRID USE 0kWh / EXPORTED 32kWh`. Both the device type and the export/import direction matter: the type is what makes it a separate device, the direction is what puts the energy in the Exported column rather than Grid Use.

Changing this option changes the endpoint's structure, so Homebridge tears the accessory down and rebuilds it. Expect a re-registration in the log, and re-pair the Matter bridge if a controller does not pick up the change.

The earlier `solarPowerDeviceType` option still works and means the same thing.

## The grid sensor

Neither production nor house load tells a controller what crossed your service entrance, because solar consumed on site never touches the grid. Publishing only those two is why the Home app shows a house-load *total* with no grid figure: it is handed "imported 61 kWh" for the whole house and takes that at face value, even though much of it came from the roof.

The grid sensor closes that gap. It is the only one that reports **both** cumulative directions:

```
cumulativeEnergyImported  ← drawn from the utility
cumulativeEnergyExported  ← sent to the utility
```

**Power** comes from the `net-consumption` CT when the gateway has one, since that is a direct measurement of the service entrance. Otherwise it is derived as `house load − production`, which is the same quantity by conservation of energy.

**Energy is accumulated by the plugin**, and this is the part worth understanding before you trust the numbers. The gateway reports lifetime net as a single *signed* figure, and a signed net cannot be split back into two directions — net zero could mean nothing ever happened, or 100 kWh each way. So the plugin integrates the power samples itself:

- Trapezoidal integration over each poll interval, with the interval split at the zero crossing when flow reverses mid-interval, so a sample pair straddling zero credits both counters rather than whichever sign won.
- A gap longer than five poll intervals is **skipped, not integrated**. If the plugin was down for six hours that energy is genuinely unknown, and holding the last power across the gap would invent a large number.
- Counters are persisted to `<storage>/enphaseEnvoyMatter/gridEnergy_<host>.json` and restored on start, because Matter treats cumulative energy as monotonic and a restart that reset them to zero would corrupt the Home app's history.

The honest caveat: this is a Riemann sum at your polling rate, so swings between samples are invisible to it. Expect it to track well for slow-moving loads and to under-resolve spiky ones. It is an approximation where the production and consumption counters are the gateway's own measurements. A shorter `refreshInterval` improves it at the cost of polling the gateway harder.

## How readings are sourced

The plugin reads `/production.json?details=1`, which returns production and consumption in a single call:

- **Production** comes from the production CT (`eim`) when one is installed and reporting, otherwise from the microinverters' own reports (`inverters`).
- **Consumption** comes from the `total-consumption` CT. On a gateway wired for net metering only, house load is reconstructed as `production + net-consumption`.
- If `/production.json` is unavailable the plugin falls back to `/api/v1/production`, which reports production only.

Lifetime energy counters are held at their high-water mark, since Matter treats cumulative energy as monotonic and a momentary dip in a gateway reading would otherwise surface as a bogus spike in the Home app.

Live power is pushed on every poll. Cumulative energy is pushed at most once a minute — Matter delivers energy updates as events to every subscribed controller without throttling, so a faster cadence is just noise.

## Relationship to the original plugin

This is a heavily reduced derivative of `homebridge-enphase-envoy` v10.7.7, kept in the same repository. The original exposes inverters, batteries, Ensemble/Enpower/Encharge devices, meters, grid profiles, production switches and MQTT/REST integrations as HomeKit accessories. None of that is here — only the two Matter energy sensors.

The gateway address and authentication config keys are carried over unchanged, so you can copy those fields straight across from an existing `enphaseEnvoy` block. Every other v10 option is ignored.

If you want the full accessory tree, keep using [`homebridge-enphase-envoy`](https://github.com/grzegorz914/homebridge-enphase-envoy) — that is exactly what running the two side by side is for.

## Troubleshooting

**"Matter export disabled: api.matter is unavailable"** — Matter is not enabled on this plugin's child bridge, or Homebridge is older than 2.4.0. Enable Matter in the plugin's Bridge Settings and restart.

**Sensors appear but show no energy history** — the Energy view builds history over time from the cumulative counters; it will not backfill.

**"Gateway reports no consumption data"** — your gateway has no consumption CTs installed. Only the production sensor can be published.

## License

MIT — see [LICENSE](LICENSE).
