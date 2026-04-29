/* eslint-disable no-console */

'use strict';

/**
 * Interactive simulator to test optimization strategies manually
 * Run: node tools/simulate-optimizer.js
 */

const { optimizeStrategyWithLp } = require('../drivers/energy-optimizer/optimizer-core');

let lpSolver;
try {
  // eslint-disable-next-line global-require
  lpSolver = require('../lib/javascript-lp-solver/src/main');
} catch (e) {
  lpSolver = null;
}

function buildIndexedData(prices, datePrefix = '2025-01-15') {
  return prices.map((total, index) => ({
    index,
    startsAt: `${datePrefix}T${String(Math.floor(index / 4)).padStart(2, '0')}:${String((index % 4) * 15).padStart(2, '0')}:00Z`,
    total,
    intervalOfDay: index,
  }));
}

function createBaseParams(overrides = {}) {
  return {
    batteryCapacity: 9.9,
    currentSoc: 0.20,
    targetSoc: 0.85,
    chargePowerKW: 6.0,
    intervalHours: 0.25,
    efficiencyLoss: 0.10,
    minProfitEurPerKWh: 0.08,
    ...overrides,
  };
}

function createEmptyHistory(overrides = {}) {
  return {
    productionHistory: {},
    consumptionHistory: {},
    batteryHistory: {},
    ...overrides,
  };
}

function logStrategySummary(strategy) {
  console.log('\n--- Results ---');
  console.log(`Charge intervals: ${strategy.chargeIntervals.length}`);
  console.log(`Discharge intervals: ${strategy.dischargeIntervals.length}`);
  console.log(`Total charge planned: ${strategy.totalChargeKWh.toFixed(2)} kWh`);
  console.log(`Total discharge planned: ${strategy.totalDischargeKWh.toFixed(2)} kWh`);
  console.log(`Estimated savings: €${strategy.savings.toFixed(2)}`);

  if (strategy.plannedCharging) {
    console.log(`Planned charging avg: €${strategy.plannedCharging.avgPriceEurPerKWh.toFixed(4)}/kWh`);
    console.log(`Planned charging split: ${strategy.plannedCharging.gridEnergyKWh.toFixed(2)} kWh grid, ${strategy.plannedCharging.solarEnergyKWh.toFixed(2)} kWh solar`);
  }

  if (strategy.chargeDisplayEntries.length > 0) {
    console.log('\nFirst charge display entries:');
    strategy.chargeDisplayEntries.slice(0, 5).forEach((entry) => {
      const time = new Date(entry.startsAt).toISOString().substring(11, 16);
      console.log(`  ${time} ${entry.plannedSymbol} ${entry.plannedEnergyKWh.toFixed(2)} kWh @ €${entry.plannedPriceEurPerKWh.toFixed(4)}/kWh`);
    });
  }
}

function runScenario(name, indexedData, params, history) {
  console.log(`\n=== ${name} ===\n`);

  const logger = {
    log: console.log,
    debug: () => {},
  };

  if (!lpSolver) {
    console.log('LP solver not available (missing lib/javascript-lp-solver).');
    return;
  }

  const strategy = optimizeStrategyWithLp(indexedData, params, history, { logger, lpSolver });

  if (!strategy) {
    console.log('LP returned no solution for this scenario.');
    return;
  }

  logStrategySummary(strategy);
}

// Example 1: Clear day/night pattern
function simulateDayNightPattern() {
  const prices = [
    ...Array.from({ length: 24 }, (_, i) => 0.14 + ((i % 4) * 0.005)),
    ...Array.from({ length: 12 }, (_, i) => 0.29 + ((i % 4) * 0.01)),
    ...Array.from({ length: 32 }, (_, i) => 0.20 + ((i % 4) * 0.004)),
    ...Array.from({ length: 12 }, (_, i) => 0.31 + ((i % 4) * 0.008)),
    ...Array.from({ length: 16 }, (_, i) => 0.18 + ((i % 4) * 0.003)),
  ];

  runScenario(
    'SCENARIO 1: Clear Day/Night Pattern',
    buildIndexedData(prices),
    createBaseParams(),
    createEmptyHistory(),
  );
}

// Example 2: Flat prices (no optimization opportunity)
function simulateFlatPrices() {
  const prices = Array.from({ length: 96 }, (_, i) => 0.20 + ((i % 3) * 0.0005));
  runScenario(
    'SCENARIO 2: Flat Prices (No Optimization)',
    buildIndexedData(prices),
    createBaseParams({ currentSoc: 0.0, targetSoc: 0.85 }),
    createEmptyHistory(),
  );
  console.log('Expected: no charging/discharging plan because the battery starts empty and the spread stays below the profit threshold.');
}

// Example 3: Battery already full
function simulateFullBattery() {
  runScenario(
    'SCENARIO 3: Battery Already Full',
    buildIndexedData([0.10, 0.11, 0.30, 0.32]),
    createBaseParams({ currentSoc: 0.85, targetSoc: 0.85 }),
    createEmptyHistory(),
  );
  console.log('Expected: no new charging, but discharging can still be economical if expensive demand exists.');
}

function simulateTinySpread() {
  const prices = Array.from({ length: 16 }, (_, i) => 0.20 + (i < 8 ? 0 : 0.01));
  runScenario(
    'SCENARIO 4: Tiny Price Spread Below Profit Margin',
    buildIndexedData(prices),
    createBaseParams({ currentSoc: 0.0, targetSoc: 0.85, minProfitEurPerKWh: 0.08 }),
    createEmptyHistory(),
  );
  console.log('Expected: no arbitrage because the battery starts empty and the 1 ct spread is below the configured 8 ct profit floor.');
}

function simulateSolarDominatedDay() {
  const indexedData = buildIndexedData([
    0.24, 0.24, 0.23, 0.22,
    0.21, 0.20, 0.19, 0.18,
    0.18, 0.19, 0.30, 0.31,
  ]);

  const history = createEmptyHistory({
    productionHistory: {
      4: [5000, 5000],
      5: [5200, 5200],
      6: [4800, 4800],
      7: [4500, 4500],
    },
    consumptionHistory: {
      4: [-2500, -2500],
      5: [-2600, -2600],
      6: [-2200, -2200],
      7: [-2000, -2000],
      10: [3500, 3500],
      11: [3600, 3600],
    },
  });

  runScenario(
    'SCENARIO 5: Solar-Dominated Midday With Evening Demand',
    indexedData,
    createBaseParams({ currentSoc: 0.35, targetSoc: 0.85 }),
    history,
  );
  console.log('Expected: chargeDisplayEntries should include ☀️ solar charging before the expensive evening slots.');
}

// Run all scenarios
function main() {
  console.log('╔═══════════════════════════════════════════════════════════════╗');
  console.log('║  Energy Optimizer Strategy Simulator                         ║');
  console.log('║  Testing different price patterns and battery states         ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝');

  simulateDayNightPattern();
  simulateFlatPrices();
  simulateFullBattery();
  simulateTinySpread();
  simulateSolarDominatedDay();

  console.log('\n\n✅ Simulation complete!\n');
  console.log('To run tests: npm test');
  console.log('To run with coverage: npm run test:coverage\n');
}

main();
