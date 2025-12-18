const { computeHeuristicStrategy, forecastEnergyDemand, getPercentile } = require('../drivers/energy-optimizer/optimizer-core');

describe('Energy Optimizer Core Logic', () => {
  describe('getPercentile', () => {
    test('calculates 50th percentile (median) correctly', () => {
      const values = [1, 2, 3, 4, 5];
      expect(getPercentile(values, 0.5)).toBe(3);
    });

    test('calculates 70th percentile correctly', () => {
      const values = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
      const p70 = getPercentile(values, 0.7);
      expect(p70).toBeGreaterThan(60);
      expect(p70).toBeLessThanOrEqual(80);
    });

    test('handles empty array', () => {
      expect(getPercentile([], 0.5)).toBe(0);
    });

    test('handles single value', () => {
      expect(getPercentile([42], 0.5)).toBe(42);
    });
  });

  describe('forecastEnergyDemand', () => {
    test('returns 0 for empty intervals', () => {
      const demand = forecastEnergyDemand([], {}, 0.25);
      expect(demand).toBe(0);
    });

    test('uses default 3kW when no history available', () => {
      const intervals = [
        { intervalOfDay: 0 },
        { intervalOfDay: 1 },
      ];
      const history = {
        consumptionHistory: {},
        productionHistory: {},
        batteryHistory: {},
      };

      const demand = forecastEnergyDemand(intervals, history, 0.25);
      // 2 intervals × 3kW × 0.25h = 1.5 kWh
      expect(demand).toBeCloseTo(1.5, 1);
    });

    test('uses historical data when available', () => {
      const intervals = [
        { intervalOfDay: 10 },
      ];
      const history = {
        consumptionHistory: {
          10: [4000, 5000, 6000], // Average 5000W = 5kW
        },
        productionHistory: {},
        batteryHistory: {},
      };

      const demand = forecastEnergyDemand(intervals, history, 0.25);
      // 1 interval × 5kW × 0.25h = 1.25 kWh
      expect(demand).toBeCloseTo(1.25, 1);
    });
  });

  describe('computeHeuristicStrategy', () => {
    test('charges during cheap hours and discharges during expensive hours', () => {
      // Simulate a day with clear cheap/expensive pattern
      const indexedData = [
        { index: 0, startsAt: '2025-01-01T00:00:00Z', total: 0.10, intervalOfDay: 0 },  // cheap
        { index: 1, startsAt: '2025-01-01T00:15:00Z', total: 0.11, intervalOfDay: 1 },  // cheap
        { index: 2, startsAt: '2025-01-01T00:30:00Z', total: 0.12, intervalOfDay: 2 },  // cheap
        { index: 3, startsAt: '2025-01-01T07:00:00Z', total: 0.30, intervalOfDay: 28 }, // expensive
        { index: 4, startsAt: '2025-01-01T07:15:00Z', total: 0.32, intervalOfDay: 29 }, // expensive
        { index: 5, startsAt: '2025-01-01T07:30:00Z', total: 0.31, intervalOfDay: 30 }, // expensive
      ];

      const params = {
        batteryCapacity: 10,      // kWh
        currentSoc: 0.2,          // 20%
        targetSoc: 0.8,           // 80%
        chargePowerKW: 5,
        intervalHours: 0.25,
        efficiencyLoss: 0.1,
        expensivePriceFactor: 1.05,
        minProfitEurPerKWh: 0.05, // 5 ct/kWh - lower threshold
      };

      const history = {
        productionHistory: {},
        consumptionHistory: {
          28: [4000, 4200, 4100], // Morning consumption ~4 kW
          29: [4500, 4300, 4400],
          30: [4200, 4100, 4300],
        },
        batteryHistory: {},
      };

      const strategy = computeHeuristicStrategy(indexedData, params, history);

      // Should have charge intervals in cheap hours
      expect(strategy.chargeIntervals.length).toBeGreaterThan(0);
      const chargeIndices = strategy.chargeIntervals.map(i => i.index);
      expect(chargeIndices.some(idx => idx <= 2)).toBe(true); // At least one cheap slot

      // Should have discharge intervals in expensive hours
      expect(strategy.dischargeIntervals.length).toBeGreaterThan(0);
      const dischargeIndices = strategy.dischargeIntervals.map(i => i.index);
      expect(dischargeIndices.some(idx => idx >= 3)).toBe(true); // At least one expensive slot

      // Should have positive savings
      expect(strategy.savings).toBeGreaterThan(0);

      // Energy balance check
      expect(strategy.neededKWh).toBeGreaterThan(0);
      expect(strategy.forecastedDemand).toBeGreaterThan(0);
    });

    test('does not charge when battery is already at target SoC', () => {
      const indexedData = [
        { index: 0, startsAt: '2025-01-01T00:00:00Z', total: 0.10, intervalOfDay: 0 },
        { index: 1, startsAt: '2025-01-01T07:00:00Z', total: 0.30, intervalOfDay: 28 },
      ];

      const params = {
        batteryCapacity: 10,
        currentSoc: 0.85,  // Already at 85%
        targetSoc: 0.85,   // Target is 85%
        chargePowerKW: 5,
        intervalHours: 0.25,
        efficiencyLoss: 0.1,
        expensivePriceFactor: 1.05,
        minProfitEurPerKWh: 0.06,
      };

      const history = {
        productionHistory: {},
        consumptionHistory: {},
        batteryHistory: {},
      };

      const strategy = computeHeuristicStrategy(indexedData, params, history);

      // Should not plan new charging (battery full)
      expect(strategy.neededKWh).toBe(0);
      expect(strategy.chargeIntervals.length).toBe(0);
    });

    test('respects minimum profit threshold', () => {
      // Small price difference, below minimum profit
      const indexedData = [
        { index: 0, startsAt: '2025-01-01T00:00:00Z', total: 0.20, intervalOfDay: 0 },  // cheap
        { index: 1, startsAt: '2025-01-01T07:00:00Z', total: 0.24, intervalOfDay: 28 }, // expensive
      ];

      const params = {
        batteryCapacity: 10,
        currentSoc: 0.2,
        targetSoc: 0.8,
        chargePowerKW: 5,
        intervalHours: 0.25,
        efficiencyLoss: 0.1,
        expensivePriceFactor: 1.05,
        minProfitEurPerKWh: 0.10, // Very high minimum profit (10 ct/kWh)
      };

      const history = {
        productionHistory: {},
        consumptionHistory: {},
        batteryHistory: {},
      };

      const strategy = computeHeuristicStrategy(indexedData, params, history);

      // With such small price difference and high min profit, should not charge
      // Effective charge: 0.20 * 1.1 = 0.22, discharge: 0.24, diff: 0.02 < 0.10
      expect(strategy.chargeIntervals.length).toBe(0);
      expect(strategy.savings).toBe(0);
    });

    test('handles flat price profile (no optimization needed)', () => {
      // All prices the same
      const indexedData = [
        { index: 0, startsAt: '2025-01-01T00:00:00Z', total: 0.20, intervalOfDay: 0 },
        { index: 1, startsAt: '2025-01-01T00:15:00Z', total: 0.20, intervalOfDay: 1 },
        { index: 2, startsAt: '2025-01-01T00:30:00Z', total: 0.20, intervalOfDay: 2 },
        { index: 3, startsAt: '2025-01-01T07:00:00Z', total: 0.20, intervalOfDay: 28 },
      ];

      const params = {
        batteryCapacity: 10,
        currentSoc: 0.2,
        targetSoc: 0.8,
        chargePowerKW: 5,
        intervalHours: 0.25,
        efficiencyLoss: 0.1,
        expensivePriceFactor: 1.05,
        minProfitEurPerKWh: 0.06,
      };

      const history = {
        productionHistory: {},
        consumptionHistory: {},
        batteryHistory: {},
      };

      const strategy = computeHeuristicStrategy(indexedData, params, history);

      // With flat prices, no expensive intervals should be identified
      expect(strategy.expensiveIntervals.length).toBe(0);
      expect(strategy.chargeIntervals.length).toBe(0);
      expect(strategy.dischargeIntervals.length).toBe(0);
    });

    test('prioritizes highest price differences for maximum savings', () => {
      const indexedData = [
        { index: 0, startsAt: '2025-01-01T00:00:00Z', total: 0.10, intervalOfDay: 0 },   // cheapest
        { index: 1, startsAt: '2025-01-01T00:15:00Z', total: 0.11, intervalOfDay: 1 },
        { index: 2, startsAt: '2025-01-01T00:30:00Z', total: 0.12, intervalOfDay: 2 },
        { index: 3, startsAt: '2025-01-01T01:00:00Z', total: 0.15, intervalOfDay: 4 },   // medium cheap
        { index: 4, startsAt: '2025-01-01T07:00:00Z', total: 0.25, intervalOfDay: 28 },  // medium expensive
        { index: 5, startsAt: '2025-01-01T08:00:00Z', total: 0.35, intervalOfDay: 32 },  // most expensive
      ];

      const params = {
        batteryCapacity: 10,
        currentSoc: 0.2,
        targetSoc: 0.8,
        chargePowerKW: 5,
        intervalHours: 0.25,
        efficiencyLoss: 0.1,
        expensivePriceFactor: 1.0,  // Lower factor to enable discharge intervals
        minProfitEurPerKWh: 0.05,
      };

      const history = {
        productionHistory: {},
        consumptionHistory: {
          28: [3500, 3600, 3700],  // Some demand in medium hour
          32: [5000, 5200, 5100],  // High demand in expensive hour
        },
        batteryHistory: {},
      };

      const strategy = computeHeuristicStrategy(indexedData, params, history);

      // Should have some charge and discharge intervals
      expect(strategy.chargeIntervals.length).toBeGreaterThan(0);
      expect(strategy.dischargeIntervals.length).toBeGreaterThan(0);

      // Should charge from cheapest intervals (0, 1, 2)
      const chargeIndices = strategy.chargeIntervals.map(i => i.index);
      expect(chargeIndices.some(idx => idx <= 2)).toBe(true);

      // Should discharge to most expensive intervals (4 or 5)
      const dischargeIndices = strategy.dischargeIntervals.map(i => i.index);
      expect(dischargeIndices.some(idx => idx >= 4)).toBe(true);

      // Savings should be positive and significant
      expect(strategy.savings).toBeGreaterThan(0);
    });

    test('respects battery capacity limits', () => {
      // Many cheap and expensive intervals but limited battery
      const indexedData = [];
      for (let i = 0; i < 10; i++) {
        indexedData.push({ index: i, startsAt: `2025-01-01T0${i}:00:00Z`, total: 0.10, intervalOfDay: i * 4 });
      }
      for (let i = 10; i < 20; i++) {
        indexedData.push({ index: i, startsAt: `2025-01-01T${i}:00:00Z`, total: 0.30, intervalOfDay: i * 4 });
      }

      const params = {
        batteryCapacity: 5,   // Small battery
        currentSoc: 0.2,
        targetSoc: 0.8,
        chargePowerKW: 5,
        intervalHours: 0.25,
        efficiencyLoss: 0.1,
        expensivePriceFactor: 1.05,
        minProfitEurPerKWh: 0.05,
      };

      const history = {
        productionHistory: {},
        consumptionHistory: {},
        batteryHistory: {},
      };

      const strategy = computeHeuristicStrategy(indexedData, params, history);

      // Total charge should not exceed available battery capacity
      const maxCapacity = params.batteryCapacity * (params.targetSoc - params.currentSoc);
      expect(strategy.neededKWh).toBeLessThanOrEqual(maxCapacity + 0.01);
    });

    test('does not discharge existing battery energy when price is below cost basis (incl. minProfit, efficiency adjusted)', () => {
      const indexedData = [
        { index: 0, startsAt: '2025-01-01T00:00:00Z', total: 0.10, intervalOfDay: 0 },
        { index: 1, startsAt: '2025-01-01T07:00:00Z', total: 0.20, intervalOfDay: 28 },
      ];

      const params = {
        batteryCapacity: 10,
        currentSoc: 0.8, // plenty of energy available
        targetSoc: 0.8,  // no charging plan, only existing energy could be used
        chargePowerKW: 5,
        intervalHours: 0.25,
        efficiencyLoss: 0.1,
        expensivePriceFactor: 1.0,
        minProfitEurPerKWh: 0.0,
        // Very expensive stored energy => should not be used
        batteryCostEurPerKWh: 0.30,
      };

      const history = {
        productionHistory: {},
        consumptionHistory: {
          28: [4000, 4000, 4000], // demand exists
        },
        batteryHistory: {},
      };

      const strategy = computeHeuristicStrategy(indexedData, params, history);

      expect(strategy.dischargeIntervals.length).toBe(0);
    });

    test('respects minEnergyKWh (min SoC reserve) when using existing battery energy', () => {
      const indexedData = [
        { index: 0, startsAt: '2025-01-01T00:00:00Z', total: 0.10, intervalOfDay: 0 },
        { index: 1, startsAt: '2025-01-01T07:00:00Z', total: 0.30, intervalOfDay: 28 },
      ];

      const params = {
        batteryCapacity: 10,
        currentSoc: 0.5, // 5.0 kWh stored
        targetSoc: 0.5,  // cannot charge more
        chargePowerKW: 5,
        intervalHours: 0.25,
        efficiencyLoss: 0.1,
        expensivePriceFactor: 1.0,
        minProfitEurPerKWh: 0.0,
        batteryCostEurPerKWh: 0.05, // profitable to use
        minEnergyKWh: 4.0, // keep 4 kWh stored => only 1 kWh stored usable
      };

      const history = {
        productionHistory: {},
        consumptionHistory: {
          // demand = 3.2kW * 0.25h = 0.8kWh
          28: [3200, 3200, 3200],
        },
        batteryHistory: {},
      };

      const strategy = computeHeuristicStrategy(indexedData, params, history);

      // Usable delivered energy above reserve = (5-4)*etaDischarge = 1*0.9 = 0.9kWh
      // Demand is 0.8kWh, so discharging should still be allowed
      expect(strategy.dischargeIntervals.length).toBeGreaterThan(0);
      expect(strategy.dischargeIntervals[0].index).toBe(1);
      expect(strategy.dischargeIntervals[0].demandKWh).toBeCloseTo(0.8, 1);
    });
  });

  describe('Realistic scenario: Winter day with morning peak', () => {
    test('optimizes for typical German winter day', () => {
      // Simulated Tibber prices for a winter day
      const indexedData = [
        // Night hours (cheap)
        { index: 0, startsAt: '2025-01-15T00:00:00Z', total: 0.18, intervalOfDay: 0 },
        { index: 4, startsAt: '2025-01-15T01:00:00Z', total: 0.17, intervalOfDay: 4 },
        { index: 8, startsAt: '2025-01-15T02:00:00Z', total: 0.16, intervalOfDay: 8 },
        { index: 12, startsAt: '2025-01-15T03:00:00Z', total: 0.15, intervalOfDay: 12 }, // cheapest
        { index: 16, startsAt: '2025-01-15T04:00:00Z', total: 0.16, intervalOfDay: 16 },
        { index: 20, startsAt: '2025-01-15T05:00:00Z', total: 0.18, intervalOfDay: 20 },
        // Morning peak (expensive)
        { index: 24, startsAt: '2025-01-15T06:00:00Z', total: 0.28, intervalOfDay: 24 },
        { index: 28, startsAt: '2025-01-15T07:00:00Z', total: 0.35, intervalOfDay: 28 }, // peak
        { index: 32, startsAt: '2025-01-15T08:00:00Z', total: 0.33, intervalOfDay: 32 },
        { index: 36, startsAt: '2025-01-15T09:00:00Z', total: 0.30, intervalOfDay: 36 },
        // Day (moderate)
        { index: 40, startsAt: '2025-01-15T10:00:00Z', total: 0.22, intervalOfDay: 40 },
        { index: 60, startsAt: '2025-01-15T15:00:00Z', total: 0.20, intervalOfDay: 60 },
        // Evening peak (expensive)
        { index: 68, startsAt: '2025-01-15T17:00:00Z', total: 0.30, intervalOfDay: 68 },
        { index: 72, startsAt: '2025-01-15T18:00:00Z', total: 0.34, intervalOfDay: 72 },
        { index: 76, startsAt: '2025-01-15T19:00:00Z', total: 0.32, intervalOfDay: 76 },
      ];

      const params = {
        batteryCapacity: 9.9,
        currentSoc: 0.20,     // 20% at midnight
        targetSoc: 0.85,      // Target 85%
        chargePowerKW: 6.0,
        intervalHours: 0.25,
        efficiencyLoss: 0.10,
        expensivePriceFactor: 1.0,  // Lower to enable more discharge intervals
        minProfitEurPerKWh: 0.05,   // Lower threshold
      };

      const history = {
        productionHistory: {},
        consumptionHistory: {
          28: [5000, 5500, 5200], // Morning peak consumption
          72: [4500, 4800, 4600], // Evening peak consumption
        },
        batteryHistory: {},
      };

      const strategy = computeHeuristicStrategy(indexedData, params, history);

      // Should charge during night (cheapest hours)
      const chargeIndices = strategy.chargeIntervals.map(i => i.index);
      expect(chargeIndices.some(idx => idx >= 8 && idx <= 20)).toBe(true);

      // Should discharge during morning peak
      const dischargeIndices = strategy.dischargeIntervals.map(i => i.index);
      expect(dischargeIndices.some(idx => idx >= 24 && idx <= 36)).toBe(true);

      // Should have savings (may be modest with small price differences)
      expect(strategy.savings).toBeGreaterThan(0);

      // Energy balance
      expect(strategy.neededKWh).toBeGreaterThan(0);
      expect(strategy.neededKWh).toBeLessThanOrEqual(params.batteryCapacity * (params.targetSoc - params.currentSoc));
    });
  });
});
