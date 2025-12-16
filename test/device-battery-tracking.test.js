'use strict';

/**
 * Device Battery Tracking Integration Tests
 * 
 * Tests for bugs in collectCurrentData() and trackBatteryCharging():
 * 1. Battery tracking should work with measure_power, not just measure_power.battery
 * 2. Meter deltas should use nullish coalescing to handle 0 values correctly
 * 3. Tracking should not skip when batteryPower is low but meters are moving
 * 4. First run should initialize lastMeterReading to avoid false deltas
 */

// Allow requiring Homey SDK classes in plain Node tests
jest.mock('homey', () => ({ Device: class {} }), { virtual: true });

const EnergyOptimizerDevice = require('../drivers/energy-optimizer/device');

function createFakeDevice({ id, capabilities, values, settings }) {
  return {
    getData: () => ({ id }),
    hasCapability: (cap) => !!capabilities[cap],
    getCapabilityValue: (cap) => values[cap],
    getSetting: (key) => (settings ? settings[key] : undefined),
  };
}

describe('EnergyOptimizerDevice battery tracking integration', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2024-01-15T12:00:00Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('should track battery even if only measure_power exists (not measure_power.battery)', async () => {
    const optimizer = new EnergyOptimizerDevice();

    optimizer.getCapabilityValue = jest.fn((cap) => (cap === 'onoff' ? true : null));
    optimizer.getSetting = jest.fn((key) => {
      if (key === 'battery_device_id') return 'bat1';
      if (key === 'forecast_days') return 7;
      return '';
    });

    optimizer.productionHistory = {};
    optimizer.consumptionHistory = {};
    optimizer.batteryHistory = {};
    optimizer.gridHistory = {};
    optimizer.batteryChargeLog = [];

    optimizer.setStoreValue = jest.fn(async () => {});
    optimizer.saveHistoricalData = jest.fn(async () => {});
    optimizer.trackBatteryCharging = jest.fn(async () => {});
    optimizer.log = jest.fn();

    const batteryDevice = createFakeDevice({
      id: 'bat1',
      capabilities: {
        'measure_power': true, // Only measure_power, not measure_power.battery
        'measure_battery': true,
      },
      values: {
        'measure_power': 250, // Some power
        'measure_battery': 72, // %
      },
      settings: { battery_capacity: '10.0' },
    });

    const fakeDrivers = {
      'rct-power-storage-dc': { getDevices: () => [batteryDevice] },
      'solar-panel': { getDevices: () => [] },
      'grid-meter': { getDevices: () => [] },
    };

    optimizer.homey = {
      drivers: { getDriver: (id) => fakeDrivers[id] },
    };

    optimizer.getCapabilitySafe = (dev, cap) => (dev.hasCapability(cap) ? dev.getCapabilityValue(cap) : null);

    await optimizer.collectCurrentData();

    // trackBatteryCharging should be called even without measure_power.battery
    expect(optimizer.trackBatteryCharging).toHaveBeenCalledTimes(1);
    expect(optimizer.trackBatteryCharging).toHaveBeenCalledWith(250);

    // Battery history should be stored
    const anyInterval = Object.keys(optimizer.batteryHistory)[0];
    expect(optimizer.batteryHistory[anyInterval]).toBeDefined();
    expect(optimizer.batteryHistory[anyInterval].length).toBe(1);
    expect(optimizer.batteryHistory[anyInterval][0]).toBe(250);
  });

  it('should log solar charge even when last readings are 0 and batteryPower is ~0', async () => {
    const optimizer = new EnergyOptimizerDevice();

    optimizer.getSetting = jest.fn((key) => {
      if (key === 'solar_device_id') return 'sol1';
      if (key === 'grid_device_id') return 'grid1';
      if (key === 'battery_device_id') return 'bat1';
      if (key === 'min_soc_threshold') return 7;
      return '';
    });

    optimizer.priceCache = [
      { startsAt: '2024-01-15T12:00:00Z', total: 0.20 },
      { startsAt: '2024-01-15T12:15:00Z', total: 0.21 },
    ];

    optimizer.batteryChargeLog = [];
    optimizer.setStoreValue = jest.fn(async () => {});
    optimizer.log = jest.fn();
    optimizer.error = jest.fn();

    // Simulate a scenario where previous readings were 0 (after reset/restart)
    optimizer.lastMeterReading = {
      solar: 0,
      grid: 0,
      battery: 0,
      batteryDischarged: 0,
      timestamp: new Date('2024-01-15T11:45:00Z'),
    };

    const solarDevice = createFakeDevice({
      id: 'sol1',
      capabilities: { 'meter_power': true },
      values: { 'meter_power': 10.0 }, // 10 kWh cumulative
    });

    const gridDevice = createFakeDevice({
      id: 'grid1',
      capabilities: { 'meter_power': true },
      values: { 'meter_power': 5.0 },
    });

    const batteryDevice = createFakeDevice({
      id: 'bat1',
      capabilities: {
        'meter_power.charged': true,
        'meter_power.discharged': true,
        'measure_battery': true,
      },
      values: {
        'meter_power.charged': 5.0, // 5 kWh cumulative charged
        'meter_power.discharged': 0.0,
        'measure_battery': 72, // %
      },
      settings: { battery_capacity: '10.0' },
    });

    const fakeDrivers = {
      'solar-panel': { getDevices: () => [solarDevice] },
      'grid-meter': { getDevices: () => [gridDevice] },
      'rct-power-storage-dc': { getDevices: () => [batteryDevice] },
    };

    optimizer.homey = {
      drivers: { getDriver: (id) => fakeDrivers[id] },
    };

    // Call with batteryPower = 0 (no significant current power flow)
    await optimizer.trackBatteryCharging(0);

    // Should create charge entry because meter deltas show charging happened
    expect(optimizer.batteryChargeLog.length).toBe(1);
    expect(optimizer.batteryChargeLog[0].type).toBe('charge');
    expect(optimizer.batteryChargeLog[0].totalKWh).toBeCloseTo(5.0, 1);
    expect(optimizer.batteryChargeLog[0].solarKWh).toBeGreaterThan(0);
  });

  it('should initialize lastMeterReading on first run to prevent false deltas', async () => {
    const optimizer = new EnergyOptimizerDevice();

    optimizer.getSetting = jest.fn((key) => {
      if (key === 'solar_device_id') return 'sol1';
      if (key === 'battery_device_id') return 'bat1';
      if (key === 'min_soc_threshold') return 7;
      return '';
    });

    optimizer.priceCache = [
      { startsAt: '2024-01-15T12:00:00Z', total: 0.20 },
    ];

    optimizer.batteryChargeLog = [];
    optimizer.lastMeterReading = null; // First run
    optimizer.setStoreValue = jest.fn(async () => {});
    optimizer.log = jest.fn();
    optimizer.error = jest.fn();

    const solarDevice = createFakeDevice({
      id: 'sol1',
      capabilities: { 'meter_power': true },
      values: { 'meter_power': 1000.0 }, // Large cumulative value
    });

    const batteryDevice = createFakeDevice({
      id: 'bat1',
      capabilities: {
        'meter_power.charged': true,
        'meter_power.discharged': true,
        'measure_battery': true,
      },
      values: {
        'meter_power.charged': 500.0, // Large cumulative value
        'meter_power.discharged': 0.0,
        'measure_battery': 72,
      },
      settings: { battery_capacity: '10.0' },
    });

    const fakeDrivers = {
      'solar-panel': { getDevices: () => [solarDevice] },
      'grid-meter': { getDevices: () => [] },
      'rct-power-storage-dc': { getDevices: () => [batteryDevice] },
    };

    optimizer.homey = {
      drivers: { getDriver: (id) => fakeDrivers[id] },
    };

    // First call should initialize lastMeterReading and return early
    await optimizer.trackBatteryCharging(250);

    // Should not create any charge entries on first run
    expect(optimizer.batteryChargeLog.length).toBe(0);

    // lastMeterReading should now be initialized
    expect(optimizer.lastMeterReading).not.toBeNull();
    expect(optimizer.lastMeterReading.solar).toBe(1000.0);
    expect(optimizer.lastMeterReading.battery).toBe(500.0);

    // Log should mention initialization
    expect(optimizer.log).toHaveBeenCalledWith(expect.stringContaining('Initializing meter readings'));
  });

  it('should correctly calculate deltas when previous readings are 0 (using nullish coalescing)', async () => {
    const optimizer = new EnergyOptimizerDevice();

    optimizer.getSetting = jest.fn((key) => {
      if (key === 'solar_device_id') return 'sol1';
      if (key === 'battery_device_id') return 'bat1';
      if (key === 'min_soc_threshold') return 7;
      return '';
    });

    optimizer.priceCache = [
      { startsAt: '2024-01-15T12:00:00Z', total: 0.20 },
    ];

    optimizer.batteryChargeLog = [];
    optimizer.setStoreValue = jest.fn(async () => {});
    optimizer.log = jest.fn();
    optimizer.error = jest.fn();

    // Previous readings are explicitly 0 (not undefined)
    optimizer.lastMeterReading = {
      solar: 0,
      grid: 0,
      battery: 0,
      batteryDischarged: 0,
      timestamp: new Date('2024-01-15T11:45:00Z'),
    };

    const solarDevice = createFakeDevice({
      id: 'sol1',
      capabilities: { 'meter_power': true },
      values: { 'meter_power': 2.5 }, // Increased from 0 to 2.5 kWh
    });

    const batteryDevice = createFakeDevice({
      id: 'bat1',
      capabilities: {
        'meter_power.charged': true,
        'meter_power.discharged': true,
        'measure_battery': true,
      },
      values: {
        'meter_power.charged': 2.0, // Increased from 0 to 2.0 kWh
        'meter_power.discharged': 0.0,
        'measure_battery': 55,
      },
      settings: { battery_capacity: '10.0' },
    });

    const fakeDrivers = {
      'solar-panel': { getDevices: () => [solarDevice] },
      'grid-meter': { getDevices: () => [] },
      'rct-power-storage-dc': { getDevices: () => [batteryDevice] },
    };

    optimizer.homey = {
      drivers: { getDriver: (id) => fakeDrivers[id] },
    };

    await optimizer.trackBatteryCharging(150);

    // Should correctly calculate delta: 2.5 - 0 = 2.5 kWh solar, 2.0 - 0 = 2.0 kWh battery
    expect(optimizer.batteryChargeLog.length).toBe(1);
    expect(optimizer.batteryChargeLog[0].type).toBe('charge');
    expect(optimizer.batteryChargeLog[0].totalKWh).toBeCloseTo(2.0, 1);
    expect(optimizer.batteryChargeLog[0].solarKWh).toBeCloseTo(2.0, 1); // All from solar (limited by battery charge)
    expect(optimizer.batteryChargeLog[0].gridKWh).toBeCloseTo(0, 1);
  });
});
