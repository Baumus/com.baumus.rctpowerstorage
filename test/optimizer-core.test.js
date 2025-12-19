const { forecastHouseSignalsPerInterval, getPercentile } = require('../drivers/energy-optimizer/optimizer-core');

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

  describe('forecastHouseSignalsPerInterval', () => {
    test('returns empty arrays for empty intervals', () => {
      const signals = forecastHouseSignalsPerInterval([], {}, 0.25);
      expect(signals.houseLoadKWh).toEqual([]);
      expect(signals.solarKWh).toEqual([]);
      expect(signals.importDemandKWh).toEqual([]);
      expect(signals.solarSurplusKWh).toEqual([]);
    });

    test('uses default 3kW load when no history available', () => {
      const intervals = [
        { intervalOfDay: 0 },
        { intervalOfDay: 1 },
      ];
      const history = {
        consumptionHistory: {},
        productionHistory: {},
        batteryHistory: {},
      };

      const signals = forecastHouseSignalsPerInterval(intervals, history, 0.25);
      // 2 intervals × 3kW × 0.25h = 1.5 kWh
      expect(signals.houseLoadKWh.reduce((a, b) => a + b, 0)).toBeCloseTo(1.5, 1);
      // No solar => all load must be imported
      expect(signals.importDemandKWh.reduce((a, b) => a + b, 0)).toBeCloseTo(1.5, 1);
      expect(signals.solarSurplusKWh.reduce((a, b) => a + b, 0)).toBeCloseTo(0, 6);
    });

    test('reconstructs house load from grid+solar-battery power balance', () => {
      const intervals = [
        { intervalOfDay: 10 },
      ];
      const history = {
        // net grid import 300W
        consumptionHistory: { 10: [300, 300, 300] },
        // solar production 200W
        productionHistory: { 10: [200, 200, 200] },
        // battery discharging -100W
        batteryHistory: { 10: [-100, -100, -100] },
      };

      const signals = forecastHouseSignalsPerInterval(intervals, history, 0.25);
      // loadW = 300 + 200 - (-100) = 600W => 0.15kWh
      expect(signals.houseLoadKWh[0]).toBeCloseTo(0.15, 6);
      // solarKWh = 200W * 0.25h = 0.05kWh
      expect(signals.solarKWh[0]).toBeCloseTo(0.05, 6);
      // import = load - solar = 0.10kWh
      expect(signals.importDemandKWh[0]).toBeCloseTo(0.10, 6);
      expect(signals.solarSurplusKWh[0]).toBeCloseTo(0, 6);
    });
  });

});
