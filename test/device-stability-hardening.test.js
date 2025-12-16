'use strict';

// Allow requiring Homey SDK classes in plain Node tests
jest.mock('homey', () => ({ Device: class {} }), { virtual: true });

const EnergyOptimizerDevice = require('../drivers/energy-optimizer/device');

describe('EnergyOptimizerDevice stability hardening', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2024-01-15T12:15:00Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('should not run overlapping update ticks (mutex)', async () => {
    const optimizer = new EnergyOptimizerDevice();

    optimizer.getCapabilityValue = jest.fn((cap) => (cap === 'onoff' ? true : null));
    optimizer.getSettingOrDefault = jest.fn((key, fallback) => fallback);

    optimizer.lastDailyFetchDate = null;
    optimizer.lastOptimizationCheckMinute = -1;
    optimizer.lastDataCollectionMinute = -1;

    optimizer.debug = jest.fn();
    optimizer.log = jest.fn();
    optimizer.error = jest.fn();

    optimizer.fetchPricesFromTibber = jest.fn(async () => {});
    optimizer.calculateOptimalStrategy = jest.fn(async () => {});
    optimizer.executeOptimizationStrategy = jest.fn(async () => {});

    optimizer.collectCurrentData = jest.fn(() => new Promise((resolve) => {
      setTimeout(resolve, 50);
    }));

    const p1 = optimizer.updateDeviceData();
    const p2 = optimizer.updateDeviceData();

    // Second call should be skipped immediately due to mutex
    expect(optimizer.collectCurrentData).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(60);
    await p1;
    await p2;

    expect(optimizer.calculateOptimalStrategy).toHaveBeenCalledTimes(1);
    expect(optimizer.executeOptimizationStrategy).toHaveBeenCalledTimes(1);
  });

  it('should batch queued store writes and persist only latest value per key', async () => {
    const optimizer = new EnergyOptimizerDevice();

    optimizer.setStoreValue = jest.fn(async () => {});
    optimizer.error = jest.fn();

    optimizer.queueStoreValue('battery_charge_log', [{ n: 1 }]);
    optimizer.queueStoreValue('battery_charge_log', [{ n: 1 }, { n: 2 }]);

    // Not flushed yet
    expect(optimizer.setStoreValue).toHaveBeenCalledTimes(0);

    await optimizer.flushStoreWrites();

    expect(optimizer.setStoreValue).toHaveBeenCalledTimes(1);
    expect(optimizer.setStoreValue).toHaveBeenCalledWith('battery_charge_log', [{ n: 1 }, { n: 2 }]);
  });
});
