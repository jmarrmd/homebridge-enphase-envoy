import { test } from 'node:test';
import assert from 'node:assert/strict';
import GridEnergy from '../src/gridenergy.js';
import { tempFile } from './gateway.js';

const MINUTE = 60_000;

test('register increments are sorted into import and export by sign', () => {
    const grid = new GridEnergy({ file: tempFile('grid.json') });
    grid.sample({ netEnergy: 1000 }, 0);
    grid.sample({ netEnergy: 1050 }, MINUTE);      // +50 Wh drawn
    grid.sample({ netEnergy: 1020 }, 2 * MINUTE);  // -30 Wh sent
    assert.deepEqual(grid.totals(), { imported: 50, exported: 30 });
});

test('an increment implying impossible power is refused', () => {
    const grid = new GridEnergy({ file: tempFile('grid.json') });
    grid.sample({ netEnergy: 0 }, 0);
    grid.sample({ netEnergy: 23_000 }, MINUTE);
    assert.deepEqual(grid.totals(), { imported: 0, exported: 0 });
    assert.equal(grid.takeSkipped().delta, 23_000);
});

test('the last register reading survives a restart, and a long gap still counts', async () => {
    const file = tempFile('grid.json');
    const before = new GridEnergy({ file });
    before.sample({ netEnergy: 1000 }, 0);
    await before.save();

    const after = new GridEnergy({ file });
    assert.equal((await after.load()).status, 'restored');
    after.sample({ netEnergy: 4000 }, 6 * 60 * MINUTE);  // 3 kWh over six hours
    assert.deepEqual(after.totals(), { imported: 3000, exported: 0 });
});
