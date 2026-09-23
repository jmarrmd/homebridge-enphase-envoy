import { test } from 'node:test';
import assert from 'node:assert/strict';
import EnvoyClient from '../src/envoyclient.js';
import {
    startGateway, tempFile, withClock,
    CT_LIFETIME, PRODUCTION_PER_POLL, EXPORT_PER_POLL
} from './gateway.js';

/** Poll a scripted gateway `polls` times at 30 s spacing. */
async function run(script, polls = 20) {
    const gateway = await startGateway(script);
    const client = new EnvoyClient({ host: gateway.host, tokenMode: 0, gridFile: tempFile('grid.json') });
    const warnings = [];
    client.on('warn', (message) => warnings.push(message));

    try {
        await client.connect();
        const readings = await withClock(async ({ tick }) => {
            const out = [];
            for (let i = 0; i < polls; i++) {
                out.push(await client.readEnergy());
                tick();
            }
            return out;
        });
        return { client, readings, warnings };
    } finally {
        await gateway.close();
    }
}

/** Grid totals after the last poll, against what actually crossed the meter. */
function assertGridTruth(readings, exportedPolls) {
    const grid = readings.at(-1).grid;
    assert.equal(grid.energyImported, 0, 'nothing was imported — the array out-produced the house on every poll');
    assert.ok(Math.abs(grid.energyExported - EXPORT_PER_POLL * exportedPolls) < 0.01,
        `exported ${grid.energyExported} Wh, expected ${EXPORT_PER_POLL * exportedPolls}`);
}

test('a healthy gateway: production from the CT, grid export only', async () => {
    const { client, readings } = await run(() => ({}));

    assert.equal(client.energySource.production, 'eim');
    assert.equal(readings[0].production.energyLifetime, CT_LIFETIME);
    assert.ok(readings.every((r) => r.statsRead));
    assertGridTruth(readings, 19);
});

test('a failed first /production.json does not pin production to the fallback', async () => {
    const { client, readings } = await run((n) => (n === 0 ? 'fail' : {}));

    // The failed poll says nothing about consumption or grid, and does not
    // publish the fallback's (different) lifetime register.
    assert.equal(readings[0].statsRead, false);
    assert.equal(readings[0].consumption, null);
    assert.equal(readings[0].production.energyLifetime, null);

    // Once it answers, production is the CT's and keeps counting.
    assert.equal(client.energySource.production, 'eim');
    assert.equal(readings[1].production.energyLifetime, CT_LIFETIME + PRODUCTION_PER_POLL);
    assert.ok(readings.at(-1).production.energyLifetime > readings[1].production.energyLifetime);
    assertGridTruth(readings, 18);
});

test('a failed /production.json mid-run leaves the grid counters untouched, then catches up', async () => {
    const { readings, warnings } = await run((n) => (n >= 8 && n < 12 ? 'fail' : {}));

    for (const r of readings.slice(8, 12)) {
        assert.equal(r.statsRead, false);
        assert.equal(r.grid, null, 'a poll without registers publishes no grid reading');
    }
    assertGridTruth(readings, 19);
    assert.deepEqual(warnings, [], 'the stand-in turning up is routine, not a warning');
});

test('a production total missing mid-run does not become phantom import', async () => {
    const { readings, warnings } = await run((n) => ({ omitTotal: n >= 8 && n < 13 }));

    assertGridTruth(readings, 19);
    assert.ok(!warnings.some((w) => w.includes('Refused')), 'the catch-up is ordinary and must not be refused');
});

test('a production total missing at startup is held, not published from the lines sum', async () => {
    const { client, readings } = await run((n) => ({ omitTotal: n < 5 }));

    for (const r of readings.slice(0, 5)) assert.equal(r.production.energyLifetime, null);
    assert.equal(readings[5].production.energyLifetime, CT_LIFETIME + PRODUCTION_PER_POLL * 5);
    assert.equal(client.energyTotalSeen.production, true);
    assertGridTruth(readings, 14);
});

test('a gateway that only ever answers the fallback settles on it', async () => {
    const { client, readings } = await run(() => 'fail', 12);

    assert.equal(client.energySource.production, 'fallback');
    assert.equal(readings[8].production.energyLifetime, null);
    assert.equal(typeof readings[9].production.energyLifetime, 'number');
    assert.ok(readings.every((r) => r.consumption === null && r.grid === null));
});
