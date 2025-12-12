'use strict';

const {
  calculateBatteryEnergyCost,
  createChargeEntry,
  createDischargeEntry,
  shouldClearChargeLog,
  trimChargeLog,
  calculateDischargeProfit,
} = require('../drivers/energy-optimizer/battery-cost-core');

describe('battery-cost-core', () => {
  describe('createChargeEntry', () => {
    it('should create a charge entry with solar and grid split', () => {
      const entry = createChargeEntry({
        chargedKWh: 5.0,
        solarKWh: 3.0,
        gridPrice: 0.25,
        soc: 50,
        timestamp: new Date('2024-01-15T10:00:00Z'),
      });

      expect(entry.type).toBe('charge');
      expect(entry.solarKWh).toBe(3.0); // From solar
      expect(entry.gridKWh).toBe(2.0); // Rest from grid (5 - 3)
      expect(entry.totalKWh).toBe(5.0);
      expect(entry.gridPrice).toBe(0.25);
      expect(entry.soc).toBe(50);
      expect(entry.timestamp).toBe('2024-01-15T10:00:00.000Z');
    });

    it('should handle all energy from solar', () => {
      const entry = createChargeEntry({
        chargedKWh: 3.0,
        solarKWh: 5.0, // More solar than charged
        gridPrice: 0.25,
        soc: 60,
      });

      expect(entry.solarKWh).toBe(3.0); // Capped at chargedKWh
      expect(entry.gridKWh).toBe(0); // No grid needed
    });

    it('should handle all energy from grid', () => {
      const entry = createChargeEntry({
        chargedKWh: 5.0,
        solarKWh: 0, // No solar
        gridPrice: 0.30,
        soc: 40,
      });

      expect(entry.solarKWh).toBe(0);
      expect(entry.gridKWh).toBe(5.0); // All from grid
    });

    it('should use default values for optional parameters', () => {
      const entry = createChargeEntry({
        chargedKWh: 2.0,
      });

      expect(entry.solarKWh).toBe(0);
      expect(entry.gridKWh).toBe(2.0);
      expect(entry.gridPrice).toBe(0);
      expect(entry.soc).toBe(0);
      expect(entry.timestamp).toBeDefined();
    });
  });

  describe('createDischargeEntry', () => {
    it('should create a discharge entry with negative totalKWh', () => {
      const entry = createDischargeEntry({
        dischargedKWh: 3.0,
        gridPrice: 0.35,
        avgBatteryPrice: 0.22,
        soc: 45,
        timestamp: new Date('2024-01-15T18:00:00Z'),
      });

      expect(entry.type).toBe('discharge');
      expect(entry.totalKWh).toBe(-3.0); // Negative for discharge
      expect(entry.gridPrice).toBe(0.35);
      expect(entry.avgBatteryPrice).toBe(0.22);
      expect(entry.soc).toBe(45);
    });

    it('should handle positive dischargedKWh and make it negative', () => {
      const entry = createDischargeEntry({
        dischargedKWh: 5.0, // Positive input
        gridPrice: 0.40,
        avgBatteryPrice: 0.25,
        soc: 30,
      });

      expect(entry.totalKWh).toBe(-5.0); // Always negative
    });

    it('should use default values for optional parameters', () => {
      const entry = createDischargeEntry({
        dischargedKWh: 1.5,
      });

      expect(entry.totalKWh).toBe(-1.5);
      expect(entry.gridPrice).toBe(0);
      expect(entry.avgBatteryPrice).toBe(0);
      expect(entry.soc).toBe(0);
    });
  });

  describe('shouldClearChargeLog', () => {
    it('should return true when SoC at or below threshold with entries', () => {
      expect(shouldClearChargeLog(7, 7, 5)).toBe(true);
      expect(shouldClearChargeLog(5, 7, 10)).toBe(true);
      expect(shouldClearChargeLog(0, 7, 1)).toBe(true);
    });

    it('should return false when SoC above threshold', () => {
      expect(shouldClearChargeLog(8, 7, 5)).toBe(false);
      expect(shouldClearChargeLog(50, 7, 10)).toBe(false);
      expect(shouldClearChargeLog(100, 7, 5)).toBe(false);
    });

    it('should return false when log is empty', () => {
      expect(shouldClearChargeLog(5, 7, 0)).toBe(false);
      expect(shouldClearChargeLog(0, 7, 0)).toBe(false);
    });

    it('should handle different thresholds', () => {
      expect(shouldClearChargeLog(10, 10, 5)).toBe(true);
      expect(shouldClearChargeLog(10, 15, 5)).toBe(true);
      expect(shouldClearChargeLog(10, 5, 5)).toBe(false);
    });
  });

  describe('trimChargeLog', () => {
    it('should trim log to max entries', () => {
      const log = [
        { id: 1 },
        { id: 2 },
        { id: 3 },
        { id: 4 },
        { id: 5 },
      ];

      const trimmed = trimChargeLog(log, 3);
      expect(trimmed.length).toBe(3);
      expect(trimmed[0].id).toBe(3); // Keeps last 3
      expect(trimmed[1].id).toBe(4);
      expect(trimmed[2].id).toBe(5);
    });

    it('should not trim if log is smaller than max', () => {
      const log = [{ id: 1 }, { id: 2 }];
      const trimmed = trimChargeLog(log, 5);
      expect(trimmed.length).toBe(2);
      expect(trimmed).toEqual(log);
    });

    it('should handle empty log', () => {
      const trimmed = trimChargeLog([], 10);
      expect(trimmed).toEqual([]);
    });

    it('should handle null/undefined log', () => {
      expect(trimChargeLog(null, 10)).toEqual([]);
      expect(trimChargeLog(undefined, 10)).toEqual([]);
    });

    it('should handle exact size match', () => {
      const log = [{ id: 1 }, { id: 2 }, { id: 3 }];
      const trimmed = trimChargeLog(log, 3);
      expect(trimmed.length).toBe(3);
      expect(trimmed).toEqual(log);
    });
  });

  describe('calculateDischargeProfit', () => {
    it('should calculate profit for profitable discharge', () => {
      const result = calculateDischargeProfit(
        5.0, // 5 kWh discharged
        0.20, // Cost 0.20 €/kWh
        0.35, // Sell at 0.35 €/kWh
      );

      expect(result.cost).toBe(1.0); // 5 * 0.20
      expect(result.revenue).toBe(1.75); // 5 * 0.35
      expect(result.profit).toBe(0.75); // 1.75 - 1.0
      expect(result.profitPercent).toBeCloseTo(75, 1); // 75% profit
      expect(result.worthIt).toBe(true);
      expect(result.reason).toBe('Profitable discharge');
    });

    it('should calculate loss for unprofitable discharge', () => {
      const result = calculateDischargeProfit(
        3.0, // 3 kWh discharged
        0.30, // Cost 0.30 €/kWh
        0.25, // Sell at 0.25 €/kWh (loss!)
      );

      expect(result.cost).toBeCloseTo(0.90, 2); // 3 * 0.30
      expect(result.revenue).toBe(0.75); // 3 * 0.25
      expect(result.profit).toBeCloseTo(-0.15, 2); // 0.75 - 0.90
      expect(result.profitPercent).toBeCloseTo(-16.67, 1);
      expect(result.worthIt).toBe(false);
      expect(result.reason).toBe('Unprofitable discharge');
    });

    it('should handle zero discharge', () => {
      const result = calculateDischargeProfit(0, 0.20, 0.35);
      expect(result.profit).toBe(0);
      expect(result.worthIt).toBe(false);
      expect(result.reason).toBe('Invalid parameters');
    });

    it('should handle negative values', () => {
      const result = calculateDischargeProfit(5.0, -0.20, 0.35);
      expect(result.profit).toBe(0);
      expect(result.worthIt).toBe(false);
    });

    it('should handle break-even scenario', () => {
      const result = calculateDischargeProfit(4.0, 0.25, 0.25);
      expect(result.profit).toBe(0);
      expect(result.profitPercent).toBe(0);
      expect(result.worthIt).toBe(false);
    });
  });

  describe('calculateBatteryEnergyCost', () => {
    it('should return null for empty log', () => {
      expect(calculateBatteryEnergyCost([])).toBeNull();
      expect(calculateBatteryEnergyCost(null)).toBeNull();
      expect(calculateBatteryEnergyCost(undefined)).toBeNull();
    });

    it('should calculate cost for simple charge from grid', () => {
      const log = [
        {
          type: 'charge',
          solarKWh: 0,
          gridKWh: 5.0,
          gridPrice: 0.20,
        },
      ];

      const result = calculateBatteryEnergyCost(log);
      expect(result).not.toBeNull();
      expect(result.totalKWh).toBe(5.0);
      expect(result.solarKWh).toBe(0);
      expect(result.gridKWh).toBe(5.0);
      expect(result.avgPrice).toBe(0.20); // Weighted average
      expect(result.gridOnlyAvgPrice).toBe(0.20);
      expect(result.totalCost).toBe(1.0); // 5 * 0.20
      expect(result.gridPercent).toBe(100);
      expect(result.solarPercent).toBe(0);
    });

    it('should calculate cost for simple charge from solar', () => {
      const log = [
        {
          type: 'charge',
          solarKWh: 3.0,
          gridKWh: 0,
          gridPrice: 0.25,
        },
      ];

      const result = calculateBatteryEnergyCost(log);
      expect(result.totalKWh).toBe(3.0);
      expect(result.solarKWh).toBe(3.0);
      expect(result.gridKWh).toBe(0);
      expect(result.avgPrice).toBe(0); // All solar is free
      expect(result.totalCost).toBe(0);
      expect(result.solarPercent).toBe(100);
      expect(result.gridPercent).toBe(0);
    });

    it('should calculate cost for mixed solar and grid charge', () => {
      const log = [
        {
          type: 'charge',
          solarKWh: 3.0,
          gridKWh: 2.0,
          gridPrice: 0.30,
        },
      ];

      const result = calculateBatteryEnergyCost(log);
      expect(result.totalKWh).toBe(5.0);
      expect(result.solarKWh).toBe(3.0);
      expect(result.gridKWh).toBe(2.0);
      expect(result.totalCost).toBe(0.6); // 2 * 0.30
      expect(result.avgPrice).toBe(0.12); // 0.6 / 5.0 (weighted avg)
      expect(result.gridOnlyAvgPrice).toBe(0.30); // Grid portion only
      expect(result.solarPercent).toBe(60);
      expect(result.gridPercent).toBe(40);
    });

    it('should handle charge and discharge sequence', () => {
      const log = [
        {
          type: 'charge',
          solarKWh: 2.0,
          gridKWh: 3.0,
          gridPrice: 0.20,
        },
        {
          type: 'discharge',
          totalKWh: -2.0, // Discharge 2 kWh
          gridPrice: 0.35,
        },
      ];

      const result = calculateBatteryEnergyCost(log);
      expect(result.totalKWh).toBe(3.0); // 5 charged - 2 discharged
      expect(result.solarKWh).toBeCloseTo(1.2, 2); // 2 - (2 * 2/5)
      expect(result.gridKWh).toBeCloseTo(1.8, 2); // 3 - (2 * 3/5)
      expect(result.totalCost).toBeCloseTo(0.36, 2); // 0.6 - (2 * 0.12)
    });

    it('should handle multiple charges at different prices', () => {
      const log = [
        {
          type: 'charge',
          solarKWh: 0,
          gridKWh: 2.0,
          gridPrice: 0.15, // Cheap
        },
        {
          type: 'charge',
          solarKWh: 0,
          gridKWh: 3.0,
          gridPrice: 0.35, // Expensive
        },
      ];

      const result = calculateBatteryEnergyCost(log);
      expect(result.totalKWh).toBe(5.0);
      expect(result.gridKWh).toBe(5.0);
      expect(result.totalCost).toBeCloseTo(1.35, 2); // (2*0.15) + (3*0.35)
      expect(result.avgPrice).toBeCloseTo(0.27, 2); // 1.35 / 5.0
    });

    it('should return null when battery is effectively empty', () => {
      const log = [
        {
          type: 'charge',
          solarKWh: 0,
          gridKWh: 1.0,
          gridPrice: 0.20,
        },
        {
          type: 'discharge',
          totalKWh: -1.0, // Discharge everything
          gridPrice: 0.35,
        },
      ];

      const result = calculateBatteryEnergyCost(log);
      expect(result).toBeNull(); // < 0.01 kWh remaining
    });

    it('should handle complex charge/discharge sequence', () => {
      const log = [
        // Day 1: Charge 5 kWh
        {
          type: 'charge',
          solarKWh: 3.0,
          gridKWh: 2.0,
          gridPrice: 0.20,
        },
        // Day 1: Discharge 2 kWh
        {
          type: 'discharge',
          totalKWh: -2.0,
          gridPrice: 0.35,
        },
        // Day 2: Charge 3 kWh more
        {
          type: 'charge',
          solarKWh: 1.0,
          gridKWh: 2.0,
          gridPrice: 0.25,
        },
        // Day 2: Discharge 1 kWh
        {
          type: 'discharge',
          totalKWh: -1.0,
          gridPrice: 0.30,
        },
      ];

      const result = calculateBatteryEnergyCost(log);
      // Net: 5 - 2 + 3 - 1 = 5 kWh remaining
      expect(result.totalKWh).toBeCloseTo(5.0, 2);
      // Should have some solar and grid mix
      expect(result.solarKWh).toBeGreaterThan(0);
      expect(result.gridKWh).toBeGreaterThan(0);
      expect(result.totalCost).toBeGreaterThan(0);
    });

    it('should handle edge case of very small remaining energy', () => {
      const log = [
        {
          type: 'charge',
          solarKWh: 0,
          gridKWh: 0.02,
          gridPrice: 0.20,
        },
        {
          type: 'discharge',
          totalKWh: -0.015,
          gridPrice: 0.35,
        },
      ];

      const result = calculateBatteryEnergyCost(log);
      expect(result).toBeNull(); // < 0.01 kWh remaining
    });

    it('should call logger when provided', () => {
      const logMessages = [];
      const logger = (msg) => logMessages.push(msg);

      const log = [
        {
          type: 'charge',
          solarKWh: 1.0,
          gridKWh: 1.0,
          gridPrice: 0.20,
        },
      ];

      calculateBatteryEnergyCost(log, { logger });
      expect(logMessages.length).toBeGreaterThan(0);
      expect(logMessages.some((msg) => msg.includes('Battery energy calculation'))).toBe(true);
    });

    it('should handle proportional discharge correctly', () => {
      const log = [
        // Charge: 60% solar, 40% grid
        {
          type: 'charge',
          solarKWh: 6.0,
          gridKWh: 4.0,
          gridPrice: 0.25,
        },
        // Discharge 5 kWh (should subtract proportionally)
        {
          type: 'discharge',
          totalKWh: -5.0,
          gridPrice: 0.40,
        },
      ];

      const result = calculateBatteryEnergyCost(log);
      expect(result.totalKWh).toBeCloseTo(5.0, 2); // 10 - 5
      // Should maintain 60/40 ratio
      expect(result.solarKWh).toBeCloseTo(3.0, 2); // 60% of 5
      expect(result.gridKWh).toBeCloseTo(2.0, 2); // 40% of 5
      expect(result.solarPercent).toBeCloseTo(60, 1);
      expect(result.gridPercent).toBeCloseTo(40, 1);
    });
  });
});
