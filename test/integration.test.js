'use strict';

/**
 * Integration Tests - Light
 * 
 * These tests verify that the extracted modules work together correctly
 * without requiring a full Homey device environment. They test the
 * integration points between modules and ensure data flows correctly.
 */

const { optimizeStrategyWithLp } = require('../drivers/energy-optimizer/optimizer-core');

let lpSolver;
try {
  // eslint-disable-next-line global-require
  lpSolver = require('../lib/javascript-lp-solver/src/main');
} catch (e) {
  lpSolver = null;
}

const {
  decideBatteryMode,
  findCurrentIntervalIndex,
  BATTERY_MODE,
} = require('../drivers/energy-optimizer/strategy-execution-core');

const {
  calculateBatteryEnergyCost,
  createChargeEntry,
  createDischargeEntry,
  calculateDischargeProfit,
} = require('../drivers/energy-optimizer/battery-cost-core');

const {
  getIntervalOfDay,
  getPriceAtTime,
  filterCurrentAndFutureIntervals,
  enrichPriceData,
  groupConsecutiveIntervals,
  formatTime,
} = require('../drivers/energy-optimizer/time-scheduling-core');

describe('Integration Tests - Light', () => {
  describe('Full Optimization Flow', () => {
    it('should complete LP optimization cycle from price data to battery mode', () => {
      if (!lpSolver) {
        // eslint-disable-next-line jest/no-conditional-expect
        expect(lpSolver).not.toBeNull();
        return;
      }

      // Two intervals: charge in cheap slot, discharge in expensive slot.
      const baseTime = new Date('2025-01-01T00:00:00.000Z');
      const priceData = [
        { startsAt: baseTime.toISOString(), total: 0.10 },
        { startsAt: new Date(baseTime.getTime() + 15 * 60 * 1000).toISOString(), total: 0.40 },
      ];

      const indexedData = enrichPriceData(priceData);
      expect(indexedData[0]).toHaveProperty('intervalOfDay');
      expect(indexedData[1]).toHaveProperty('intervalOfDay');

      const params = {
        batteryCapacity: 10,
        currentSoc: 0.0,
        targetSoc: 0.2,
        chargePowerKW: 5,
        intervalHours: 0.25,
        efficiencyLoss: 0.1,
        minEnergyKWh: 0,
        minProfitEurPerKWh: 0,
      };

      const history = {
        productionHistory: {},
        batteryHistory: {},
        consumptionHistory: {
          // No demand in first interval, 4kW import in second interval
          [indexedData[0].intervalOfDay]: [0, 0, 0],
          [indexedData[1].intervalOfDay]: [4000, 4000, 4000],
        },
      };

      const strategy = optimizeStrategyWithLp(indexedData, params, history, { lpSolver });
      expect(strategy).not.toBeNull();
      expect(strategy.chargeIntervals.length).toBeGreaterThan(0);
      expect(strategy.dischargeIntervals.length).toBeGreaterThan(0);

      const decisionCharge = decideBatteryMode({
        now: new Date(indexedData[0].startsAt),
        priceCache: indexedData,
        strategy,
        gridPower: 0,
        intervalMinutes: 15,
      });

      const decisionDischarge = decideBatteryMode({
        now: new Date(indexedData[1].startsAt),
        priceCache: indexedData,
        strategy,
        gridPower: 0,
        intervalMinutes: 15,
      });

      expect(decisionCharge).toBeDefined();
      expect(decisionDischarge).toBeDefined();
      expect(decisionCharge.mode).toBe(BATTERY_MODE.CHARGE);
      expect(decisionDischarge.mode).toBe(BATTERY_MODE.DISCHARGE);
    });
  });

  describe('Battery Cost Tracking Integration', () => {
    it('should track battery costs through charge/discharge cycle', () => {
      // Setup: Battery empty initially
      let chargeLog = [];
      let totalEnergyInBattery = 0;

      // 1. Charge from grid at €0.25/kWh
      const gridPrice = 0.25;
      const chargeAmount = 5.0; // 5 kWh
      const solarAvailable = 0; // No solar

      const chargeEntry = createChargeEntry({
        chargedKWh: chargeAmount,
        solarKWh: solarAvailable,
        gridPrice,
        soc: 50,
        timestamp: new Date(),
      });

      chargeLog.push(chargeEntry);
      totalEnergyInBattery += chargeAmount;

      expect(chargeEntry.type).toBe('charge');
      expect(chargeEntry.totalKWh).toBeCloseTo(5.0, 1);

      // 2. Calculate battery cost
      const costResult = calculateBatteryEnergyCost(chargeLog);
      expect(costResult).toBeDefined();
      expect(costResult.avgPrice).toBeCloseTo(0.25, 2);

      // 3. Discharge 2 kWh at €0.30/kWh
      const dischargeAmount = 2.0;
      const dischargeSellPrice = 0.30;

      const dischargeEntry = createDischargeEntry({
        dischargedKWh: dischargeAmount,
        soc: 30,
        timestamp: new Date(),
      });

      chargeLog.push(dischargeEntry);
      totalEnergyInBattery -= dischargeAmount;

      // 4. Calculate profit
      const profitResult = calculateDischargeProfit(
        dischargeAmount,
        costResult.avgPrice,
        dischargeSellPrice,
      );

      // Profit = (sell price - cost) * energy = (0.30 - 0.25) * 2.0 = 0.10
      expect(profitResult.profit).toBeCloseTo(0.10, 2);
      expect(profitResult.worthIt).toBe(true);
      expect(totalEnergyInBattery).toBeCloseTo(3.0, 1);
    });

    it('should track mixed solar/grid charging correctly', () => {
      let chargeLog = [];
      let totalEnergy = 0;

      // Charge 1: 50% solar, 50% grid
      const entry1 = createChargeEntry({
        chargedKWh: 4.0,
        solarKWh: 2.0, // 2kWh from solar
        gridPrice: 0.25,
        soc: 40,
        timestamp: new Date(),
      });
      
      chargeLog.push(entry1);
      totalEnergy += 4.0;

      expect(entry1.solarKWh).toBeCloseTo(2.0, 1);
      expect(entry1.gridKWh).toBeCloseTo(2.0, 1);

      // Average cost should be weighted: (2*0.05 + 2*0.25) / 4 = 0.15
      // Note: Solar energy has assumed cost of €0.05/kWh
      const costResult = calculateBatteryEnergyCost(chargeLog);
      expect(costResult).toBeDefined();
      expect(costResult.avgPrice).toBeLessThan(0.25); // Should be lower due to solar
      expect(costResult.solarKWh).toBeCloseTo(2.0, 1);
      expect(costResult.gridKWh).toBeCloseTo(2.0, 1);
    });
  });

  describe('Price Lookup and Interval Matching', () => {
    it('should correctly match prices across time intervals', () => {
      const baseTime = new Date(2024, 0, 15, 10, 0, 0);
      const priceData = [];

      // Create 4 hours of price data
      for (let i = 0; i < 16; i++) {
        const time = new Date(baseTime.getTime() + i * 15 * 60 * 1000);
        priceData.push({
          startsAt: time.toISOString(),
          total: 0.20 + i * 0.01, // Increasing prices
        });
      }

      // Test 1: Get interval of day
      const testTime = new Date(2024, 0, 15, 11, 30, 0); // 11:30 AM
      const intervalOfDay = getIntervalOfDay(testTime, 15);
      expect(intervalOfDay).toBe(46); // (11*4 + 2)

      // Test 2: Get price at specific time
      const price = getPriceAtTime(testTime, priceData, 15);
      expect(price).toBeCloseTo(0.26, 2); // Should match 11:30 interval

      // Test 3: Group consecutive intervals
      const enriched = enrichPriceData(priceData);
      const grouped = groupConsecutiveIntervals(enriched, 15);
      
      expect(grouped.length).toBe(1); // All consecutive
      expect(grouped[0].duration).toBe(240); // 16 * 15 = 240 minutes
      expect(formatTime(grouped[0].start)).toBe('10:00');
    });
  });

  describe('Error Handling and Edge Cases', () => {
    it('should handle empty price data gracefully', () => {
      const emptyData = [];
      const enriched = enrichPriceData(emptyData);
      expect(enriched).toEqual([]);

      const filtered = filterCurrentAndFutureIntervals(emptyData, new Date(), 15);
      expect(filtered).toEqual([]);

      const grouped = groupConsecutiveIntervals(emptyData, 15);
      expect(grouped).toEqual([]);
    });

    it('should handle missing optimization strategy', () => {
      const emptyStrategy = { chargeIntervals: [], dischargeIntervals: [] };
      const params = {
        batteryCapacity: 10,
        maxChargePower: 3.3,
        maxDischargePower: 3.3,
        minSoC: 0.10,
        maxSoC: 0.95,
      };

      const decision = decideBatteryMode(
        emptyStrategy,
        0,
        0.50,
        params,
        0,
        2.0,
      );

      // With no strategy, should be IDLE
      expect(decision.mode).toBe(BATTERY_MODE.IDLE);
    });

    it('should handle extreme battery states', () => {
      let chargeLog = [];
      let totalEnergy = 0;

      // Empty battery cost
      const emptyCost = calculateBatteryEnergyCost(chargeLog);
      expect(emptyCost).toBeNull(); // Returns null when empty

      // Add minimal charge
      const entry = createChargeEntry({
        chargedKWh: 0.1,
        solarKWh: 0,
        gridPrice: 0.25,
        soc: 1,
        timestamp: new Date(),
      });
      
      chargeLog.push(entry);
      totalEnergy += 0.1;

      const smallCostResult = calculateBatteryEnergyCost(chargeLog);
      expect(smallCostResult).toBeDefined();
      expect(smallCostResult.avgPrice).toBeGreaterThan(0);
    });
  });

  describe('Battery Status Updates', () => {
    it('should maintain energyCost data even when strategy intervals dont change', () => {
      // Simulate scenario: Battery charged 3 hours ago, strategy hasn't changed
      
      // Step 1: Create initial charge log (battery charged from grid)
      const chargeLog = [];
      const charge1 = createChargeEntry({
        chargedKWh: 4.0,
        solarKWh: 1.5,
        gridPrice: 0.20,
        soc: 0.64,
        timestamp: Date.now() - 3 * 60 * 60 * 1000, // 3 hours ago
      });
      chargeLog.push(charge1);

      // Step 2: Calculate initial battery cost
      const initialCost = calculateBatteryEnergyCost(chargeLog);
      expect(initialCost).not.toBeNull();
      expect(initialCost.totalKWh).toBeCloseTo(4.0, 1);
      expect(initialCost.avgPrice).toBeGreaterThan(0);
      expect(initialCost.solarKWh).toBeCloseTo(1.5, 1);
      expect(initialCost.gridKWh).toBeCloseTo(2.5, 1);

      // Step 3: Simulate strategy object (as it would exist in device.js)
      const strategy = {
        chargeIntervals: [], // No new charging planned
        dischargeIntervals: [],
        expensiveIntervals: [],
        avgPrice: 0.25,
        neededKWh: 0,
        batteryStatus: {
          currentSoc: 0.64,
          targetSoc: 0.85,
          availableCapacity: 2.1,
          batteryCapacity: 10.0,
          energyCost: initialCost, // Initial cost from 3 hours ago
        },
      };

      // Step 4: Verify initial energyCost is available
      expect(strategy.batteryStatus.energyCost).not.toBeNull();
      expect(strategy.batteryStatus.energyCost.avgPrice).toBeGreaterThan(0);

      // Step 5: Simulate another charge event (20 minutes ago)
      const charge2 = createChargeEntry({
        chargedKWh: 2.0,
        solarKWh: 0.5,
        gridPrice: 0.18,
        soc: 0.84,
        timestamp: Date.now() - 20 * 60 * 1000, // 20 minutes ago
      });
      chargeLog.push(charge2);

      // Step 6: Recalculate battery cost (this is what updateBatteryStatus() does)
      const updatedCost = calculateBatteryEnergyCost(chargeLog);
      expect(updatedCost).not.toBeNull();
      expect(updatedCost.totalKWh).toBeCloseTo(6.0, 1);
      expect(updatedCost.avgPrice).toBeGreaterThan(0);

      // Step 7: Update strategy.batteryStatus (simulating updateBatteryStatus() call)
      strategy.batteryStatus.energyCost = updatedCost;
      strategy.batteryStatus.currentSoc = 0.84;

      // Step 8: Verify updated energyCost is now available
      expect(strategy.batteryStatus.energyCost).not.toBeNull();
      expect(strategy.batteryStatus.energyCost.totalKWh).toBeCloseTo(6.0, 1);
      expect(strategy.batteryStatus.energyCost.avgPrice).toBeGreaterThan(0);

      // Step 9: Verify this data would be visible in UI
      // (This is what the user would see in settings page)
      const uiEnergyCost = strategy.batteryStatus.energyCost;
      expect(uiEnergyCost).not.toBeNull();
      expect(uiEnergyCost.avgPrice).toBeGreaterThan(0);
      expect(uiEnergyCost.solarKWh).toBeGreaterThan(0);
      expect(uiEnergyCost.gridKWh).toBeGreaterThan(0);
      expect(uiEnergyCost.solarPercent + uiEnergyCost.gridPercent).toBeCloseTo(100, 0);
    });
  });
});

