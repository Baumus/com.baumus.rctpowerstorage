'use strict';

const { optimizeStrategyWithLp } = require('../optimizer-core');
const {
  filterCurrentAndFutureIntervals,
  enrichPriceData,
} = require('../time-scheduling-core');
const {
  INTERVAL_MINUTES,
  INTERVAL_HOURS,
  DEFAULT_BATTERY_CAPACITY_KWH,
  DEFAULT_TARGET_SOC,
  DEFAULT_MIN_SOC_THRESHOLD,
  DEFAULT_MIN_PROFIT_CENT_PER_KWH,
} = require('../constants');

// Try to load LP solver from submodule
let lpSolver;
try {
  // eslint-disable-next-line global-require
  lpSolver = require('../../../lib/javascript-lp-solver/src/main');
} catch (error) {
  // LP solver not available
}

function getStrategyInputHash(host) {
  const batteryDeviceId = host.getSettingOrDefault('battery_device_id', '');
  const batteryDevice = host.getDeviceById('rct-power-storage-dc', batteryDeviceId);
  const socValue = host.getCapabilitySafe(batteryDevice, 'measure_battery');
  const soc = socValue !== null ? Math.round(socValue) : 0;

  const priceLen = host.priceCache ? host.priceCache.length : 0;
  const targetSoc = host.normalizedTargetSoc || 0;
  const chargePower = host.normalizedChargePowerKW || 0;
  const effLoss = host.normalizedEfficiencyLoss || 0;

  return `${priceLen}:${soc}:${targetSoc}:${chargePower}:${effLoss}`;
}

/**
 * Calculate optimal charging strategy based on price data.
 * Host-based service module: operates on the EnergyOptimizerDevice instance.
 */
async function calculateOptimalStrategy(host, { force = false } = {}) {
  // Skip recalc if inputs haven't changed (unless forced)
  if (!force && host._lastStrategyInputHash) {
    const currentHash = getStrategyInputHash(host);
    if (currentHash === host._lastStrategyInputHash) {
      host.debug('⏭️ Skipping strategy recalc (no input changes)');
      return;
    }
    host._lastStrategyInputHash = currentHash;
  } else if (!force) {
    host._lastStrategyInputHash = getStrategyInputHash(host);
  }

  host.log('\n🔄 Recalculating optimization strategy with current battery status...');

  if (!host.priceCache.length) {
    host.log('⚠️ No price data available - cannot optimize');
    return;
  }

  const now = new Date();
  const availableData = filterCurrentAndFutureIntervals(
    host.priceCache,
    now,
    INTERVAL_MINUTES,
  );

  if (!availableData.length) {
    host.log('No price data available');
    host.currentStrategy = { chargeIntervals: [] };
    await host.setCapabilityValueIfChanged('next_charge_start', host.homey.__('status.no_data'));
    return;
  }

  // Get battery configuration
  const batteryDeviceId = host.getSettingOrDefault('battery_device_id', '');
  const batteryDevice = host.getDeviceById('rct-power-storage-dc', batteryDeviceId);

  if (!batteryDevice) {
    host.error(`Battery device not found with ID: ${batteryDeviceId}`);
    await host.setCapabilityValueIfChanged('optimizer_status', host.homey.__('error.battery_not_found'));
    return;
  }

  let currentSoc = 0;
  const socValue = host.getCapabilitySafe(batteryDevice, 'measure_battery');
  if (socValue !== null) {
    currentSoc = socValue / 100;
  } else {
    host.log('Warning: Could not read current SoC from battery device');
  }

  const batteryCapacity = parseFloat(batteryDevice.getSetting('battery_capacity')) || DEFAULT_BATTERY_CAPACITY_KWH;
  const chargePowerKW = host.normalizedChargePowerKW;
  const energyPerInterval = chargePowerKW * INTERVAL_HOURS;
  const maxTargetSoc = host.normalizedTargetSoc || (DEFAULT_TARGET_SOC / 100);
  const BATTERY_EFFICIENCY_LOSS = host.normalizedEfficiencyLoss;
  const maxBatteryKWh = batteryCapacity * (maxTargetSoc - currentSoc);

  // Economic inputs / constraints (no new settings):
  // - min_soc_threshold is the lower SoC bound
  // - min_profit_cent_per_kwh is the minimum profit margin
  // - battery energy cost basis is derived from the same combined energyCost shown in the UI
  const minSocThresholdPercent = Number(host.getSettingOrDefault('min_soc_threshold', DEFAULT_MIN_SOC_THRESHOLD));
  const minSocThreshold = Math.max(0, Math.min(100, minSocThresholdPercent)) / 100;
  const configuredMinEnergyKWh = batteryCapacity * minSocThreshold;
  const currentEnergyKWh = currentSoc * batteryCapacity;
  const maxEnergyKWh = maxTargetSoc * batteryCapacity;
  const minEnergyKWh = Math.min(
    Math.min(configuredMinEnergyKWh, maxEnergyKWh),
    currentEnergyKWh,
  );

  const storedKWh = currentEnergyKWh;
  const trackedCost = host.calculateBatteryEnergyCost();
  const batteryCostInfo = currentSoc > 0.05
    ? host.combineBatteryCost(trackedCost, storedKWh, batteryCapacity)
    : null;

  const minProfitCent = Number(host.getSettingOrDefault('min_profit_cent_per_kwh', DEFAULT_MIN_PROFIT_CENT_PER_KWH));
  const minProfitEurPerKWh = Number.isFinite(minProfitCent) ? Math.max(0, minProfitCent) / 100 : 0;

  host.log('\n=== BATTERY STATUS ===');
  host.log(`Current SoC: ${(currentSoc * 100).toFixed(1)}%, Max target: ${(maxTargetSoc * 100).toFixed(1)}%`);
  host.log(`Available capacity: ${maxBatteryKWh.toFixed(2)} kWh (can charge from ${(currentSoc * 100).toFixed(1)}% to ${(maxTargetSoc * 100).toFixed(1)}%)`);
  host.log(`Charge power: ${chargePowerKW} kW = ${energyPerInterval.toFixed(2)} kWh per interval`);
  host.log(`Battery efficiency loss: ${(BATTERY_EFFICIENCY_LOSS * 100).toFixed(1)}%`);

  // Add index and intervalOfDay to all data using pure function
  const indexedData = enrichPriceData(availableData, INTERVAL_MINUTES);

  const avgPrice = indexedData.reduce((sum, p) => sum + p.total, 0) / indexedData.length;
  host.log(`Average price: ${avgPrice.toFixed(4)} €/kWh`);

  // LP-only optimization
  const lpResult = optimizeStrategyWithLp(
    indexedData,
    {
      batteryCapacity,
      currentSoc,
      targetSoc: maxTargetSoc,
      chargePowerKW,
      intervalHours: INTERVAL_HOURS,
      efficiencyLoss: BATTERY_EFFICIENCY_LOSS,
      minEnergyKWh,
      batteryCostEurPerKWh: batteryCostInfo?.avgPrice,
      minProfitEurPerKWh,
    },
    {
      productionHistory: host.productionHistory || {},
      consumptionHistory: host.consumptionHistory || {},
      batteryHistory: host.batteryHistory || {},
    },
    {
      lpSolver,
      logger: host,
    },
  );

  if (lpResult) {
    const {
      chargeIntervals,
      chargeDisplayEntries,
      dischargeIntervals,
      totalChargeKWh,
      totalDischargeKWh,
      savings,
      economics,
      plannedCharging,
    } = lpResult;

    host.currentStrategy = {
      chargeIntervals,
      chargeDisplayEntries,
      dischargeIntervals,
      expensiveIntervals: dischargeIntervals,
      avgPrice,
      neededKWh: totalChargeKWh,
      forecastedDemand: totalDischargeKWh,
      savings,
      economics,
      plannedCharging,
      batteryStatus: {
        currentSoc,
        targetSoc: maxTargetSoc,
        availableCapacity: maxBatteryKWh,
        batteryCapacity,
        storedKWh,
        energyCost: batteryCostInfo,
      },
    };

    host.lastOptimizationSoC = currentSoc;

    const nextChargeInterval = chargeIntervals
      .filter((ci) => new Date(ci.startsAt) >= now)
      .sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt))[0];

    if (nextChargeInterval) {
      const firstCharge = new Date(nextChargeInterval.startsAt);
      const formattedTime = firstCharge.toLocaleString(host.homey.i18n.getLanguage(), {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Europe/Berlin',
      });

      await host.setCapabilityValueIfChanged('next_charge_start', formattedTime);
      await host.setCapabilityValueIfChanged('estimated_savings', Math.round(savings * 100) / 100, { tolerance: 0.01 });

      host.log('\n=== LP STRATEGY SUMMARY ===');
      host.log(`Charge intervals: ${chargeIntervals.length}`);
      host.log(`Discharge intervals: ${dischargeIntervals.length}`);
      host.log(`First charge: ${firstCharge.toLocaleString()}`);
      host.log(`Total charge: ${totalChargeKWh.toFixed(2)} kWh`);
      host.log(`Estimated savings: €${savings.toFixed(2)}`);
      host.log('======================\n');
    } else {
      await host.setCapabilityValueIfChanged('next_charge_start', host.homey.__('status.no_cheap_slots'));
      await host.setCapabilityValueIfChanged('estimated_savings', 0);
    }

    host.log('LP optimization completed successfully, skipping heuristic optimizer.');
    return;
  }

  // LP-only mode: if LP fails/unavailable, do not fall back to heuristic.
  host.log('LP optimization unavailable/failed; using no-op strategy.');

  host.currentStrategy = {
    chargeIntervals: [],
    chargeDisplayEntries: [],
    dischargeIntervals: [],
    expensiveIntervals: [],
    avgPrice,
    neededKWh: 0,
    forecastedDemand: 0,
    savings: 0,
    economics: null,
    plannedCharging: null,
    batteryStatus: {
      currentSoc,
      targetSoc: maxTargetSoc,
      availableCapacity: maxBatteryKWh,
      batteryCapacity,
      storedKWh,
      energyCost: batteryCostInfo,
    },
  };

  host.lastOptimizationSoC = currentSoc;
  await host.setCapabilityValueIfChanged('next_charge_start', host.homey.__('status.no_cheap_slots'));
  await host.setCapabilityValueIfChanged('estimated_savings', 0);
}

module.exports = {
  getStrategyInputHash,
  calculateOptimalStrategy,
};
