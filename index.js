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
import MatterEnergyBridge from './src/matterenergy.js';
import { PluginName, PlatformName, StorageDir, MeasurementKind } from './src/constants.js';

const DEFAULT_REFRESH_SECONDS = 30;
const MIN_REFRESH_SECONDS = 5;
const CONNECT_RETRY_MS = 120_000;

/** Watt-hours for the debug log: enough precision to see a counter advance. */
const wh = (value) => (typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(1)} Wh` : '-');

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
    constructor({ config, host, name, tokenMode, tokenFile, gridFile, log, api }) {
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
        this.productionName = config.productionName || `${name} Solar Production`;
        this.consumptionName = config.consumptionName || `${name} Home Consumption`;
        this.gridName = config.gridName || `${name} Grid`;

        // Apple's iOS 27 Energy view reads only the export half of an endpoint
        // that declares both grid directions, so publish them separately.
        this.gridSplit = config.gridSplit ?? true;

        // Side-by-side controls for observing how the Home app treats an
        // endpoint that declares both energy directions. Off by default: the
        // extra sensors duplicate energy the real ones already report, and the
        // solar one reports an import figure that is not true of the array.
        this.experimentalSensors = config.experimentalSensors ?? false;

        this.client = new EnvoyClient({
            host,
            tokenMode,
            tokenFile,
            enlightenUser: config.enlightenUser,
            enlightenPasswd: config.enlightenPasswd,
            envoyToken: config.envoyToken,
            envoyPasswd: config.envoyPasswd,
            gridFile: this.gridEnabled ? gridFile : null,
            // Integrating across a long outage would invent energy that was never
            // measured, so anything beyond a few missed polls is treated as a gap.
            gridMaxGapMs: Math.max(this.refreshMs * 5, 120_000)
        })
            .on('success', (message) => this.logLevel.success && this.log.success(`${this.prefix}${message}`))
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

            const reading = await this.client.readEnergy();
            const sensors = this.buildSensors(reading);
            if (sensors.length === 0) {
                throw new Error('Gateway reported neither production nor consumption');
            }

            const published = await this.matter.register({ info, sensors });
            if (!published) return;

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
    buildSensors(reading) {
        const sensors = [];

        if (this.productionEnabled && reading.production) {
            sensors.push({ kind: MeasurementKind.Production, displayName: this.productionName, reading: reading.production });
        } else if (this.productionEnabled && this.logLevel.warn) {
            this.log.warn(`${this.prefix}Gateway reports no production data — production sensor not published.`);
        }

        if (this.consumptionEnabled && reading.consumption) {
            sensors.push({ kind: MeasurementKind.Consumption, displayName: this.consumptionName, reading: reading.consumption });
        } else if (this.consumptionEnabled && this.logLevel.info) {
            this.log.info(`${this.prefix}Gateway reports no consumption data (no consumption CTs installed) — consumption sensor not published.`);
        }

        if (this.gridEnabled && reading.grid && this.gridSplit) {
            sensors.push({ kind: MeasurementKind.GridImport, displayName: `${this.gridName} Import`, reading: reading.grid });
            sensors.push({ kind: MeasurementKind.GridExport, displayName: `${this.gridName} Export`, reading: reading.grid });

            // The combined endpoint as a control, published next to the split
            // pair so both shapes see the same flow at the same time.
            if (this.experimentalSensors) {
                sensors.push({ kind: MeasurementKind.Grid, displayName: `${this.gridName} Test`, reading: reading.grid });
            }
        } else if (this.gridEnabled && reading.grid) {
            sensors.push({ kind: MeasurementKind.Grid, displayName: this.gridName, reading: reading.grid });
        } else if (this.gridEnabled && this.logLevel.info) {
            this.log.info(`${this.prefix}Cannot determine grid flow — needs either a net-consumption CT or both production and consumption. Grid sensor not published.`);
        }

        if (this.experimentalSensors && this.productionEnabled && reading.production) {
            sensors.push({
                kind: MeasurementKind.ProductionCombined,
                displayName: `${this.productionName} Test`,
                reading: this.combinedProduction(reading)
            });
        }

        return sensors;
    }

    /**
     * Production plus the house's grid import on one reading, for the
     * experimental SolarPower endpoint. The import figure is the home's, not
     * the array's — see MeasurementKind.ProductionCombined.
     */
    combinedProduction(reading) {
        return { ...reading.production, energyImported: reading.grid?.energyImported ?? 0 };
    }

    async poll() {
        if (this.polling || this.stopped) return;
        this.polling = true;

        try {
            const reading = await this.client.readEnergy();

            await Promise.all([
                this.matter.update(MeasurementKind.Production, reading.production),
                this.matter.update(MeasurementKind.Consumption, reading.consumption),
                // All three take the same grid reading; update() no-ops for
                // whichever kinds were not registered.
                this.matter.update(MeasurementKind.Grid, reading.grid),
                this.matter.update(MeasurementKind.GridImport, reading.grid),
                this.matter.update(MeasurementKind.GridExport, reading.grid),
                this.matter.update(MeasurementKind.ProductionCombined, this.combinedProduction(reading))
            ]);

            // Cheap when nothing changed, and the counters are only as good as
            // the last write if Homebridge stops unexpectedly.
            await this.client.saveGridEnergy();

            if (this.logLevel.debug) {
                this.log.info(`${this.prefix}debug: production ${reading.production?.power ?? '-'} W, consumption ${reading.consumption?.power ?? '-'} W, grid ${reading.grid?.power ?? '-'} W (imported ${wh(reading.grid?.energyImported)}, exported ${wh(reading.grid?.energyExported)})`);
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
