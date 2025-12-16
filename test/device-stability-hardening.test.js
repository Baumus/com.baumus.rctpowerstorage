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

  it('should avoid redundant capability updates (diff helper)', async () => {
    const optimizer = new EnergyOptimizerDevice();

    optimizer.hasCapability = jest.fn(() => true);
    optimizer.getCapabilityValue = jest.fn((cap) => {
      if (cap === 'optimizer_status') return 'active';
      return null;
    });
    optimizer.setCapabilityValue = jest.fn(async () => {});

    // Same value -> no write
    await optimizer.setCapabilityValueIfChanged('optimizer_status', 'active');
    expect(optimizer.setCapabilityValue).toHaveBeenCalledTimes(0);

    // Different -> write
    await optimizer.setCapabilityValueIfChanged('optimizer_status', 'fetching');
    expect(optimizer.setCapabilityValue).toHaveBeenCalledTimes(1);
    expect(optimizer.setCapabilityValue).toHaveBeenCalledWith('optimizer_status', 'fetching');

    // Same again -> no additional write
    await optimizer.setCapabilityValueIfChanged('optimizer_status', 'fetching');
    expect(optimizer.setCapabilityValue).toHaveBeenCalledTimes(1);
  });

  it('should short-circuit Tibber fetch when circuit breaker is open', async () => {
    const optimizer = new EnergyOptimizerDevice();

    optimizer.debug = jest.fn();
    optimizer.log = jest.fn();
    optimizer.error = jest.fn();
    optimizer.hasCapability = jest.fn(() => true);
    optimizer.getCapabilityValue = jest.fn(() => null);
    optimizer.setCapabilityValue = jest.fn(async () => {});
    optimizer.setAvailable = jest.fn(async () => {});
    optimizer.setUnavailable = jest.fn(async () => {});

    optimizer.getSettingOrDefault = jest.fn((key, fallback) => {
      if (key === 'tibber_token') return 't';
      if (key === 'tibber_home_id') return 'home';
      return fallback;
    });

    global.fetch = jest.fn(async () => {
      throw new Error('Should not be called');
    });

    optimizer._tibberCircuit = { failures: 3, nextAllowedAt: Date.now() + 60_000 };
    const ok = await optimizer.fetchPricesFromTibber();
    expect(ok).toBe(false);
    expect(global.fetch).toHaveBeenCalledTimes(0);
  });
});
