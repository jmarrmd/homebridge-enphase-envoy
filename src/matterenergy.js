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

import { createHash } from 'crypto';
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
    [MeasurementKind.GridPeriodic]: { module: 'electrical-meter', exportName: 'ElectricalMeterDevice' }
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

/**
 * Matter caps BridgedDeviceBasicInformation's serialNumber and nodeLabel at 32
 * characters, and matter.js rejects the whole accessory when one overflows
 * rather than trimming it. Homebridge passes ours through unchanged, so the
 * bound is ours to respect.
 */
const MAX_IDENTITY = 32;

/**
 * A serial that already fits is kept byte-identical: changing one would alter
 * the device's identity and cost it its history in the controller. Only a
 * value that would overflow falls back to a hashed form, which stays
 * deterministic and unique where a plain truncation would not — "…-gridImport"
 * and "…-gridExport" can trim to the same string.
 */
const serialFor = (value) => {
    if (value.length <= MAX_IDENTITY) return value;
    const digest = createHash('sha1').update(value).digest('hex').slice(0, 8);
    return `${value.slice(0, MAX_IDENTITY - 9)}-${digest}`;
};

/** Display names are labels rather than identity, so trimming is enough. */
const labelFor = (value) => (value.length <= MAX_IDENTITY ? value : value.slice(0, MAX_IDENTITY));

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
 * One periodic energy reading: how much crossed the meter over a stated period,
 * rather than a running total.
 *
 * Both timestamps are carried, which is the inverse of the cumulative rule.
 * Per the cluster spec, `startTimestamp` **shall be omitted** for cumulative
 * energy but **shall be indicated** for periodic once the server knows UTC
 * (Matter 1.6 Cluster § 2.12.5.2.2-3) — the period is the whole meaning of the
 * value, so a reading without it says nothing. The systime pair may be omitted
 * once UTC is known, so it is.
 *
 * EndTimestamp carries `min startTimestamp + 1` in the spec's own data model,
 * so a period must span at least a second and a zero-length one is rejected —
 * matter.js validates it and fails the whole accessory, not just the reading.
 * The floor is applied here rather than at each call site because every path
 * that builds one of these owes the same invariant.
 */
const periodic = (wattHours, from, to) => ({
    energy: milli(wattHours) ?? 0,
    startTimestamp: from,
    endTimestamp: Math.max(to, from + 1)
});

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
 * How much opening cumulative energy is worth saying out loud, in mWh.
 *
 * A controller derives each hourly bar by differencing the cumulative counter,
 * and it has no prior reading for a device it has never seen — the Home app
 * differences that first reading against zero, so whatever a sensor opens with
 * is charted as a single hour's energy. A sensor opening at 50 kWh is a 50 kWh
 * bar in tomorrow's chart, and nothing later in the log explains it. Say the
 * number at registration, where it can still be acted on.
 */
const OPENING_ENERGY_NOTICE = 1_000_000;

/**
 * Implied average power past which a step in a cumulative counter is not load,
 * in watts.
 *
 * A cumulative counter climbs with real flow, so a step in it is either a
 * genuine surge or a bookkeeping accident — a baseline that moved, a counter
 * file that was lost, a controller resuming after a gap it could not see. Only
 * the last of those ever surfaces, days later, as one absurd bar in a chart.
 * Power is the part that is physically bounded — a residential service is a
 * couple of hundred amps — so an implied power beyond this is the accident.
 */
const IMPLAUSIBLE_POWER = 50_000;

/**
 * Energy accumulated since an anchor. The counters underneath are monotonic, so
 * a negative difference means the anchor is stale rather than that energy flowed
 * backwards — report nothing rather than a negative period.
 */
const since = (total, anchor) => {
    if (typeof total !== 'number' || !Number.isFinite(total)) return 0;
    if (typeof anchor !== 'number' || !Number.isFinite(anchor)) return 0;
    return Math.max(0, total - anchor);
};

/** Kilowatt-hours from milliwatt-hours, for the log. */
const kwh = (milliWattHours) => `${(milliWattHours / 1_000_000).toFixed(1)} kWh`;

/** Watts, in the unit that keeps the number readable. */
const watts = (value) => (Math.abs(value) >= 10_000
    ? `${Math.round(value / 1000).toLocaleString('en-US')} kW`
    : `${Math.round(value)} W`);

/** The usable numbers out of an ElectricalEnergyMeasurement state. */
const energyValuesOf = (energy) => Object.fromEntries(
    Object.entries(energy ?? {})
        .map(([field, measurement]) => [field, measurement?.energy])
        .filter(([, value]) => typeof value === 'number' && Number.isFinite(value))
);

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
    constructor({ api, log, prefix = '', energyDeviceTypes = false, generationFor = () => 0 }) {
        this.api = api;
        this.log = log;
        this.prefix = prefix;
        this.energyDeviceTypes = energyDeviceTypes;

        // Folded into each accessory's identity, so bumping a sensor's
        // generation presents it as a new device and the controller starts a
        // fresh history for that sensor alone.
        this.generationFor = generationFor;

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
     * @param {object} [sensor] the registered sensor, when there is one. Only
     *        the periodic endpoint needs it: its value is a difference against
     *        what that sensor last published, which nothing else is.
     */
    buildClusters(kind, reading, sensor) {
        return {
            electricalPowerMeasurement: {
                voltage: milli(reading?.voltage),
                activeCurrent: milli(reading?.current),
                activePower: milli(powerFor(kind, reading))
            },
            electricalEnergyMeasurement: this.energyFor(kind, reading, sensor)
        };
    }

    /**
     * Which cumulative energy attributes a sensor declares. Homebridge picks the
     * feature-gated ElectricalEnergyMeasurement features from exactly this, at
     * registration, so whatever a sensor declares here is all it can ever report.
     *
     * The combined grid endpoint declares both directions, which is the shape
     * the Matter spec describes for a grid connection. What a controller then
     * makes of it has moved: an iOS 27 beta in August 2026 read only the
     * exported half and silently ignored 68 kWh of import, which is why
     * `gridSplit` exists; by September it was reading both, though it appears
     * to show their difference rather than gross import. `gridSplit` publishes
     * the same flow as two one-directional endpoints instead, leaving the
     * controller nothing to infer.
     */
    energyFor(kind, reading, sensor) {
        const at = nowEpochS();

        // Periodic energy: what crossed the meter since this sensor's last
        // report, so a controller has nothing to difference and nothing to
        // carry forward. The anchor advances only when a reading is actually
        // published — see update() — because a period has to end where the
        // next one begins, and energy goes out far less often than we poll.
        //
        // Declared alone, with no cumulative counter beside it: Homebridge
        // picks the cluster's features from what is declared at registration,
        // so this endpoint gets PeriodicEnergy and not CumulativeEnergy, and
        // whether the Home app populates it is then an unambiguous answer.
        if (kind === MeasurementKind.GridPeriodic) {
            const anchor = sensor?.periodicAnchor;
            // Registration has no previous period to follow, so it opens with
            // the second just gone: the shortest window the spec allows, over
            // which nothing is claimed to have flowed.
            const from = anchor?.at ?? at - 1;
            return {
                periodicEnergyImported: periodic(since(reading?.energyImported, anchor?.imported), from, at),
                periodicEnergyExported: periodic(since(reading?.energyExported, anchor?.exported), from, at)
            };
        }

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
            const number = this.generationFor(sensor.kind);
            const generation = number > 0 ? `:g${number}` : '';
            const uuid = matter.uuid.generate(`${PluginName}:${info.serialNumber}:${sensor.kind}${generation}`);

            const accessory = {
                UUID: uuid,
                displayName: labelFor(sensor.displayName),
                deviceType: this.deviceTypeFor(sensor.kind, matter),
                serialNumber: serialFor(`${info.serialNumber}-${sensor.kind}${generation}`),
                manufacturer: 'Enphase',
                model: info.modelName,
                firmwareRevision: info.software,
                context: { serialNumber: info.serialNumber, kind: sensor.kind },
                clusters: this.buildClusters(sensor.kind, sensor.reading)
            };
            accessories.push(accessory);

            this.sensors.set(sensor.kind, {
                uuid,
                kind: sensor.kind,
                displayName: sensor.displayName,
                lastEnergy: null,
                lastEnergyAt: 0,
                // Seeded from what the accessory is registered with, so the
                // first published update is measured against the opening value
                // rather than passing unchecked.
                energyValues: energyValuesOf(accessory.clusters.electricalEnergyMeasurement),
                energyValuesAt: Date.now(),
                // Where this sensor's first period begins. Registration reports
                // a zero-length period of zero energy, which is what declares
                // the attributes without inventing a reading for time before
                // the sensor existed.
                periodicAnchor: {
                    imported: sensor.reading?.energyImported ?? 0,
                    exported: sensor.reading?.energyExported ?? 0,
                    at: nowEpochS()
                }
            });
        }

        if (accessories.length === 0) {
            this.log.warn(`${this.prefix}No sensors enabled, nothing published to Matter.`);
            return false;
        }

        try {
            await matter.registerPlatformAccessories(PluginName, PlatformName, accessories);
            const names = accessories.map((accessory) => accessory.displayName).join(', ');
            this.log.info(`${this.prefix}Published to Matter as electrical sensors: ${names}. They appear in the Apple Home Energy view on iOS 27 and later.`);
            accessories.forEach((accessory) => this.reportOpeningEnergy(accessory));
            return true;
        } catch (error) {
            this.log.error(`${this.prefix}Failed to register Matter accessories: ${error.message ?? error}`);
            this.sensors.clear();
            return false;
        }
    }

    /**
     * Say what a sensor opened at, because that value is the first bar.
     *
     * Reported for every sensor at debug, and at info once it is large enough
     * to distort a chart — at which point it is also worth saying what to do
     * about it, since by the time the bar appears the reason is a day old and
     * two config changes back.
     */
    reportOpeningEnergy(accessory) {
        // Only cumulative opens at anything: a periodic sensor's first report
        // covers a zero-length period, so there is no opening bar to warn about
        // — which is the property the experiment is testing for.
        const values = Object.entries(energyValuesOf(accessory.clusters?.electricalEnergyMeasurement))
            .filter(([field]) => field.startsWith('cumulative'));
        if (values.length === 0) return;

        const summary = values.map(([field, value]) => `${field} ${kwh(value)}`).join(', ');
        const notable = values.some(([, value]) => value >= OPENING_ENERGY_NOTICE);
        if (!notable) {
            this.log.debug(`${this.prefix}${accessory.displayName} opens at ${summary}.`);
            return;
        }

        this.log.info(`${this.prefix}${accessory.displayName} opens at ${summary}. A controller that has not seen this device before has nothing to difference against, so the Home app records the opening value as a single hour of energy — one tall bar, which then sets the chart's axis. It is a one-off, and the bars after it are real. To open at zero instead, bump this sensor's resetHistory, which republishes it under a new identity.`);
    }

    /**
     * Watch a published counter for steps that are not load.
     *
     * The counters this plugin publishes are monotonic totals, and every bar a
     * controller draws is a difference between two of them. That makes a step
     * indistinguishable from an hour of enormous consumption once it reaches a
     * chart — so it is caught here, at the moment it is published, where the
     * size and the interval are both still known.
     */
    reportEnergyStep(sensor, energy, now) {
        const values = energyValuesOf(energy);
        const previous = sensor.energyValues;
        const elapsed = now - sensor.energyValuesAt;
        sensor.energyValues = values;
        sensor.energyValuesAt = now;
        if (!previous || elapsed <= 0) return;

        for (const [field, value] of Object.entries(values)) {
            // Cumulative counters only. A periodic reading is already a
            // difference, so it is not monotonic and falling is what it does
            // whenever less energy flowed than last period — differencing it
            // again would warn on ordinary behaviour.
            if (!field.startsWith('cumulative')) continue;

            const before = previous[field];
            if (typeof before !== 'number') continue;

            const delta = value - before;
            if (delta === 0) continue;

            // mWh over ms, as watts.
            const implied = delta * 3600 / elapsed;
            const step = `${sensor.displayName} ${field} ${kwh(value)}, ${delta > 0 ? '+' : ''}${kwh(delta)} in ${Math.round(elapsed / 1000)} s (${watts(implied)} implied)`;

            if (delta < 0) {
                this.log.warn(`${this.prefix}${step}. Cumulative energy went backwards, which Matter does not allow — a controller may discard readings until it climbs past what it saw before. The counter file or a baseline has probably been lost or rewritten.`);
            } else if (implied > IMPLAUSIBLE_POWER) {
                this.log.warn(`${this.prefix}${step}. That is not load. A controller charts a step like this as one hour's energy, so expect a tall bar. Usual causes: the counter file or a baseline changed underneath, or this sensor's history was reset.`);
            } else {
                this.log.debug(`${this.prefix}${step}.`);
            }
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
        const clusters = this.buildClusters(sensor.kind, reading, sensor);
        const updates = [matter.updateAccessoryState(sensor.uuid, 'electricalPowerMeasurement', clusters.electricalPowerMeasurement)];

        const energy = energyKey(clusters.electricalEnergyMeasurement);
        const now = Date.now();
        const changed = energy !== sensor.lastEnergy;
        const due = now - sensor.lastEnergyAt >= ENERGY_UPDATE_INTERVAL;
        const heartbeat = now - sensor.lastEnergyAt >= ENERGY_HEARTBEAT_INTERVAL;

        if ((changed && due) || heartbeat) {
            sensor.lastEnergy = energy;
            sensor.lastEnergyAt = now;
            this.reportEnergyStep(sensor, clusters.electricalEnergyMeasurement, now);
            // The period just reported ends here, so the next one starts here.
            // Advanced only on a publish: moving it every poll would report a
            // 30-second slice as if it were the whole minute.
            //
            // Taken from the timestamp actually published rather than a fresh
            // clock reading, so successive periods abut exactly — including
            // where the one-second floor moved the end forward. Reading the
            // clock again would leave a gap or an overlap whenever a second
            // ticked between building the reading and recording it.
            if (sensor.periodicAnchor) {
                const published = clusters.electricalEnergyMeasurement.periodicEnergyImported;
                sensor.periodicAnchor = {
                    imported: reading.energyImported ?? sensor.periodicAnchor.imported,
                    exported: reading.energyExported ?? sensor.periodicAnchor.exported,
                    at: published?.endTimestamp ?? nowEpochS()
                };
            }
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
