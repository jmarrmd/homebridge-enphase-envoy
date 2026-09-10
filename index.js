/**
 * homebridge-enphase-envoy-matter
 *
 * Publishes solar production and home consumption from an Enphase Envoy /
 * IQ Gateway as Matter electrical sensors, so they show up in the Apple Home
 * Energy view on iOS 27 and later.
 *
 * This plugin is Matter-only: it registers no HomeKit/HAP accessories, because
 * HAP has no power or energy characteristic that the Energy view reads.
 *
 * It is a separate package from homebridge-enphase-envoy and installs alongside
 * it — see PluginName / PlatformName / StorageDir in src/constants.js.
 */

import { join } from 'path';
import { mkdirSync } from 'fs';
import EnvoyClient, { TokenMode } from './src/envoyclient.js';
import DailyEnergy from './src/dailyenergy.js';
import MatterEnergyBridge from './src/matterenergy.js';
import { PluginName, PlatformName, StorageDir, MeasurementKind, SensorNames } from './src/constants.js';

const DEFAULT_REFRESH_SECONDS = 30;
const MIN_REFRESH_SECONDS = 5;
const CONNECT_RETRY_MS = 120_000;

/** Watt-hours for the debug log: enough precision to see a counter advance. */
const wh = (value) => (typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(1)} Wh` : '-');

/** Energy fields a reading may carry, for the debug line. */
const ENERGY_FIELDS = ['energyLifetime', 'energyImported', 'energyExported'];

/** Kilowatt-hours, to compare a day against a figure from the Enphase app. */
const kwh = (value) => (typeof value === 'number' && Number.isFinite(value) ? `${(value / 1000).toFixed(1)} kWh` : '-');

class EnvoyPlatform {
    constructor(log, config, api) {
        this.log = log;
        this.api = api;
        this.config = config ?? {};
        this.cachedAccessories = [];
        this.devices = [];

        api.on('didFinishLaunching', () => this.launch());
        api.on('shutdown', () => this.shutdown());
    }

    async launch() {
        // This plugin registers no HAP accessories, so anything Homebridge
        // restored for it is a leftover. Homebridge scopes both the cache and
        // the unregister call to this plugin+platform pair, so this can only
        // ever touch our own accessories — never those of the separate
        // homebridge-enphase-envoy plugin running alongside us.
        this.purgeCachedAccessories();

        const devices = Array.isArray(this.config.devices) ? this.config.devices : [];
        if (devices.length === 0) {
            this.log.warn(`No devices configured for ${PluginName}.`);
            return;
        }

        const prefDir = join(this.api.user.storagePath(), StorageDir);
        try {
            mkdirSync(prefDir, { recursive: true });
        } catch (error) {
            this.log.error(`Prepare directory error: ${error.message ?? error}`);
            return;
        }

        // Each device runs independently — one unreachable gateway must not
        // hold up the others.
        await Promise.allSettled(devices.map((device, index) => this.setupDevice(device, index, prefDir)));
    }

    purgeCachedAccessories() {
        if (this.cachedAccessories.length === 0) return;

        this.log.info(`Removing ${this.cachedAccessories.length} stale cached HomeKit accessory(ies) — this plugin publishes over Matter only.`);
        this.api.unregisterPlatformAccessories(PluginName, PlatformName, this.cachedAccessories);
        this.cachedAccessories = [];
    }

    async setupDevice(config, index, prefDir) {
        const name = config.name;
        const host = config.host || (index === 0 ? 'envoy.local' : `envoy-${index + 1}.local`);

        if (!name) {
            this.log.warn(`Device: ${host}, name missing — skipped.`);
            return;
        }

        const tokenMode = config.envoyFirmware7xxTokenGenerationMode ?? TokenMode.None;
        if (tokenMode === TokenMode.Enlighten && (!config.enlightenUser || !config.enlightenPasswd)) {
            this.log.warn(`Device: ${host} ${name}, missing Enlighten credentials — skipped.`);
            return;
        }
        if (tokenMode === TokenMode.Supplied && !config.envoyToken) {
            this.log.warn(`Device: ${host} ${name}, missing Envoy token — skipped.`);
            return;
        }

        const device = new EnvoyEnergyDevice({
            config,
            host,
            name,
            tokenMode,
            tokenFile: join(prefDir, `envoyToken_${host.replaceAll('.', '')}`),
            gridFile: join(prefDir, `gridEnergy_${host.replaceAll('.', '')}.json`),
            dailyFile: join(prefDir, `gridDaily_${host.replaceAll('.', '')}.json`),
            log: this.log,
            api: this.api
        });

        this.devices.push(device);
        await device.start();
    }

    /** Homebridge restores previously cached accessories through this hook. */
    configureAccessory(accessory) {
        this.cachedAccessories.push(accessory);
    }

    shutdown() {
        this.devices.forEach((device) => device.stop());
    }
}

/**
 * One Envoy gateway: connect, publish its sensors to Matter, then poll.
 */
class EnvoyEnergyDevice {
    constructor({ config, host, name, tokenMode, tokenFile, gridFile, dailyFile, log, api }) {
        this.config = config;
        this.host = host;
        this.name = name;
        this.log = log;
        this.api = api;
        this.prefix = `Device: ${host} ${name}, `;

        this.logLevel = {
            success: config.log?.success ?? true,
            info: config.log?.info ?? true,
            warn: config.log?.warn ?? true,
            error: config.log?.error ?? true,
            debug: config.log?.debug ?? false
        };

        this.refreshMs = Math.max(config.refreshInterval ?? DEFAULT_REFRESH_SECONDS, MIN_REFRESH_SECONDS) * 1000;
        this.productionEnabled = config.productionEnabled ?? true;
        this.consumptionEnabled = config.consumptionEnabled ?? true;
        this.gridEnabled = config.gridEnabled ?? true;
        // Fixed, and deliberately bare. Homebridge re-asserts each accessory's
        // node label on every start, so a controller may reset a name the user
        // chose — which makes a long default actively worse than a short one.
        // Rename in the Home app; the plugin's name is only the starting point.

        // The grid sensor reports what the house drew from the utility, and
        // nothing else. Export is a separate, opt-in sensor: it is the smaller
        // number for most houses, and keeping each endpoint one-directional is
        // what makes them read like production and consumption, which the Home
        // app has never mishandled.
        this.gridExportSensor = config.gridExportSensor ?? false;

        // Integrating across a long outage would invent energy that was never
        // measured, so anything beyond a few missed polls is treated as a gap —
        // skipped by the integrator, and reported as unmeasured by the day's
        // summary. Both need the same threshold to agree with each other.
        this.gridMaxGapMs = Math.max(this.refreshMs * 5, 120_000);

        // Closes the grid counters out once a local day, so the plugin's own
        // integration can be checked against the Enphase app or a utility bill.
        this.daily = new DailyEnergy({ file: dailyFile, gapMs: this.gridMaxGapMs });

        this.client = new EnvoyClient({
            host,
            tokenMode,
            tokenFile,
            enlightenUser: config.enlightenUser,
            enlightenPasswd: config.enlightenPasswd,
            envoyToken: config.envoyToken,
            envoyPasswd: config.envoyPasswd,
            gridFile: this.gridEnabled ? gridFile : null,
            gridMaxGapMs: this.gridMaxGapMs
        })
            .on('success', (message) => this.logLevel.success && this.log.success(`${this.prefix}${message}`))
            .on('info', (message) => this.logLevel.info && this.log.info(`${this.prefix}${message}`))
            .on('warn', (message) => this.logLevel.warn && this.log.warn(`${this.prefix}${message}`))
            .on('error', (message) => this.logLevel.error && this.log.error(`${this.prefix}${message}`))
            .on('debug', (message) => this.logLevel.debug && this.log.info(`${this.prefix}debug: ${message}`));

        this.matter = new MatterEnergyBridge({
            api,
            log: this.scopedLogger(),
            prefix: this.prefix,
            // solarPowerDeviceType is the v1.1.0 name, kept working because it
            // covered production only; the option now covers both sensors.
            energyDeviceTypes: config.energyDeviceTypes ?? config.solarPowerDeviceType ?? false
        });

        this.pollTimer = null;
        this.retryTimer = null;
        this.polling = false;
        this.stopped = false;
    }

    /**
     * Restore the open day. A lost mark costs one day's accuracy — the next
     * summary is reported as partial, so this is quiet about it.
     */
    async loadDaily() {
        if (!this.gridEnabled) return;

        const { status, error } = await this.daily.load();
        if (this.logLevel.debug) {
            this.log.info(`${this.prefix}debug: daily grid summary ${status}${error ? ` (${error})` : ''}`);
        }
    }

    /**
     * Log what crossed the meter over the local day that just ended.
     *
     * The counters are gross-directional — energy in and energy out,
     * accumulated separately — which is the same definition the Enphase app
     * uses for its daily Imported and Exported. Net is reported too, because
     * that is the row the app shows most prominently and a controller may
     * display something closer to it.
     *
     * The window's caveats are printed rather than assumed away: a day that did
     * not start at midnight, or one with time the integrator refused to
     * integrate across, under-reports and should not be compared as if it were
     * whole.
     */
    reportDailyGrid(grid, reading) {
        const closed = this.daily.sample(
            {
                imported: grid?.energyImported,
                exported: grid?.energyExported,
                registers: {
                    production: reading?.production?.energyLifetime,
                    consumption: reading?.consumption?.energyLifetime
                }
            },
            Date.now(),
            { spansGaps: this.client.gridEnergy?.source === 'measured' }
        );
        if (!closed || !this.logLevel.info) return;

        const caveats = [];
        if (!closed.whole) caveats.push('partial day, counting began mid-day');
        if (closed.gapMs > 0) caveats.push(`${Math.round(closed.gapMs / 60_000)} min not measured`);

        const net = closed.imported - closed.exported;
        const suffix = caveats.length > 0 ? ` (${caveats.join('; ')})` : '';
        this.log.info(`${this.prefix}Grid on ${closed.day}: imported ${kwh(closed.imported)}, exported ${kwh(closed.exported)}, net ${kwh(net)}${suffix}.`);

        // The counters are derived from these two registers, so the two
        // accounts must agree. A day's net has to equal the change in
        // consumption minus production, and neither counter can be larger than
        // the registers moved. Printing both is what makes a disagreement
        // visible in one line instead of a week of charts.
        const r = closed.registers;
        if (!r) return;

        const drift = net - r.net;
        const inflated = closed.imported + closed.exported > Math.abs(r.net) * 2 + 1000;
        this.log.info(`${this.prefix}  gateway registers moved: production ${kwh(r.production)}, consumption ${kwh(r.consumption)}, so the grid saw net ${kwh(r.net)}.${
            Math.abs(drift) > 500 ? ` Net disagrees by ${kwh(drift)} — the counters and the registers are not telling the same story.` : ''
        }${
            inflated ? ` Import and export together (${kwh(closed.imported + closed.exported)}) far exceed the net the registers moved, which is the signature of flow being attributed in both directions that never crossed the meter.` : ''
        }`);
    }

    /** Persist the open day. Warn once if that keeps failing. */
    async saveDaily() {
        const error = await this.daily.save();
        if (!error) return;

        const message = `Could not save the daily grid summary: ${error}`;
        if (this.warnedDailySave) {
            if (this.logLevel.debug) this.log.info(`${this.prefix}debug: ${message}`);
        } else {
            this.warnedDailySave = true;
            if (this.logLevel.warn) this.log.warn(`${this.prefix}${message}`);
        }
    }

    /** Routes the Matter bridge's logging through this device's log levels. */
    scopedLogger() {
        return {
            info: (message) => this.logLevel.info && this.log.info(message),
            warn: (message) => this.logLevel.warn && this.log.warn(message),
            error: (message) => this.logLevel.error && this.log.error(message),
            debug: (message) => this.logLevel.debug && this.log.info(`debug: ${message}`)
        };
    }

    /**
     * Connect, publish, and begin polling. Retries the whole cycle on failure —
     * a gateway that is booting, or briefly off the network, should not need a
     * Homebridge restart.
     */
    async start() {
        if (this.stopped) return;

        try {
            const info = await this.client.connect();
            if (this.logLevel.info) {
                this.log.info(`${this.prefix}Connected. Model: ${info.modelName}, firmware: ${info.software ?? 'unknown'}, meters: ${info.meters ? 'yes' : 'no'}`);
            }

            await this.loadDaily();

            const readings = this.readingsByKind(await this.client.readEnergy());
            const sensors = this.buildSensors(readings);
            if (sensors.length === 0) {
                throw new Error('Gateway reported neither production nor consumption');
            }

            const published = await this.matter.register({ info, sensors });
            if (!published) return;

            // The debug line reports exactly what went out, so it has to follow
            // what was registered rather than a fixed list of kinds: with a
            // per-sensor reset in play, two sensors reading the same counters
            // publish different numbers, and a line naming the wrong one sends
            // you looking for a fault in the wrong place.
            this.publishedKinds = sensors.map((sensor) => sensor.kind);

            this.pollTimer = setInterval(() => this.poll(), this.refreshMs);
        } catch (error) {
            if (this.logLevel.error) {
                this.log.error(`${this.prefix}Setup failed: ${error.message ?? error}. Retrying in ${CONNECT_RETRY_MS / 1000} s.`);
            }
            this.retryTimer = setTimeout(() => this.start(), CONNECT_RETRY_MS);
        }
    }

    /**
     * Decide which sensors to publish. A gateway without consumption CTs
     * reports no consumption at all, so publishing that sensor would only ever
     * show zero — say so once and leave it out.
     */
    buildSensors(readings) {
        const sensors = [];
        const production = readings[MeasurementKind.Production];
        const consumption = readings[MeasurementKind.Consumption];
        const grid = readings[MeasurementKind.Grid];

        if (this.productionEnabled && production) {
            sensors.push({ kind: MeasurementKind.Production, displayName: SensorNames[MeasurementKind.Production], reading: production });
        } else if (this.productionEnabled && this.logLevel.warn) {
            this.log.warn(`${this.prefix}Gateway reports no production data — production sensor not published.`);
        }

        if (this.consumptionEnabled && consumption) {
            sensors.push({ kind: MeasurementKind.Consumption, displayName: SensorNames[MeasurementKind.Consumption], reading: consumption });
        } else if (this.consumptionEnabled && this.logLevel.info) {
            this.log.info(`${this.prefix}Gateway reports no consumption data (no consumption CTs installed) — consumption sensor not published.`);
        }

        if (this.gridEnabled && grid) {
            sensors.push({ kind: MeasurementKind.Grid, displayName: SensorNames[MeasurementKind.Grid], reading: grid });
            if (this.gridExportSensor) {
                sensors.push({ kind: MeasurementKind.GridExport, displayName: SensorNames[MeasurementKind.GridExport], reading: readings[MeasurementKind.GridExport] });
            }
        } else if (this.gridEnabled && this.logLevel.info) {
            this.log.info(`${this.prefix}Cannot determine grid flow — needs either a net-consumption CT or both production and consumption. Grid sensor not published.`);
        }

        return sensors;
    }

    /**
     * One reading per sensor kind. Grid import, grid export and the combined
     * grid endpoint all read the same counters — they differ in which
     * directions they declare, not in what they measure.
     */
    readingsByKind(reading) {
        return {
            [MeasurementKind.Production]: reading.production,
            [MeasurementKind.Consumption]: reading.consumption,
            [MeasurementKind.Grid]: reading.grid,
            [MeasurementKind.GridExport]: reading.grid
        };
    }

    /**
     * One line describing each published sensor as it stands this poll: live
     * power, and whichever cumulative counters that sensor actually carries.
     */
    describeReadings(readings) {
        const kinds = this.publishedKinds ?? Object.keys(readings);
        return kinds
            .map((kind) => {
                const reading = readings[kind];
                const energy = ENERGY_FIELDS
                    .filter((field) => typeof reading?.[field] === 'number')
                    .map((field) => `${field.replace('energy', '').toLowerCase()} ${wh(reading[field])}`);
                const detail = energy.length > 0 ? ` (${energy.join(', ')})` : '';
                return `${kind} ${reading?.power ?? '-'} W${detail}`;
            })
            .join(' | ');
    }

    async poll() {
        if (this.polling || this.stopped) return;
        this.polling = true;

        try {
            const reading = await this.client.readEnergy();
            const readings = this.readingsByKind(reading);

            // update() no-ops for whichever kinds were not registered.
            await Promise.all(
                Object.entries(readings).map(([kind, value]) => this.matter.update(kind, value))
            );

            // Cheap when nothing changed, and the counters are only as good as
            // the last write if Homebridge stops unexpectedly.
            await this.client.saveGridEnergy();

            this.reportDailyGrid(reading.grid, reading);
            await this.saveDaily();

            if (this.logLevel.debug) {
                this.log.info(`${this.prefix}debug: ${this.describeReadings(readings)}`);
            }
        } catch (error) {
            if (this.logLevel.error) {
                this.log.error(`${this.prefix}Poll failed: ${error.message ?? error}`);
            }
        } finally {
            this.polling = false;
        }
    }

    stop() {
        this.stopped = true;
        this.client.saveGridEnergy().catch(() => {});
        if (this.pollTimer) clearInterval(this.pollTimer);
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.pollTimer = null;
        this.retryTimer = null;
    }
}

export default (api) => {
    api.registerPlatform(PluginName, PlatformName, EnvoyPlatform);
};
