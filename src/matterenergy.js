/**
 * matterenergy.js
 *
 * Publishes solar production and home consumption to Matter controllers as
 * ElectricalSensor devices, so they appear in the Apple Home Energy view
 * (iOS 27 and later) with live watts and lifetime energy.
 *
 * Background
 * ----------
 * Apple Home's Energy view is driven by *Matter* electrical-measurement
 * clusters, not by classic HomeKit/HAP characteristics. HAP has no native
 * power or energy characteristic, so no arrangement of HAP services can
 * populate the Energy view — which is why this plugin publishes over Matter
 * only.
 *
 * Homebridge exposes the Matter device types and clusters through `api.matter`.
 * This module uses two of them:
 *
 *   ElectricalSensor (0x0510)  a measurement-only endpoint, no on/off control
 *   ElectricalPowerMeasurement  live volts / amps / watts
 *   ElectricalEnergyMeasurement lifetime watt-hours
 *
 * Mapping
 * -------
 *   Solar production   -> activePower + cumulativeEnergyExported
 *   Home consumption   -> activePower + cumulativeEnergyImported
 *
 * Import vs. export is relative to the endpoint: the PV array *delivers*
 * energy, the house *draws* it. Getting this right is what lets a controller
 * tell a producer from a load.
 *
 * Matter expresses all electrical measurements in milli-units, hence the x1000
 * conversions. Homebridge fills in the mandatory cluster attributes it can
 * derive itself (powerMode, numberOfMeasurementTypes, accuracy, PowerTopology)
 * and picks the feature-gated ElectricalEnergyMeasurement features from which
 * energy attributes we declare — so this module declares only the readings.
 *
 * Requirements
 * ------------
 * - Homebridge 2.4.0 or later (earlier builds have no ElectricalSensor type)
 * - Matter enabled on this plugin's child bridge (Homebridge UI ->
 *   plugin settings -> Bridge Settings -> enable Matter)
 *
 * Everything here is feature-detected: on a Homebridge build without the Matter
 * API, or with Matter disabled, `isSupported()` returns false and the plugin
 * reports why instead of throwing.
 */

import { createRequire } from 'module';
import { PluginName, PlatformName, MeasurementKind } from './constants.js';

/**
 * Resolve a device type from matter.js that Homebridge does not surface in
 * `api.matter.deviceTypes` — its curated list covers 38 entries and omits the
 * energy device types such as SolarPower (0x17) and ElectricalMeter (0x0514).
 *
 * matter.js is installed alongside Homebridge, which is normally installed
 * alongside this plugin, so ordinary Node resolution finds it from one of three
 * vantage points. Each is tried in turn.
 *
 * This deliberately reaches past the plugin API, so it is treated as optional:
 * on failure the caller falls back to ElectricalSensor. The attempted paths and
 * their errors are returned rather than swallowed, because "it silently did
 * nothing" is the hardest possible thing to debug from a log.
 *
 * @param {string} moduleName e.g. 'solar-power'
 * @param {string} exportName e.g. 'SolarPowerDevice'
 * @returns {{device: object|null, tried: string[]}}
 */
function resolveMatterDevice(moduleName, exportName) {
    const requireFrom = createRequire(import.meta.url);
    const specifier = `@matter/main/devices/${moduleName}`;
    const tried = [];

    const anchors = [
        // Hoisted next to us — the usual Homebridge plugin layout.
        ['plugin', () => requireFrom],
        // Resolve relative to Homebridge itself, which always depends on matter.js.
        ['homebridge package', () => createRequire(requireFrom.resolve('homebridge'))],
        // Last resort: the running Homebridge process. argv[1] is its entry
        // script, which is inside the very installation that loaded matter.js.
        ['running process', () => createRequire(process.argv[1])]
    ];

    for (const [label, makeRequire] of anchors) {
        try {
            const device = makeRequire()(specifier)?.[exportName];
            if (device?.deviceType) return { device, tried };
            tried.push(`${label}: loaded but no usable ${exportName} export`);
        } catch (error) {
            tried.push(`${label}: ${error.message ?? error}`);
        }
    }

    return { device: null, tried };
}

/** Matter uses milli-units for electrical measurements. */
const milli = (value) => (typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 1000) : null);

/**
 * Cumulative energy updates are delivered to controllers as Matter events and
 * are not throttled by Homebridge — every update reaches every subscriber. Push
 * them no more often than this, independently of the power update cadence.
 */
const ENERGY_UPDATE_INTERVAL = 60_000;

class MatterEnergyBridge {
    /**
     * @param {object} options
     * @param {object} options.api   Homebridge API
     * @param {object} options.log   Homebridge logger
     * @param {string} options.prefix Log prefix identifying the device
     * @param {boolean} options.solarPowerDeviceType opt in to publishing
     *        production as Matter SolarPower (0x17) instead of a plain
     *        ElectricalSensor. See resolveSolarPowerDeviceType.
     */
    constructor({ api, log, prefix = '', solarPowerDeviceType = false }) {
        this.api = api;
        this.log = log;
        this.prefix = prefix;
        this.solarPowerDeviceType = solarPowerDeviceType;

        /** @type {Map<string, {uuid: string, direction: string, lastEnergy: number|null, lastEnergyAt: number}>} */
        this.sensors = new Map();
        this.warnedUpdate = false;
    }

    /**
     * Whether this Homebridge build exposes everything needed to publish an
     * ElectricalSensor. Returns a reason string when it does not, so the caller
     * can tell the user exactly what to change.
     *
     * @returns {{supported: boolean, reason?: string}}
     */
    isSupported() {
        const matter = this.api?.matter;
        if (!matter) {
            return {
                supported: false,
                reason: 'api.matter is unavailable. Matter needs Homebridge 2.4.0 or later, with Matter enabled on this plugin\'s child bridge (plugin settings -> Bridge Settings -> enable Matter).'
            };
        }
        if (!matter.deviceTypes?.ElectricalSensor) {
            return {
                supported: false,
                reason: 'This Homebridge build has no ElectricalSensor Matter device type. Upgrade to Homebridge 2.4.0 or later.'
            };
        }
        if (typeof matter.registerPlatformAccessories !== 'function' || typeof matter.updateAccessoryState !== 'function') {
            return { supported: false, reason: 'The Matter registration API is unavailable in this Homebridge build.' };
        }
        return { supported: true };
    }

    /**
     * Build the cluster state for one sensor.
     *
     * All three power attributes are always declared, using null where the
     * gateway does not report a value — null is Matter's "no measurement right
     * now", and declaring the attribute up front is what makes it updatable
     * later on gateways that start reporting it mid-run.
     *
     * @param {string} direction 'exported' for a producer, 'imported' for a load
     * @param {object|null} reading normalized reading from EnvoyClient
     */
    buildClusters(direction, reading) {
        const energyKey = direction === 'exported' ? 'cumulativeEnergyExported' : 'cumulativeEnergyImported';

        return {
            electricalPowerMeasurement: {
                voltage: milli(reading?.voltage),
                activeCurrent: milli(reading?.current),
                activePower: milli(reading?.power)
            },
            electricalEnergyMeasurement: {
                [energyKey]: { energy: milli(reading?.energyLifetime) ?? 0 }
            }
        };
    }

    /**
     * Pick the Matter device type for one sensor.
     *
     * Consumption is a load and stays an ElectricalSensor. Production is a
     * generator, and a controller can only tell the two apart from the
     * endpoint's DeviceTypeList — the energy import/export direction is not
     * enough on its own. Opting in to SolarPower (0x17) puts that distinction
     * where a controller will look for it.
     *
     * SolarPower declares no measurement clusters of its own, which is correct:
     * Homebridge attaches ElectricalPowerMeasurement / ElectricalEnergyMeasurement
     * from the cluster state we declare, and additionally advertises
     * ElectricalSensor (0x0510) as a secondary device type. The endpoint ends up
     * listing both, which is the shape the Matter spec describes for a PV array.
     */
    deviceTypeFor(kind, matter) {
        if (kind !== MeasurementKind.Production || !this.solarPowerDeviceType) {
            return matter.deviceTypes.ElectricalSensor;
        }

        const { device, tried } = resolveMatterDevice('solar-power', 'SolarPowerDevice');
        if (!device) {
            this.log.warn(`${this.prefix}Could not load the Matter SolarPower device type from matter.js — publishing production as a plain ElectricalSensor instead. Tried: ${tried.join(' | ')}`);
            return matter.deviceTypes.ElectricalSensor;
        }

        this.log.info(`${this.prefix}Publishing production as Matter SolarPower (0x${device.deviceType.toString(16)}). This is experimental — if the Home app does not pick it up, set "solarPowerDeviceType": false.`);
        return device;
    }

    /**
     * Register the configured sensors as Matter accessories.
     *
     * @param {object} device
     * @param {object} device.info      device info from EnvoyClient#connect
     * @param {Array} device.sensors    `[{ kind, displayName, reading }]`
     * @returns {Promise<boolean>} whether registration succeeded
     */
    async register({ info, sensors }) {
        const { supported, reason } = this.isSupported();
        if (!supported) {
            this.log.warn(`${this.prefix}Matter export disabled: ${reason}`);
            return false;
        }

        const matter = this.api.matter;
        const accessories = [];

        for (const sensor of sensors) {
            const direction = sensor.kind === MeasurementKind.Production ? 'exported' : 'imported';
            const uuid = matter.uuid.generate(`${PluginName}:${info.serialNumber}:${sensor.kind}`);

            accessories.push({
                UUID: uuid,
                displayName: sensor.displayName,
                deviceType: this.deviceTypeFor(sensor.kind, matter),
                serialNumber: `${info.serialNumber}-${sensor.kind}`,
                manufacturer: 'Enphase',
                model: info.modelName,
                firmwareRevision: info.software,
                context: { serialNumber: info.serialNumber, kind: sensor.kind },
                clusters: this.buildClusters(direction, sensor.reading)
            });

            this.sensors.set(sensor.kind, { uuid, direction, lastEnergy: null, lastEnergyAt: 0 });
        }

        if (accessories.length === 0) {
            this.log.warn(`${this.prefix}No sensors enabled, nothing published to Matter.`);
            return false;
        }

        try {
            await matter.registerPlatformAccessories(PluginName, PlatformName, accessories);
            const names = accessories.map((accessory) => accessory.displayName).join(', ');
            this.log.info(`${this.prefix}Published to Matter as electrical sensors: ${names}. They appear in the Apple Home Energy view on iOS 27 and later.`);
            return true;
        } catch (error) {
            this.log.error(`${this.prefix}Failed to register Matter accessories: ${error.message ?? error}`);
            this.sensors.clear();
            return false;
        }
    }

    /**
     * Push a fresh reading to one registered sensor. Power goes out on every
     * call; cumulative energy is rate-limited and only sent when it changed.
     *
     * @param {string} kind one of MeasurementKind
     * @param {object|null} reading normalized reading from EnvoyClient
     */
    async update(kind, reading) {
        const sensor = this.sensors.get(kind);
        if (!sensor || !reading) return;

        const matter = this.api.matter;
        const clusters = this.buildClusters(sensor.direction, reading);
        const updates = [matter.updateAccessoryState(sensor.uuid, 'electricalPowerMeasurement', clusters.electricalPowerMeasurement)];

        const energyKey = sensor.direction === 'exported' ? 'cumulativeEnergyExported' : 'cumulativeEnergyImported';
        const energy = clusters.electricalEnergyMeasurement[energyKey].energy;
        const now = Date.now();
        const due = now - sensor.lastEnergyAt >= ENERGY_UPDATE_INTERVAL;

        if (energy !== sensor.lastEnergy && due) {
            sensor.lastEnergy = energy;
            sensor.lastEnergyAt = now;
            updates.push(matter.updateAccessoryState(sensor.uuid, 'electricalEnergyMeasurement', clusters.electricalEnergyMeasurement));
        }

        try {
            await Promise.all(updates);
        } catch (error) {
            // Log the first failure at warn and the rest at debug, so a
            // persistently unhappy Matter server cannot flood the log.
            const message = `${this.prefix}Failed to update Matter state for ${kind}: ${error.message ?? error}`;
            if (this.warnedUpdate) {
                this.log.debug(message);
            } else {
                this.warnedUpdate = true;
                this.log.warn(message);
            }
        }
    }
}

export default MatterEnergyBridge;
