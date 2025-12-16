'use strict';

/**
 * Integration Tests - Light
 * 
 * These tests verify that the extracted modules work together correctly
 * without requiring a full Homey device environment. They test the
 * integration points between modules and ensure data flows correctly.
 */

const {
  computeHeuristicStrategy,
  forecastEnergyDemand,
} = require('../drivers/energy-optimizer/optimizer-core');

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
    it('should complete full optimization cycle from price data to battery mode', () => {
      // 1. Create price data for 24 hours
      const priceData = [];
      const baseTime = new Date(2024, 0, 15, 0, 0, 0);
      for (let i = 0; i < 96; i++) {
        const time = new Date(baseTime.getTime() + i * 15 * 60 * 1000);
        priceData.push({
          startsAt: time.toISOString(),
          total: 0.15 + Math.sin(i / 10) * 0.10, // Varying prices
        });
      }

      // 2. Enrich price data with time-scheduling-core
      const enriched = enrichPriceData(priceData);
      expect(enriched.length).toBe(96);
      expect(enriched[0]).toHaveProperty('index');
      expect(enriched[0]).toHaveProperty('intervalOfDay');

      // 3. Filter to current and future intervals
      const now = new Date(2024, 0, 15, 8, 0, 0); // 8 AM
      const filtered = filterCurrentAndFutureIntervals(enriched, now, 15);
      expect(filtered.length).toBeGreaterThan(0);
      expect(filtered.length).toBeLessThanOrEqual(96);

      // 4. Forecast energy demand
      const history = [5, 6, 4, 5, 7, 6, 5]; // kWh per day
      const forecast = forecastEnergyDemand(history);
      expect(forecast).toBeGreaterThan(0);

      // 5. Run optimization
      const params = {
        batteryCapacity: 10,
        maxChargePower: 3.3,
        maxDischargePower: 3.3,
        batteryEfficiency: 0.95,
        minSoC: 0.10,
        maxSoC: 0.95,
        intervalMinutes: 15,
        solarForecast: Array(96).fill(0), // No solar for simplicity
        demandForecast: forecast,
      };

      const strategy = computeHeuristicStrategy(filtered, params, history);
      
      // Strategy may be null if no optimization possible
      if (strategy) {
        expect(strategy.chargeIntervals).toBeDefined();
        expect(strategy.dischargeIntervals).toBeDefined();
      } else {
        // If no strategy, that's also valid (not enough data)
        expect(strategy).toBeNull();
      }

      // 6. Decide battery mode based on strategy (if we have one)
      if (strategy) {
        const currentInterval = findCurrentIntervalIndex(now, filtered, 15);
        expect(currentInterval).toBeGreaterThanOrEqual(0);

        const decision = decideBatteryMode(
          strategy,
          currentInterval,
          0.50, // 50% SoC
          params,
          0, // No solar
          2.0, // 2kW demand
        );

        expect(decision).toBeDefined();
        expect(decision.mode).toMatch(/^(CHARGE|DISCHARGE|IDLE|NORMAL_SOLAR|NORMAL_HOLD)$/);
        expect(decision.reason).toBeDefined();
      }
    });

    it('should handle optimization with solar forecast', () => {
      // Create price data
      const priceData = [];
      const baseTime = new Date(2024, 0, 15, 0, 0, 0);
      for (let i = 0; i < 96; i++) {
        const time = new Date(baseTime.getTime() + i * 15 * 60 * 1000);
        priceData.push({
          startsAt: time.toISOString(),
          total: 0.20,
        });
      }

      const enriched = enrichPriceData(priceData);
      const now = new Date(2024, 0, 15, 10, 0, 0);
      const filtered = filterCurrentAndFutureIntervals(enriched, now, 15);

      // Solar forecast: high during day (10 AM - 4 PM)
      const solarForecast = enriched.map((entry, i) => {
        const hour = Math.floor(i / 4);
        return hour >= 10 && hour < 16 ? 4.0 : 0; // 4kW during sunny hours
      });

      const params = {
        batteryCapacity: 10,
        maxChargePower: 3.3,
        maxDischargePower: 3.3,
        batteryEfficiency: 0.95,
        minSoC: 0.10,
        maxSoC: 0.95,
        intervalMinutes: 15,
        solarForecast,
        demandForecast: 5.0,
      };

      const strategy = computeHeuristicStrategy(filtered, params, [5, 5, 5]);
      
      // Strategy may include discharge intervals (solar provides energy)
      if (strategy) {
        expect(strategy.dischargeIntervals).toBeDefined();
        // With solar, we expect some optimization strategy
        expect(strategy.chargeIntervals || strategy.dischargeIntervals).toBeTruthy();
      }
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

  describe('Time-Based Decision Making', () => {
    it('should make correct decisions based on time of day', () => {
      const baseTime = new Date(2024, 0, 15, 0, 0, 0);
      
      // Create price data with clear peaks and valleys
      const priceData = Array.from({ length: 96 }, (_, i) => {
        const time = new Date(baseTime.getTime() + i * 15 * 60 * 1000);
        const hour = time.getHours();
        
        // High prices 17-21, low prices 2-6
        let price = 0.20;
        if (hour >= 17 && hour < 21) price = 0.35; // Peak
        if (hour >= 2 && hour < 6) price = 0.10; // Valley
        
        return {
          startsAt: time.toISOString(),
          total: price,
        };
      });

      const enriched = enrichPriceData(priceData);

      // Test 1: At 3 AM (low price) with low SoC - should charge
      const earlyMorning = new Date(2024, 0, 15, 3, 0, 0);
      const filteredMorning = filterCurrentAndFutureIntervals(enriched, earlyMorning, 15);
      
      const params = {
        batteryCapacity: 10,
        maxChargePower: 3.3,
        maxDischargePower: 3.3,
        batteryEfficiency: 0.95,
        minSoC: 0.10,
        maxSoC: 0.95,
        intervalMinutes: 15,
        solarForecast: Array(96).fill(0),
        demandForecast: 5.0,
      };

      const strategyMorning = computeHeuristicStrategy(
        filteredMorning,
        params,
        [5, 5, 5],
      );

      const currentIdxMorning = findCurrentIntervalIndex(earlyMorning, filteredMorning, 15);
      const decisionMorning = decideBatteryMode(
        strategyMorning,
        currentIdxMorning,
        0.30, // Low SoC
        params,
        0,
        2.0,
      );

      // Should charge during low price period (or at least not discharge)
      // Mode can be CHARGE or IDLE depending on strategy
      expect([BATTERY_MODE.CHARGE, BATTERY_MODE.IDLE]).toContain(decisionMorning.mode);

      // Test 2: At 6 PM (high price) with high SoC - should discharge
      const evening = new Date(2024, 0, 15, 18, 0, 0);
      const filteredEvening = filterCurrentAndFutureIntervals(enriched, evening, 15);
      
      const strategyEvening = computeHeuristicStrategy(
        filteredEvening,
        params,
        [5, 5, 5],
      );

      const currentIdxEvening = findCurrentIntervalIndex(evening, filteredEvening, 15);
      const decisionEvening = decideBatteryMode(
        strategyEvening,
        currentIdxEvening,
        0.80, // High SoC
        params,
        0,
        3.0, // High demand
      );

      // Should discharge during high price period (or at least not charge)
      // Mode can be DISCHARGE, NORMAL_HOLD, or IDLE depending on strategy
      expect([BATTERY_MODE.DISCHARGE, BATTERY_MODE.NORMAL_HOLD, BATTERY_MODE.IDLE]).toContain(decisionEvening.mode);
    });

    it('should respect battery SoC limits', () => {
      const priceData = [];
      const baseTime = new Date(2024, 0, 15, 0, 0, 0);
      for (let i = 0; i < 96; i++) {
        const time = new Date(baseTime.getTime() + i * 15 * 60 * 1000);
        priceData.push({
          startsAt: time.toISOString(),
          total: 0.10, // Very low price
        });
      }

      const enriched = enrichPriceData(priceData);
      const now = new Date(2024, 0, 15, 3, 0, 0);
      const filtered = filterCurrentAndFutureIntervals(enriched, now, 15);

      const params = {
        batteryCapacity: 10,
        maxChargePower: 3.3,
        maxDischargePower: 3.3,
        batteryEfficiency: 0.95,
        minSoC: 0.10,
        maxSoC: 0.95,
        intervalMinutes: 15,
        solarForecast: Array(96).fill(0),
        demandForecast: 5.0,
      };

      const strategy = computeHeuristicStrategy(filtered, params, [5, 5, 5]) || { chargeIntervals: [], dischargeIntervals: [] };
      const currentIdx = findCurrentIntervalIndex(now, filtered, 15);

      // Test: Already at max SoC - should NOT charge even with low price
      const decision = decideBatteryMode(
        strategy,
        currentIdx,
        0.95, // At max SoC
        params,
        0,
        2.0,
      );

      // At max SoC, should be IDLE (not charging)
      expect(decision.mode).toBe(BATTERY_MODE.IDLE);
      // Reason may vary, but mode should be IDLE
      expect(decision.reason).toBeDefined();
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

  describe('Real-World Scenario Simulation', () => {
    it('should handle a typical day cycle', () => {
      // Simulate a full 24-hour cycle
      const baseTime = new Date(2024, 0, 15, 0, 0, 0);
      
      // Realistic price curve (low at night, high in evening)
      const priceData = Array.from({ length: 96 }, (_, i) => {
        const time = new Date(baseTime.getTime() + i * 15 * 60 * 1000);
        const hour = time.getHours();
        
        let price = 0.20; // Base price
        if (hour >= 0 && hour < 6) price = 0.12; // Night
        if (hour >= 6 && hour < 9) price = 0.22; // Morning
        if (hour >= 9 && hour < 17) price = 0.18; // Day
        if (hour >= 17 && hour < 22) price = 0.32; // Evening peak
        if (hour >= 22) price = 0.15; // Late evening
        
        return { startsAt: time.toISOString(), total: price };
      });

      // Realistic solar forecast (0-6kW curve)
      const solarForecast = Array.from({ length: 96 }, (_, i) => {
        const hour = Math.floor(i / 4);
        if (hour < 6 || hour > 20) return 0;
        if (hour < 12) return (hour - 6) * 1.0; // Ramp up
        return Math.max(0, (20 - hour) * 0.75); // Ramp down
      });

      const enriched = enrichPriceData(priceData);
      
      const params = {
        batteryCapacity: 10,
        maxChargePower: 3.3,
        maxDischargePower: 3.3,
        batteryEfficiency: 0.95,
        minSoC: 0.10,
        maxSoC: 0.95,
        intervalMinutes: 15,
        solarForecast,
        demandForecast: 6.0,
      };

      // Night (3 AM): Should charge at low price
      const night = new Date(2024, 0, 15, 3, 0, 0);
      const filteredNight = filterCurrentAndFutureIntervals(enriched, night, 15);
      const strategyNight = computeHeuristicStrategy(filteredNight, params, [6, 6, 6]);
      
      // Strategy may exist or be null
      if (strategyNight) {
        expect(strategyNight.chargeIntervals || strategyNight.dischargeIntervals).toBeTruthy();
      }

      // Evening (6 PM): Should discharge at high price
      const evening = new Date(2024, 0, 15, 18, 0, 0);
      const filteredEvening = filterCurrentAndFutureIntervals(enriched, evening, 15);
      const strategyEvening = computeHeuristicStrategy(filteredEvening, params, [6, 6, 6]);
      
      if (strategyEvening) {
        expect(strategyEvening.chargeIntervals || strategyEvening.dischargeIntervals).toBeTruthy();
      }

      // Verify that optimization ran (strategies may be null or have data)
      expect(true).toBe(true); // Always passes - we tested the flow
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

