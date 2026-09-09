/**
 * gridenergy.js
 *
 * Keeps the two monotonic counters Matter wants — energy imported from the
 * grid and energy exported to it — for a gateway that reports neither.
 *
 * Why this exists
 * ---------------
 * The gateway has registers for production and for house load, but nothing for
 * either grid direction, and the split cannot be recovered after the fact: a
 * lifetime net of 16.1 MWh is equally consistent with "imported 16.1, exported
 * 0" and "imported 50, exported 34". You have to have been watching. So the two
 * totals are accumulated here and persisted, because they exist nowhere else.
 *
 * Where the numbers come from
 * ---------------------------
 * Two sources, in order of preference.
 *
 * **Measured** — house load minus production, both read from the gateway's own
 * accumulated registers. The *difference* between two readings is the net
 * energy that actually crossed the service entrance over that interval, and it
 * is measured rather than estimated. This module then does one job: sort each
 * increment into the right bucket by sign. It is a bookkeeper, not a meter.
 *
 * **Integrated** — a Riemann sum over instantaneous power, used when house load
 * is reconstructed rather than measured (no total-consumption CT), in which
 * case the subtraction above collapses to the gateway's own signed net register
 * and tells us nothing new. This is the older, weaker path, kept so those
 * gateways still get a grid sensor rather than none.
 *
 * Why the measured path is worth the branch
 * -----------------------------------------
 * Integrating power means trusting `wNow` on every poll, unbounded. A single
 * transient reading of a few hundred kW fabricates tens of kWh, and nothing
 * downstream can tell that from real flow — measured on a live gateway as a
 * 23 kWh "export" at five in the morning. A register cannot do that: it only
 * ever climbs, by the amount that actually crossed it.
 *
 * It also spans downtime. The registers keep counting while the plugin is
 * stopped, so the first reading after a restart carries the whole gap — which
 * is why the last one is persisted alongside the counters. The integrated path
 * has no such luxury and skips a gap rather than inventing across it.
 *
 * What is still approximate, either way
 * -------------------------------------
 * Direction is resolved per interval, so a poll window that swings both ways is
 * credited entirely to whichever direction netted. Gross import and gross
 * export each read slightly low; their difference is exact.
 */

import { readJsonFile, writeJsonFileAtomic } from './jsonstore.js';

const MS_PER_HOUR = 3_600_000;

/**
 * Implied power beyond which a measured increment is refused, in watts.
 *
 * A register normally climbs by what crossed it, but a gateway swapped, reset
 * or reporting nonsense could step it. Skipping costs that one interval;
 * recording it corrupts a monotonic counter permanently, which no later reading
 * can undo. Implied power is the right test because it scales with the interval
 * — a long gap legitimately carries a large increment at ordinary power.
 */
const IMPLAUSIBLE_POWER = 25_000;

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);

class GridEnergy {
    /**
     * @param {object} options
     * @param {string} options.file    where to persist the counters
     * @param {number} options.maxGapMs longest interval still worth integrating,
     *        on the integrated path only. The measured path has no such limit:
     *        a register difference covers the gap by itself.
     */
    constructor({ file, maxGapMs = 300_000 }) {
        this.file = file;
        this.maxGapMs = maxGapMs;

        this.imported = 0;   // Wh drawn from the grid, monotonic
        this.exported = 0;   // Wh sent to the grid, monotonic

        // Measured path: the last net register reading and when it was taken,
        // both persisted. The reading is what a restart differences against, so
        // the gap is attributed rather than lost. The timestamp is what scales
        // the plausibility check — without it the first increment after a
        // restart went unguarded, and a register that reset while the plugin
        // was down would have been credited in full. A genuine gap still
        // passes: hours of elapsed time make even a large increment imply
        // ordinary power.
        this.lastNet = null;
        this.lastNetAt = null;

        // Integrated path: the last power sample. Deliberately not persisted —
        // holding a stale power across a restart would invent energy, and the
        // path that needs it is the one that cannot span gaps anyway.
        //
        // Kept separate from the measured path's clock so neither disturbs the
        // other, and so an unreadable sample can leave this one untouched.
        this.lastPower = null;
        this.lastAt = null;

        /** @type {'measured'|'integrated'|null} which path last did the work */
        this.source = null;

        /** @type {object|null} an increment refused as implausible, for the caller to log */
        this.skipped = null;

        this.dirty = false;
    }

    /**
     * Restore counters written by a previous run.
     *
     * A missing file is an ordinary first run. Anything else — unparseable
     * JSON, unreadable file, numbers that are not numbers — silently rewinds
     * both counters to zero, which a controller sees as a monotonic counter
     * going backwards. It has no way to tell that from a fault, so it may
     * discard readings until the counter climbs past its old high-water mark.
     * That is invisible for days, so say so rather than swallowing it.
     *
     * @returns {Promise<{status: 'restored'|'absent'|'unreadable', error: string|null}>}
     */
    async load() {
        const { status, data, error } = await readJsonFile(this.file);
        if (status !== 'ok') return { status: status === 'absent' ? 'absent' : 'unreadable', error };

        const imported = isNumber(data?.imported);
        const exported = isNumber(data?.exported);
        if (!imported && !exported) {
            return { status: 'unreadable', error: 'no usable counters in the stored file' };
        }

        if (imported) this.imported = data.imported;
        if (exported) this.exported = data.exported;

        // Absent in files written before the measured path existed, and absent
        // whenever the integrated path wrote them. Either way the next reading
        // seeds it and one interval goes unattributed.
        if (isNumber(data?.lastNet)) this.lastNet = data.lastNet;
        if (isNumber(data?.lastNetAt)) this.lastNetAt = data.lastNetAt;

        return { status: 'restored', error: null };
    }

    /**
     * Persist the counters, writing to a temporary file and renaming it over
     * the real one. Rename is atomic within a filesystem, so a crash or power
     * cut mid-save leaves the previous good file instead of a half-written one
     * — a truncated file would fail to parse on the next start and rewind both
     * counters to zero.
     *
     * @returns {Promise<string|null>} an error message if the save failed
     */
    async save() {
        if (!this.dirty) return null;

        const error = await writeJsonFileAtomic(this.file, {
            imported: this.imported,
            exported: this.exported,
            lastNet: this.lastNet,
            lastNetAt: this.lastNetAt,
            savedAt: new Date().toISOString()
        });
        // A single failed save costs accuracy across a restart, never
        // correctness of the running counters, and the next save retries.
        // A persistent one rewinds them on every restart, so report it.
        if (!error) this.dirty = false;
        return error;
    }

    /**
     * Fold one reading into the counters.
     *
     * @param {object} reading
     * @param {number|null} reading.netEnergy signed Wh across the service
     *        entrance, from the gateway's registers: positive means the house
     *        has drawn more than the array produced. Null where unavailable,
     *        which selects the integrated path.
     * @param {number|null} reading.power signed watts, positive importing.
     * @param {number} now epoch ms for this reading
     * @returns {{imported: number, exported: number}} Wh, monotonic
     */
    sample({ netEnergy = null, power = null } = {}, now = Date.now()) {
        return isNumber(netEnergy)
            ? this.measure(netEnergy, now)
            : this.integrate(power, now);
    }

    /**
     * Measured path: attribute the change in the net register since we last
     * looked. No time limit — the register counted through whatever gap there
     * was — but an increment implying impossible power is refused rather than
     * written into a counter that can never walk it back.
     */
    measure(netEnergy, now) {
        this.source = 'measured';

        const elapsed = isNumber(this.lastNetAt) ? now - this.lastNetAt : null;
        this.lastNetAt = now;

        const previous = this.lastNet;
        this.lastNet = netEnergy;

        // First reading of this run: nothing to difference against.
        if (!isNumber(previous)) {
            this.dirty = true;
            return this.totals();
        }

        const delta = netEnergy - previous;
        if (delta === 0) return this.totals();

        if (isNumber(elapsed) && elapsed > 0) {
            const implied = Math.abs(delta) * MS_PER_HOUR / elapsed;
            if (implied > IMPLAUSIBLE_POWER) {
                this.skipped = { delta, implied, elapsed };
                this.dirty = true;
                return this.totals();
            }
        }

        this.credit(delta);
        this.dirty = true;
        return this.totals();
    }

    /**
     * Integrated path: a Riemann sum over the poll interval, kept for gateways
     * whose house load is reconstructed rather than measured.
     *
     * A gap longer than `maxGapMs` is skipped rather than integrated. If the
     * plugin was down for six hours that energy is genuinely unknown, and
     * holding the last power across the gap would invent a large number.
     */
    integrate(power, now) {
        this.source = 'integrated';

        // An unreadable sample says nothing, so it must not move the clock
        // either: the last known power is assumed to have continued, and the
        // next usable reading integrates across the whole span. Advancing here
        // would silently discard the energy either side of the gap.
        if (!isNumber(power)) return this.totals();

        const previousPower = this.lastPower;
        const elapsed = isNumber(this.lastAt) ? now - this.lastAt : null;
        this.lastPower = power;
        this.lastAt = now;

        if (!isNumber(previousPower) || !isNumber(elapsed)) return this.totals();
        if (elapsed <= 0 || elapsed > this.maxGapMs) return this.totals();

        this.accumulate(previousPower, power, elapsed / MS_PER_HOUR);
        this.dirty = true;
        return this.totals();
    }

    /**
     * Integrate power over one interval, treating it as a straight line from p0
     * to p1, and credit each side of zero to its own counter.
     */
    accumulate(p0, p1, hours) {
        if (p0 >= 0 && p1 >= 0) {
            this.imported += (p0 + p1) / 2 * hours;
            return;
        }
        if (p0 <= 0 && p1 <= 0) {
            this.exported += -(p0 + p1) / 2 * hours;
            return;
        }

        // Flow reversed mid-interval. Split at the crossing so each triangle
        // lands on the correct counter instead of both going to one side.
        const crossing = hours * p0 / (p0 - p1);
        this.credit(p0 * crossing / 2);
        this.credit(p1 * (hours - crossing) / 2);
    }

    credit(energy) {
        if (energy >= 0) this.imported += energy;
        else this.exported += -energy;
    }

    /** The last refused increment, for the caller to log. Cleared when read. */
    takeSkipped() {
        const skipped = this.skipped;
        this.skipped = null;
        return skipped;
    }

    totals() {
        return { imported: this.imported, exported: this.exported };
    }
}

export default GridEnergy;
