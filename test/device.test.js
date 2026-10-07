import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EnvoyEnergyDevice } from '../index.js';
import { startGateway, tempFile, fakeApi, CT_LIFETIME } from './gateway.js';

const quietLog = { info() {}, warn() {}, error() {}, success() {} };

async function startDevice(script) {
    const gateway = await startGateway(script);
    const api = fakeApi();
    const errors = [];
    const device = new EnvoyEnergyDevice({
        config: { name: 'Envoy', host: gateway.host },
        host: gateway.host,
        name: 'Envoy',
        tokenMode: 0,
        tokenFile: tempFile('token'),
        gridFile: tempFile('grid.json'),
        dailyFile: tempFile('daily.json'),
        log: { ...quietLog, error: (message) => errors.push(message) },
        api
    });
    device.startupRetryMs = 0;
    await device.start();
    device.stop();
    await gateway.close();
    return { api, errors };
}

test('a restart whose first read fails still registers every sensor, at its real total', async () => {
    const { api, errors } = await startDevice((n) => (n < 2 ? 'fail' : {}));

    assert.deepEqual(errors, []);
    assert.deepEqual(api.registered.map((a) => a.displayName), ['Solar', 'Consumption', 'Grid']);

    const solar = api.registered[0].clusters.electricalEnergyMeasurement.cumulativeEnergyExported.energy;
    assert.ok(solar >= CT_LIFETIME * 1000, `Solar opened at ${solar} mWh, not its lifetime`);
    const consumption = api.registered[1].clusters.electricalEnergyMeasurement.cumulativeEnergyImported.energy;
    assert.ok(consumption > 0);
});

test('a production total missing at startup delays registration instead of opening at zero', async () => {
    const { api } = await startDevice((n) => ({ omitTotal: n < 3 }));

    const solar = api.registered[0].clusters.electricalEnergyMeasurement.cumulativeEnergyExported.energy;
    assert.ok(solar >= CT_LIFETIME * 1000);
});

test('a registration Homebridge refuses while Matter is starting is retried', async () => {
    const gateway = await startGateway(() => ({}));
    const api = fakeApi();
    const register = api.matter.registerPlatformAccessories;
    let refusals = 0;
    api.matter.registerPlatformAccessories = async (...args) => {
        if (refusals++ === 0) throw new Error('Cannot register Matter accessories yet — the Matter server for this bridge is still starting.');
        return register(...args);
    };

    const device = new EnvoyEnergyDevice({
        config: { name: 'Envoy', host: gateway.host },
        host: gateway.host, name: 'Envoy', tokenMode: 0,
        tokenFile: tempFile('token'), gridFile: tempFile('grid.json'), dailyFile: tempFile('daily.json'),
        log: quietLog, api
    });
    device.startupRetryMs = 0;
    device.registerRetryMs = 0;

    try {
        await device.start();
        for (let i = 0; i < 100 && api.registered.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
        assert.deepEqual(api.registered.map((a) => a.displayName), ['Solar', 'Consumption', 'Grid']);
        assert.ok(device.pollTimer, 'polling started after the retry');
    } finally {
        device.stop();
        await gateway.close();
    }
});
