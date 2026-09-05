/**
 * baseline.js
 *
 * Publishes cumulative energy as "since this sensor went live" rather than
 * "since the gateway was commissioned".
 *
 * Why this exists
 * ---------------
 * A controller derives each bar by differencing the cumulative counter, and it
 * has no prior reading for a device it has never seen. The Home app appears to
 * difference that first reading against zero, so a brand-new sensor whose
 * counter already stands at 41 MWh records the whole 41 MWh as one hour's
 * energy. The bar is meaningless, and because it sets the axis it makes every
 * real bar beside it unreadable for as long as it stays in the history.
 *
 * Subtracting the value seen when the sensor was first published fixes that:
 * the counter starts at zero and climbs with real flow. Nothing is lost,
 * because the absolute total is never displayed — only differences between
 * successive readings, which are identical either way. Matter asks only that
 * cumulative energy be monotonic, not that it count from the beginning of time.
 *
 * Generations, per sensor
 * -----------------------
 * Each sensor carries its own generation number. Bumping one (`resetHistory`,
 * or `resetHistoryPerSensor` for a single sensor) discards that sensor's
 * baselines and changes its accessory UUID, so the controller treats it as a
 * new device and starts a fresh history — while every other sensor keeps the
 * history it has.
 *
 * Baselines are therefore keyed by sensor *and* field, not by field alone:
 * grid import, grid export and the combined grid endpoint all read the same two
 * counters, so resetting one of them must not disturb the others.
 *
 * Re-capturing a baseline at an unchanged generation would rewind a counter the
 * controller has already seen, which is the one thing that corrupts its
 * history. Capture happens only when a sensor's generation actually changes.
 */

import { readJsonFile, writeJsonFileAtomic } from './jsonstore.js';

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);

/** Energy fields a reading may carry. Power is never offset. */
const ENERGY_FIELDS = ['energyLifetime', 'energyImported', 'energyExported'];

/**
 * v1.7.0 stored one generation and four field-keyed baselines, applied to the
 * shared reading before it was fanned out. Map those onto every sensor that
 * consumed them, so upgrading does not rewind a counter mid-generation.
 */
const LEGACY_KEYS = {
    production: ['production:energyLifetime', 'productionCombined:energyLifetime'],
    consumption: ['consumption:energyLifetime'],
    gridImported: ['grid:energyImported', 'gridImport:energyImported', 'productionCombined:energyImported'],
    gridExported: ['grid:energyExported', 'gridExport:energyExported']
};

class EnergyBaseline {
    /**
     * @param {object} options
     * @param {string} options.file          where to persist the baselines
     * @param {number} options.generation    default generation for every sensor
     * @param {object} options.perSensor     per-kind overrides, `{kind: number}`
     */
    constructor({ file, generation = 0, perSensor = {} }) {
        this.file = file;
        this.generation = generation;
        this.perSensor = perSensor;
        this.entries = {};
        this.dirty = false;
    }

    /**
     * The generation a sensor publishes under. An override wins outright.
     *
     * Coerced rather than type-checked: a config UI may write an integer field
     * as the string "1", and silently ignoring that would turn a reset the user
     * asked for into a no-op with nothing in the log to explain it. An unset
     * field — absent, null or empty — falls back to the global generation.
     */
    generationFor(kind) {
        const raw = this.perSensor?.[kind];
        if (raw === undefined || raw === null || raw === '') return this.generation;

        const override = Number(raw);
        return Number.isFinite(override) ? Math.max(0, Math.trunc(override)) : this.generation;
    }

    /** Whether any sensor is offset at all. */
    get enabled() {
        if (this.generation > 0) return true;
        return Object.keys(this.perSensor ?? {}).some((kind) => this.generationFor(kind) > 0);
    }

    /**
     * Restore stored baselines.
     *
     * @returns {Promise<{status: 'restored'|'absent'|'unreadable', error: string|null}>}
     */
    async load() {
        const { status, data, error } = await readJsonFile(this.file);
        if (status === 'absent') return { status: 'absent', error: null };
        if (status !== 'ok') return { status: 'unreadable', error };

        if (data?.entries && typeof data.entries === 'object') {
            for (const [key, entry] of Object.entries(data.entries)) {
                if (isNumber(entry?.generation) && isNumber(entry?.value)) this.entries[key] = { ...entry };
            }
            return { status: 'restored', error: null };
        }

        // v1.7.0 shape.
        if (isNumber(data?.generation) && data?.values && typeof data.values === 'object') {
            for (const [legacy, keys] of Object.entries(LEGACY_KEYS)) {
                const value = data.values[legacy];
                if (!isNumber(value)) continue;
                for (const key of keys) this.entries[key] = { generation: data.generation, value };
            }
            this.dirty = true;
            return { status: 'restored', error: null };
        }

        return { status: 'unreadable', error: 'no usable baselines in the stored file' };
    }

    /**
     * Offset one sensor's reading, capturing baselines the first time that
     * sensor is seen at its current generation.
     *
     * Clamped at zero: a gateway whose lifetime register is reset would
     * otherwise drive the offset negative, and cumulative energy may not go
     * backwards.
     *
     * @param {string} kind    one of MeasurementKind
     * @param {object|null} reading
     * @returns {object|null} the reading, offset where it carries energy
     */
    apply(kind, reading) {
        const generation = this.generationFor(kind);
        if (!reading || generation <= 0) return reading;

        let adjusted = reading;
        for (const field of ENERGY_FIELDS) {
            const value = reading[field];
            if (!isNumber(value)) continue;

            const key = `${kind}:${field}`;
            const stored = this.entries[key];
            if (stored?.generation !== generation) {
                this.entries[key] = { generation, value };
                this.dirty = true;
            }

            if (adjusted === reading) adjusted = { ...reading };
            adjusted[field] = Math.max(0, value - this.entries[key].value);
        }
        return adjusted;
    }

    /** @returns {Promise<string|null>} an error message if the save failed */
    async save() {
        if (!this.dirty) return null;

        const error = await writeJsonFileAtomic(this.file, {
            entries: this.entries,
            savedAt: new Date().toISOString()
        });
        if (!error) this.dirty = false;
        return error;
    }
}

export default EnergyBaseline;
