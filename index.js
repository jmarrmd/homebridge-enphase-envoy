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
    constructor({ config, host, name, tokenMode, tokenFile, log, api }) {
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
        this.productionName = config.productionName || `${name} Solar Production`;
        this.consumptionName = config.consumptionName || `${name} Home Consumption`;

        this.client = new EnvoyClient({
            host,
            tokenMode,
            tokenFile,
            enlightenUser: config.enlightenUser,
            enlightenPasswd: config.enlightenPasswd,
            envoyToken: config.envoyToken,
            envoyPasswd: config.envoyPasswd
        })
            .on('success', (message) => this.logLevel.success && this.log.success(`${this.prefix}${message}`))
            .on('warn', (message) => this.logLevel.warn && this.log.warn(`${this.prefix}${message}`))
            .on('error', (message) => this.logLevel.error && this.log.error(`${this.prefix}${message}`))
            .on('debug', (message) => this.logLevel.debug && this.log.info(`${this.prefix}debug: ${message}`));

        this.matter = new MatterEnergyBridge({
            api,
            log: this.scopedLogger(),
            prefix: this.prefix
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

        return sensors;
    }

    async poll() {
        if (this.polling || this.stopped) return;
        this.polling = true;

        try {
            const reading = await this.client.readEnergy();

            await Promise.all([
                this.matter.update(MeasurementKind.Production, reading.production),
                this.matter.update(MeasurementKind.Consumption, reading.consumption)
            ]);

            if (this.logLevel.debug) {
                this.log.info(`${this.prefix}debug: production ${reading.production?.power ?? '-'} W, consumption ${reading.consumption?.power ?? '-'} W`);
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
        if (this.pollTimer) clearInterval(this.pollTimer);
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.pollTimer = null;
        this.retryTimer = null;
    }
}

export default (api) => {
    api.registerPlatform(PluginName, PlatformName, EnvoyPlatform);
};
