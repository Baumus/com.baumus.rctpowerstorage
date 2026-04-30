'use strict';

const de = require('../locales/de.json');
const { buildDashboardSummary } = require('../drivers/energy-optimizer/services/dashboard-summary');
const { BATTERY_MODE } = require('../drivers/energy-optimizer/strategy-execution-core');

function translate(messages, key) {
  return key.split('.').reduce((value, segment) => value?.[segment], messages) || key;
}

function createHost(overrides = {}) {
  return {
    homey: {
      __: (key) => translate(de, key),
      i18n: {
        getLanguage: () => 'de-DE',
      },
    },
    currentStrategy: null,
    lastBatteryMode: BATTERY_MODE.IDLE,
    savingsHistory: {},
    ...overrides,
  };
}

describe('dashboard summary service', () => {
  it('summarizes an active cheap charging window', () => {
    const host = createHost({
      lastBatteryMode: BATTERY_MODE.CHARGE,
      _dashboardSummaryNow: new Date('2026-04-29T10:05:00.000Z'),
      liveEnergyState: {
        gridPowerW: 1800,
        solarPowerW: 120,
        batteryPowerW: -3200,
        source: 'strategy-execution',
        updatedAt: '2026-04-29T10:05:00.000Z',
      },
      savingsHistory: {
        '2026-04-29': { dayKey: '2026-04-29', realizedSavingsEur: 0.42, dischargedKWh: 3, eventCount: 2, updatedAt: '2026-04-29T10:00:00.000Z' },
        '2026-03-15': { dayKey: '2026-03-15', realizedSavingsEur: 0.35, dischargedKWh: 2, eventCount: 1, updatedAt: '2026-03-15T18:00:00.000Z' },
      },
    });

    const strategy = {
      chargeIntervals: [
        { startsAt: '2026-04-29T10:00:00.000Z', total: 0.12 },
        { startsAt: '2026-04-29T12:00:00.000Z', total: 0.14 },
      ],
      dischargeIntervals: [],
      plannedCharging: {
        totalEnergyKWh: 4.2,
        avgPriceEurPerKWh: 0.13,
      },
      economics: {
        savings: 1.85,
      },
      batteryStatus: {
        currentSoc: 0.52,
        targetSoc: 0.85,
        availableCapacity: 3.3,
        availableCapacityToTarget: 3.3,
        excessEnergyAboveTargetKWh: 0,
        storedKWh: 5.2,
        energyCost: {
          avgPrice: 0.17,
          isEstimated: false,
        },
      },
    };

    const summary = buildDashboardSummary(host, strategy);

    expect(summary.currentAction.key).toBe('charging');
    expect(summary.currentAction.title).toBe('Batterie laedt aus dem Netz');
    expect(summary.currentReason).toMatch(/guenstigen Ladefenster/);
    expect(summary.nextAction.key).toBe('next-charge-window');
    expect(summary.chargePlan.hasPlan).toBe(true);
    expect(summary.chargePlan.totalEnergyKWh).toBeCloseTo(4.2, 6);
    expect(summary.dischargePlan.hasPlan).toBe(false);
    expect(summary.planHorizon.hasPlan).toBe(true);
    expect(summary.planHorizon.endsAt).toBe('2026-04-29T12:15:00.000Z');
    expect(summary.savings.todayForecastEur).toBeCloseTo(1.85, 6);
    expect(summary.savings.realized.currentMonthEur).toBeCloseTo(0.42, 6);
    expect(summary.savings.realized.last365DaysEur).toBeCloseTo(0.77, 6);
    expect(summary.energyFlow.title).toBe('Netz laedt die Batterie');
    expect(summary.energyFlow.grid).toBe('importing');
    expect(summary.energyFlow.battery).toBe('charging');
    expect(summary.battery.freeCapacityToTargetKWh).toBeCloseTo(3.3, 6);
    expect(summary.battery.aboveTargetDeltaPercent).toBe(0);
  });

  it('normalizes battery capacity when current soc is above target', () => {
    const host = createHost({
      lastBatteryMode: BATTERY_MODE.CONSTANT,
      _dashboardSummaryNow: new Date('2026-04-29T18:00:00.000Z'),
    });

    const strategy = {
      chargeIntervals: [],
      dischargeIntervals: [],
      savings: 0,
      batteryStatus: {
        currentSoc: 0.91,
        targetSoc: 0.80,
        availableCapacity: 0,
        availableCapacityToTarget: 0,
        excessEnergyAboveTargetKWh: 1.1,
        storedKWh: 9.1,
        energyCost: {
          avgPrice: 0.19,
          isEstimated: true,
        },
      },
    };

    const summary = buildDashboardSummary(host, strategy);

    expect(summary.currentAction.key).toBe('holding');
    expect(summary.chargePlan.hasPlan).toBe(false);
    expect(summary.chargePlan.summary).toBe('Keine Netzladung geplant.');
    expect(summary.dischargePlan.hasPlan).toBe(false);
    expect(summary.planHorizon.hasPlan).toBe(false);
    expect(summary.battery.freeCapacityToTargetKWh).toBe(0);
    expect(summary.battery.aboveTargetDeltaPercent).toBeCloseTo(11, 6);
    expect(summary.battery.aboveTargetBufferKWh).toBeCloseTo(1.1, 6);
    expect(summary.battery.energyPriceIsEstimated).toBe(true);
  });

  it('describes live solar export when no battery flow is active', () => {
    const host = createHost({
      lastBatteryMode: BATTERY_MODE.CONSTANT,
      _dashboardSummaryNow: new Date('2026-04-29T13:00:00.000Z'),
      liveEnergyState: {
        gridPowerW: -900,
        solarPowerW: 2400,
        batteryPowerW: 0,
        source: 'data-collection',
        updatedAt: '2026-04-29T13:00:00.000Z',
      },
    });

    const summary = buildDashboardSummary(host, {
      chargeIntervals: [],
      dischargeIntervals: [],
      batteryStatus: {
        currentSoc: 0.62,
        targetSoc: 0.8,
        availableCapacity: 1.8,
        availableCapacityToTarget: 1.8,
        excessEnergyAboveTargetKWh: 0,
        storedKWh: 6.2,
        energyCost: null,
      },
    });

    expect(summary.energyFlow.title).toBe('Solar versorgt das Haus und speist Ueberschuss ein');
    expect(summary.energyFlow.grid).toBe('exporting');
    expect(summary.energyFlow.solar).toBe('active');
    expect(summary.energyFlow.battery).toBe('idle');
  });

  it('shows the next discharge phase when it starts before the next charge window', () => {
    const host = createHost({
      lastBatteryMode: BATTERY_MODE.CONSTANT,
      _dashboardSummaryNow: new Date('2026-04-29T13:00:00.000Z'),
    });

    const summary = buildDashboardSummary(host, {
      chargeIntervals: [
        { startsAt: '2026-04-29T18:00:00.000Z', total: 0.14 },
      ],
      dischargeIntervals: [
        { startsAt: '2026-04-29T14:00:00.000Z', total: 0.34, demandKWh: 0.8 },
      ],
      plannedCharging: {
        totalEnergyKWh: 2.5,
        avgPriceEurPerKWh: 0.14,
      },
      batteryStatus: {
        currentSoc: 0.91,
        targetSoc: 0.8,
        availableCapacity: 0,
        availableCapacityToTarget: 0,
        excessEnergyAboveTargetKWh: 1.1,
        storedKWh: 9.1,
        energyCost: {
          avgPrice: 0.07,
          isEstimated: false,
        },
      },
    });

    expect(summary.nextAction.key).toBe('next-expensive-window');
    expect(summary.nextAction.title).toBe('Naechste teure Phase');
    expect(summary.dischargePlan.hasPlan).toBe(true);
    expect(summary.dischargePlan.windowCount).toBe(1);
    expect(summary.dischargePlan.nextStart).toBe('2026-04-29T14:00:00.000Z');
    expect(summary.planHorizon.endsAt).toBe('2026-04-29T18:15:00.000Z');
  });
});