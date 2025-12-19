'use strict';

/**
 * Strategy execution logic - pure functions for battery mode decisions
 * This module determines what battery mode should be active based on
 * current conditions without performing actual device I/O.
 */

// Battery modes
const BATTERY_MODE = {
  CHARGE: 'CHARGE', // Grid charging active
  DISCHARGE: 'DISCHARGE', // Discharging to grid (expensive interval)
  NORMAL_SOLAR: 'NORMAL_SOLAR', // Normal mode with solar excess
  NORMAL_HOLD: 'NORMAL_HOLD', // Hold mode (prevent discharge during grid consumption)
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
  const shouldCharge = strategy.chargeIntervals
    && Array.isArray(strategy.chargeIntervals)
    && strategy.chargeIntervals.some(matchesCurrentInterval);

  // Check if current interval is a planned discharge slot
  const shouldDischarge = strategy.dischargeIntervals
    && Array.isArray(strategy.dischargeIntervals)
    && strategy.dischargeIntervals.some(matchesCurrentInterval);

  // Priority 1: Charge interval
  if (shouldCharge) {
    return {
      mode: BATTERY_MODE.CHARGE,
      intervalIndex: currentIntervalIndex,
      reason: `Planned charge interval (price: ${priceCache[currentIntervalIndex]?.total?.toFixed(4)} €/kWh)`,
    };
  }

  // Priority 2: Discharge interval (expensive hour)
  if (shouldDischarge) {
    return {
      mode: BATTERY_MODE.DISCHARGE,
      intervalIndex: currentIntervalIndex,
      reason: `Planned discharge interval (price: ${priceCache[currentIntervalIndex]?.total?.toFixed(4)} €/kWh)`,
    };
  }

  // Priority 3: Normal interval - decide based on grid power with hysteresis
  const { solarThreshold, consumptionThreshold } = thresholds;

  if (gridPower < solarThreshold) {
    // Significant solar excess → allow battery charging and discharging
    return {
      mode: BATTERY_MODE.NORMAL_SOLAR,
      intervalIndex: currentIntervalIndex,
      reason: `Solar excess detected (${gridPower.toFixed(0)} W < ${solarThreshold} W)`,
    };
  }

  if (gridPower > consumptionThreshold) {
    // Consuming from grid → prevent battery discharge
    return {
      mode: BATTERY_MODE.NORMAL_HOLD, // as quick fix until HOLD mode is implemented correctly
      intervalIndex: currentIntervalIndex,
      reason: `Grid consumption (${gridPower.toFixed(0)} W > ${consumptionThreshold} W)`,
    };
  }

  // In neutral zone (between thresholds) → keep current mode to prevent oscillation
  const maintainedMode = lastMode === BATTERY_MODE.NORMAL_SOLAR || lastMode === BATTERY_MODE.NORMAL_HOLD
    ? lastMode
    : BATTERY_MODE.NORMAL_HOLD;

  return {
    mode: maintainedMode,
    intervalIndex: currentIntervalIndex,
    reason: `Neutral zone (${gridPower.toFixed(0)} W), maintaining ${maintainedMode}`,
  };
}

module.exports = {
  decideBatteryMode,
  findCurrentIntervalIndex,
  hasModeChanged,
  BATTERY_MODE,
};
