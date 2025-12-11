'use strict';

/**
 * Interactive simulator to test optimization strategies manually
 * Run: node tools/simulate-optimizer.js
 */

const { computeHeuristicStrategy } = require('../drivers/energy-optimizer/optimizer-core');

// Example 1: Clear day/night pattern
function simulateDayNightPattern() {
  console.log('\n=== SCENARIO 1: Clear Day/Night Pattern ===\n');

  const indexedData = [];

  // Night hours (00:00-06:00): cheap
  for (let h = 0; h < 6; h++) {
    for (let q = 0; q < 4; q++) {
      const idx = h * 4 + q;
      indexedData.push({
        index: idx,
        startsAt: `2025-01-15T${String(h).padStart(2, '0')}:${String(q * 15).padStart(2, '0')}:00Z`,
        total: 0.15 + Math.random() * 0.03,
        intervalOfDay: idx,
      });
    }
  }

  // Morning peak (06:00-09:00): expensive
  for (let h = 6; h < 9; h++) {
    for (let q = 0; q < 4; q++) {
      const idx = h * 4 + q;
      indexedData.push({
        index: idx,
        startsAt: `2025-01-15T${String(h).padStart(2, '0')}:${String(q * 15).padStart(2, '0')}:00Z`,
        total: 0.28 + Math.random() * 0.05,
        intervalOfDay: idx,
      });
    }
  }

  // Day (09:00-17:00): moderate
  for (let h = 9; h < 17; h++) {
    for (let q = 0; q < 4; q++) {
      const idx = h * 4 + q;
      indexedData.push({
        index: idx,
        startsAt: `2025-01-15T${String(h).padStart(2, '0')}:${String(q * 15).padStart(2, '0')}:00Z`,
        total: 0.20 + Math.random() * 0.03,
        intervalOfDay: idx,
      });
    }
  }

  // Evening peak (17:00-20:00): expensive
  for (let h = 17; h < 20; h++) {
    for (let q = 0; q < 4; q++) {
      const idx = h * 4 + q;
      indexedData.push({
        index: idx,
        startsAt: `2025-01-15T${String(h).padStart(2, '0')}:${String(q * 15).padStart(2, '0')}:00Z`,
        total: 0.30 + Math.random() * 0.04,
        intervalOfDay: idx,
      });
    }
  }

  // Night (20:00-24:00): moderate
  for (let h = 20; h < 24; h++) {
    for (let q = 0; q < 4; q++) {
      const idx = h * 4 + q;
      indexedData.push({
        index: idx,
        startsAt: `2025-01-15T${String(h).padStart(2, '0')}:${String(q * 15).padStart(2, '0')}:00Z`,
        total: 0.18 + Math.random() * 0.02,
        intervalOfDay: idx,
      });
    }
  }

  const params = {
    batteryCapacity: 9.9,
    currentSoc: 0.20,
    targetSoc: 0.85,
    chargePowerKW: 6.0,
    intervalHours: 0.25,
    efficiencyLoss: 0.10,
    expensivePriceFactor: 1.05,
    minProfitEurPerKWh: 0.08,
  };

  const history = {
    productionHistory: {},
    consumptionHistory: {},
    batteryHistory: {},
  };

  const logger = {
    log: console.log,
    debug: () => {}, // Suppress debug logs
  };

  const strategy = computeHeuristicStrategy(indexedData, params, history, { logger });

  console.log('\n--- Results ---');
  console.log(`Charge intervals: ${strategy.chargeIntervals.length}`);
  console.log(`Discharge intervals: ${strategy.dischargeIntervals.length}`);
  console.log(`Total charge needed: ${strategy.neededKWh.toFixed(2)} kWh`);
  console.log(`Total discharge forecast: ${strategy.forecastedDemand.toFixed(2)} kWh`);
  console.log(`Estimated savings: €${strategy.savings.toFixed(2)}`);
  console.log(`Average price: ${strategy.avgPrice.toFixed(4)} €/kWh`);
  console.log(`Expensive threshold: ${strategy.expensiveThreshold.toFixed(4)} €/kWh`);

  if (strategy.chargeIntervals.length > 0) {
    console.log('\nFirst 5 charge slots:');
    strategy.chargeIntervals.slice(0, 5).forEach((interval) => {
      const time = new Date(interval.startsAt).toISOString().substring(11, 16);
      console.log(`  ${time} - ${interval.total.toFixed(4)} €/kWh`);
    });
  }

  if (strategy.dischargeIntervals.length > 0) {
    console.log('\nFirst 5 discharge slots:');
    strategy.dischargeIntervals.slice(0, 5).forEach((interval) => {
      const time = new Date(interval.startsAt).toISOString().substring(11, 16);
      console.log(`  ${time} - ${interval.total.toFixed(4)} €/kWh (need: ${interval.demandKWh.toFixed(2)} kWh)`);
    });
  }
}

// Example 2: Flat prices (no optimization opportunity)
function simulateFlatPrices() {
  console.log('\n\n=== SCENARIO 2: Flat Prices (No Optimization) ===\n');

  const indexedData = [];
  const flatPrice = 0.20;

  for (let i = 0; i < 96; i++) {
    const h = Math.floor(i / 4);
    const q = i % 4;
    indexedData.push({
      index: i,
      startsAt: `2025-01-15T${String(h).padStart(2, '0')}:${String(q * 15).padStart(2, '0')}:00Z`,
      total: flatPrice + (Math.random() * 0.002 - 0.001), // Tiny variation
      intervalOfDay: i,
    });
  }

  const params = {
    batteryCapacity: 9.9,
    currentSoc: 0.20,
    targetSoc: 0.85,
    chargePowerKW: 6.0,
    intervalHours: 0.25,
    efficiencyLoss: 0.10,
    expensivePriceFactor: 1.05,
    minProfitEurPerKWh: 0.08,
  };

  const history = {
    productionHistory: {},
    consumptionHistory: {},
    batteryHistory: {},
  };

  const logger = {
    log: console.log,
    debug: () => {},
  };

  const strategy = computeHeuristicStrategy(indexedData, params, history, { logger });

  console.log('\n--- Results ---');
  console.log(`Charge intervals: ${strategy.chargeIntervals.length}`);
  console.log(`Discharge intervals: ${strategy.dischargeIntervals.length}`);
  console.log('Expected: No optimization (prices too flat)');
  console.log(`Savings: €${strategy.savings.toFixed(2)}`);
}

// Example 3: Battery already full
function simulateFullBattery() {
  console.log('\n\n=== SCENARIO 3: Battery Already Full ===\n');

  const indexedData = [
    {
      index: 0, startsAt: '2025-01-15T00:00:00Z', total: 0.10, intervalOfDay: 0,
    },
    {
      index: 1, startsAt: '2025-01-15T00:15:00Z', total: 0.11, intervalOfDay: 1,
    },
    {
      index: 2, startsAt: '2025-01-15T07:00:00Z', total: 0.30, intervalOfDay: 28,
    },
    {
      index: 3, startsAt: '2025-01-15T07:15:00Z', total: 0.32, intervalOfDay: 29,
    },
  ];

  const params = {
    batteryCapacity: 9.9,
    currentSoc: 0.85, // Already at target
    targetSoc: 0.85,
    chargePowerKW: 6.0,
    intervalHours: 0.25,
    efficiencyLoss: 0.10,
    expensivePriceFactor: 1.05,
    minProfitEurPerKWh: 0.08,
  };

  const history = {
    productionHistory: {},
    consumptionHistory: {},
    batteryHistory: {},
  };

  const logger = {
    log: console.log,
    debug: () => {},
  };

  const strategy = computeHeuristicStrategy(indexedData, params, history, { logger });

  console.log('\n--- Results ---');
  console.log(`Charge intervals: ${strategy.chargeIntervals.length}`);
  console.log('Expected: 0 (battery full)');
  console.log(`Discharge intervals: ${strategy.dischargeIntervals.length}`);
  console.log(`Can still discharge existing charge: ${strategy.dischargeIntervals.length > 0 ? 'Yes' : 'No'}`);
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

  console.log('\n\n✅ Simulation complete!\n');
  console.log('To run tests: npm test');
  console.log('To run with coverage: npm run test:coverage\n');
}

main();
