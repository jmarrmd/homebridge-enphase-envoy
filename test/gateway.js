/**
 * A fake IQ Gateway for tests: serves /info.xml, /production.json and
 * /api/v1/production from a scripted sequence, so the real client can be
 * driven through the failures seen on live gateways.
 */

import http from 'http';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const INFO = '<?xml version="1.0"?><envoy_info><device><sn>122233445566</sn><pn>800-00654-r08</pn>'
    + '<software>D5.0.62</software><imeter>1</imeter></device></envoy_info>';

/** A daytime house: the array makes 5 kW, the house draws 2 kW, 3 kW is exported. */
export const POLL_MS = 30_000;
export const PRODUCTION_PER_POLL = 5000 * POLL_MS / 3_600_000;
export const CONSUMPTION_PER_POLL = 2000 * POLL_MS / 3_600_000;
export const EXPORT_PER_POLL = PRODUCTION_PER_POLL - CONSUMPTION_PER_POLL;

export const CT_LIFETIME = 42_545_000;
export const INVERTER_LIFETIME = 81_400_000;

/** /production.json for poll n. */
export function stats(n, { omitTotal = false } = {}) {
    const eim = {
        type: 'eim', activeCount: 1, measurementType: 'production', wNow: 5000,
        whLifetime: CT_LIFETIME + PRODUCTION_PER_POLL * n,
        lines: [
            { whLifetime: 21_000_000 + PRODUCTION_PER_POLL * n / 2 },
            { whLifetime: 21_000_000 + PRODUCTION_PER_POLL * n / 2 }
        ]
    };
    if (omitTotal) delete eim.whLifetime;

    return {
        production: [
            { type: 'inverters', activeCount: 22, wNow: 5000, whLifetime: INVERTER_LIFETIME + PRODUCTION_PER_POLL * n },
            eim
        ],
        consumption: [
            { type: 'eim', measurementType: 'total-consumption', wNow: 2000, whLifetime: 60_000_000 + CONSUMPTION_PER_POLL * n, lines: [] },
            { type: 'eim', measurementType: 'net-consumption', wNow: -3000, whLifetime: 17_455_000 - EXPORT_PER_POLL * n, lines: [] }
        ]
    };
}

/**
 * Start a gateway. `script(n)` decides poll n: return 'fail' to answer
 * /production.json with a 500, or options for stats(). The poll counter
 * advances on every /production.json request.
 */
export async function startGateway(script = () => ({})) {
    let n = 0;
    const server = http.createServer((req, res) => {
        if (req.url === '/info.xml') return res.writeHead(200).end(INFO);

        if (req.url.startsWith('/production.json')) {
            const poll = n++;
            const plan = script(poll) ?? {};
            if (plan === 'fail') return res.writeHead(500).end();
            return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(stats(poll, plan)));
        }

        if (req.url.startsWith('/api/v1/production')) {
            // Reports the microinverters' lifetime — a different register from the CT.
            return res.writeHead(200, { 'Content-Type': 'application/json' })
                .end(JSON.stringify({ wattsNow: 5000, wattHoursLifetime: INVERTER_LIFETIME + PRODUCTION_PER_POLL * n }));
        }

        res.writeHead(404).end();
    });

    const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
    return { host: `127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

export const tempFile = (name) => join(mkdtempSync(join(tmpdir(), 'envoy-test-')), name);

/**
 * Run `fn` with Date.now() under test control, advanced by `tick()`.
 * The grid counters difference against the clock, so real polling cadence has
 * to be simulated rather than waited out.
 */
export async function withClock(fn) {
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    try {
        return await fn({ tick: (ms = POLL_MS) => { now += ms; } });
    } finally {
        Date.now = realNow;
    }
}

/** Just enough of api.matter to register and update accessories. */
export function fakeApi() {
    const registered = [];
    const updates = [];
    return {
        registered,
        updates,
        matter: {
            deviceTypes: { ElectricalSensor: { name: 'ElectricalSensor' } },
            uuid: { generate: (value) => value },
            registerPlatformAccessories: async (plugin, platform, accessories) => { registered.push(...accessories); },
            updateAccessoryState: async (uuid, cluster, state) => { updates.push({ uuid, cluster, state }); }
        }
    };
}
