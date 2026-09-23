import { test } from 'node:test';
import assert from 'node:assert/strict';
import MatterEnergyBridge, { hasEnergy } from '../src/matterenergy.js';
import { fakeApi } from './gateway.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

test('hasEnergy looks at the field each sensor publishes', () => {
    assert.equal(hasEnergy('production', { energyLifetime: 5 }), true);
    assert.equal(hasEnergy('production', { energyLifetime: null }), false);
    assert.equal(hasEnergy('grid', { energyImported: 0 }), true);
    assert.equal(hasEnergy('gridExport', { energyImported: 5 }), false);
});

test('an update without a known total sends power only, never a zero total', async () => {
    const api = fakeApi();
    const bridge = new MatterEnergyBridge({ api, log: quiet });
    await bridge.register({
        info: { serialNumber: '122233445566', modelName: 'IQ Gateway' },
        sensors: [{ kind: 'production', displayName: 'Solar', reading: { power: 5000, energyLifetime: 42_545_000 } }]
    });

    await bridge.update('production', { power: 4000, energyLifetime: null });
    assert.deepEqual(api.updates.map((u) => u.cluster), ['electricalPowerMeasurement']);

    await bridge.update('production', { power: 4000, energyLifetime: 42_546_000 });
    const energy = api.updates.find((u) => u.cluster === 'electricalEnergyMeasurement');
    assert.equal(energy.state.cumulativeEnergyExported.energy, 42_546_000_000);
});
