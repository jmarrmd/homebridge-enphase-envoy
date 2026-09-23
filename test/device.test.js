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
