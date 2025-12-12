'use strict';

/**
 * Battery cost calculation logic - pure functions for tracking battery energy costs
 * This module handles FIFO (First In, First Out) tracking of battery charge/discharge
 * events to calculate the average cost of energy currently stored in the battery.
 */

/**
 * Calculate the average cost and composition of energy currently in battery
 * Uses FIFO accounting to track solar vs grid energy and associated costs
 *
 * @param {Array} chargeLog - Array of charge/discharge events
 * @param {Object} options - Optional configuration
 * @param {Function} options.logger - Optional logger function
 * @returns {Object|null} Battery energy cost breakdown or null if empty
 */
function calculateBatteryEnergyCost(chargeLog, options = {}) {
  const { logger } = options;

  if (!chargeLog || !Array.isArray(chargeLog) || chargeLog.length === 0) {
    if (logger) logger('No battery charge log data available');
    return null;
  }

  // Calculate net energy and costs by summing all charge/discharge events
  let netSolarKWh = 0;
  let netGridKWh = 0;
  let totalGridCost = 0;

  for (const entry of chargeLog) {
    if (entry.type === 'charge') {
      // Charging: add solar and grid energy
      netSolarKWh += entry.solarKWh || 0;
      netGridKWh += entry.gridKWh || 0;
      totalGridCost += (entry.gridKWh || 0) * (entry.gridPrice || 0);
    } else if (entry.type === 'discharge') {
      // Discharging: subtract energy proportionally from solar and grid
      const dischargedKWh = Math.abs(entry.totalKWh || 0);
      const totalBeforeDischarge = netSolarKWh + netGridKWh;

      if (totalBeforeDischarge > 0.001) {
        // Calculate ratio of solar vs grid before discharge
        const solarRatio = netSolarKWh / totalBeforeDischarge;
        const gridRatio = netGridKWh / totalBeforeDischarge;

        // Subtract proportionally
        const solarDischarged = dischargedKWh * solarRatio;
        const gridDischarged = dischargedKWh * gridRatio;

        netSolarKWh = Math.max(0, netSolarKWh - solarDischarged);
        netGridKWh = Math.max(0, netGridKWh - gridDischarged);

        // Also subtract cost proportionally
        const avgCostBeforeDischarge = totalGridCost / totalBeforeDischarge;
        totalGridCost = Math.max(0, totalGridCost - (dischargedKWh * avgCostBeforeDischarge));
      }
    }
  }

  const netTotalKWh = netSolarKWh + netGridKWh;

  if (logger) {
    logger(`Battery energy calculation from ${chargeLog.length} log entries:`);
    logger(`  Net remaining: ${netTotalKWh.toFixed(3)} kWh (${netSolarKWh.toFixed(3)} solar + ${netGridKWh.toFixed(3)} grid)`);
  }

  if (netTotalKWh < 0.01) {
    if (logger) logger('  Battery effectively empty (< 0.01 kWh)');
    return null;
  }

  // Calculate weighted average price
  const avgPrice = netGridKWh > 0 ? totalGridCost / netGridKWh : 0;
  const weightedAvgPrice = netTotalKWh > 0 ? totalGridCost / netTotalKWh : 0;

  if (logger) {
    logger(`  Weighted avg cost: ${weightedAvgPrice.toFixed(4)} €/kWh`);
    logger(`  Total grid cost: €${totalGridCost.toFixed(2)}`);
    logger(`  Solar: ${((netSolarKWh / netTotalKWh) * 100).toFixed(1)}% (free)`);
    if (netGridKWh > 0) {
      logger(`  Grid: ${((netGridKWh / netTotalKWh) * 100).toFixed(1)}% @ ${avgPrice.toFixed(4)} €/kWh`);
    }
  }

  return {
    avgPrice: weightedAvgPrice,
    totalKWh: netTotalKWh,
    solarKWh: netSolarKWh,
    gridKWh: netGridKWh,
    solarPercent: netTotalKWh > 0 ? (netSolarKWh / netTotalKWh) * 100 : 0,
    gridPercent: netTotalKWh > 0 ? (netGridKWh / netTotalKWh) * 100 : 0,
    totalCost: totalGridCost,
    gridOnlyAvgPrice: avgPrice,
  };
}

/**
 * Create a charge log entry for battery charging
 *
 * @param {Object} params - Charge event parameters
 * @param {number} params.chargedKWh - Total kWh charged to battery
 * @param {number} params.solarKWh - kWh from solar production
 * @param {number} params.gridPrice - Current grid electricity price
 * @param {number} params.soc - Current State of Charge (%)
 * @param {Date} params.timestamp - Event timestamp
 * @returns {Object} Charge log entry
 */
function createChargeEntry(params) {
  const {
    chargedKWh,
    solarKWh = 0,
    gridPrice = 0,
    soc = 0,
    timestamp = new Date(),
  } = params;

  const chargeFromSolar = Math.min(chargedKWh, solarKWh);
  const chargeFromGrid = Math.max(0, chargedKWh - chargeFromSolar);

  return {
    timestamp: timestamp instanceof Date ? timestamp.toISOString() : timestamp,
    type: 'charge',
    solarKWh: chargeFromSolar,
    gridKWh: chargeFromGrid,
    totalKWh: chargedKWh,
    gridPrice,
    soc,
  };
}

/**
 * Create a discharge log entry for battery discharging
 *
 * @param {Object} params - Discharge event parameters
 * @param {number} params.dischargedKWh - Total kWh discharged from battery
 * @param {number} params.gridPrice - Current grid electricity price
 * @param {number} params.avgBatteryPrice - Average cost of energy in battery before discharge
 * @param {number} params.soc - Current State of Charge (%)
 * @param {Date} params.timestamp - Event timestamp
 * @returns {Object} Discharge log entry
 */
function createDischargeEntry(params) {
  const {
    dischargedKWh,
    gridPrice = 0,
    avgBatteryPrice = 0,
    soc = 0,
    timestamp = new Date(),
  } = params;

  return {
    timestamp: timestamp instanceof Date ? timestamp.toISOString() : timestamp,
    type: 'discharge',
    totalKWh: -Math.abs(dischargedKWh), // Negative for discharge
    gridPrice,
    avgBatteryPrice,
    soc,
  };
}

/**
 * Check if battery should be considered empty and log cleared
 *
 * @param {number} currentSoc - Current State of Charge (%)
 * @param {number} minSocThreshold - Minimum SoC threshold (%)
 * @param {number} logLength - Current charge log length
 * @returns {boolean} True if battery is empty and log should be cleared
 */
function shouldClearChargeLog(currentSoc, minSocThreshold, logLength) {
  return currentSoc <= minSocThreshold && logLength > 0;
}

/**
 * Trim charge log to maximum number of entries
 *
 * @param {Array} chargeLog - Array of charge/discharge events
 * @param {number} maxEntries - Maximum number of entries to keep
 * @returns {Array} Trimmed charge log
 */
function trimChargeLog(chargeLog, maxEntries) {
  if (!chargeLog || !Array.isArray(chargeLog)) {
    return [];
  }

  if (chargeLog.length <= maxEntries) {
    return chargeLog;
  }

  return chargeLog.slice(-maxEntries);
}

/**
 * Calculate profit/loss from a discharge event
 *
 * @param {number} dischargedKWh - Amount discharged (kWh)
 * @param {number} avgBatteryCost - Average cost of energy in battery (€/kWh)
 * @param {number} currentGridPrice - Current grid price (€/kWh)
 * @returns {Object} Profit calculation { profit, profitPercent, worthIt }
 */
function calculateDischargeProfit(dischargedKWh, avgBatteryCost, currentGridPrice) {
  if (dischargedKWh <= 0 || avgBatteryCost < 0 || currentGridPrice < 0) {
    return {
      profit: 0,
      profitPercent: 0,
      worthIt: false,
      reason: 'Invalid parameters',
    };
  }

  const cost = dischargedKWh * avgBatteryCost;
  const revenue = dischargedKWh * currentGridPrice;
  const profit = revenue - cost;
  const profitPercent = avgBatteryCost > 0 ? (profit / cost) * 100 : 0;

  return {
    profit,
    profitPercent,
    worthIt: profit > 0,
    cost,
    revenue,
    reason: profit > 0 ? 'Profitable discharge' : 'Unprofitable discharge',
  };
}

module.exports = {
  calculateBatteryEnergyCost,
  createChargeEntry,
  createDischargeEntry,
  shouldClearChargeLog,
  trimChargeLog,
  calculateDischargeProfit,
};
