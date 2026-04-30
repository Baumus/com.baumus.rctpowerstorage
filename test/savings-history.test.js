'use strict';

const {
  createDischargeEntry,
} = require('../drivers/energy-optimizer/battery-cost-core');
const {
  rebuildSavingsHistoryFromChargeLog,
  summarizeSavingsHistory,
  updateSavingsHistoryWithEntry,
} = require('../drivers/energy-optimizer/services/savings-history');

describe('savings history service', () => {
  it('aggregates profitable discharge events into Berlin day rollups', () => {
    const first = createDischargeEntry({
      dischargedKWh: 2,
      avgBatteryPrice: 0.10,
      gridPrice: 0.30,
      timestamp: '2026-04-29T08:00:00.000Z',
    });
    const second = createDischargeEntry({
      dischargedKWh: 1,
      avgBatteryPrice: 0.12,
      gridPrice: 0.22,
      timestamp: '2026-04-29T17:00:00.000Z',
    });

    let history = {};
    history = updateSavingsHistoryWithEntry(history, first);
    history = updateSavingsHistoryWithEntry(history, second);

    expect(Object.keys(history)).toHaveLength(1);
    expect(history['2026-04-29'].realizedSavingsEur).toBeCloseTo(0.5, 2);
    expect(history['2026-04-29'].dischargedKWh).toBeCloseTo(3, 2);
    expect(history['2026-04-29'].eventCount).toBe(2);
  });

  it('summarizes current month, last month and 365 days from rollups', () => {
    const chargeLog = [
      createDischargeEntry({
        dischargedKWh: 2,
        avgBatteryPrice: 0.10,
        gridPrice: 0.30,
        timestamp: '2026-04-29T08:00:00.000Z',
      }),
      createDischargeEntry({
        dischargedKWh: 1,
        avgBatteryPrice: 0.10,
        gridPrice: 0.20,
        timestamp: '2026-04-05T18:00:00.000Z',
      }),
      createDischargeEntry({
        dischargedKWh: 1.5,
        avgBatteryPrice: 0.10,
        gridPrice: 0.25,
        timestamp: '2026-03-10T18:00:00.000Z',
      }),
      createDischargeEntry({
        dischargedKWh: 1,
        avgBatteryPrice: 0.20,
        gridPrice: 0.18,
        timestamp: '2025-02-10T18:00:00.000Z',
      }),
    ];

    const history = rebuildSavingsHistoryFromChargeLog(chargeLog);
    const summary = summarizeSavingsHistory(history, new Date('2026-04-29T12:00:00.000Z'));

    expect(summary.currentMonthEur).toBeCloseTo(0.5, 2);
    expect(summary.lastMonthEur).toBeCloseTo(0.23, 2);
    expect(summary.last365DaysEur).toBeCloseTo(0.73, 2);
    expect(summary.lifetimeEur).toBeCloseTo(0.73, 2);
    expect(summary.historyDays).toBe(4);
  });
});