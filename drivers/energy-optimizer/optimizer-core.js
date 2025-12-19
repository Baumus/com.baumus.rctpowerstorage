'use strict';

const SOLAR_FEED_IN_TARIFF_EUR_PER_KWH = 0.07;

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

function averageWattsForInterval(historyByIntervalOfDay, intervalOfDay) {
  if (!historyByIntervalOfDay || typeof historyByIntervalOfDay !== 'object') {
    return null;
  }
  const arr = historyByIntervalOfDay[intervalOfDay];
  if (!Array.isArray(arr) || arr.length === 0) {
    return null;
  }
  const sum = arr.reduce((s, v) => s + v, 0);
  return sum / arr.length;
}

/**
 * Forecast physically-correct per-interval signals from history:
 * - houseLoadKWh_t >= 0
 * - solarKWh_t >= 0
 * Derived:
 * - importDemandKWh_t = max(0, houseLoadKWh_t - solarKWh_t)
 * - solarSurplusKWh_t = max(0, solarKWh_t - houseLoadKWh_t)
 *
 * We reconstruct house load using instantaneous power balance:
 *   houseLoadW = gridNetW + solarW - batteryW
 *
 * Where:
 * - gridNetW: signed net power at grid connection (+import, -export)
 * - solarW: PV production power (>= 0)
 * - batteryW: battery power (+charging, -discharging)
 */
function forecastHouseSignalsPerInterval(intervals, history, intervalHours = 0.25) {
  if (!intervals || intervals.length === 0) {
    return {
      houseLoadKWh: [],
      solarKWh: [],
      importDemandKWh: [],
      solarSurplusKWh: [],
    };
  }

  const safeHistory = (history && typeof history === 'object') ? history : {};
  const gridNetHistory = (safeHistory.consumptionHistory && typeof safeHistory.consumptionHistory === 'object')
    ? safeHistory.consumptionHistory
    : {};
  const solarHistory = (safeHistory.productionHistory && typeof safeHistory.productionHistory === 'object')
    ? safeHistory.productionHistory
    : {};
  const batteryHistory = (safeHistory.batteryHistory && typeof safeHistory.batteryHistory === 'object')
    ? safeHistory.batteryHistory
    : {};

  const houseLoadKWh = [];
  const solarKWh = [];
  const importDemandKWh = [];
  const solarSurplusKWh = [];

  for (const interval of intervals) {
    const { intervalOfDay } = interval;

    // If we cannot map the interval, assume 3kW load, 0 solar.
    if (intervalOfDay === undefined || intervalOfDay === null) {
      const load = 3.0 * intervalHours;
      houseLoadKWh.push(load);
      solarKWh.push(0);
      importDemandKWh.push(load);
      solarSurplusKWh.push(0);
      continue;
    }

    const avgGridW = averageWattsForInterval(gridNetHistory, intervalOfDay);
    const avgSolarW = averageWattsForInterval(solarHistory, intervalOfDay);
    const avgBatteryW = averageWattsForInterval(batteryHistory, intervalOfDay);

    const gridKW = (typeof avgGridW === 'number' && Number.isFinite(avgGridW)) ? (avgGridW / 1000) : 3.0;
    const pvKW = (typeof avgSolarW === 'number' && Number.isFinite(avgSolarW)) ? Math.max(0, avgSolarW / 1000) : 0;
    const batteryKW = (typeof avgBatteryW === 'number' && Number.isFinite(avgBatteryW)) ? (avgBatteryW / 1000) : 0;

    const loadKW = Math.max(0, gridKW + pvKW - batteryKW);

    const loadKWh = loadKW * intervalHours;
    const pvKWh = pvKW * intervalHours;

    const importKWh = Math.max(0, loadKWh - pvKWh);
    const surplusKWh = Math.max(0, pvKWh - loadKWh);

    houseLoadKWh.push(loadKWh);
    solarKWh.push(pvKWh);
    importDemandKWh.push(importKWh);
    solarSurplusKWh.push(surplusKWh);
  }

  return {
    houseLoadKWh,
    solarKWh,
    importDemandKWh,
    solarSurplusKWh,
  };
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

  // Compute dynamic price thresholds
  const sortedPrices = indexedData.map((p) => p.total).sort((a, b) => a - b);
  const p70 = getPercentile(sortedPrices, 0.7);
  const expensiveThreshold = Math.max(avgPrice * expensivePriceFactor, p70);

  logger.debug(`Dynamic expensive threshold: ${expensiveThreshold.toFixed(4)} €/kWh (avgFactor=${expensivePriceFactor}, p70=${p70.toFixed(4)})`);

  const {
    importDemandKWh: importDemandKWhPerInterval,
    solarSurplusKWh: solarSurplusKWhPerInterval,
  } = forecastHouseSignalsPerInterval(indexedData, history, intervalHours);

  // NOTE: indexedData[].index is not guaranteed to be a dense 0..N-1 range in tests.
  // Forecast arrays are aligned to the *array position*.
  const indexToPos = new Map(indexedData.map((p, pos) => [p.index, pos]));

  // Baseline net cost (no battery): pay import at spot price and earn export at feed-in tariff.
  const baselineCost = importDemandKWhPerInterval.reduce(
    (sum, d, i) => sum + d * indexedData[i].total,
    0,
  ) - solarSurplusKWhPerInterval.reduce(
    (sum, s) => sum + s * SOLAR_FEED_IN_TARIFF_EUR_PER_KWH,
    0,
  );

  // Step 1: Identify expensive intervals
  const expensiveIntervals = indexedData.filter((p) => p.total > expensiveThreshold);

  logger.log(`Found ${expensiveIntervals.length} expensive intervals (> ${expensiveThreshold.toFixed(4)} €/kWh)`);

  // Step 2: Calculate import demand (kWh) for each expensive interval (never discharge into export)
  const chargeAssignments = new Map();
  const chargeAssignmentsGrid = new Map();
  const chargeAssignmentsSolar = new Map();
  const dischargeNeeds = new Map();

  // Track economic cost deltas vs baseline.
  let deltaCost = 0;

  // Battery cost basis (stored) only applies when using existing energy.
  const costBasisPerDeliveredKWh = hasBatteryCostBasis ? (batteryCostEurPerKWh / safeEtaDischarge) : null;

  for (const expInterval of expensiveIntervals) {
    const pos = indexToPos.get(expInterval.index);
    const demand = (pos !== undefined ? importDemandKWhPerInterval[pos] : 0) || 0;
    dischargeNeeds.set(expInterval.index, demand);
  }

  // Step 3: Collect all cheap intervals (grid) and solar surplus intervals (treated as cheap via opportunity cost)
  const lastExpensiveIndex = expensiveIntervals.length > 0
    ? expensiveIntervals[expensiveIntervals.length - 1].index
    : -1;

  const allCheapIntervals = indexedData
    .filter((p) => lastExpensiveIndex >= 0 && p.index < lastExpensiveIndex)
    .map((p) => {
      const pos = indexToPos.get(p.index);
      const solarSurplusKWh = (pos !== undefined ? solarSurplusKWhPerInterval[pos] : 0) || 0;
      const hasSolarSurplus = solarSurplusKWh > 0.01;

      if (hasSolarSurplus) {
        // Treat solar surplus as a "charge source" with effective price = feed-in tariff.
        return {
          ...p,
          _chargeSource: 'solar',
          _effectiveChargePrice: SOLAR_FEED_IN_TARIFF_EUR_PER_KWH,
          _maxChargeKWh: Math.min(energyPerInterval, solarSurplusKWh),
        };
      }

      // Grid charging candidate only if below expensive threshold.
      if (p.total <= expensiveThreshold) {
        return {
          ...p,
          _chargeSource: 'grid',
          _effectiveChargePrice: p.total,
          _maxChargeKWh: energyPerInterval,
        };
      }

      return null;
    })
    .filter(Boolean);

  // Sort by effective charge price (cheapest first)
  allCheapIntervals.sort((a, b) => a._effectiveChargePrice - b._effectiveChargePrice);

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
    if (!Number.isFinite(demandKWh) || demandKWh < 0.01) {
      continue;
    }
    let assignedEnergy = 0;

    // First, use existing battery charge
    if (remainingBatteryEnergyStoredKWh > 0.01) {
      // Only discharge existing energy if profitable vs cost basis (when available)
      const canUseExistingEnergy = costBasisPerDeliveredKWh === null
        ? true
        : (expInterval.total - (costBasisPerDeliveredKWh + effectiveMinProfitEurPerKWh)) > 0;

      if (canUseExistingEnergy) {
        const maxDeliverableFromStored = remainingBatteryEnergyStoredKWh * safeEtaDischarge;
        const useFromBatteryDelivered = Math.min(demandKWh, maxDeliverableFromStored);
        const storedUsed = useFromBatteryDelivered / safeEtaDischarge;
        remainingBatteryEnergyStoredKWh -= storedUsed;
        assignedEnergy += useFromBatteryDelivered;

        // Savings from using existing energy (vs buying from grid now)
        // Only apply when we have a cost basis; otherwise keep legacy semantics
        // where savings only reflect charge/discharge arbitrage decisions.
        if (costBasisPerDeliveredKWh !== null) {
          // Economic savings from using existing energy now:
          // avoided import at exp price minus cost basis and profit margin per delivered kWh.
          const perKWhSavings = expInterval.total - (costBasisPerDeliveredKWh + effectiveMinProfitEurPerKWh);
          // In cost terms, this is a reduction of baseline cost.
          deltaCost -= perKWhSavings * useFromBatteryDelivered;
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

      const effectiveChargePrice = chargeInterval._effectiveChargePrice * (1 + efficiencyLoss);
      const priceDiff = expInterval.total - effectiveChargePrice;

      if (priceDiff <= minProfitEurPerKWh) {
        break;
      }

      const alreadyAssigned = chargeAssignments.get(chargeInterval.index) || 0;
      const remainingCapacity = chargeInterval._maxChargeKWh - alreadyAssigned;

      if (remainingCapacity < 0.01) continue;

      const stillNeededNow = demandKWh - assignedEnergy;
      if (stillNeededNow < 0.01) break;

      const remainingBatteryCapacity = maxBatteryKWh - totalAssignedCharge;
      if (remainingBatteryCapacity < 0.01) {
        break;
      }

      const toAssign = Math.min(remainingCapacity, stillNeededNow, remainingBatteryCapacity);
      chargeAssignments.set(chargeInterval.index, alreadyAssigned + toAssign);

      if (chargeInterval._chargeSource === 'solar') {
        chargeAssignmentsSolar.set(chargeInterval.index, (chargeAssignmentsSolar.get(chargeInterval.index) || 0) + toAssign);
        // Solar charge opportunity cost (lost feed-in revenue)
        deltaCost += SOLAR_FEED_IN_TARIFF_EUR_PER_KWH * toAssign;
      } else {
        chargeAssignmentsGrid.set(chargeInterval.index, (chargeAssignmentsGrid.get(chargeInterval.index) || 0) + toAssign);
        // Grid charge cost
        deltaCost += chargeInterval.total * toAssign;
      }

      // Discharge avoids import at expensive price
      deltaCost -= expInterval.total * toAssign;

      // Profit margin requirement (modeled as extra cost when discharging)
      deltaCost += effectiveMinProfitEurPerKWh * toAssign;

      assignedEnergy += toAssign;
      totalAssignedCharge += toAssign;

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
  // Economic savings vs baseline, including solar feed-in opportunity cost.
  // We compute from deltaCost so it stays meaningful even when there are no explicit charge intervals.
  const optimizedCost = baselineCost + deltaCost;
  const economicSavings = Math.max(0, baselineCost - optimizedCost);

  logger.log(`Total estimated savings: €${economicSavings.toFixed(2)}`);

  return {
    chargeIntervals: selectedChargeIntervals,
    dischargeIntervals: selectedDischargeIntervals,
    expensiveIntervals,
    avgPrice,
    neededKWh: totalChargeKWh,
    forecastedDemand: totalDischargeKWh,
    savings: economicSavings,
    economics: {
      baselineCost,
      optimizedCost,
      savings: economicSavings,
      totalGridChargeKWh: Array.from(chargeAssignmentsGrid.values()).reduce((sum, val) => sum + val, 0),
      totalSolarChargeKWh: Array.from(chargeAssignmentsSolar.values()).reduce((sum, val) => sum + val, 0),
    },
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

  const {
    importDemandKWh: importDemandKWhPerInterval,
    solarSurplusKWh: solarSurplusKWhPerInterval,
  } = forecastHouseSignalsPerInterval(indexedData, history, intervalHours);

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

  // Battery cost basis applies to energy that is already stored at optimization start.
  // We model discharge split into:
  // - d0_t: discharge delivered from existing energy (pays cost basis)
  // - d1_t: discharge delivered from newly charged energy (pays charge cost at charge-time)
  const hasBatteryCostBasis = Number.isFinite(batteryCostEurPerKWh) && batteryCostEurPerKWh > 0;
  const effectiveMinProfitEurPerKWh = Number.isFinite(minProfitEurPerKWh) ? Math.max(0, minProfitEurPerKWh) : 0;
  const effectiveBatteryCostPerDeliveredKWh = hasBatteryCostBasis
    ? (batteryCostEurPerKWh / safeEtaDischarge)
    : 0;

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
    if (hasBatteryCostBasis) {
      logger.log(`Battery cost basis (stored): €${batteryCostEurPerKWh.toFixed(4)}/kWh (delivered: €${effectiveBatteryCostPerDeliveredKWh.toFixed(4)}/kWh)`);
    }
    logger.log(`Solar feed-in opportunity cost: €${SOLAR_FEED_IN_TARIFF_EUR_PER_KWH.toFixed(3)}/kWh`);
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

  // Baseline net cost (without using the battery):
  // - pay import at dynamic spot price
  // - earn export revenue for solar surplus at a fixed feed-in tariff
  const baselineCost = importDemandKWhPerInterval.reduce(
    (sum, d, i) => sum + d * indexedData[i].total,
    0,
  ) - solarSurplusKWhPerInterval.reduce(
    (sum, s) => sum + s * SOLAR_FEED_IN_TARIFF_EUR_PER_KWH,
    0,
  );

  // 3) Variables and constraints
  for (let t = 0; t < num; t += 1) {
    const price = indexedData[t].total;
    const importDemand = importDemandKWhPerInterval[t];
    const solarSurplus = solarSurplusKWhPerInterval[t];

    const cVar = `c_${t}`;
    const scVar = `sc_${t}`;
    const d0Var = `d0_${t}`;
    const d1Var = `d1_${t}`;
    const sVar = `s_${t}`;
    const eVar = `e_${t}`;

    // Variables with cost coefficients:
    // - c_t: grid energy used for charging (kWh)
    // - sc_t: solar surplus used for charging (kWh) => opportunity cost is lost feed-in revenue
    // - d0_t: discharge delivered from existing battery energy (kWh delivered)
    // - d1_t: discharge delivered from newly charged energy (kWh delivered)
    // Net cost effects vs baseline:
    // - Charging from grid increases import cost: +price * c_t
    // - Charging from solar reduces export revenue: +feedIn * sc_t
    // - Discharging reduces import: -price * (d0_t + d1_t)
    // Additional economics:
    // - Existing energy has cost basis per delivered kWh: +(batteryCost/etaDischarge) * d0_t
    // - Apply minimum profit margin as an additional cost per delivered kWh: +minProfit * (d0_t + d1_t)
    variables[cVar] = {
      totalCost: price,
    };
    variables[scVar] = {
      totalCost: SOLAR_FEED_IN_TARIFF_EUR_PER_KWH,
    };
    variables[d0Var] = {
      totalCost: (-price) + effectiveMinProfitEurPerKWh + (hasBatteryCostBasis ? effectiveBatteryCostPerDeliveredKWh : 0),
    };
    variables[d1Var] = {
      totalCost: (-price) + effectiveMinProfitEurPerKWh,
    };
    variables[sVar] = {
      totalCost: 0,
    };
    variables[eVar] = {
      totalCost: 0,
    };

    // Charge power: 0 <= c_t + sc_t <= energyPerInterval
    const cCapName = `cCap_${t}`;
    constraints[cCapName] = { max: energyPerInterval };
    constraints[cCapName][cVar] = 1;
    constraints[cCapName][scVar] = 1;

    // Solar surplus availability: 0 <= sc_t <= solarSurplus
    const scCapName = `scCap_${t}`;
    constraints[scCapName] = { max: solarSurplus };
    constraints[scCapName][scVar] = 1;

    // Discharge power: 0 <= d0_t + d1_t <= maxDischargePerInterval
    const dCapName = `dCap_${t}`;
    constraints[dCapName] = { max: maxDischargePerInterval };
    constraints[dCapName][d0Var] = 1;
    constraints[dCapName][d1Var] = 1;

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

    // Discharge not more than import demand (never export while discharging)
    const dDemandName = `demandLimit_${t}`;
    constraints[dDemandName] = { max: importDemand };
    constraints[dDemandName][d0Var] = 1;
    constraints[dDemandName][d1Var] = 1;

    // Existing-energy state bounds
    const eCapName = `eCap_${t}`;
    constraints[eCapName] = { max: currentEnergyKWh };
    constraints[eCapName][eVar] = 1;

    const eNonNegName = `eNonNeg_${t}`;
    constraints[eNonNegName] = { min: 0 };
    constraints[eNonNegName][eVar] = 1;

    // Ensure existing-energy portion is never larger than total SoC:
    // e_t <= s_t  =>  s_t - e_t >= 0
    const eLeSocName = `eLeSoc_${t}`;
    constraints[eLeSocName] = { min: 0 };
    constraints[eLeSocName][sVar] = 1;
    constraints[eLeSocName][eVar] = -1;
  }

  // 4) SoC dynamics with efficiency
  // soc_0 = currentEnergyKWh + etaCharge * (c_0 + sc_0) - (1/etaDischarge) * (d0_0 + d1_0)
  // existing_0 = currentEnergyKWh - (1/etaDischarge) * d0_0
  {
    const c0 = 'c_0';
    const sc0 = 'sc_0';
    const d00 = 'd0_0';
    const d10 = 'd1_0';
    const s0 = 's_0';
    const e0 = 'e_0';

    const soc0Max = 'soc0_eqMax';
    const soc0Min = 'soc0_eqMin';

    constraints[soc0Max] = { max: currentEnergyKWh };
    constraints[soc0Max][s0] = 1;
    constraints[soc0Max][c0] = -etaCharge;
    constraints[soc0Max][sc0] = -etaCharge;
    constraints[soc0Max][d00] = 1 / etaDischarge;
    constraints[soc0Max][d10] = 1 / etaDischarge;

    constraints[soc0Min] = { min: currentEnergyKWh };
    constraints[soc0Min][s0] = 1;
    constraints[soc0Min][c0] = -etaCharge;
    constraints[soc0Min][sc0] = -etaCharge;
    constraints[soc0Min][d00] = 1 / etaDischarge;
    constraints[soc0Min][d10] = 1 / etaDischarge;

    const e0EqMax = 'e0_eqMax';
    const e0EqMin = 'e0_eqMin';

    constraints[e0EqMax] = { max: currentEnergyKWh };
    constraints[e0EqMax][e0] = 1;
    constraints[e0EqMax][d00] = 1 / etaDischarge;

    constraints[e0EqMin] = { min: currentEnergyKWh };
    constraints[e0EqMin][e0] = 1;
    constraints[e0EqMin][d00] = 1 / etaDischarge;
  }

  // For t >= 1:
  // soc_t = soc_{t-1} + etaCharge * (c_t + sc_t) - (1/etaDischarge) * (d0_t + d1_t)
  // existing_t = existing_{t-1} - (1/etaDischarge) * d0_t
  for (let t = 1; t < num; t += 1) {
    const cVar = `c_${t}`;
    const scVar = `sc_${t}`;
    const d0Var = `d0_${t}`;
    const d1Var = `d1_${t}`;
    const sVar = `s_${t}`;
    const sPrev = `s_${t - 1}`;

    const eVar = `e_${t}`;
    const ePrev = `e_${t - 1}`;

    const socEqMax = `soc_${t}_eqMax`;
    const socEqMin = `soc_${t}_eqMin`;

    constraints[socEqMax] = { max: 0 };
    constraints[socEqMax][sVar] = 1;
    constraints[socEqMax][sPrev] = -1;
    constraints[socEqMax][cVar] = -etaCharge;
    constraints[socEqMax][scVar] = -etaCharge;
    constraints[socEqMax][d0Var] = 1 / etaDischarge;
    constraints[socEqMax][d1Var] = 1 / etaDischarge;

    constraints[socEqMin] = { min: 0 };
    constraints[socEqMin][sVar] = 1;
    constraints[socEqMin][sPrev] = -1;
    constraints[socEqMin][cVar] = -etaCharge;
    constraints[socEqMin][scVar] = -etaCharge;
    constraints[socEqMin][d0Var] = 1 / etaDischarge;
    constraints[socEqMin][d1Var] = 1 / etaDischarge;

    const eEqMax = `e_${t}_eqMax`;
    const eEqMin = `e_${t}_eqMin`;

    constraints[eEqMax] = { max: 0 };
    constraints[eEqMax][eVar] = 1;
    constraints[eEqMax][ePrev] = -1;
    constraints[eEqMax][d0Var] = 1 / etaDischarge;

    constraints[eEqMin] = { min: 0 };
    constraints[eEqMin][eVar] = 1;
    constraints[eEqMin][ePrev] = -1;
    constraints[eEqMin][d0Var] = 1 / etaDischarge;
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
  let totalSolarChargeKWh = 0;
  let totalGridChargeKWh = 0;

  const EPS = 0.01;

  for (let t = 0; t < num; t += 1) {
    const cVar = `c_${t}`;
    const scVar = `sc_${t}`;
    const d0Var = `d0_${t}`;
    const d1Var = `d1_${t}`;
    const charge = result[cVar] || 0;
    const solarCharge = result[scVar] || 0;
    const discharge0 = result[d0Var] || 0;
    const discharge1 = result[d1Var] || 0;
    const discharge = discharge0 + discharge1;

    const totalIntervalCharge = charge + solarCharge;
    if (totalIntervalCharge > EPS) {
      totalChargeKWh += totalIntervalCharge;
      totalGridChargeKWh += charge;
      totalSolarChargeKWh += solarCharge;
      const chargeInterval = {
        ...indexedData[t],
        plannedEnergyKWh: totalIntervalCharge,
        plannedGridEnergyKWh: charge,
        plannedSolarEnergyKWh: solarCharge,
      };
      chargeIntervals.push(chargeInterval);
    }

    if (discharge > EPS) {
      totalDischargeKWh += discharge;
      const dischargeInterval = {
        ...indexedData[t],
        demandKWh: discharge,
        demandKWhFromExisting: discharge0,
        demandKWhFromNew: discharge1,
      };
      dischargeIntervals.push(dischargeInterval);
    }
  }

  const optimizedVariableCost = result.totalCost || 0;
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
    totalGridChargeKWh,
    totalSolarChargeKWh,
    economics: {
      baselineCost,
      optimizedCost: optimizedTotalCost,
      savings,
    },
    savings,
  };
}

module.exports = {
  computeHeuristicStrategy,
  optimizeStrategyWithLp,
  forecastHouseSignalsPerInterval,
  getPercentile,
};
