/**
 * matterenergy.js
 *
 * Publishes solar production, home consumption and grid flow to Matter
 * controllers, so they appear in the Apple Home Energy view (iOS 27 and later)
 * with live watts and lifetime energy.
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
 *   Grid               -> activePower + both cumulative directions
 *
 * Import vs. export is relative to the endpoint: the PV array *delivers*
 * energy, the house *draws* it. The grid sensor is the only one that does both,
 * and it is what lets a controller work out grid use — neither production nor
 * house load alone says what crossed the service entrance.
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
 * The application-class device type for each measurement, resolved from
 * matter.js. Both replace the plain ElectricalSensor, which is a *utility*
 * class type and per the Matter spec is not meant to stand alone as a device.
 *
 * SolarPower (0x17) declares no clusters of its own — it is a semantic tag for
 * a PV array. ElectricalMeter (0x0514) mandates exactly the two clusters this
 * plugin already declares, and matter.js deliberately leaves them unattached so
 * the composer selects the right features — which is what Homebridge does.
 *
 * Not ElectricalUtilityMeter (0x0511): despite the name it models the utility
 * *account* — its mandatory cluster is MeterIdentification, not measurement —
 * so it describes the revenue meter at the service entrance, not house load.
 */
const ENERGY_DEVICE_TYPES = {
    [MeasurementKind.Production]: { module: 'solar-power', exportName: 'SolarPowerDevice' },
    [MeasurementKind.Consumption]: { module: 'electrical-meter', exportName: 'ElectricalMeterDevice' },
    [MeasurementKind.Grid]: { module: 'electrical-meter', exportName: 'ElectricalMeterDevice' },
    [MeasurementKind.GridImport]: { module: 'electrical-meter', exportName: 'ElectricalMeterDevice' },
    [MeasurementKind.GridExport]: { module: 'electrical-meter', exportName: 'ElectricalMeterDevice' },
    [MeasurementKind.ProductionCombined]: { module: 'solar-power', exportName: 'SolarPowerDevice' }
};

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
 * Unix epoch seconds. matter.js's TlvEpochS accepts Unix time and converts to
 * the Matter epoch (2000-01-01) itself, so do not offset it here.
 */
const nowEpochS = () => Math.floor(Date.now() / 1000);

/**
 * One cumulative EnergyMeasurementStruct.
 *
 * Only `endTimestamp` is carried. The Matter spec is explicit that for
 * cumulative energy `startTimestamp` and `startSystime` "shall be omitted" —
 * a cumulative reading is a total *as of* an instant, not a measurement over a
 * period — and `endSystime` may be omitted once the server knows UTC, which we
 * do. Carrying the end timestamp is what lets a controller place the reading in
 * time rather than inferring it from when the packet happened to arrive.
 */
const cumulative = (wattHours, at) => ({ energy: milli(wattHours) ?? 0, endTimestamp: at });

/**
 * Active power for one sensor.
 *
 * Grid power is signed: positive drawing from the utility, negative pushing
 * back. A split grid endpoint reports only its own direction and zero when
 * flow is the other way, so it reads exactly like production and consumption
 * do — a positive number whose direction is fixed by the endpoint rather than
 * carried in the sign. The combined endpoint keeps the signed value.
 */
const powerFor = (kind, reading) => {
    const power = reading?.power;
    if (typeof power !== 'number' || !Number.isFinite(power)) return power;
    if (kind === MeasurementKind.GridImport) return Math.max(0, power);
    if (kind === MeasurementKind.GridExport) return Math.max(0, -power);
    return power;
};

/**
 * Cumulative energy updates are delivered to controllers as Matter events and
 * are not throttled by Homebridge — every update reaches every subscriber. Push
 * them no more often than this, independently of the power update cadence.
 */
const ENERGY_UPDATE_INTERVAL = 60_000;

/**
 * How long an unchanged total may go unreported.
 *
 * A counter that stops moving — solar overnight — otherwise goes silent, and a
 * controller cannot close an hourly bucket without a reading at or after the
 * bucket's end. Republishing the unchanged total with a fresh endTimestamp lets
 * those buckets close instead of sitting "in progress" until sunrise.
 */
const ENERGY_HEARTBEAT_INTERVAL = 300_000;

/**
 * Key for change detection: the energy totals alone. endTimestamp moves every
 * poll, so comparing the whole struct would make every reading look new.
 */
const energyKey = (energy) => JSON.stringify(
    Object.entries(energy).map(([name, measurement]) => [name, measurement?.energy])
);

class MatterEnergyBridge {
    /**
     * @param {object} options
     * @param {object} options.api   Homebridge API
     * @param {object} options.log   Homebridge logger
     * @param {string} options.prefix Log prefix identifying the device
     * @param {boolean} options.energyDeviceTypes opt in to the application-class
     *        energy device types instead of a plain ElectricalSensor.
     *        See ENERGY_DEVICE_TYPES.
     */
    constructor({ api, log, prefix = '', energyDeviceTypes = false, historyGeneration = 0 }) {
        this.api = api;
        this.log = log;
        this.prefix = prefix;
        this.energyDeviceTypes = energyDeviceTypes;

        // Folded into the accessory UUIDs, so bumping it presents every sensor
        // as a new device and the controller starts a fresh history.
        this.historyGeneration = historyGeneration;

        /** @type {Map<string, {uuid: string, kind: string, lastEnergy: string|null, lastEnergyAt: number}>} */
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
     * @param {string} kind one of MeasurementKind
     * @param {object|null} reading normalized reading from EnvoyClient
     */
    buildClusters(kind, reading) {
        return {
            electricalPowerMeasurement: {
                voltage: milli(reading?.voltage),
                activeCurrent: milli(reading?.current),
                activePower: milli(powerFor(kind, reading))
            },
            electricalEnergyMeasurement: this.energyFor(kind, reading)
        };
    }

    /**
     * Which cumulative energy attributes a sensor declares. Homebridge picks the
     * feature-gated ElectricalEnergyMeasurement features from exactly this, at
     * registration, so whatever a sensor declares here is all it can ever report.
     *
     * The combined grid endpoint declares both directions. That is legal, and
     * Homebridge writes both without error, but on an iOS 27 beta the Home app
     * showed only the exported half — measured against 68 kWh of import sitting
     * correct on disk. Splitting the two into their own endpoints, each with a
     * single direction, is what `gridSplit` does and why it is the default.
     */
    energyFor(kind, reading) {
        const at = nowEpochS();

        if (kind === MeasurementKind.Grid) {
            return {
                cumulativeEnergyImported: cumulative(reading?.energyImported, at),
                cumulativeEnergyExported: cumulative(reading?.energyExported, at)
            };
        }
        if (kind === MeasurementKind.GridImport) {
            return { cumulativeEnergyImported: cumulative(reading?.energyImported, at) };
        }
        if (kind === MeasurementKind.GridExport) {
            return { cumulativeEnergyExported: cumulative(reading?.energyExported, at) };
        }

        // Experiment only. Production as export, the house's grid draw as
        // import, on one SolarPower endpoint — see MeasurementKind.
        if (kind === MeasurementKind.ProductionCombined) {
            return {
                cumulativeEnergyExported: cumulative(reading?.energyLifetime, at),
                cumulativeEnergyImported: cumulative(reading?.energyImported, at)
            };
        }

        // The array delivers energy; the house draws it.
        const key = kind === MeasurementKind.Production ? 'cumulativeEnergyExported' : 'cumulativeEnergyImported';
        return { [key]: cumulative(reading?.energyLifetime, at) };
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
        const spec = this.energyDeviceTypes ? ENERGY_DEVICE_TYPES[kind] : null;
        if (!spec) return matter.deviceTypes.ElectricalSensor;

        const { device, tried } = resolveMatterDevice(spec.module, spec.exportName);
        if (!device) {
            this.log.warn(`${this.prefix}Could not load the Matter ${spec.exportName} device type from matter.js — publishing ${kind} as a plain ElectricalSensor instead. Tried: ${tried.join(' | ')}`);
            return matter.deviceTypes.ElectricalSensor;
        }

        this.log.info(`${this.prefix}Publishing ${kind} as Matter ${device.name} (0x${device.deviceType.toString(16)}). This is experimental — if the Home app does not pick it up, set "energyDeviceTypes": false.`);
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
            const generation = this.historyGeneration > 0 ? `:g${this.historyGeneration}` : '';
            const uuid = matter.uuid.generate(`${PluginName}:${info.serialNumber}:${sensor.kind}${generation}`);

            accessories.push({
                UUID: uuid,
                displayName: sensor.displayName,
                deviceType: this.deviceTypeFor(sensor.kind, matter),
                serialNumber: `${info.serialNumber}-${sensor.kind}${generation}`,
                manufacturer: 'Enphase',
                model: info.modelName,
                firmwareRevision: info.software,
                context: { serialNumber: info.serialNumber, kind: sensor.kind },
                clusters: this.buildClusters(sensor.kind, sensor.reading)
            });

            this.sensors.set(sensor.kind, { uuid, kind: sensor.kind, lastEnergy: null, lastEnergyAt: 0 });
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
        const clusters = this.buildClusters(sensor.kind, reading);
        const updates = [matter.updateAccessoryState(sensor.uuid, 'electricalPowerMeasurement', clusters.electricalPowerMeasurement)];

        const energy = energyKey(clusters.electricalEnergyMeasurement);
        const now = Date.now();
        const changed = energy !== sensor.lastEnergy;
        const due = now - sensor.lastEnergyAt >= ENERGY_UPDATE_INTERVAL;
        const heartbeat = now - sensor.lastEnergyAt >= ENERGY_HEARTBEAT_INTERVAL;

        if ((changed && due) || heartbeat) {
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
