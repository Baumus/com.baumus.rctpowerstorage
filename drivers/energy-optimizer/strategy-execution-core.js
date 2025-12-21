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
    // In CONSTANT, solar excess is still stored automatically while discharge is prevented.
    return {
      mode: BATTERY_MODE.CONSTANT,
      intervalIndex: currentIntervalIndex,
      reason: `Planned solar-only charge (no grid charge planned) → CONSTANT to prevent discharge`,
    };
  }

  // Priority 2: Discharge interval (expensive hour)
  if (shouldDischarge) {
    if (isLowSoc) {
      return {
        mode: BATTERY_MODE.CONSTANT,
        intervalIndex: currentIntervalIndex,
        reason: `Low SoC (${currentSocPercent.toFixed(1)}% <= ${minSocThresholdPercent.toFixed(1)}%) → CONSTANT to prevent discharge`,
      };
    }
    return {
      mode: BATTERY_MODE.NORMAL,
      intervalIndex: currentIntervalIndex,
      reason: `Planned discharge interval (price: ${priceCache[currentIntervalIndex]?.total?.toFixed(4)} €/kWh)`,
    };
  }

  // Priority 3: Default interval
  // With SOCStrategy.CONSTANT optimized to still store solar excess, we can keep the inverter
  // in CONSTANT whenever we're not explicitly charging from grid or allowing discharge.
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
