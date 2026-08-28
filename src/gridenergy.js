/**
 * gridenergy.js
 *
 * Turns a series of instantaneous grid-power samples into the two monotonic
 * counters Matter wants: cumulative energy imported from the grid and exported
 * to it.
 *
 * Why this exists
 * ---------------
 * The gateway reports grid flow as a single *signed* power (positive drawing
 * from the utility, negative pushing back) and, for lifetime energy, a single
 * signed net figure. A signed net cannot be split back into separate import and
 * export totals — net zero could be "nothing ever happened" or "imported 100 and
 * exported 100" — so the two counters have to be accumulated as we watch.
 *
 * Accuracy
 * --------
 * This is a Riemann sum over the poll interval, so it is an approximation, and
 * load swings between samples are invisible to it. It is strictly worse than
 * reading the gateway's own hardware counters, and is the fallback for when
 * those are not available. Two things keep it honest:
 *
 *   - Trapezoidal rather than rectangular integration, with the interval split
 *     at the zero crossing when flow reverses mid-interval, so a sample pair
 *     that straddles zero contributes to both counters rather than to whichever
 *     sign happened to win.
 *   - A gap longer than `maxGapMs` is skipped rather than integrated. If the
 *     plugin was down for six hours, that energy is genuinely unknown; holding
 *     the last power across the gap would invent a large number.
 *
 * Persistence
 * -----------
 * Counters are restored from disk on start. Matter treats cumulative energy as
 * monotonic, so a restart that reset them to zero would make the counters jump
 * backwards and corrupt the Home app's history.
 */

import { promises as fsPromises } from 'fs';

const MS_PER_HOUR = 3_600_000;

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);

class GridEnergy {
    /**
     * @param {object} options
     * @param {string} options.file    where to persist the counters
     * @param {number} options.maxGapMs longest interval still worth integrating
     */
    constructor({ file, maxGapMs = 300_000 }) {
        this.file = file;
        this.maxGapMs = maxGapMs;

        this.imported = 0;   // Wh drawn from the grid, monotonic
        this.exported = 0;   // Wh sent to the grid, monotonic
        this.lastPower = null;
        this.lastAt = null;
        this.dirty = false;
    }

    /** Restore counters written by a previous run. Absent or unreadable = start at zero. */
    async load() {
        try {
            const saved = JSON.parse(await fsPromises.readFile(this.file, 'utf8'));
            if (isNumber(saved.imported)) this.imported = saved.imported;
            if (isNumber(saved.exported)) this.exported = saved.exported;
            return true;
        } catch {
            return false;
        }
    }

    async save() {
        if (!this.dirty) return;
        try {
            await fsPromises.writeFile(this.file, JSON.stringify({
                imported: this.imported,
                exported: this.exported,
                savedAt: new Date().toISOString()
            }, null, 2));
            this.dirty = false;
        } catch {
            // A failed save costs accuracy across a restart, never correctness
            // of the running counters; the next save will try again.
        }
    }

    /**
     * Fold one grid-power sample into the counters.
     *
     * @param {number} power  signed watts: positive importing, negative exporting
     * @param {number} now    epoch ms for this sample
     * @returns {{imported: number, exported: number}} Wh, monotonic
     */
    sample(power, now = Date.now()) {
        if (!isNumber(power)) return this.totals();

        const previousPower = this.lastPower;
        const previousAt = this.lastAt;
        this.lastPower = power;
        this.lastAt = now;

        // First sample after start or after a gap: nothing to integrate over.
        if (!isNumber(previousPower) || !isNumber(previousAt)) return this.totals();

        const elapsed = now - previousAt;
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

    totals() {
        return { imported: this.imported, exported: this.exported };
    }
}

export default GridEnergy;
