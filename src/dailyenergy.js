/**
 * dailyenergy.js
 *
 * Closes out the grid counters once a local day and reports what moved, so the
 * plugin's own integration can be checked against a figure from somewhere else
 * — the Enphase app's daily Imported / Exported, or a utility bill.
 *
 * Why this exists
 * ---------------
 * The counters in `gridenergy.js` are monotonic lifetime totals, which is what
 * Matter wants and what a controller differences into hourly bars. Nothing in
 * the log says what a *day* came to, so verifying the integration meant
 * catching the counter file at midnight by hand.
 *
 * It also answers a question the lifetime totals cannot: our counters are
 * gross-directional — energy that flowed in, and energy that flowed out,
 * accumulated separately — which is the same definition the Enphase app uses
 * for Imported and Exported. Its "Net Imported" row is just the difference. If
 * a controller displays something closer to the difference than to our import
 * figure, that is the controller netting the two, not the counters.
 *
 * Honesty about the window
 * ------------------------
 * A day is only comparable to somebody else's day if it covers the whole of it,
 * so the summary carries two caveats and the caller prints them:
 *
 *   - `whole` is false for the first day after a fresh start, where counting
 *     began partway through.
 *   - `gapMs` accumulates time the plugin was not sampling. `gridenergy.js`
 *     skips a long gap rather than integrating across it — energy that flowed
 *     while Homebridge was down is genuinely unknown — so a day with a gap
 *     under-reports by however much crossed the meter during it.
 *
 * The mark is persisted for the same reason the counters are: a restart at
 * 4 p.m. would otherwise start the day over and report eight hours as a day.
 */

import { readJsonFile, writeJsonFileAtomic } from './jsonstore.js';

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);

/**
 * The local calendar day, as YYYY-MM-DD. `en-CA` formats in that order, and
 * asking the runtime for local time is what makes the boundary land on the
 * user's midnight rather than on UTC's.
 */
const localDay = (at) => new Date(at).toLocaleDateString('en-CA');

/**
 * How stale the "last sampled at" mark may get on disk.
 *
 * It is only written when the file is being written anyway, so an unclean
 * shutdown leaves it up to this far behind — and the next start would read that
 * as time the plugin was down. Kept well under the gap threshold so a bounded
 * amount of staleness can never be mistaken for a real absence, and rare enough
 * that a 30-second poll does not rewrite the file every time.
 */
const SEEN_PERSIST_INTERVAL = 60_000;

class DailyEnergy {
    /**
     * @param {object} options
     * @param {string} options.file    where to persist the day mark
     * @param {number} options.gapMs   a quiet period longer than this counts as
     *                                 time not measured, matching the gap the
     *                                 integrator refuses to integrate across
     */
    constructor({ file, gapMs = 300_000 }) {
        this.file = file;
        this.gapMs = gapMs;
        this.mark = null;
        this.persistedSeenAt = null;
        this.dirty = false;
    }

    /**
     * Restore the open day.
     *
     * A missing or unusable file costs one day's accuracy — the next day is
     * reported as partial — and never corrupts anything, so unlike the grid
     * counters this does not need to be loud about it.
     *
     * @returns {Promise<{status: 'restored'|'absent'|'unreadable', error: string|null}>}
     */
    async load() {
        const { status, data, error } = await readJsonFile(this.file);
        if (status === 'absent') return { status: 'absent', error: null };
        if (status !== 'ok') return { status: 'unreadable', error };

        const mark = data?.mark;
        if (typeof mark?.day !== 'string' || !isNumber(mark.imported) || !isNumber(mark.exported)) {
            return { status: 'unreadable', error: 'no usable day mark in the stored file' };
        }

        this.mark = {
            day: mark.day,
            imported: mark.imported,
            exported: mark.exported,
            at: isNumber(mark.at) ? mark.at : Date.now(),
            seenAt: isNumber(mark.seenAt) ? mark.seenAt : null,
            gapMs: isNumber(mark.gapMs) ? mark.gapMs : 0,
            whole: mark.whole === true
        };
        this.persistedSeenAt = this.mark.seenAt;
        return { status: 'restored', error: null };
    }

    /**
     * Fold one counter reading in, closing the previous day if this reading is
     * the first of a new one.
     *
     * Deltas are reported as measured, including a negative one. That can only
     * happen if a monotonic counter went backwards — a lost or rewound counter
     * file — and hiding it behind a clamp would remove the one place it shows.
     *
     * @param {{imported: number, exported: number}} totals lifetime Wh
     * @param {number} now epoch ms
     * @param {object} [options]
     * @param {boolean} [options.spansGaps] whether the counters cover time the
     *        plugin was not sampling. True where they are measured from the
     *        gateway's registers, which keep counting while we are stopped —
     *        there is then no unmeasured time to report, and saying otherwise
     *        would tell you a whole day was suspect when it was not.
     * @returns {object|null} the closed day, or null while the day continues
     */
    sample(totals, now = Date.now(), { spansGaps = false } = {}) {
        if (!isNumber(totals?.imported) || !isNumber(totals?.exported)) return null;

        const day = localDay(now);
        if (!this.mark) {
            this.reset(day, totals, now, false);
            return null;
        }

        // Time between samples that the integrator would have skipped is time
        // this day did not measure. Counted before the rollover so it lands on
        // the day the plugin was actually absent for.
        if (!spansGaps && isNumber(this.mark.seenAt) && now - this.mark.seenAt > this.gapMs) {
            this.mark.gapMs += now - this.mark.seenAt;
            this.dirty = true;
        }

        if (this.mark.day === day) {
            this.mark.seenAt = now;
            if (now - (this.persistedSeenAt ?? 0) > SEEN_PERSIST_INTERVAL) this.dirty = true;
            return null;
        }

        const closed = {
            day: this.mark.day,
            imported: totals.imported - this.mark.imported,
            exported: totals.exported - this.mark.exported,
            whole: this.mark.whole,
            gapMs: this.mark.gapMs
        };

        // The new day begins where this one ended, so nothing falls between
        // them, and it is whole by construction — it started at a rollover.
        this.reset(day, totals, now, true);
        return closed;
    }

    reset(day, totals, now, whole) {
        this.mark = {
            day,
            imported: totals.imported,
            exported: totals.exported,
            at: now,
            seenAt: now,
            gapMs: 0,
            whole
        };
        this.dirty = true;
    }

    /** @returns {Promise<string|null>} an error message if the save failed */
    async save() {
        if (!this.dirty) return null;

        const error = await writeJsonFileAtomic(this.file, {
            mark: this.mark,
            savedAt: new Date().toISOString()
        });
        if (!error) {
            this.dirty = false;
            this.persistedSeenAt = this.mark?.seenAt ?? null;
        }
        return error;
    }
}

export default DailyEnergy;
