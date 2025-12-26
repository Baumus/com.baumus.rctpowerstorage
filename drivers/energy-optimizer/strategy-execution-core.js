'use strict';

/**
 * Strategy execution logic - pure functions for battery mode decisions
 * This module determines what battery mode should be active based on
 * current conditions without performing actual device I/O.
 */

// Battery modes
const BATTERY_MODE = {
  CHARGE: 'CHARGE', // Charge from grid active
  NORMAL: 'NORMAL', // Feed house load from 1st solar, 2nd battery, 3rd grid
  CONSTANT: 'CONSTANT', // Prevent battery discharge (solar excess still charges battery)
  IDLE: 'IDLE', // No action needed
};

/**
 * Find the index of the current interval in the price cache
 * @param {Date} now - Current timestamp
 * @param {Array} priceCache - Array of price intervals
 * @param {number} intervalMinutes - Duration of each interval
 * @returns {number} Index of current interval, or -1 if not found
 */
function findCurrentIntervalIndex(now, priceCache, intervalMinutes = 15) {
  for (let i = 0; i < priceCache.length; i++) {
    const start = new Date(priceCache[i].startsAt);
    const end = new Date(start.getTime() + intervalMinutes * 60 * 1000);

    if (now >= start && now < end) {
      return i;
    }
  }

  return -1;
}

/**
 * Check if battery mode has changed
 * @param {string} newMode - New battery mode
 * @param {string} lastMode - Previous battery mode
 * @returns {boolean} True if mode has changed
 */
function hasModeChanged(newMode, lastMode) {
  return newMode !== lastMode && lastMode !== null;
}

/**
 * Determine battery mode based on current conditions
 * @param {Object} params - Decision parameters
 * @param {Date} params.now - Current timestamp
 * @param {Array} params.priceCache - Array of price intervals with startsAt
 * @param {Object} params.strategy - Current optimization strategy
 * @param {number} params.gridPower - Current grid power in W (negative = solar export)
 * @param {number} params.solarProductionW - Current solar production power in W (>= 0)
 * @param {string} params.lastMode - Previous battery mode for hysteresis
 * @param {Object} params.thresholds - Grid power thresholds
 * @param {number} params.intervalMinutes - Interval duration (default 15)
 * @returns {Object} { mode: string, intervalIndex: number, reason: string }
 */
function decideBatteryMode(params) {
  const {
    now,
    priceCache,
    strategy,
    gridPower = 0,
    solarProductionW = null,
    lastMode = null,
    currentSocPercent = null,
    minSocThresholdPercent = null,
    thresholds = { solarThreshold: -300, consumptionThreshold: 300 },
    intervalMinutes = 15,
  } = params;

  // Validate inputs
  if (!now || !(now instanceof Date)) {
    return { mode: BATTERY_MODE.IDLE, intervalIndex: -1, reason: 'Invalid timestamp' };
  }

  if (!priceCache || !Array.isArray(priceCache) || priceCache.length === 0) {
    return { mode: BATTERY_MODE.IDLE, intervalIndex: -1, reason: 'No price data available' };
  }

  if (!strategy) {
    return { mode: BATTERY_MODE.IDLE, intervalIndex: -1, reason: 'No strategy available' };
  }

  // Find current interval index
  const currentIntervalIndex = findCurrentIntervalIndex(now, priceCache, intervalMinutes);

  if (currentIntervalIndex === -1) {
    return {
      mode: BATTERY_MODE.IDLE,
      intervalIndex: -1,
      reason: 'Current time not in any price interval',
    };
  }

  const currentStartsAt = priceCache[currentIntervalIndex]?.startsAt;
  const currentStartMs = currentStartsAt ? new Date(currentStartsAt).getTime() : NaN;

  const matchesCurrentInterval = (plannedInterval) => {
    if (!plannedInterval || typeof plannedInterval !== 'object') return false;
    if (plannedInterval.startsAt) {
      const plannedMs = new Date(plannedInterval.startsAt).getTime();
      return Number.isFinite(currentStartMs) && plannedMs === currentStartMs;
    }
    // Backwards compatibility: older strategies/tests only provide index
    return plannedInterval.index === currentIntervalIndex;
  };

  // Check if current interval is a planned charge slot
  const chargeIntervals = (strategy.chargeIntervals && Array.isArray(strategy.chargeIntervals))
    ? strategy.chargeIntervals
    : [];

  const matchedChargeInterval = chargeIntervals.find(matchesCurrentInterval) || null;
  const shouldCharge = Boolean(matchedChargeInterval);

  // Check if current interval is a planned discharge slot
  const shouldDischarge = strategy.dischargeIntervals
    && Array.isArray(strategy.dischargeIntervals)
    && strategy.dischargeIntervals.some(matchesCurrentInterval);

  const isLowSoc = (typeof currentSocPercent === 'number' && Number.isFinite(currentSocPercent))
    && (typeof minSocThresholdPercent === 'number' && Number.isFinite(minSocThresholdPercent))
    && currentSocPercent <= minSocThresholdPercent;

  const SOLAR_START_THRESHOLD_W = 50;
  const isSolarActive = (typeof solarProductionW === 'number' && Number.isFinite(solarProductionW))
    && solarProductionW > SOLAR_START_THRESHOLD_W;

  // Priority 1: Charge interval
  if (shouldCharge) {
    const EPS_KWH = 0.001;
    const plannedGridEnergyKWh = (() => {
      if (!matchedChargeInterval || typeof matchedChargeInterval !== 'object') return null;
      if (Number.isFinite(matchedChargeInterval.plannedGridEnergyKWh)) return matchedChargeInterval.plannedGridEnergyKWh;
      if (Array.isArray(matchedChargeInterval.plannedChargeParts)) {
        return matchedChargeInterval.plannedChargeParts
          .filter((p) => p && p.source === 'grid')
          .reduce((sum, p) => sum + (Number.isFinite(p.energyKWh) ? p.energyKWh : 0), 0);
      }
      // Some callers might provide a flattened plannedEnergySource
      if (matchedChargeInterval.plannedEnergySource === 'grid' && Number.isFinite(matchedChargeInterval.plannedEnergyKWh)) {
        return matchedChargeInterval.plannedEnergyKWh;
      }
      return null;
    })();

    const plannedSolarEnergyKWh = (() => {
      if (!matchedChargeInterval || typeof matchedChargeInterval !== 'object') return null;
      if (Number.isFinite(matchedChargeInterval.plannedSolarEnergyKWh)) return matchedChargeInterval.plannedSolarEnergyKWh;
      if (Array.isArray(matchedChargeInterval.plannedChargeParts)) {
        return matchedChargeInterval.plannedChargeParts
          .filter((p) => p && p.source === 'solar')
          .reduce((sum, p) => sum + (Number.isFinite(p.energyKWh) ? p.energyKWh : 0), 0);
      }
      if (matchedChargeInterval.plannedEnergySource === 'solar' && Number.isFinite(matchedChargeInterval.plannedEnergyKWh)) {
        return matchedChargeInterval.plannedEnergyKWh;
      }
      return null;
    })();

    const hasPlannedGridCharge = Number.isFinite(plannedGridEnergyKWh) && plannedGridEnergyKWh > EPS_KWH;
    const hasPlannedSolarCharge = Number.isFinite(plannedSolarEnergyKWh) && plannedSolarEnergyKWh > EPS_KWH;

    // Battery_Mode.CHARGE must only be used for charging from grid.
    // Backwards compatibility: if the strategy doesn't specify sources, assume it is a grid-charge slot.
    if (hasPlannedGridCharge || (!hasPlannedSolarCharge && !hasPlannedGridCharge)) {
      return {
        mode: BATTERY_MODE.CHARGE,
        intervalIndex: currentIntervalIndex,
        reason: `Planned grid charge interval (price: ${priceCache[currentIntervalIndex]?.total?.toFixed(4)} €/kWh)`,
      };
    }

    // Planned solar-only charging: no special mode needed.
    // Real-world behavior can differ by inverter/firmware; ensure PV can start/run by allowing NORMAL when PV is active.
    if (isSolarActive) {
      return {
        mode: BATTERY_MODE.NORMAL,
        intervalIndex: currentIntervalIndex,
        reason: `Planned solar-only charge (PV ${solarProductionW.toFixed(0)} W > ${SOLAR_START_THRESHOLD_W} W) → NORMAL to ensure PV operation`,
      };
    }
    return {
      mode: BATTERY_MODE.CONSTANT,
      intervalIndex: currentIntervalIndex,
      reason: 'Planned solar-only charge (no grid charge planned) → CONSTANT to prevent discharge',
    };
  }

  // Priority 2: Discharge interval (expensive hour)
  if (shouldDischarge) {
    if (isLowSoc) {
      return {
        mode: BATTERY_MODE.NORMAL,
        intervalIndex: currentIntervalIndex,
        reason: `Low SoC (${currentSocPercent.toFixed(1)}% <= ${minSocThresholdPercent.toFixed(1)}%) → NORMAL (battery will not discharge below threshold)`,
      };
    }
    return {
      mode: BATTERY_MODE.NORMAL,
      intervalIndex: currentIntervalIndex,
      reason: `Planned discharge interval (price: ${priceCache[currentIntervalIndex]?.total?.toFixed(4)} €/kWh)`,
    };
  }

  // Priority 3: Default interval
  // When PV is active, switch between NORMAL and CONSTANT based on gridPower thresholds
  // to avoid feeding excess solar into the grid while still preventing discharge when importing.
  if (isSolarActive) {
    const hasGridPower = typeof gridPower === 'number' && Number.isFinite(gridPower);
    const solarThreshold = (thresholds && Number.isFinite(thresholds.solarThreshold)) ? thresholds.solarThreshold : -300;
    const consumptionThreshold = (thresholds && Number.isFinite(thresholds.consumptionThreshold)) ? thresholds.consumptionThreshold : 300;

    if (hasGridPower && gridPower <= solarThreshold) {
      return {
        mode: BATTERY_MODE.NORMAL,
        intervalIndex: currentIntervalIndex,
        reason: `PV active (${solarProductionW.toFixed(0)} W) and exporting (gridPower ${gridPower.toFixed(0)} W <= ${solarThreshold} W) → NORMAL to reduce feed-in`,
      };
    }

    if (hasGridPower && gridPower >= consumptionThreshold) {
      return {
        mode: BATTERY_MODE.CONSTANT,
        intervalIndex: currentIntervalIndex,
        reason: `PV active (${solarProductionW.toFixed(0)} W) and importing (gridPower ${gridPower.toFixed(0)} W >= ${consumptionThreshold} W) → CONSTANT to prevent discharge`,
      };
    }

    // Hysteresis/deadband: keep last mode to avoid flapping.
    if (lastMode === BATTERY_MODE.NORMAL || lastMode === BATTERY_MODE.CONSTANT) {
      return {
        mode: lastMode,
        intervalIndex: currentIntervalIndex,
        reason: `PV active (${solarProductionW.toFixed(0)} W) and gridPower within deadband → keep ${lastMode}`,
      };
    }

    return {
      mode: BATTERY_MODE.NORMAL,
      intervalIndex: currentIntervalIndex,
      reason: `PV active (${solarProductionW.toFixed(0)} W) → NORMAL (no prior mode for hysteresis)`,
    };
  }

  // No PV signal available or PV not active: keep safe default (prevent discharge).
  return {
    mode: BATTERY_MODE.CONSTANT,
    intervalIndex: currentIntervalIndex,
    reason: `Default interval (gridPower ${Number.isFinite(gridPower) ? gridPower.toFixed(0) : 'n/a'} W) → CONSTANT to prevent discharge`,
  };
}

module.exports = {
  decideBatteryMode,
  findCurrentIntervalIndex,
  hasModeChanged,
  BATTERY_MODE,
};
