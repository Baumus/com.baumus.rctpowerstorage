'use strict';

// Allow requiring Homey SDK classes in plain Node tests
jest.mock('homey', () => ({ Device: class {} }), { virtual: true });

const EnergyOptimizerDevice = require('../drivers/energy-optimizer/device');

describe('EnergyOptimizerDevice resource optimization', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2024-01-15T12:00:00Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('Rate-limited logging', () => {
    it('should suppress repeated logs within interval', () => {
      const optimizer = new EnergyOptimizerDevice();
      optimizer.log = jest.fn();
      optimizer._logThrottleMap = new Map();

      // First log should appear
      optimizer.logThrottled('test-category', 60000, 'Test message 1');
      expect(optimizer.log).toHaveBeenCalledTimes(1);
      expect(optimizer.log).toHaveBeenCalledWith('Test message 1');

      // Second log within 60s should be suppressed
      jest.advanceTimersByTime(30000);
      optimizer.logThrottled('test-category', 60000, 'Test message 2');
      expect(optimizer.log).toHaveBeenCalledTimes(1);

      // Third log after 60s should appear
      jest.advanceTimersByTime(31000);
      optimizer.logThrottled('test-category', 60000, 'Test message 3');
      expect(optimizer.log).toHaveBeenCalledTimes(2);
      expect(optimizer.log).toHaveBeenCalledWith('Test message 3');
    });

    it('should allow different categories to log independently', () => {
      const optimizer = new EnergyOptimizerDevice();
      optimizer.log = jest.fn();
      optimizer._logThrottleMap = new Map();

      optimizer.logThrottled('category-a', 60000, 'Message A');
      optimizer.logThrottled('category-b', 60000, 'Message B');

      expect(optimizer.log).toHaveBeenCalledTimes(2);
      expect(optimizer.log).toHaveBeenCalledWith('Message A');
      expect(optimizer.log).toHaveBeenCalledWith('Message B');
    });
  });

  describe('Strategy recalculation skip', () => {
    it('should skip recalculation when inputs unchanged', async () => {
      const optimizer = new EnergyOptimizerDevice();
      optimizer.log = jest.fn();
      optimizer.debug = jest.fn();
      optimizer.error = jest.fn();
      optimizer.priceCache = [{ startsAt: '2024-01-15T14:00:00Z', total: 0.25 }];
      
      const mockBattery = {
        getCapabilityValue: jest.fn(() => 50),
        getSetting: jest.fn(() => 10),
      };
      optimizer.getDeviceById = jest.fn(() => mockBattery);
      optimizer.getSettingOrDefault = jest.fn((key, def) => {
        if (key === 'battery_device_id') return 'battery-123';
        return def;
      });
      optimizer.getSetting = jest.fn((key) => {
        if (key === 'min_profit_cent_per_kwh') return 8;
        return undefined;
      });
      optimizer.getCapabilitySafe = jest.fn(() => 50);
      optimizer.getSettings = jest.fn(() => ({
        battery_capacity: 10,
        cheap_price_factor: 0.8,
        expensive_price_factor: 1.2,
        min_profit_cent_per_kwh: 2,
        forecast_days: 2,
      }));
      optimizer.normalizedChargePowerKW = 5;
      optimizer.normalizedTargetSoc = 1;
      optimizer.normalizedEfficiencyLoss = 0.1;
      optimizer.normalizedExpensivePriceFactor = 1.2;
      optimizer.productionHistory = {};
      optimizer.gridHistory = {};
      optimizer.batteryHistory = {};
      optimizer.homey = { __: jest.fn((key) => key) };
      optimizer.setCapabilityValueIfChanged = jest.fn();

      // First call should calculate
      await optimizer.calculateOptimalStrategy();
      optimizer.debug.mockClear();

      // Second call with same inputs should skip
      await optimizer.calculateOptimalStrategy();
      expect(optimizer.debug).toHaveBeenCalledWith('⏭️ Skipping strategy recalc (no input changes)');
    });

    it('should recalculate when input hash changes', async () => {
      const optimizer = new EnergyOptimizerDevice();
      optimizer.log = jest.fn();
      optimizer.debug = jest.fn();
      optimizer.error = jest.fn();
      optimizer.priceCache = [{ startsAt: '2024-01-15T14:00:00Z', total: 0.25 }];
      
      const mockBattery = {
        getCapabilityValue: jest.fn(() => 50),
        getSetting: jest.fn(() => 10),
      };
      optimizer.getDeviceById = jest.fn(() => mockBattery);
      optimizer.getSettingOrDefault = jest.fn((key, def) => {
        if (key === 'battery_device_id') return 'battery-123';
        return def;
      });
      optimizer.getSetting = jest.fn((key) => {
        if (key === 'min_profit_cent_per_kwh') return 8;
        return undefined;
      });
      optimizer.getCapabilitySafe = jest.fn(() => 50);
      optimizer.getSettings = jest.fn(() => ({
        battery_capacity: 10,
        cheap_price_factor: 0.8,
        expensive_price_factor: 1.2,
        min_profit_cent_per_kwh: 2,
        forecast_days: 2,
      }));
      optimizer.normalizedChargePowerKW = 5;
      optimizer.normalizedTargetSoc = 1;
      optimizer.normalizedEfficiencyLoss = 0.1;
      optimizer.normalizedExpensivePriceFactor = 1.2;
      optimizer.productionHistory = {};
      optimizer.gridHistory = {};
      optimizer.batteryHistory = {};
      optimizer.homey = { __: jest.fn((key) => key) };
      optimizer.setCapabilityValueIfChanged = jest.fn();

      // First call
      await optimizer.calculateOptimalStrategy();
      const firstHash = optimizer._lastStrategyInputHash;

      // Change price cache length -> should recalculate
      optimizer.priceCache = [
        { startsAt: '2024-01-15T14:00:00Z', total: 0.25 },
        { startsAt: '2024-01-15T15:00:00Z', total: 0.30 },
      ];
      await optimizer.calculateOptimalStrategy();
      
      const secondHash = optimizer._lastStrategyInputHash;
      expect(secondHash).not.toBe(firstHash);
    });

    it('should recalculate when force flag is true', async () => {
      const optimizer = new EnergyOptimizerDevice();
      optimizer.log = jest.fn();
      optimizer.debug = jest.fn();
      optimizer.error = jest.fn();
      optimizer.priceCache = [{ startsAt: '2024-01-15T14:00:00Z', total: 0.25 }];
      
      const mockBattery = {
        getCapabilityValue: jest.fn(() => 50),
        getSetting: jest.fn(() => 10),
      };
      optimizer.getDeviceById = jest.fn(() => mockBattery);
      optimizer.getSettingOrDefault = jest.fn((key, def) => {
        if (key === 'battery_device_id') return 'battery-123';
        return def;
      });
      optimizer.getSetting = jest.fn((key) => {
        if (key === 'min_profit_cent_per_kwh') return 8;
        return undefined;
      });
      optimizer.getCapabilitySafe = jest.fn(() => 50);
      optimizer.getSettings = jest.fn(() => ({
        battery_capacity: 10,
        cheap_price_factor: 0.8,
        expensive_price_factor: 1.2,
        min_profit_cent_per_kwh: 2,
        forecast_days: 2,
      }));
      optimizer.normalizedChargePowerKW = 5;
      optimizer.normalizedTargetSoc = 1;
      optimizer.normalizedEfficiencyLoss = 0.1;
      optimizer.normalizedExpensivePriceFactor = 1.2;
      optimizer.productionHistory = {};
      optimizer.gridHistory = {};
      optimizer.batteryHistory = {};
      optimizer.homey = { __: jest.fn((key) => key) };
      optimizer.setCapabilityValueIfChanged = jest.fn();

      // First call
      await optimizer.calculateOptimalStrategy();
      optimizer.debug.mockClear();

      // Second call with force flag should recalculate and NOT show the skip message
      await optimizer.calculateOptimalStrategy({ force: true });
      expect(optimizer.debug).not.toHaveBeenCalledWith('⏭️ Skipping strategy recalc (no input changes)');
    });
  });

  describe('Device/driver cache', () => {
    it('should cache driver lookups and avoid repeated getDriver calls', () => {
      const optimizer = new EnergyOptimizerDevice();
      
      // Initialize cache structures
      optimizer._driverCache = new Map();
      optimizer._driverCacheTtlMs = 60000;
      optimizer._negativeCacheTtlMs = 5000;
      
      const mockDriver = { getDevices: jest.fn(() => []) };
      optimizer.homey = {
        drivers: {
          getDriver: jest.fn(() => mockDriver),
        },
      };

      // First call
      const driver1 = optimizer.getDriverSafe('solar-panel');
      expect(driver1).toBe(mockDriver);
      expect(optimizer.homey.drivers.getDriver).toHaveBeenCalledTimes(1);

      // Second call within TTL should use cache
      const driver2 = optimizer.getDriverSafe('solar-panel');
      expect(driver2).toBe(mockDriver);
      expect(optimizer.homey.drivers.getDriver).toHaveBeenCalledTimes(1);

      // Advance time beyond TTL (60s)
      jest.advanceTimersByTime(61000);

      // Should call getDriver again
      const driver3 = optimizer.getDriverSafe('solar-panel');
      expect(driver3).toBe(mockDriver);
      expect(optimizer.homey.drivers.getDriver).toHaveBeenCalledTimes(2);
    });

    it('should negative-cache missing drivers with shorter TTL', () => {
      const optimizer = new EnergyOptimizerDevice();
      
      // Initialize cache structures
      optimizer._driverCache = new Map();
      optimizer._driverCacheTtlMs = 60000;
      optimizer._negativeCacheTtlMs = 5000;
      
      optimizer.homey = {
        drivers: {
          getDriver: jest.fn(() => { throw new Error('Driver not found'); }),
        },
      };
      optimizer.log = jest.fn();

      // First call
      const driver1 = optimizer.getDriverSafe('missing-driver');
      expect(driver1).toBeNull();
      expect(optimizer.homey.drivers.getDriver).toHaveBeenCalledTimes(1);

      // Second call within negative TTL should use cache
      const driver2 = optimizer.getDriverSafe('missing-driver');
      expect(driver2).toBeNull();
      expect(optimizer.homey.drivers.getDriver).toHaveBeenCalledTimes(1);

      // Advance time beyond negative TTL (5s)
      jest.advanceTimersByTime(6000);

      // Should try again
      const driver3 = optimizer.getDriverSafe('missing-driver');
      expect(driver3).toBeNull();
      expect(optimizer.homey.drivers.getDriver).toHaveBeenCalledTimes(2);
    });

    it('should cache device lookups and avoid repeated getDevices scans', () => {
      const optimizer = new EnergyOptimizerDevice();
      
      // Initialize cache structures
      optimizer._driverCache = new Map();
      optimizer._deviceCache = new Map();
      optimizer._driverCacheTtlMs = 60000;
      optimizer._deviceCacheTtlMs = 60000;
      optimizer._negativeCacheTtlMs = 5000;
      
      const mockDevice = { getData: () => ({ id: 'dev1' }) };
      const mockDriver = { getDevices: jest.fn(() => [mockDevice]) };
      optimizer.homey = {
        drivers: {
          getDriver: jest.fn(() => mockDriver),
        },
      };
      optimizer.log = jest.fn();

      // First call
      const device1 = optimizer.getDeviceById('solar-panel', 'dev1');
      expect(device1).toBe(mockDevice);
      expect(mockDriver.getDevices).toHaveBeenCalledTimes(1);

      // Second call within TTL should use cache
      const device2 = optimizer.getDeviceById('solar-panel', 'dev1');
      expect(device2).toBe(mockDevice);
      expect(mockDriver.getDevices).toHaveBeenCalledTimes(1);

      // Advance time beyond TTL
      jest.advanceTimersByTime(61000);

      // Should scan again
      const device3 = optimizer.getDeviceById('solar-panel', 'dev1');
      expect(device3).toBe(mockDevice);
      expect(mockDriver.getDevices).toHaveBeenCalledTimes(2);
    });

    it('should invalidate device cache when requested', () => {
      const optimizer = new EnergyOptimizerDevice();
      
      // Initialize cache structures
      optimizer._driverCache = new Map();
      optimizer._deviceCache = new Map();
      optimizer._driverCacheTtlMs = 60000;
      optimizer._deviceCacheTtlMs = 60000;
      optimizer._negativeCacheTtlMs = 5000;
      
      const mockDevice = { getData: () => ({ id: 'dev1' }) };
      const mockDriver = { getDevices: jest.fn(() => [mockDevice]) };
      optimizer.homey = {
        drivers: {
          getDriver: jest.fn(() => mockDriver),
        },
      };
      optimizer.log = jest.fn();

      optimizer.getDeviceById('solar-panel', 'dev1');
      expect(mockDriver.getDevices).toHaveBeenCalledTimes(1);

      // Invalidate cache
      optimizer._invalidateDeviceCache('solar-panel', 'dev1');

      // Next call should re-scan
      optimizer.getDeviceById('solar-panel', 'dev1');
      expect(mockDriver.getDevices).toHaveBeenCalledTimes(2);
    });
  });

  describe('History pruning', () => {
    it('should trim history arrays to max days', () => {
      const optimizer = new EnergyOptimizerDevice();

      optimizer.productionHistory = {
        0: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], // 10 days
        1: [11, 12, 13],
      };
      optimizer.consumptionHistory = {};
      optimizer.gridHistory = {};
      optimizer.batteryHistory = {};

      optimizer.pruneHistories(7);

      expect(optimizer.productionHistory[0].length).toBe(7);
      expect(optimizer.productionHistory[0]).toEqual([4, 5, 6, 7, 8, 9, 10]);
      expect(optimizer.productionHistory[1].length).toBe(3);
    });

    it('should remove empty arrays from histories', () => {
      const optimizer = new EnergyOptimizerDevice();

      optimizer.productionHistory = {
        0: [1, 2, 3],
        1: [],
        2: [4, 5],
      };
      optimizer.consumptionHistory = {};
      optimizer.gridHistory = {};
      optimizer.batteryHistory = {};

      optimizer.pruneHistories(7);

      expect(optimizer.productionHistory[0]).toEqual([1, 2, 3]);
      expect(optimizer.productionHistory[1]).toBeUndefined();
      expect(optimizer.productionHistory[2]).toEqual([4, 5]);
    });

    it('should remove invalid (non-array) history entries', () => {
      const optimizer = new EnergyOptimizerDevice();

      optimizer.productionHistory = {
        0: [1, 2, 3],
        1: 'invalid',
        2: null,
        3: { not: 'array' },
      };
      optimizer.consumptionHistory = {};
      optimizer.gridHistory = {};
      optimizer.batteryHistory = {};

      optimizer.pruneHistories(7);

      expect(optimizer.productionHistory[0]).toEqual([1, 2, 3]);
      expect(optimizer.productionHistory[1]).toBeUndefined();
      expect(optimizer.productionHistory[2]).toBeUndefined();
      expect(optimizer.productionHistory[3]).toBeUndefined();
    });

    it('should prune all history objects (production, consumption, grid, battery)', () => {
      const optimizer = new EnergyOptimizerDevice();

      optimizer.productionHistory = { 0: [1, 2, 3, 4, 5] };
      optimizer.consumptionHistory = { 0: [6, 7, 8, 9, 10] };
      optimizer.gridHistory = { 0: [] };
      optimizer.batteryHistory = { 0: 'invalid', 1: [11, 12] };

      optimizer.pruneHistories(3);

      expect(optimizer.productionHistory[0]).toEqual([3, 4, 5]);
      expect(optimizer.consumptionHistory[0]).toEqual([8, 9, 10]);
      expect(optimizer.gridHistory[0]).toBeUndefined();
      expect(optimizer.batteryHistory[0]).toBeUndefined();
      expect(optimizer.batteryHistory[1]).toEqual([11, 12]);
    });
  });
});
