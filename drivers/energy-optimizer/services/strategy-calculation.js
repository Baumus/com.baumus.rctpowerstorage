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
  PRICE_TIMEZONE,
} = require('../constants');
const { getBatteryTargetState } = require('./battery-target-state');
const {
  getDateKeyInTimeZone,
  getMinutesSinceMidnightInTimeZone,
  resolveSunriseEstimate,
  isMinuteInWindow,
} = require('../sunrise-core');

const SUNRISE_RECALC_PRE_MINUTES = 45;
const SUNRISE_RECALC_POST_MINUTES = 120;
const PV_START_FORCE_THRESHOLD_W = 100;
const PV_START_FORCE_BASELINE_W = 20;

function getHomeyGeolocationSnapshot(host) {
  try {
    const manager = host?.homey?.geolocation;
    if (!manager) return null;

    const latitude = typeof manager.getLatitude === 'function' ? manager.getLatitude() : null;
    const longitude = typeof manager.getLongitude === 'function' ? manager.getLongitude() : null;
    const accuracy = typeof manager.getAccuracy === 'function' ? manager.getAccuracy() : null;

    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      return null;
    }

    return {
      latitude,
      longitude,
      accuracy: Number.isFinite(accuracy) ? accuracy : null,
    };
  } catch (error) {
    return null;
  }
}

function getCurrentSolarProductionW(host) {
  try {
    const solarDeviceId = typeof host.getSetting === 'function' ? host.getSetting('solar_device_id') : '';
    if (!solarDeviceId || typeof solarDeviceId !== 'string' || solarDeviceId.trim() === '') {
      return null;
    }

    const solarDevice = host.getDeviceById('solar-panel', solarDeviceId);
    if (!solarDevice || typeof solarDevice.hasCapability !== 'function' || !solarDevice.hasCapability('measure_power')) {
      return null;
    }

    const value = solarDevice.getCapabilityValue('measure_power');
    return (typeof value === 'number' && Number.isFinite(value)) ? value : null;
  } catch (error) {
    return null;
  }
}

function getSunriseRecalcTrigger(host, now) {
  const geolocation = getHomeyGeolocationSnapshot(host);
  const estimate = resolveSunriseEstimate({
    date: now,
    timeZone: PRICE_TIMEZONE,
    geolocation,
    productionHistory: host.productionHistory || {},
    intervalMinutes: INTERVAL_MINUTES,
  });

  const currentMinutes = getMinutesSinceMidnightInTimeZone(now, PRICE_TIMEZONE);
  const sunriseMinutes = Number.isFinite(estimate?.minutes) ? estimate.minutes : null;
  const dateKey = getDateKeyInTimeZone(now, PRICE_TIMEZONE);
  let enteredSunriseWindow = false;

  if (Number.isFinite(currentMinutes) && Number.isFinite(sunriseMinutes) && dateKey) {
    const startMinutes = sunriseMinutes - SUNRISE_RECALC_PRE_MINUTES;
    const endMinutes = sunriseMinutes + SUNRISE_RECALC_POST_MINUTES;
    const inWindow = isMinuteInWindow(currentMinutes, startMinutes, endMinutes);
    const previousInWindow = host._sunriseRecalcWindowDateKey === dateKey
      ? Boolean(host._sunriseRecalcInWindow)
      : false;
    enteredSunriseWindow = inWindow && !previousInWindow;

    host._sunriseRecalcWindowDateKey = dateKey;
    host._sunriseRecalcInWindow = inWindow;
  } else {
    host._sunriseRecalcWindowDateKey = dateKey || null;
    host._sunriseRecalcInWindow = false;
  }

  const currentSolarW = getCurrentSolarProductionW(host);
  const previousSolarW = Number.isFinite(host._lastObservedSolarProductionW)
    ? host._lastObservedSolarProductionW
    : null;
  const risingSolarSignal = Number.isFinite(currentSolarW)
    && (!Number.isFinite(previousSolarW) || previousSolarW <= PV_START_FORCE_BASELINE_W)
    && currentSolarW >= PV_START_FORCE_THRESHOLD_W;

  if (Number.isFinite(currentSolarW)) {
    host._lastObservedSolarProductionW = currentSolarW;
  }

  if (enteredSunriseWindow) {
    return {
      force: true,
      reason: `sunrise-window-entered (${estimate.source || 'fallback'})`,
    };
  }

  if (risingSolarSignal) {
    return {
      force: true,
      reason: `solar-start-signal (${currentSolarW.toFixed(0)}W)`,
    };
  }

  return { force: false, reason: null };
}

// Try to load LP solver from submodule
let lpSolver;
try {
  // eslint-disable-next-line global-require
  lpSolver = require('../../../lib/javascript-lp-solver/src/main');
} catch (error) {
  // LP solver not available
}

function serializeStrategyInput(value) {
  if (value === null || value === undefined) {
    return '';
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value.toFixed(6) : String(value);
  }

  if (typeof value === 'string' || typeof value === 'boolean') {
    return String(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => serializeStrategyInput(entry)).join(',')}]`;
  }

  if (typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${key}:${serializeStrategyInput(value[key])}`).join(',')}}`;
  }

  return String(value);
}

function getStrategyInputHash(host) {
  const batteryDeviceId = host.getSettingOrDefault('battery_device_id', '');
  const batteryDevice = host.getDeviceById('rct-power-storage-dc', batteryDeviceId);
  const socValue = host.getCapabilitySafe(batteryDevice, 'measure_battery');
  const soc = Number.isFinite(socValue) ? socValue : 0;

  const nowQuarterBucket = Math.floor(Date.now() / (INTERVAL_MINUTES * 60 * 1000));
  const priceSignature = serializeStrategyInput(
    Array.isArray(host.priceCache)
      ? host.priceCache.map((entry) => ({ startsAt: entry.startsAt, total: entry.total }))
      : [],
  );
  const targetSoc = host.normalizedTargetSoc || 0;
  const chargePower = host.normalizedChargePowerKW || 0;
  const effLoss = host.normalizedEfficiencyLoss || 0;
  const batteryCapacity = parseFloat(batteryDevice?.getSetting('battery_capacity')) || DEFAULT_BATTERY_CAPACITY_KWH;
  const minSocThreshold = Number(host.getSettingOrDefault('min_soc_threshold', DEFAULT_MIN_SOC_THRESHOLD)) || 0;
  const minProfitCent = Number(host.getSettingOrDefault('min_profit_cent_per_kwh', DEFAULT_MIN_PROFIT_CENT_PER_KWH)) || 0;
  const productionHistory = serializeStrategyInput(host.productionHistory || {});
  const consumptionHistory = serializeStrategyInput(host.consumptionHistory || {});
  const batteryHistory = serializeStrategyInput(host.batteryHistory || {});
  const geolocation = getHomeyGeolocationSnapshot(host);
  const geolocationSignature = serializeStrategyInput(geolocation || {});

  return [
    nowQuarterBucket,
    soc.toFixed(2),
    targetSoc,
    chargePower,
    effLoss,
    batteryCapacity,
    minSocThreshold,
    minProfitCent,
    priceSignature,
    productionHistory,
    consumptionHistory,
    batteryHistory,
    geolocationSignature,
  ].join('|');
}

/**
 * Calculate optimal charging strategy based on price data.
 * Host-based service module: operates on the EnergyOptimizerDevice instance.
 */
async function calculateOptimalStrategy(host, { force = false } = {}) {
  const now = new Date();
  const sunriseTrigger = getSunriseRecalcTrigger(host, now);
  const forceRecalc = Boolean(force || sunriseTrigger.force);

  if (sunriseTrigger.force && !force && typeof host.debug === 'function') {
    host.debug(`🌅 Forcing strategy recalc (${sunriseTrigger.reason})`);
  }

  // Skip recalc if inputs haven't changed (unless forced)
  if (!forceRecalc && host._lastStrategyInputHash) {
    const currentHash = getStrategyInputHash(host);
    if (currentHash === host._lastStrategyInputHash) {
      host.debug('⏭️ Skipping strategy recalc (no input changes)');
      return;
    }
    host._lastStrategyInputHash = currentHash;
  } else if (!forceRecalc) {
    host._lastStrategyInputHash = getStrategyInputHash(host);
  }

  host.log('\n🔄 Recalculating optimization strategy with current battery status...');

  if (!host.priceCache.length) {
    host.log('⚠️ No price data available - cannot optimize');
    return;
  }

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
  const {
    currentEnergyKWh,
    targetEnergyKWh,
    availableCapacityToTargetKWh,
    excessEnergyAboveTargetKWh,
  } = getBatteryTargetState({
    batteryCapacity,
    currentSoc,
    targetSoc: maxTargetSoc,
  });

  // Economic inputs / constraints (no new settings):
  // - min_soc_threshold is the lower SoC bound
  // - min_profit_cent_per_kwh is the minimum profit margin
  // - battery energy cost basis is derived from the same combined energyCost shown in the UI
  const minSocThresholdPercent = Number(host.getSettingOrDefault('min_soc_threshold', DEFAULT_MIN_SOC_THRESHOLD));
  const minSocThreshold = Math.max(0, Math.min(100, minSocThresholdPercent)) / 100;
  const configuredMinEnergyKWh = batteryCapacity * minSocThreshold;
  const maxEnergyKWh = targetEnergyKWh;
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
  host.log(`Current SoC: ${(currentSoc * 100).toFixed(1)}%, Optimization target: ${(maxTargetSoc * 100).toFixed(1)}%`);
  host.log(`Charging headroom to target: ${availableCapacityToTargetKWh.toFixed(2)} kWh (optimizer charges only up to ${(maxTargetSoc * 100).toFixed(1)}%)`);
  if (excessEnergyAboveTargetKWh > 0) {
    host.log(`Above-target reserve: ${excessEnergyAboveTargetKWh.toFixed(2)} kWh (kept available as discharge buffer, no further charging optimization)`);
  }
  host.log(`Charge power: ${chargePowerKW} kW = ${energyPerInterval.toFixed(2)} kWh per interval`);
  host.log(`Battery efficiency loss: ${(BATTERY_EFFICIENCY_LOSS * 100).toFixed(1)}%`);

  // Add index and intervalOfDay to all data using pure function
  const indexedData = enrichPriceData(availableData, INTERVAL_MINUTES);

  const avgPrice = indexedData.reduce((sum, p) => sum + p.total, 0) / indexedData.length;
  host.log(`Average price: ${avgPrice.toFixed(4)} €/kWh`);

  const geolocation = getHomeyGeolocationSnapshot(host);
  host._sunriseGeolocation = geolocation;
  if (geolocation) {
    host.log(`Sunrise source candidate: geolocation (${geolocation.latitude.toFixed(4)}, ${geolocation.longitude.toFixed(4)})`);
  } else {
    host.log('Sunrise source candidate: no geolocation available, fallback chain will be used');
  }

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
      forecastOptions: {
        enableSunriseBias: true,
        sunriseBiasLevel: 'medium',
        maxBiasKWhPerInterval: 0.15,
        intervalMinutes: INTERVAL_MINUTES,
        timeZone: 'Europe/Berlin',
        geolocation,
      },
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
        availableCapacity: availableCapacityToTargetKWh,
        availableCapacityToTarget: availableCapacityToTargetKWh,
        excessEnergyAboveTargetKWh,
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
  if (availableCapacityToTargetKWh < 0.01 && excessEnergyAboveTargetKWh > 0) {
    host.log(`No target-window charging planned: target SoC already reached or exceeded. Keeping ${excessEnergyAboveTargetKWh.toFixed(2)} kWh above target available as discharge buffer in normal mode.`);
  }
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
      availableCapacity: availableCapacityToTargetKWh,
      availableCapacityToTarget: availableCapacityToTargetKWh,
      excessEnergyAboveTargetKWh,
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
