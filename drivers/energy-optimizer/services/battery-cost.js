'use strict';

/**
 * Battery cost helpers that depend on host state (`priceCache`, `currentStrategy`, logging).
 * Host-based service module: operates on the EnergyOptimizerDevice instance.
 */

/**
 * Estimate battery energy cost when charge log is unavailable.
 * Mirrors the previous `EnergyOptimizerDevice.estimateBatteryEnergyCost()` behavior.
 */
function estimateBatteryEnergyCost(host, currentSoc, batteryCapacity) {
  try {
    // Calculate actual energy stored in battery
    const totalKWh = currentSoc * batteryCapacity;

    if (totalKWh < 0.01) {
      return null;
    }

    // Determine default price for unknown energy source
    let estimatedPrice = 0.20; // Fallback: typical German electricity price

    // Option 1: Use average price from planned charge intervals (best estimate)
    if (host.currentStrategy?.chargeIntervals && host.currentStrategy.chargeIntervals.length > 0) {
      const sum = host.currentStrategy.chargeIntervals.reduce((acc, interval) => acc + (interval.total || 0), 0);
      estimatedPrice = sum / host.currentStrategy.chargeIntervals.length;
      host.log(`   Using avg planned charge price as estimate: ${estimatedPrice.toFixed(4)} €/kWh`);

    // Option 2: Use average of recent price data
    } else if (host.priceCache && host.priceCache.length > 0) {
      const recentPrices = host.priceCache.slice(0, Math.min(96, host.priceCache.length)); // Last 24h
      const sum = recentPrices.reduce((acc, p) => acc + (p.total || 0), 0);
      estimatedPrice = sum / recentPrices.length;
      host.log(`   Using avg recent price as estimate: ${estimatedPrice.toFixed(4)} €/kWh`);
    } else {
      host.log(`   Using fallback price as estimate: ${estimatedPrice.toFixed(4)} €/kWh`);
    }

    // Assume unknown source (could be mix of grid and solar, but we don't know)
    // Conservative approach: assume mostly grid with some solar
    const estimatedGridPercent = 70; // Conservative estimate
    const estimatedSolarPercent = 30; // Optimistic solar contribution

    const gridKWh = totalKWh * (estimatedGridPercent / 100);
    const solarKWh = totalKWh * (estimatedSolarPercent / 100);
    const totalCost = gridKWh * estimatedPrice;
    const weightedAvgPrice = totalCost / totalKWh;

    host.log('   📊 Estimated battery cost (source unknown):');
    host.log(`      Total: ${totalKWh.toFixed(2)} kWh @ ${weightedAvgPrice.toFixed(4)} €/kWh (estimated)`);
    host.log(`      Assumed: ${gridKWh.toFixed(2)} kWh grid (${estimatedGridPercent}%) + ${solarKWh.toFixed(2)} kWh solar (${estimatedSolarPercent}%)`);

    return {
      avgPrice: weightedAvgPrice,
      totalKWh,
      solarKWh,
      gridKWh,
      solarPercent: estimatedSolarPercent,
      gridPercent: estimatedGridPercent,
      totalCost,
      gridOnlyAvgPrice: estimatedPrice,
      unknownAvgPrice: estimatedPrice,
      trackedKWh: 0,
      unknownKWh: totalKWh,
      isEstimated: true, // Flag to indicate this is estimated, not tracked
    };
  } catch (error) {
    host.error('Error estimating battery energy cost:', error);
    return null;
  }
}

/**
 * Combine tracked and unknown battery energy costs.
 * Mirrors the previous `EnergyOptimizerDevice.combineBatteryCost()` behavior.
 */
function combineBatteryCost(host, tracked, totalKWh, batteryCapacity) {
  if (totalKWh < 0.01) {
    return null;
  }

  const trackedKWh = tracked?.totalKWh || 0;
  const unknownKWh = Math.max(0, totalKWh - trackedKWh);

  // If everything is tracked, return it directly
  if (unknownKWh < 0.01) {
    return {
      ...tracked,
      storedKWh: totalKWh,
      trackedKWh,
      unknownKWh: 0,
      isEstimated: false,
    };
  }

  // If nothing is tracked, estimate everything
  if (trackedKWh < 0.01) {
    const estimated = estimateBatteryEnergyCost(host, totalKWh / batteryCapacity, batteryCapacity);
    if (!estimated) return null;

    let unknownPrice = 0.20;
    if (Number.isFinite(estimated.unknownAvgPrice)) {
      unknownPrice = estimated.unknownAvgPrice;
    } else if (Number.isFinite(estimated.gridOnlyAvgPrice)) {
      unknownPrice = estimated.gridOnlyAvgPrice;
    }

    return {
      ...estimated,
      storedKWh: totalKWh,
      trackedKWh: 0,
      unknownKWh: totalKWh,
      unknownAvgPrice: unknownPrice,
      isEstimated: true,
    };
  }

  // Mixed case: combine tracked + unknown
  // Estimate the unknown portion
  let unknownAvgPrice = 0.20; // Fallback

  if (host.currentStrategy?.chargeIntervals && host.currentStrategy.chargeIntervals.length > 0) {
    const sum = host.currentStrategy.chargeIntervals.reduce((acc, interval) => acc + (interval.total || 0), 0);
    unknownAvgPrice = sum / host.currentStrategy.chargeIntervals.length;
  } else if (host.priceCache && host.priceCache.length > 0) {
    const recentPrices = host.priceCache.slice(0, Math.min(96, host.priceCache.length));
    const sum = recentPrices.reduce((acc, p) => acc + (p.total || 0), 0);
    unknownAvgPrice = sum / recentPrices.length;
  }

  // Assume unknown energy is mostly grid with some solar (conservative)
  const unknownSolarPercent = 30;
  const unknownGridPercent = 70;
  const unknownSolarKWh = unknownKWh * (unknownSolarPercent / 100);
  const unknownGridKWh = unknownKWh * (unknownGridPercent / 100);
  const unknownTotalCost = unknownGridKWh * unknownAvgPrice;

  // Combine tracked + unknown
  const combinedTotalKWh = trackedKWh + unknownKWh;
  const combinedSolarKWh = (tracked?.solarKWh || 0) + unknownSolarKWh;
  const combinedGridKWh = (tracked?.gridKWh || 0) + unknownGridKWh;
  const combinedTotalCost = (tracked?.totalCost || 0) + unknownTotalCost;
  const combinedAvgPrice = combinedTotalCost / combinedTotalKWh;

  host.log('   📊 Combined battery cost (tracked + unknown):');
  host.log(`      Total: ${combinedTotalKWh.toFixed(2)} kWh @ ${combinedAvgPrice.toFixed(4)} €/kWh`);
  host.log(`      Tracked: ${trackedKWh.toFixed(2)} kWh @ ${(tracked?.avgPrice || 0).toFixed(4)} €/kWh`);
  host.log(`      Unknown: ${unknownKWh.toFixed(2)} kWh @ ${unknownAvgPrice.toFixed(4)} €/kWh (estimated)`);

  return {
    avgPrice: combinedAvgPrice,
    totalKWh: combinedTotalKWh,
    storedKWh: totalKWh,
    solarKWh: combinedSolarKWh,
    gridKWh: combinedGridKWh,
    solarPercent: (combinedSolarKWh / combinedTotalKWh) * 100,
    gridPercent: (combinedGridKWh / combinedTotalKWh) * 100,
    totalCost: combinedTotalCost,
    gridOnlyAvgPrice: combinedGridKWh > 0 ? combinedTotalCost / combinedGridKWh : unknownAvgPrice,
    isEstimated: true, // Flag to indicate mixed/estimated data
    trackedKWh,
    unknownKWh,
    unknownAvgPrice,
  };
}

module.exports = {
  estimateBatteryEnergyCost,
  combineBatteryCost,
};
