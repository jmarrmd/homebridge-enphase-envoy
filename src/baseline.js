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
 * counter already stands at, say, 41 MWh records the whole 41 MWh as one hour's
 * energy. The bar is meaningless, and because it sets the axis it makes every
 * real bar beside it unreadable for as long as it stays in the history.
 *
 * Subtracting the value seen when the sensor was first published fixes that:
 * the counter starts at zero and climbs with real flow. Nothing is lost,
 * because the absolute total is never displayed — only differences between
 * successive readings, which are identical either way. Matter asks only that
 * cumulative energy be monotonic, not that it count from the beginning of time.
 *
 * Generations
 * -----------
 * Baselines are tied to a generation number. Bumping it (`resetHistory` in
 * config) discards the stored baselines and changes the accessory UUIDs, so the
 * controller treats every sensor as new and starts a fresh history. Leaving it
 * alone keeps the existing baselines, because re-capturing them would rewind
 * counters the controller has already seen — the one thing that corrupts its
 * history.
 */

import { readJsonFile, writeJsonFileAtomic } from './jsonstore.js';

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);

/** Which reading field each baseline offsets. */
const FIELDS = [
    { key: 'production', reading: 'production', field: 'energyLifetime' },
    { key: 'consumption', reading: 'consumption', field: 'energyLifetime' },
    { key: 'gridImported', reading: 'grid', field: 'energyImported' },
    { key: 'gridExported', reading: 'grid', field: 'energyExported' }
];

class EnergyBaseline {
    /**
     * @param {object} options
     * @param {string} options.file       where to persist the baselines
     * @param {number} options.generation bump to start a fresh history
     */
    constructor({ file, generation = 0 }) {
        this.file = file;
        this.generation = generation;
        this.values = {};
        this.dirty = false;
    }

    /** Whether offsets apply at all. Generation 0 publishes raw gateway totals. */
    get enabled() {
        return this.generation > 0;
    }

    /**
     * Restore baselines captured under this generation.
     *
     * @returns {Promise<{status: 'restored'|'absent'|'reset'|'unreadable', error: string|null}>}
     *   'reset' means the stored baselines belonged to an earlier generation and
     *   were discarded, which is what bumping `resetHistory` is meant to do.
     */
    async load() {
        if (!this.enabled) return { status: 'absent', error: null };

        const { status, data, error } = await readJsonFile(this.file);
        if (status === 'absent') return { status: 'absent', error: null };
        if (status !== 'ok') return { status: 'unreadable', error };

        if (data?.generation !== this.generation) return { status: 'reset', error: null };

        for (const { key } of FIELDS) {
            if (isNumber(data?.values?.[key])) this.values[key] = data.values[key];
        }
        return { status: 'restored', error: null };
    }

    /**
     * Offset one set of readings, capturing any baseline not yet seen.
     *
     * Clamped at zero: a gateway whose lifetime register is reset would
     * otherwise drive the offset negative, and cumulative energy may not go
     * backwards.
     *
     * @param {object} readings `{ production, consumption, grid }`
     * @returns {object} the same shape, with energy fields offset
     */
    apply(readings) {
        if (!this.enabled) return readings;

        const adjusted = { ...readings };
        for (const { key, reading, field } of FIELDS) {
            const source = readings?.[reading];
            const value = source?.[field];
            if (!source || !isNumber(value)) continue;

            if (!isNumber(this.values[key])) {
                this.values[key] = value;
                this.dirty = true;
            }

            adjusted[reading] = { ...(adjusted[reading] ?? source), [field]: Math.max(0, value - this.values[key]) };
        }
        return adjusted;
    }

    /** @returns {Promise<string|null>} an error message if the save failed */
    async save() {
        if (!this.enabled || !this.dirty) return null;

        const error = await writeJsonFileAtomic(this.file, {
            generation: this.generation,
            values: this.values,
            savedAt: new Date().toISOString()
        });
        if (!error) this.dirty = false;
        return error;
    }
}

export default EnergyBaseline;
