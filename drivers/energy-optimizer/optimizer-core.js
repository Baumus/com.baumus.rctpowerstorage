'use strict';

const { SOLAR_FEED_IN_TARIFF_EUR_PER_KWH } = require('./constants');

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
      logger.log('LP solver not available');
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
    variables[cVar][cCapName] = 1;
    variables[scVar][cCapName] = 1;

    // Solar surplus availability: 0 <= sc_t <= solarSurplus
    const scCapName = `scCap_${t}`;
    constraints[scCapName] = { max: solarSurplus };
    variables[scVar][scCapName] = 1;

    // Discharge power: 0 <= d0_t + d1_t <= maxDischargePerInterval
    const dCapName = `dCap_${t}`;
    constraints[dCapName] = { max: maxDischargePerInterval };
    variables[d0Var][dCapName] = 1;
    variables[d1Var][dCapName] = 1;

    // SoC upper bound: soc_t <= maxEnergyKWh
    const sCapName = `sCap_${t}`;
    constraints[sCapName] = { max: maxEnergyKWh };
    variables[sVar][sCapName] = 1;

    // SoC lower bound (min SoC threshold): soc_t >= effectiveMinEnergyKWh
    if (effectiveMinEnergyKWh > 0) {
      const sMinName = `sMin_${t}`;
      constraints[sMinName] = { min: effectiveMinEnergyKWh };
      variables[sVar][sMinName] = 1;
    }

    // Discharge not more than import demand (never export while discharging)
    const dDemandName = `demandLimit_${t}`;
    constraints[dDemandName] = { max: importDemand };
    variables[d0Var][dDemandName] = 1;
    variables[d1Var][dDemandName] = 1;

    // Existing-energy state bounds
    const eCapName = `eCap_${t}`;
    constraints[eCapName] = { max: currentEnergyKWh };
    variables[eVar][eCapName] = 1;

    const eNonNegName = `eNonNeg_${t}`;
    constraints[eNonNegName] = { min: 0 };
    variables[eVar][eNonNegName] = 1;

    // Ensure existing-energy portion is never larger than total SoC:
    // e_t <= s_t  =>  s_t - e_t >= 0
    const eLeSocName = `eLeSoc_${t}`;
    constraints[eLeSocName] = { min: 0 };
    variables[sVar][eLeSocName] = 1;
    variables[eVar][eLeSocName] = -1;
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
    variables[s0][soc0Max] = 1;
    variables[c0][soc0Max] = -etaCharge;
    variables[sc0][soc0Max] = -etaCharge;
    variables[d00][soc0Max] = 1 / etaDischarge;
    variables[d10][soc0Max] = 1 / etaDischarge;

    constraints[soc0Min] = { min: currentEnergyKWh };
    variables[s0][soc0Min] = 1;
    variables[c0][soc0Min] = -etaCharge;
    variables[sc0][soc0Min] = -etaCharge;
    variables[d00][soc0Min] = 1 / etaDischarge;
    variables[d10][soc0Min] = 1 / etaDischarge;

    const e0EqMax = 'e0_eqMax';
    const e0EqMin = 'e0_eqMin';

    constraints[e0EqMax] = { max: currentEnergyKWh };
    variables[e0][e0EqMax] = 1;
    variables[d00][e0EqMax] = 1 / etaDischarge;

    constraints[e0EqMin] = { min: currentEnergyKWh };
    variables[e0][e0EqMin] = 1;
    variables[d00][e0EqMin] = 1 / etaDischarge;
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
    variables[sVar][socEqMax] = 1;
    variables[sPrev][socEqMax] = -1;
    variables[cVar][socEqMax] = -etaCharge;
    variables[scVar][socEqMax] = -etaCharge;
    variables[d0Var][socEqMax] = 1 / etaDischarge;
    variables[d1Var][socEqMax] = 1 / etaDischarge;

    constraints[socEqMin] = { min: 0 };
    variables[sVar][socEqMin] = 1;
    variables[sPrev][socEqMin] = -1;
    variables[cVar][socEqMin] = -etaCharge;
    variables[scVar][socEqMin] = -etaCharge;
    variables[d0Var][socEqMin] = 1 / etaDischarge;
    variables[d1Var][socEqMin] = 1 / etaDischarge;

    const eEqMax = `e_${t}_eqMax`;
    const eEqMin = `e_${t}_eqMin`;

    constraints[eEqMax] = { max: 0 };
    variables[eVar][eEqMax] = 1;
    variables[ePrev][eEqMax] = -1;
    variables[d0Var][eEqMax] = 1 / etaDischarge;

    constraints[eEqMin] = { min: 0 };
    variables[eVar][eEqMin] = 1;
    variables[ePrev][eEqMin] = -1;
    variables[d0Var][eEqMin] = 1 / etaDischarge;
  }

  // 5) Solve LP
  let result;
  try {
    result = lpSolver.Solve(model);
  } catch (error) {
    if (logger) {
      logger.log(`LP solver error: ${error.message}`);
    }
    return null;
  }

  // javascript-lp-solver typically returns the objective as `result.result`.
  // Older wrappers/tests may use `result.totalCost`.
  let objectiveValue = null;
  if (result && Number.isFinite(result.totalCost)) {
    objectiveValue = result.totalCost;
  } else if (result && Number.isFinite(result.result)) {
    objectiveValue = result.result;
  }

  if (!result || objectiveValue === null || !result.feasible) {
    if (logger) {
      logger.log('LP solver returned no valid solution');
    }
    return null;
  }

  // 6) Interpret solution
  const chargeIntervals = [];
  const chargeDisplayEntries = [];
  const dischargeIntervals = [];
  let totalChargeKWh = 0;
  let totalDischargeKWh = 0;
  let totalSolarChargeKWh = 0;
  let totalGridChargeKWh = 0;
  let totalSolarChargeCostEur = 0;
  let totalGridChargeCostEur = 0;

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

      const plannedChargeParts = [];

      if (charge > EPS) {
        const gridCostEur = charge * indexedData[t].total;
        totalGridChargeCostEur += gridCostEur;
        plannedChargeParts.push({
          source: 'grid',
          symbol: '⚡',
          energyKWh: charge,
          priceEurPerKWh: indexedData[t].total,
          costEur: gridCostEur,
        });
        chargeDisplayEntries.push({
          ...indexedData[t],
          plannedEnergySource: 'grid',
          plannedSymbol: '⚡',
          plannedEnergyKWh: charge,
          plannedPriceEurPerKWh: indexedData[t].total,
          plannedCostEur: gridCostEur,
        });
      }

      if (solarCharge > EPS) {
        const solarCostEur = solarCharge * SOLAR_FEED_IN_TARIFF_EUR_PER_KWH;
        totalSolarChargeCostEur += solarCostEur;
        plannedChargeParts.push({
          source: 'solar',
          symbol: '☀',
          energyKWh: solarCharge,
          priceEurPerKWh: SOLAR_FEED_IN_TARIFF_EUR_PER_KWH,
          costEur: solarCostEur,
        });
        chargeDisplayEntries.push({
          ...indexedData[t],
          plannedEnergySource: 'solar',
          plannedSymbol: '☀',
          plannedEnergyKWh: solarCharge,
          plannedPriceEurPerKWh: SOLAR_FEED_IN_TARIFF_EUR_PER_KWH,
          plannedCostEur: solarCostEur,
        });
      }

      const chargeInterval = {
        ...indexedData[t],
        plannedEnergyKWh: totalIntervalCharge,
        plannedGridEnergyKWh: charge,
        plannedSolarEnergyKWh: solarCharge,
        plannedChargeParts,
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

  const optimizedVariableCost = objectiveValue;
  const optimizedTotalCost = baselineCost + optimizedVariableCost;
  const savings = Math.max(0, baselineCost - optimizedTotalCost);

  const totalChargeCostEur = totalGridChargeCostEur + totalSolarChargeCostEur;
  const avgChargePriceEurPerKWh = totalChargeKWh > 0 ? (totalChargeCostEur / totalChargeKWh) : 0;
  const plannedCharging = {
    totalEnergyKWh: totalChargeKWh,
    totalCostEur: totalChargeCostEur,
    avgPriceEurPerKWh: avgChargePriceEurPerKWh,
    gridEnergyKWh: totalGridChargeKWh,
    solarEnergyKWh: totalSolarChargeKWh,
    gridCostEur: totalGridChargeCostEur,
    solarCostEur: totalSolarChargeCostEur,
    solarTariffEurPerKWh: SOLAR_FEED_IN_TARIFF_EUR_PER_KWH,
  };

  if (logger) {
    logger.log(`LP: baseline cost = €${baselineCost.toFixed(2)}, optimized = €${optimizedTotalCost.toFixed(2)}, savings = €${savings.toFixed(2)}`);
    logger.log(`LP: totalCharge = ${totalChargeKWh.toFixed(2)} kWh, totalDischarge = ${totalDischargeKWh.toFixed(2)} kWh`);
    logger.log('======================\n');
  }

  return {
    chargeIntervals,
    chargeDisplayEntries,
    dischargeIntervals,
    totalChargeKWh,
    totalDischargeKWh,
    totalGridChargeKWh,
    totalSolarChargeKWh,
    plannedCharging,
    economics: {
      baselineCost,
      optimizedCost: optimizedTotalCost,
      savings,
    },
    savings,
  };
}

module.exports = {
  optimizeStrategyWithLp,
  forecastHouseSignalsPerInterval,
  getPercentile,
};
