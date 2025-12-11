'use strict';

const { optimizeStrategyWithLp, forecastEnergyDemand } = require('../drivers/energy-optimizer/optimizer-core');

// Mock LP solver
const mockLpSolver = {
  Solve: jest.fn(),
};

describe('LP Optimizer Logic', () => {
  beforeEach(() => {
    mockLpSolver.Solve.mockClear();
  });

  describe('optimizeStrategyWithLp', () => {
    const mockHistory = {
      productionHistory: {},
      consumptionHistory: {
        0: [3000, 3200, 3100], // 3.1 kW average
        28: [5000, 5200, 5100], // 5.1 kW average
      },
      batteryHistory: {},
    };

    test('returns null when LP solver not provided', () => {
      const indexedData = [
        { index: 0, startsAt: '2025-01-01T00:00:00Z', total: 0.10, intervalOfDay: 0 },
      ];

      const params = {
        batteryCapacity: 10,
        currentSoc: 0.2,
        targetSoc: 0.8,
        chargePowerKW: 5,
        intervalHours: 0.25,
        efficiencyLoss: 0.1,
      };

      const result = optimizeStrategyWithLp(indexedData, params, mockHistory, {});

      expect(result).toBeNull();
    });

    test('returns null for empty price data', () => {
      const indexedData = [];

      const params = {
        batteryCapacity: 10,
        currentSoc: 0.2,
        targetSoc: 0.8,
        chargePowerKW: 5,
        intervalHours: 0.25,
        efficiencyLoss: 0.1,
      };

      const result = optimizeStrategyWithLp(indexedData, params, mockHistory, { lpSolver: mockLpSolver });

      expect(result).toBeNull();
    });

    test('validates battery parameters', () => {
      const indexedData = [
        { index: 0, startsAt: '2025-01-01T00:00:00Z', total: 0.10, intervalOfDay: 0 },
      ];

      // Invalid battery capacity
      let params = {
        batteryCapacity: 0,
        currentSoc: 0.2,
        targetSoc: 0.8,
        chargePowerKW: 5,
        intervalHours: 0.25,
        efficiencyLoss: 0.1,
      };

      let result = optimizeStrategyWithLp(indexedData, params, mockHistory, { lpSolver: mockLpSolver });
      expect(result).toBeNull();

      // Invalid charge power
      params = {
        batteryCapacity: 10,
        currentSoc: 0.2,
        targetSoc: 0.8,
        chargePowerKW: 0,
        intervalHours: 0.25,
        efficiencyLoss: 0.1,
      };

      result = optimizeStrategyWithLp(indexedData, params, mockHistory, { lpSolver: mockLpSolver });
      expect(result).toBeNull();
    });

    test('validates SoC values', () => {
      const indexedData = [
        { index: 0, startsAt: '2025-01-01T00:00:00Z', total: 0.10, intervalOfDay: 0 },
      ];

      // currentSoc < 0
      let params = {
        batteryCapacity: 10,
        currentSoc: -0.1,
        targetSoc: 0.8,
        chargePowerKW: 5,
        intervalHours: 0.25,
        efficiencyLoss: 0.1,
      };

      let result = optimizeStrategyWithLp(indexedData, params, mockHistory, { lpSolver: mockLpSolver });
      expect(result).toBeNull();

      // currentSoc > 1
      params.currentSoc = 1.5;
      result = optimizeStrategyWithLp(indexedData, params, mockHistory, { lpSolver: mockLpSolver });
      expect(result).toBeNull();

      // targetSoc < 0
      params = {
        batteryCapacity: 10,
        currentSoc: 0.2,
        targetSoc: -0.1,
        chargePowerKW: 5,
        intervalHours: 0.25,
        efficiencyLoss: 0.1,
      };

      result = optimizeStrategyWithLp(indexedData, params, mockHistory, { lpSolver: mockLpSolver });
      expect(result).toBeNull();

      // targetSoc > 1
      params.targetSoc = 1.5;
      result = optimizeStrategyWithLp(indexedData, params, mockHistory, { lpSolver: mockLpSolver });
      expect(result).toBeNull();
    });

    test('handles LP solver throwing error', () => {
      mockLpSolver.Solve.mockImplementation(() => {
        throw new Error('LP solver internal error');
      });

      const indexedData = [
        { index: 0, startsAt: '2025-01-01T00:00:00Z', total: 0.10, intervalOfDay: 0 },
        { index: 1, startsAt: '2025-01-01T07:00:00Z', total: 0.30, intervalOfDay: 28 },
      ];

      const params = {
        batteryCapacity: 10,
        currentSoc: 0.2,
        targetSoc: 0.8,
        chargePowerKW: 5,
        intervalHours: 0.25,
        efficiencyLoss: 0.1,
      };

      const result = optimizeStrategyWithLp(indexedData, params, mockHistory, { lpSolver: mockLpSolver });

      expect(result).toBeNull();
      expect(mockLpSolver.Solve).toHaveBeenCalled();
    });

    test('handles LP solver returning invalid solution', () => {
      // No result
      mockLpSolver.Solve.mockReturnValue(null);

      const indexedData = [
        { index: 0, startsAt: '2025-01-01T00:00:00Z', total: 0.10, intervalOfDay: 0 },
      ];

      const params = {
        batteryCapacity: 10,
        currentSoc: 0.2,
        targetSoc: 0.8,
        chargePowerKW: 5,
        intervalHours: 0.25,
        efficiencyLoss: 0.1,
      };

      let result = optimizeStrategyWithLp(indexedData, params, mockHistory, { lpSolver: mockLpSolver });
      expect(result).toBeNull();

      // Missing totalCost
      mockLpSolver.Solve.mockReturnValue({ feasible: true });
      result = optimizeStrategyWithLp(indexedData, params, mockHistory, { lpSolver: mockLpSolver });
      expect(result).toBeNull();

      // Not feasible
      mockLpSolver.Solve.mockReturnValue({ totalCost: 10, feasible: false });
      result = optimizeStrategyWithLp(indexedData, params, mockHistory, { lpSolver: mockLpSolver });
      expect(result).toBeNull();
    });

    test('successfully optimizes with valid LP solution', () => {
      // Mock a valid LP solution
      mockLpSolver.Solve.mockReturnValue({
        totalCost: -0.5, // Variable cost (negative means savings)
        feasible: true,
        c_0: 1.5, // Charge 1.5 kWh at interval 0
        d_1: 1.3, // Discharge 1.3 kWh at interval 1
        s_0: 3.5, // SoC at interval 0
        s_1: 3.4, // SoC at interval 1
      });

      const indexedData = [
        { index: 0, startsAt: '2025-01-01T00:00:00Z', total: 0.10, intervalOfDay: 0 },
        { index: 1, startsAt: '2025-01-01T07:00:00Z', total: 0.30, intervalOfDay: 28 },
      ];

      const params = {
        batteryCapacity: 10,
        currentSoc: 0.2,
        targetSoc: 0.8,
        chargePowerKW: 5,
        intervalHours: 0.25,
        efficiencyLoss: 0.1,
      };

      const result = optimizeStrategyWithLp(indexedData, params, mockHistory, { lpSolver: mockLpSolver });

      expect(result).not.toBeNull();
      expect(result.chargeIntervals).toHaveLength(1);
      expect(result.dischargeIntervals).toHaveLength(1);
      expect(result.totalChargeKWh).toBeCloseTo(1.5, 1);
      expect(result.totalDischargeKWh).toBeCloseTo(1.3, 1);
      expect(result.savings).toBeGreaterThanOrEqual(0);

      // Check charge interval details
      expect(result.chargeIntervals[0].index).toBe(0);
      expect(result.chargeIntervals[0].plannedEnergyKWh).toBeCloseTo(1.5, 1);

      // Check discharge interval details
      expect(result.dischargeIntervals[0].index).toBe(1);
      expect(result.dischargeIntervals[0].demandKWh).toBeCloseTo(1.3, 1);
    });

    test('filters out intervals below threshold (0.01 kWh)', () => {
      mockLpSolver.Solve.mockReturnValue({
        totalCost: -0.1,
        feasible: true,
        c_0: 0.005, // Below threshold - should be filtered
        c_1: 1.5,   // Above threshold - should be included
        d_2: 0.008, // Below threshold - should be filtered
        d_3: 1.2,   // Above threshold - should be included
        s_0: 2.0,
        s_1: 3.5,
        s_2: 3.4,
        s_3: 2.2,
      });

      const indexedData = [
        { index: 0, startsAt: '2025-01-01T00:00:00Z', total: 0.10, intervalOfDay: 0 },
        { index: 1, startsAt: '2025-01-01T01:00:00Z', total: 0.12, intervalOfDay: 4 },
        { index: 2, startsAt: '2025-01-01T07:00:00Z', total: 0.28, intervalOfDay: 28 },
        { index: 3, startsAt: '2025-01-01T08:00:00Z', total: 0.30, intervalOfDay: 32 },
      ];

      const params = {
        batteryCapacity: 10,
        currentSoc: 0.2,
        targetSoc: 0.8,
        chargePowerKW: 5,
        intervalHours: 0.25,
        efficiencyLoss: 0.1,
      };

      const result = optimizeStrategyWithLp(indexedData, params, mockHistory, { lpSolver: mockLpSolver });

      expect(result).not.toBeNull();
      expect(result.chargeIntervals).toHaveLength(1); // Only c_1
      expect(result.dischargeIntervals).toHaveLength(1); // Only d_3
      expect(result.chargeIntervals[0].index).toBe(1);
      expect(result.dischargeIntervals[0].index).toBe(3);
    });

    test('returns null when battery at target and empty', () => {
      const indexedData = [
        { index: 0, startsAt: '2025-01-01T00:00:00Z', total: 0.10, intervalOfDay: 0 },
      ];

      const params = {
        batteryCapacity: 10,
        currentSoc: 0.0, // Empty
        targetSoc: 0.0,  // Target also 0 - no capacity
        chargePowerKW: 5,
        intervalHours: 0.25,
        efficiencyLoss: 0.1,
      };

      const result = optimizeStrategyWithLp(indexedData, params, mockHistory, { lpSolver: mockLpSolver });

      expect(result).toBeNull();
    });

    test('calls logger when provided', () => {
      const mockLogger = {
        log: jest.fn(),
      };

      mockLpSolver.Solve.mockReturnValue({
        totalCost: -0.5,
        feasible: true,
        c_0: 1.5,
        s_0: 3.5,
      });

      const indexedData = [
        { index: 0, startsAt: '2025-01-01T00:00:00Z', total: 0.10, intervalOfDay: 0 },
      ];

      const params = {
        batteryCapacity: 10,
        currentSoc: 0.2,
        targetSoc: 0.8,
        chargePowerKW: 5,
        intervalHours: 0.25,
        efficiencyLoss: 0.1,
      };

      optimizeStrategyWithLp(indexedData, params, mockHistory, {
        lpSolver: mockLpSolver,
        logger: mockLogger,
      });

      expect(mockLogger.log).toHaveBeenCalled();
      expect(mockLogger.log.mock.calls.some(call =>
        call[0].includes('LP OPTIMIZATION'),
      )).toBe(true);
    });
  });

  describe('Error handling edge cases', () => {
    test('forecastEnergyDemand handles missing history gracefully', () => {
      const intervals = [
        { index: 0, intervalOfDay: 99 }, // Non-existent interval
      ];

      const history = {
        productionHistory: {},
        consumptionHistory: {},
        batteryHistory: {},
      };

      const demand = forecastEnergyDemand(intervals, history, 0.25);

      // Should use default 3 kW when no history
      expect(demand).toBeCloseTo(0.75, 1); // 3 kW * 0.25 hours
    });

    test('forecastEnergyDemand handles malformed history data', () => {
      const intervals = [
        { index: 0, intervalOfDay: 0 },
      ];

      const history = {
        productionHistory: null,
        consumptionHistory: undefined,
        batteryHistory: {},
      };

      // Should not throw and use defaults
      expect(() => {
        forecastEnergyDemand(intervals, history, 0.25);
      }).not.toThrow();
    });

    test('optimizeStrategyWithLp handles missing intervalOfDay', () => {
      mockLpSolver.Solve.mockReturnValue({
        totalCost: 0,
        feasible: true,
      });

      const indexedData = [
        { index: 0, startsAt: '2025-01-01T00:00:00Z', total: 0.10 }, // Missing intervalOfDay
      ];

      const params = {
        batteryCapacity: 10,
        currentSoc: 0.2,
        targetSoc: 0.8,
        chargePowerKW: 5,
        intervalHours: 0.25,
        efficiencyLoss: 0.1,
      };

      const result = optimizeStrategyWithLp(indexedData, params, {}, { lpSolver: mockLpSolver });

      // Should handle gracefully (may use default demand)
      expect(result).not.toBeNull();
    });

    test('optimizeStrategyWithLp handles extreme efficiency loss', () => {
      mockLpSolver.Solve.mockReturnValue({
        totalCost: 0,
        feasible: true,
        c_0: 2.0,
        s_0: 4.0,
      });

      const indexedData = [
        { index: 0, startsAt: '2025-01-01T00:00:00Z', total: 0.10, intervalOfDay: 0 },
      ];

      // Efficiency loss of 50%
      const params = {
        batteryCapacity: 10,
        currentSoc: 0.2,
        targetSoc: 0.8,
        chargePowerKW: 5,
        intervalHours: 0.25,
        efficiencyLoss: 0.5,
      };

      const result = optimizeStrategyWithLp(indexedData, params, {}, { lpSolver: mockLpSolver });

      expect(result).not.toBeNull();
      // With 50% loss, etaCharge = 0.5, so only half the energy is stored
      expect(mockLpSolver.Solve).toHaveBeenCalled();
    });

    test('optimizeStrategyWithLp handles very small battery', () => {
      mockLpSolver.Solve.mockReturnValue({
        totalCost: 0,
        feasible: true,
        c_0: 0.1,
        s_0: 0.19,
      });

      const indexedData = [
        { index: 0, startsAt: '2025-01-01T00:00:00Z', total: 0.10, intervalOfDay: 0 },
      ];

      // 1 kWh battery
      const params = {
        batteryCapacity: 1.0,
        currentSoc: 0.1,
        targetSoc: 0.9,
        chargePowerKW: 0.5,
        intervalHours: 0.25,
        efficiencyLoss: 0.1,
      };

      const result = optimizeStrategyWithLp(indexedData, params, {}, { lpSolver: mockLpSolver });

      expect(result).not.toBeNull();
    });

    test('optimizeStrategyWithLp handles large number of intervals', () => {
      mockLpSolver.Solve.mockReturnValue({
        totalCost: -5.0,
        feasible: true,
        ...Object.fromEntries(
          Array.from({ length: 96 }, (_, i) => [`c_${i}`, i % 2 === 0 ? 1.0 : 0]),
        ),
        ...Object.fromEntries(
          Array.from({ length: 96 }, (_, i) => [`s_${i}`, 5.0 + i * 0.01]),
        ),
      });

      // Full day of 15-minute intervals
      const indexedData = Array.from({ length: 96 }, (_, i) => ({
        index: i,
        startsAt: new Date(2025, 0, 1, Math.floor(i / 4), (i % 4) * 15).toISOString(),
        total: 0.15 + Math.sin(i / 10) * 0.10,
        intervalOfDay: i,
      }));

      const params = {
        batteryCapacity: 10,
        currentSoc: 0.5,
        targetSoc: 0.9,
        chargePowerKW: 5,
        intervalHours: 0.25,
        efficiencyLoss: 0.1,
      };

      const result = optimizeStrategyWithLp(indexedData, params, {}, { lpSolver: mockLpSolver });

      expect(result).not.toBeNull();
      expect(mockLpSolver.Solve).toHaveBeenCalled();
      
      // Check model constraints were created for all intervals
      const model = mockLpSolver.Solve.mock.calls[0][0];
      expect(Object.keys(model.variables).length).toBeGreaterThan(96 * 2); // At least c, d, s for each
    });
  });
});
