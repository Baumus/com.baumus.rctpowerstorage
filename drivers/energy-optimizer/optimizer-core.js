'use strict';

/**
 * Core optimization logic - pure functions without Homey dependencies
 * This module contains the heart of the energy optimization algorithm
 * and can be tested independently.
 */

/**
 * Calculate percentile from sorted array
 */
function getPercentile(values, q) {
  if (!values.length) return 0;
  const pos = (values.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (values[base + 1] !== undefined) {
    return values[base] + rest * (values[base + 1] - values[base]);
  }
  return values[base];
}

/**
 * Forecast energy demand for given intervals based on historical data
 * @param {Array} intervals - Array of price intervals
 * @param {Object} history - Historical data (productionHistory, consumptionHistory, batteryHistory)
 * @param {number} intervalHours - Duration of each interval in hours (default 0.25)
 * @returns {number} Total forecasted demand in kWh
 */
function forecastEnergyDemand(intervals, history, intervalHours = 0.25) {
  if (!intervals.length) {
    return 0;
  }

  // Validate history object
  if (!history || typeof history !== 'object') {
    // Use default estimate for all intervals
    return intervals.length * 3.0 * intervalHours;
  }

  // Safely extract history arrays, handling null/undefined
  const consumptionHistory = (history.consumptionHistory && typeof history.consumptionHistory === 'object')
    ? history.consumptionHistory
    : {};
  const productionHistory = (history.productionHistory && typeof history.productionHistory === 'object')
    ? history.productionHistory
    : {};
  const batteryHistory = (history.batteryHistory && typeof history.batteryHistory === 'object')
    ? history.batteryHistory
    : {};

  let totalForecastedKWh = 0;

  for (const interval of intervals) {
    const { intervalOfDay } = interval;

    // Skip if intervalOfDay is undefined/null
    if (intervalOfDay === undefined || intervalOfDay === null) {
      // Use default estimate
      totalForecastedKWh += 3.0 * intervalHours;
      continue;
    }

    // Get historical grid power data for this interval
    const gridHistory = consumptionHistory[intervalOfDay] || [];

    let forecastedGridKW = 0;

    if (gridHistory.length > 0) {
      // Use average of historical data (in W, convert to kW)
      const avgGridW = gridHistory.reduce((sum, val) => sum + val, 0) / gridHistory.length;
      forecastedGridKW = avgGridW / 1000;
    } else {
      // No historical data - use conservative estimate
      // Assume average household grid import of 3 kW
      forecastedGridKW = 3.0;
    }

    // Get expected solar production during this interval
    const productionHistoryData = productionHistory[intervalOfDay] || [];
    let forecastedSolarKW = 0;

    if (productionHistoryData.length > 0) {
      const avgSolarW = productionHistoryData.reduce((sum, val) => sum + val, 0) / productionHistoryData.length;
      forecastedSolarKW = avgSolarW / 1000;
    }

    // Get expected battery discharge during this interval
    const batteryHistoryData = batteryHistory[intervalOfDay] || [];
    let forecastedBatteryKW = 0;

    if (batteryHistoryData.length > 0) {
      const avgBatteryW = batteryHistoryData.reduce((sum, val) => sum + val, 0) / batteryHistoryData.length;
      forecastedBatteryKW = avgBatteryW / 1000;
    }

    // Net demand = gridPower + solarPower - batteryPower
    // Battery power is negative when discharging, so subtracting adds to demand
    const netDemandKW = forecastedGridKW + forecastedSolarKW - forecastedBatteryKW;
    const energyKWh = netDemandKW * intervalHours;

    totalForecastedKWh += energyKWh;
  }

  return totalForecastedKWh;
}

/**
 * Compute heuristic optimization strategy
 * @param {Array} indexedData - Price intervals with index and intervalOfDay
 * @param {Object} params - Battery and optimization parameters
 * @param {Object} history - Historical consumption/production data
 * @param {Object} options - Optional settings (logger, debug)
 * @returns {Object} Strategy with chargeIntervals, dischargeIntervals, etc.
 */
function computeHeuristicStrategy(indexedData, params, history, options = {}) {
  const {
    batteryCapacity,
    currentSoc,
    targetSoc,
    chargePowerKW,
    intervalHours = 0.25,
    efficiencyLoss,
    expensivePriceFactor,
    minProfitEurPerKWh,
    // Optional economics/constraints
    batteryCostEurPerKWh,
    minEnergyKWh,
  } = params;

  const logger = options.logger || {
    log: () => {},
    debug: () => {},
  };

  // Calculate basic parameters
  const energyPerInterval = chargePowerKW * intervalHours;
  const maxBatteryKWh = batteryCapacity * (targetSoc - currentSoc);
  const avgPrice = indexedData.reduce((sum, p) => sum + p.total, 0) / indexedData.length;

  const etaDischarge = 1 - efficiencyLoss;
  const safeEtaDischarge = etaDischarge > 0 ? etaDischarge : 1;

  const hasBatteryCostBasis = Number.isFinite(batteryCostEurPerKWh) && batteryCostEurPerKWh > 0;
  const effectiveMinProfitEurPerKWh = Number.isFinite(minProfitEurPerKWh) ? Math.max(0, minProfitEurPerKWh) : 0;
  const effectiveBatteryCostPerDeliveredKWh = hasBatteryCostBasis
    ? (batteryCostEurPerKWh / safeEtaDischarge) + effectiveMinProfitEurPerKWh
    : null;

  // Compute dynamic price thresholds
  const sortedPrices = indexedData.map((p) => p.total).sort((a, b) => a - b);
  const p70 = getPercentile(sortedPrices, 0.7);
  const expensiveThreshold = Math.max(avgPrice * expensivePriceFactor, p70);

  logger.debug(`Dynamic expensive threshold: ${expensiveThreshold.toFixed(4)} €/kWh (avgFactor=${expensivePriceFactor}, p70=${p70.toFixed(4)})`);

  // Step 1: Identify expensive intervals
  const expensiveIntervals = indexedData.filter((p) => p.total > expensiveThreshold);

  logger.log(`Found ${expensiveIntervals.length} expensive intervals (> ${expensiveThreshold.toFixed(4)} €/kWh)`);

  // Step 2: Calculate energy demand for each expensive interval
  const chargeAssignments = new Map();
  const dischargeNeeds = new Map();
  let totalSavings = 0;

  for (const expInterval of expensiveIntervals) {
    const demand = forecastEnergyDemand([expInterval], history, intervalHours);
    dischargeNeeds.set(expInterval.index, demand);
  }

  // Step 3: Collect all cheap intervals
  const lastExpensiveIndex = expensiveIntervals.length > 0
    ? expensiveIntervals[expensiveIntervals.length - 1].index
    : -1;
  const allCheapIntervals = indexedData.filter((p) => lastExpensiveIndex >= 0
    && p.index < lastExpensiveIndex
    && p.total <= expensiveThreshold);

  // Sort by price (cheapest first)
  allCheapIntervals.sort((a, b) => a.total - b.total);

  logger.log(`Found ${allCheapIntervals.length} cheap intervals to distribute energy from`);

  // Track assignments
  const assignedDischarges = new Set();
  let totalAssignedCharge = 0;

  // Check battery capacity
  const canChargeBattery = maxBatteryKWh > 0.01;
  const currentBatteryKWh = currentSoc * batteryCapacity;
  const configuredMinEnergyKWh = Number.isFinite(minEnergyKWh) ? Math.max(0, minEnergyKWh) : 0;
  const effectiveMinEnergyKWh = Math.min(
    Math.min(configuredMinEnergyKWh, targetSoc * batteryCapacity),
    currentBatteryKWh,
  );

  // remainingBatteryEnergyStoredKWh is energy *stored* above the min SoC threshold.
  let remainingBatteryEnergyStoredKWh = Math.max(0, currentBatteryKWh - effectiveMinEnergyKWh);

  logger.log(`Battery status: ${(currentSoc * 100).toFixed(1)}% = ${currentBatteryKWh.toFixed(2)} kWh available now`);
  if (effectiveMinEnergyKWh > 0) {
    logger.log(`   Min SoC reserve: ${effectiveMinEnergyKWh.toFixed(2)} kWh (usable now: ${(remainingBatteryEnergyStoredKWh * safeEtaDischarge).toFixed(2)} kWh delivered)`);
  }
  if (canChargeBattery) {
    logger.log(`   Can charge additional ${maxBatteryKWh.toFixed(2)} kWh (up to ${(targetSoc * 100).toFixed(1)}%)`);
  } else {
    logger.log('   Already at target SoC, will only use existing charge');
  }

  // Sort expensive intervals by price (highest first)
  const sortedExpensiveIntervals = [...expensiveIntervals].sort((a, b) => b.total - a.total);

  // Assign energy to discharges
  for (const expInterval of sortedExpensiveIntervals) {
    const demandKWh = dischargeNeeds.get(expInterval.index);
    let assignedEnergy = 0;

    // First, use existing battery charge
    if (remainingBatteryEnergyStoredKWh > 0.01) {
      // Only discharge existing energy if profitable vs cost basis (when available)
      const canUseExistingEnergy = effectiveBatteryCostPerDeliveredKWh === null
        ? true
        : (expInterval.total - effectiveBatteryCostPerDeliveredKWh) > 0;

      if (canUseExistingEnergy) {
        const maxDeliverableFromStored = remainingBatteryEnergyStoredKWh * safeEtaDischarge;
        const useFromBatteryDelivered = Math.min(demandKWh, maxDeliverableFromStored);
        const storedUsed = useFromBatteryDelivered / safeEtaDischarge;
        remainingBatteryEnergyStoredKWh -= storedUsed;
        assignedEnergy += useFromBatteryDelivered;

        // Savings from using existing energy (vs buying from grid now)
        // Only apply when we have a cost basis; otherwise keep legacy semantics
        // where savings only reflect charge/discharge arbitrage decisions.
        if (effectiveBatteryCostPerDeliveredKWh !== null) {
          totalSavings += (expInterval.total - effectiveBatteryCostPerDeliveredKWh) * useFromBatteryDelivered;
        }
      }

      if (assignedEnergy >= demandKWh - 0.01) {
        assignedDischarges.add(expInterval.index);
        continue;
      }
    }

    // If more energy needed, try to charge from cheap intervals
    if (!canChargeBattery) {
      continue;
    }

    if (totalAssignedCharge >= maxBatteryKWh - 0.01) {
      break;
    }

    for (const chargeInterval of allCheapIntervals) {
      if (chargeInterval.index >= expInterval.index) continue;

      const effectiveChargePrice = chargeInterval.total * (1 + efficiencyLoss);
      const priceDiff = expInterval.total - effectiveChargePrice;

      if (priceDiff <= minProfitEurPerKWh) {
        break;
      }

      const alreadyAssigned = chargeAssignments.get(chargeInterval.index) || 0;
      const remainingCapacity = energyPerInterval - alreadyAssigned;

      if (remainingCapacity < 0.01) continue;

      const stillNeededNow = demandKWh - assignedEnergy;
      if (stillNeededNow < 0.01) break;

      const remainingBatteryCapacity = maxBatteryKWh - totalAssignedCharge;
      if (remainingBatteryCapacity < 0.01) {
        break;
      }

      const toAssign = Math.min(remainingCapacity, stillNeededNow, remainingBatteryCapacity);
      chargeAssignments.set(chargeInterval.index, alreadyAssigned + toAssign);
      assignedEnergy += toAssign;
      totalAssignedCharge += toAssign;

      const savings = (expInterval.total - effectiveChargePrice) * toAssign;
      totalSavings += savings;

      if (assignedEnergy >= demandKWh - 0.01) break;
      if (totalAssignedCharge >= maxBatteryKWh - 0.01) break;
    }

    if (assignedEnergy >= demandKWh - 0.01) {
      assignedDischarges.add(expInterval.index);
    }
  }

  // Step 4: Build final interval lists
  const selectedChargeIntervals = indexedData.filter((p) => chargeAssignments.has(p.index));
  const selectedDischargeIntervals = expensiveIntervals
    .filter((exp) => assignedDischarges.has(exp.index))
    .map((exp) => ({ ...exp, demandKWh: dischargeNeeds.get(exp.index) }));

  const totalChargeKWh = Array.from(chargeAssignments.values()).reduce((sum, val) => sum + val, 0);
  const totalDischargeKWh = selectedDischargeIntervals
    .map((exp) => exp.demandKWh)
    .reduce((sum, val) => sum + val, 0);

  // Sort chronologically
  selectedChargeIntervals.sort((a, b) => a.index - b.index);
  selectedDischargeIntervals.sort((a, b) => a.index - b.index);

  logger.log(`Energy balance: ${totalChargeKWh.toFixed(2)} kWh charged = ${totalDischargeKWh.toFixed(2)} kWh needed`);
  logger.log(`Selected ${selectedChargeIntervals.length} charge intervals, ${selectedDischargeIntervals.length} discharge intervals`);
  logger.log(`Total estimated savings: €${totalSavings.toFixed(2)}`);

  return {
    chargeIntervals: selectedChargeIntervals,
    dischargeIntervals: selectedDischargeIntervals,
    expensiveIntervals,
    avgPrice,
    neededKWh: totalChargeKWh,
    forecastedDemand: totalDischargeKWh,
    savings: totalSavings,
    expensiveThreshold,
  };
}

/**
 * Optimize strategy using Linear Programming solver
 * @param {Array} indexedData - Price intervals with index and intervalOfDay
 * @param {Object} params - Battery and optimization parameters
 * @param {Object} history - Historical consumption/production data
 * @param {Object} options - Optional settings (lpSolver, logger)
 * @returns {Object|null} LP strategy or null if solver unavailable/failed
 */
function optimizeStrategyWithLp(indexedData, params, history, options = {}) {
  const { lpSolver, logger } = options;

  if (!lpSolver) {
    if (logger) {
      logger.log('LP solver not available, will use heuristic optimizer');
    }
    return null;
  }

  const {
    batteryCapacity,
    currentSoc,
    targetSoc,
    chargePowerKW,
    intervalHours = 0.25,
    efficiencyLoss,
    // Optional economics/constraints
    batteryCostEurPerKWh,
    minProfitEurPerKWh,
    minEnergyKWh,
  } = params;

  // Validate inputs
  if (!indexedData || !indexedData.length) {
    if (logger) logger.log('LP: No price data available');
    return null;
  }

  if (batteryCapacity <= 0 || chargePowerKW <= 0) {
    if (logger) logger.log('LP: Invalid battery parameters');
    return null;
  }

  if (currentSoc < 0 || currentSoc > 1 || targetSoc < 0 || targetSoc > 1) {
    if (logger) logger.log('LP: Invalid SoC values (must be 0-1)');
    return null;
  }

  const num = indexedData.length;

  // 1) Forecast demand per interval (kWh)
  const demandPerInterval = indexedData.map((interval) => forecastEnergyDemand([interval], history, intervalHours));

  const currentEnergyKWh = currentSoc * batteryCapacity;
  const maxEnergyKWh = targetSoc * batteryCapacity;
  const usableCapacityKWh = Math.max(0, maxEnergyKWh - currentEnergyKWh);

  if (usableCapacityKWh < 0.01 && currentEnergyKWh < 0.01) {
    if (logger) {
      logger.log('LP: No usable battery capacity (empty and no headroom), skipping LP optimization');
    }
    return null;
  }

  const energyPerInterval = chargePowerKW * intervalHours;
  const maxDischargePerInterval = energyPerInterval;

  const etaCharge = 1 - efficiencyLoss;
  const etaDischarge = 1 - efficiencyLoss;

  const safeEtaDischarge = etaDischarge > 0 ? etaDischarge : 1;

  // Battery cost basis: avg purchase price of energy currently stored in the battery.
  // discharge_t is modeled as kWh delivered to household demand (i.e. reduces grid import).
  // Delivering 1 kWh consumes (1/etaDischarge) kWh stored, so the effective cost basis per delivered kWh is:
  //   batteryCostEurPerKWh / etaDischarge
  const hasBatteryCostBasis = Number.isFinite(batteryCostEurPerKWh) && batteryCostEurPerKWh > 0;
  const effectiveMinProfitEurPerKWh = Number.isFinite(minProfitEurPerKWh) ? Math.max(0, minProfitEurPerKWh) : 0;
  const effectiveBatteryCostPerDeliveredKWh = hasBatteryCostBasis
    ? (batteryCostEurPerKWh / safeEtaDischarge) + effectiveMinProfitEurPerKWh
    : null;

  const configuredMinEnergyKWh = Number.isFinite(minEnergyKWh) ? Math.max(0, minEnergyKWh) : 0;
  const effectiveMinEnergyKWh = Math.min(
    Math.min(configuredMinEnergyKWh, maxEnergyKWh),
    currentEnergyKWh,
  );

  if (logger) {
    logger.log('\n=== LP OPTIMIZATION ===');
    logger.log(`Intervals: ${num}, Battery: ${currentEnergyKWh.toFixed(2)} kWh / ${maxEnergyKWh.toFixed(2)} kWh`);
    logger.log(`Charge/Discharge power: ${chargePowerKW} kW per interval`);
    if (effectiveMinEnergyKWh > 0) {
      logger.log(`Min energy constraint: ${effectiveMinEnergyKWh.toFixed(2)} kWh`);
    }
    if (effectiveBatteryCostPerDeliveredKWh !== null) {
      logger.log(`Battery cost basis (delivered): €${effectiveBatteryCostPerDeliveredKWh.toFixed(4)}/kWh`);
    }
  }

  // 2) Build LP model
  const model = {
    optimize: 'totalCost',
    opType: 'min',
    constraints: {},
    variables: {},
  };

  const { constraints } = model;
  const { variables } = model;

  // Baseline cost (without battery) for savings calculation
  const baselineCost = demandPerInterval.reduce(
    (sum, d, i) => sum + d * indexedData[i].total,
    0,
  );

  // 3) Variables and constraints
  for (let t = 0; t < num; t += 1) {
    const price = indexedData[t].total;
    const demand = demandPerInterval[t];

    const cVar = `c_${t}`;
    const dVar = `d_${t}`;
    const sVar = `s_${t}`;

    // Variables with cost coefficients:
    // grid_t = demand + charge_t - discharge_t
    // cost = price * grid_t = price * demand + price * charge_t - price * discharge_t
    variables[cVar] = {
      totalCost: price,
    };
    variables[dVar] = {
      // Baseline grid cost is constant (demand*price); we minimize variable cost from battery actions.
      // Without cost basis: discharge reduces grid import => coefficient = -price.
      // With cost basis: discharge also has an internal cost (battery energy purchase price + profit margin).
      // Net coefficient = (batteryCostBasisPerDeliveredKWh - price).
      totalCost: effectiveBatteryCostPerDeliveredKWh !== null
        ? (effectiveBatteryCostPerDeliveredKWh - price)
        : -price,
    };
    variables[sVar] = {
      totalCost: 0,
    };

    // Charge power: 0 <= charge_t <= energyPerInterval
    const cCapName = `cCap_${t}`;
    constraints[cCapName] = { max: energyPerInterval };
    constraints[cCapName][cVar] = 1;

    // Discharge power: 0 <= discharge_t <= maxDischargePerInterval
    const dCapName = `dCap_${t}`;
    constraints[dCapName] = { max: maxDischargePerInterval };
    constraints[dCapName][dVar] = 1;

    // SoC upper bound: soc_t <= maxEnergyKWh
    const sCapName = `sCap_${t}`;
    constraints[sCapName] = { max: maxEnergyKWh };
    constraints[sCapName][sVar] = 1;

    // SoC lower bound (min SoC threshold): soc_t >= effectiveMinEnergyKWh
    if (effectiveMinEnergyKWh > 0) {
      const sMinName = `sMin_${t}`;
      constraints[sMinName] = { min: effectiveMinEnergyKWh };
      constraints[sMinName][sVar] = 1;
    }

    // No net feed-in: grid_t = demand + charge - discharge >= 0
    // => charge_t - discharge_t >= -demand
    const gridName = `grid_${t}`;
    constraints[gridName] = { min: -demand };
    constraints[gridName][cVar] = 1;
    constraints[gridName][dVar] = -1;

    // Optional: discharge not more than demand
    const dDemandName = `demandLimit_${t}`;
    constraints[dDemandName] = { max: demand };
    constraints[dDemandName][dVar] = 1;
  }

  // 4) SoC dynamics with efficiency
  // soc_0 = currentEnergyKWh + etaCharge * charge_0 - (1/etaDischarge) * discharge_0
  {
    const c0 = 'c_0';
    const d0 = 'd_0';
    const s0 = 's_0';

    const soc0Max = 'soc0_eqMax';
    const soc0Min = 'soc0_eqMin';

    constraints[soc0Max] = { max: currentEnergyKWh };
    constraints[soc0Max][s0] = 1;
    constraints[soc0Max][c0] = -etaCharge;
    constraints[soc0Max][d0] = 1 / etaDischarge;

    constraints[soc0Min] = { min: currentEnergyKWh };
    constraints[soc0Min][s0] = 1;
    constraints[soc0Min][c0] = -etaCharge;
    constraints[soc0Min][d0] = 1 / etaDischarge;
  }

  // For t >= 1: soc_t = soc_{t-1} + etaCharge * charge_t - (1/etaDischarge) * discharge_t
  for (let t = 1; t < num; t += 1) {
    const cVar = `c_${t}`;
    const dVar = `d_${t}`;
    const sVar = `s_${t}`;
    const sPrev = `s_${t - 1}`;

    const socEqMax = `soc_${t}_eqMax`;
    const socEqMin = `soc_${t}_eqMin`;

    constraints[socEqMax] = { max: 0 };
    constraints[socEqMax][sVar] = 1;
    constraints[socEqMax][sPrev] = -1;
    constraints[socEqMax][cVar] = -etaCharge;
    constraints[socEqMax][dVar] = 1 / etaDischarge;

    constraints[socEqMin] = { min: 0 };
    constraints[socEqMin][sVar] = 1;
    constraints[socEqMin][sPrev] = -1;
    constraints[socEqMin][cVar] = -etaCharge;
    constraints[socEqMin][dVar] = 1 / etaDischarge;
  }

  // 5) Solve LP
  let result;
  try {
    result = lpSolver.Solve(model);
  } catch (error) {
    if (logger) {
      logger.log(`LP solver error, will use heuristic: ${error.message}`);
    }
    return null;
  }

  if (!result || typeof result.totalCost !== 'number' || !result.feasible) {
    if (logger) {
      logger.log('LP solver returned no valid solution, will use heuristic');
    }
    return null;
  }

  // 6) Interpret solution
  const chargeIntervals = [];
  const dischargeIntervals = [];
  let totalChargeKWh = 0;
  let totalDischargeKWh = 0;

  const EPS = 0.01;

  for (let t = 0; t < num; t += 1) {
    const cVar = `c_${t}`;
    const dVar = `d_${t}`;
    const charge = result[cVar] || 0;
    const discharge = result[dVar] || 0;

    if (charge > EPS) {
      totalChargeKWh += charge;
      const chargeInterval = { ...indexedData[t], plannedEnergyKWh: charge };
      chargeIntervals.push(chargeInterval);
    }

    if (discharge > EPS) {
      totalDischargeKWh += discharge;
      const dischargeInterval = { ...indexedData[t], demandKWh: discharge };
      dischargeIntervals.push(dischargeInterval);
    }
  }

  // Variable costs from LP: price * (charge - discharge)
  const optimizedVariableCost = result.totalCost || 0;
  // Total costs: baseline (demand * price) + variable (charge - discharge)
  const optimizedTotalCost = baselineCost + optimizedVariableCost;
  const savings = Math.max(0, baselineCost - optimizedTotalCost);

  if (logger) {
    logger.log(`LP: baseline cost = €${baselineCost.toFixed(2)}, optimized = €${optimizedTotalCost.toFixed(2)}, savings = €${savings.toFixed(2)}`);
    logger.log(`LP: totalCharge = ${totalChargeKWh.toFixed(2)} kWh, totalDischarge = ${totalDischargeKWh.toFixed(2)} kWh`);
    logger.log('======================\n');
  }

  return {
    chargeIntervals,
    dischargeIntervals,
    totalChargeKWh,
    totalDischargeKWh,
    savings,
  };
}

module.exports = {
  computeHeuristicStrategy,
  optimizeStrategyWithLp,
  forecastEnergyDemand,
  getPercentile,
};
