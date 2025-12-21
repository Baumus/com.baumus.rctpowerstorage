'use strict';

const {
  decideBatteryMode,
  findCurrentIntervalIndex,
  hasModeChanged,
  BATTERY_MODE,
} = require('../drivers/energy-optimizer/strategy-execution-core');

describe('strategy-execution-core', () => {
  // Helper to create price cache
  const createPriceCache = (startHour = 0, count = 96) => {
    const cache = [];
    const baseDate = new Date(Date.UTC(2024, 0, 15, startHour, 0, 0, 0));

    for (let i = 0; i < count; i++) {
      const startsAt = new Date(baseDate.getTime() + i * 15 * 60 * 1000);
      cache.push({
        startsAt: startsAt.toISOString(),
        total: 0.20 + (i % 24) * 0.01, // Varying prices
      });
    }

    return cache;
  };

  // Helper to create strategy
  const createStrategy = (chargeIndices = [], dischargeIndices = []) => ({
    chargeIntervals: chargeIndices.map((index) => ({ index })),
    dischargeIntervals: dischargeIndices.map((index) => ({ index })),
  });

  describe('findCurrentIntervalIndex', () => {
    it('should find the correct interval index', () => {
      const priceCache = createPriceCache(0, 96);
      const now = new Date('2024-01-15T02:30:00.000Z'); // 2.5 hours in
      const index = findCurrentIntervalIndex(now, priceCache, 15);

      expect(index).toBe(10); // 2.5 hours / 0.25 hours = 10
    });

    it('should return -1 if time is before first interval', () => {
      const priceCache = createPriceCache(10, 48); // Starts at 10:00
      const now = new Date('2024-01-15T09:00:00.000Z');
      const index = findCurrentIntervalIndex(now, priceCache, 15);

      expect(index).toBe(-1);
    });

    it('should return -1 if time is after last interval', () => {
      const priceCache = createPriceCache(0, 4); // Only 1 hour of data
      const now = new Date('2024-01-15T02:00:00.000Z');
      const index = findCurrentIntervalIndex(now, priceCache, 15);

      expect(index).toBe(-1);
    });

    it('should handle exact interval boundaries', () => {
      const priceCache = createPriceCache(0, 96);
      const now = new Date('2024-01-15T03:00:00.000Z'); // Exactly on boundary
      const index = findCurrentIntervalIndex(now, priceCache, 15);

      expect(index).toBe(12); // 3 hours / 0.25 hours = 12
    });
  });

  describe('hasModeChanged', () => {
    it('should return true when mode changes', () => {
      expect(hasModeChanged(BATTERY_MODE.CHARGE, BATTERY_MODE.IDLE)).toBe(true);
      expect(hasModeChanged(BATTERY_MODE.NORMAL, BATTERY_MODE.CONSTANT)).toBe(true);
    });

    it('should return false when mode stays the same', () => {
      expect(hasModeChanged(BATTERY_MODE.CHARGE, BATTERY_MODE.CHARGE)).toBe(false);
      expect(hasModeChanged(BATTERY_MODE.IDLE, BATTERY_MODE.IDLE)).toBe(false);
    });

    it('should return false when lastMode is null', () => {
      expect(hasModeChanged(BATTERY_MODE.CHARGE, null)).toBe(false);
    });
  });

  describe('decideBatteryMode', () => {
    describe('Input validation', () => {
      it('should return IDLE for invalid timestamp', () => {
        const result = decideBatteryMode({
          now: null,
          priceCache: createPriceCache(),
          strategy: createStrategy(),
        });

        expect(result.mode).toBe(BATTERY_MODE.IDLE);
        expect(result.reason).toContain('Invalid timestamp');
      });

      it('should return IDLE for missing price cache', () => {
        const result = decideBatteryMode({
          now: new Date(),
          priceCache: null,
          strategy: createStrategy(),
        });

        expect(result.mode).toBe(BATTERY_MODE.IDLE);
        expect(result.reason).toContain('No price data');
      });

      it('should return IDLE for empty price cache', () => {
        const result = decideBatteryMode({
          now: new Date(),
          priceCache: [],
          strategy: createStrategy(),
        });

        expect(result.mode).toBe(BATTERY_MODE.IDLE);
        expect(result.reason).toContain('No price data');
      });

      it('should return IDLE for missing strategy', () => {
        const result = decideBatteryMode({
          now: new Date('2024-01-15T01:00:00.000Z'),
          priceCache: createPriceCache(),
          strategy: null,
        });

        expect(result.mode).toBe(BATTERY_MODE.IDLE);
        expect(result.reason).toContain('No strategy');
      });

      it('should return IDLE when current time not in any interval', () => {
        const priceCache = createPriceCache(10, 48); // Starts at 10:00
        const result = decideBatteryMode({
          now: new Date('2024-01-15T02:00:00.000Z'), // 02:00, before cache
          priceCache,
          strategy: createStrategy(),
        });

        expect(result.mode).toBe(BATTERY_MODE.IDLE);
        expect(result.intervalIndex).toBe(-1);
        expect(result.reason).toContain('not in any price interval');
      });
    });

    describe('Charge interval decisions', () => {
      it('should decide CHARGE mode for charge interval', () => {
        const priceCache = createPriceCache();
        const strategy = createStrategy([4, 5, 6]); // Charge at indices 4-6
        const now = new Date('2024-01-15T01:00:00.000Z'); // Index 4

        const result = decideBatteryMode({
          now,
          priceCache,
          strategy,
        });

        expect(result.mode).toBe(BATTERY_MODE.CHARGE);
        expect(result.intervalIndex).toBe(4);
        expect(result.reason).toContain('Planned grid charge interval');
        expect(result.reason).toContain('0.24'); // Price check
      });

      it('should decide CONSTANT for a solar-only planned charge interval', () => {
        const priceCache = createPriceCache();
        const now = new Date('2024-01-15T01:00:00.000Z'); // Index 4
        const strategy = {
          chargeIntervals: [{ index: 4, plannedSolarEnergyKWh: 1.2, plannedGridEnergyKWh: 0 }],
          dischargeIntervals: [],
        };

        const result = decideBatteryMode({
          now,
          priceCache,
          strategy,
          gridPower: -500,
          thresholds: { solarThreshold: -300, consumptionThreshold: 300 },
        });

        expect(result.mode).toBe(BATTERY_MODE.CONSTANT);
        expect(result.intervalIndex).toBe(4);
        expect(result.reason).toContain('Planned solar-only charge');
      });

      it('should decide CONSTANT for a solar-only planned charge interval even when consuming', () => {
        const priceCache = createPriceCache();
        const now = new Date('2024-01-15T01:00:00.000Z'); // Index 4
        const strategy = {
          chargeIntervals: [{ index: 4, plannedSolarEnergyKWh: 1.2 }],
          dischargeIntervals: [],
        };

        const result = decideBatteryMode({
          now,
          priceCache,
          strategy,
          gridPower: 500,
          thresholds: { solarThreshold: -300, consumptionThreshold: 300 },
        });

        expect(result.mode).toBe(BATTERY_MODE.CONSTANT);
        expect(result.intervalIndex).toBe(4);
        expect(result.reason).toContain('Planned solar-only charge');
      });

      it('should use CHARGE when a charge interval includes planned grid energy', () => {
        const priceCache = createPriceCache();
        const now = new Date('2024-01-15T01:00:00.000Z'); // Index 4
        const strategy = {
          chargeIntervals: [{ index: 4, plannedSolarEnergyKWh: 0.5, plannedGridEnergyKWh: 0.5 }],
          dischargeIntervals: [],
        };

        const result = decideBatteryMode({
          now,
          priceCache,
          strategy,
          gridPower: -2000,
        });

        expect(result.mode).toBe(BATTERY_MODE.CHARGE);
        expect(result.reason).toContain('Planned grid charge interval');
      });

      it('should prioritize charge over discharge', () => {
        const priceCache = createPriceCache();
        // Overlap at index 5 (unrealistic but tests priority)
        const strategy = createStrategy([5], [5]);
        const now = new Date('2024-01-15T01:15:00.000Z'); // Index 5

        const result = decideBatteryMode({
          now,
          priceCache,
          strategy,
        });

        expect(result.mode).toBe(BATTERY_MODE.CHARGE);
      });

      it('should decide CHARGE when strategy index differs but startsAt matches current interval', () => {
        const priceCache = createPriceCache();
        // 03:30 is index 14 (3.5h * 4)
        const now = new Date('2024-01-15T03:30:05.000Z');
        const currentIndex = findCurrentIntervalIndex(now, priceCache, 15);
        expect(currentIndex).toBe(14);

        // Simulate strategy built from a filtered array (index=0) but same startsAt
        const strategy = {
          chargeIntervals: [{ index: 0, startsAt: priceCache[currentIndex].startsAt }],
          dischargeIntervals: [],
        };

        const result = decideBatteryMode({
          now,
          priceCache,
          strategy,
        });

        expect(result.mode).toBe(BATTERY_MODE.CHARGE);
        expect(result.intervalIndex).toBe(currentIndex);
      });
    });

    describe('Discharge interval decisions', () => {
      it('should decide NORMAL mode for discharge interval', () => {
        const priceCache = createPriceCache();
        const strategy = createStrategy([], [20, 21]); // Discharge at indices 20-21
        const now = new Date('2024-01-15T05:00:00.000Z'); // Index 20

        const result = decideBatteryMode({
          now,
          priceCache,
          strategy,
        });

        expect(result.mode).toBe(BATTERY_MODE.NORMAL);
        expect(result.intervalIndex).toBe(20);
        expect(result.reason).toContain('Planned discharge interval');
      });

      it('should force CONSTANT when SoC is at/below min threshold (discharge blocked)', () => {
        const priceCache = createPriceCache();
        const strategy = createStrategy([], [20, 21]);
        const now = new Date('2024-01-15T05:00:00.000Z'); // Index 20

        const result = decideBatteryMode({
          now,
          priceCache,
          strategy,
          gridPower: 500,
          currentSocPercent: 7.0,
          minSocThresholdPercent: 7.0,
        });

        expect(result.mode).toBe(BATTERY_MODE.CONSTANT);
        expect(result.intervalIndex).toBe(20);
        expect(result.reason).toContain('Low SoC');
      });
    });

    describe('Low SoC override', () => {
      it('should still allow CHARGE for planned grid charge even when SoC is low', () => {
        const priceCache = createPriceCache();
        const now = new Date('2024-01-15T01:00:00.000Z'); // Index 4
        const strategy = {
          chargeIntervals: [{ index: 4, plannedGridEnergyKWh: 1.0, plannedSolarEnergyKWh: 0 }],
          dischargeIntervals: [],
        };

        const result = decideBatteryMode({
          now,
          priceCache,
          strategy,
          gridPower: -5000,
          currentSocPercent: 6.0,
          minSocThresholdPercent: 7.0,
        });

        expect(result.mode).toBe(BATTERY_MODE.CHARGE);
        expect(result.reason).toContain('Planned grid charge interval');
      });
    });

    describe('Default interval decisions', () => {
      it('should decide CONSTANT for solar excess', () => {
        const priceCache = createPriceCache();
        const strategy = createStrategy([], []); // No charge/discharge
        const now = new Date('2024-01-15T12:00:00.000Z'); // Index 48

        const result = decideBatteryMode({
          now,
          priceCache,
          strategy,
          gridPower: -500, // Solar excess
          thresholds: { solarThreshold: -300, consumptionThreshold: 300 },
        });

        expect(result.mode).toBe(BATTERY_MODE.CONSTANT);
        expect(result.intervalIndex).toBe(48);
        expect(result.reason).toContain('CONSTANT');
      });

      it('should decide CONSTANT for grid consumption', () => {
        const priceCache = createPriceCache();
        const strategy = createStrategy([], []);
        const now = new Date('2024-01-15T18:00:00.000Z'); // Index 72

        const result = decideBatteryMode({
          now,
          priceCache,
          strategy,
          gridPower: 500, // Grid consumption
          thresholds: { solarThreshold: -300, consumptionThreshold: 300 },
        });

        expect(result.mode).toBe(BATTERY_MODE.CONSTANT);
        expect(result.intervalIndex).toBe(72);
        expect(result.reason).toContain('CONSTANT');
      });
    });

    describe('Edge cases', () => {
      it('should handle missing chargeIntervals in strategy', () => {
        const priceCache = createPriceCache();
        const strategy = { dischargeIntervals: [] }; // Missing chargeIntervals
        const now = new Date('2024-01-15T01:00:00.000Z');

        const result = decideBatteryMode({
          now,
          priceCache,
          strategy,
        });

        expect(result.mode).not.toBe(BATTERY_MODE.CHARGE);
        expect(result.mode).toBe(BATTERY_MODE.CONSTANT); // Defaults to constant
      });

      it('should handle missing dischargeIntervals in strategy', () => {
        const priceCache = createPriceCache();
        const strategy = { chargeIntervals: [] }; // Missing dischargeIntervals
        const now = new Date('2024-01-15T05:00:00.000Z');

        const result = decideBatteryMode({
          now,
          priceCache,
          strategy,
        });

        expect(result.mode).toBe(BATTERY_MODE.CONSTANT);
      });

      it('should handle undefined gridPower', () => {
        const priceCache = createPriceCache();
        const strategy = createStrategy([], []);
        const now = new Date('2024-01-15T12:00:00.000Z');

        const result = decideBatteryMode({
          now,
          priceCache,
          strategy,
          gridPower: undefined,
        });

        expect(result.mode).toBe(BATTERY_MODE.CONSTANT);
      });

      it('should handle 30-minute intervals', () => {
        const priceCache = [];
        const baseDate = new Date('2024-01-15T00:00:00.000Z');

        for (let i = 0; i < 48; i++) {
          priceCache.push({
            startsAt: new Date(baseDate.getTime() + i * 30 * 60 * 1000).toISOString(),
            total: 0.20,
          });
        }

        const strategy = createStrategy([2], []); // Index 2 = 01:00-01:30
        const now = new Date('2024-01-15T01:15:00.000Z');

        const result = decideBatteryMode({
          now,
          priceCache,
          strategy,
          intervalMinutes: 30,
        });

        expect(result.mode).toBe(BATTERY_MODE.CHARGE);
        expect(result.intervalIndex).toBe(2);
      });

      it('should handle large interval counts (96 intervals)', () => {
        const priceCache = createPriceCache(0, 96);
        const strategy = createStrategy([95], []); // Last interval
        const now = new Date('2024-01-15T23:45:00.000Z'); // Index 95

        const result = decideBatteryMode({
          now,
          priceCache,
          strategy,
        });

        expect(result.mode).toBe(BATTERY_MODE.CHARGE);
        expect(result.intervalIndex).toBe(95);
      });
    });

    describe('Real-world scenarios', () => {
      it('should handle typical morning charging scenario', () => {
        const priceCache = createPriceCache();
        const strategy = createStrategy([8, 9, 10, 11], []); // 02:00-03:00 cheap
        const now = new Date('2024-01-15T02:30:00.000Z');

        const result = decideBatteryMode({
          now,
          priceCache,
          strategy,
          gridPower: 1500, // Charging from grid
        });

        expect(result.mode).toBe(BATTERY_MODE.CHARGE);
        expect(result.intervalIndex).toBe(10);
      });

      it('should handle typical evening discharge scenario', () => {
        const priceCache = createPriceCache();
        const strategy = createStrategy([], [72, 73, 74, 75]); // 18:00-19:00 expensive
        const now = new Date('2024-01-15T18:15:00.000Z');

        const result = decideBatteryMode({
          now,
          priceCache,
          strategy,
          gridPower: 2000, // High consumption
        });

        expect(result.mode).toBe(BATTERY_MODE.NORMAL);
        expect(result.intervalIndex).toBe(73);
      });

      it('should handle midday solar production', () => {
        const priceCache = createPriceCache();
        const strategy = createStrategy([], []); // No special intervals
        const now = new Date('2024-01-15T13:00:00.000Z');

        const result = decideBatteryMode({
          now,
          priceCache,
          strategy,
          gridPower: -3000, // Strong solar export
        });

        expect(result.mode).toBe(BATTERY_MODE.CONSTANT);
        expect(result.reason).toContain('CONSTANT');
      });
    });
  });
});
