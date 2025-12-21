'use strict';

const { DEFAULT_BATTERY_CAPACITY_KWH } = require('../constants');

/**
 * Keep `host.currentStrategy.batteryStatus` in sync with latest SoC + cost info.
 * Host-based service module: operates on the EnergyOptimizerDevice instance.
 */
async function updateBatteryStatus(host, batteryDevice) {
  if (!host.currentStrategy) {
    return;
  }

  try {
    // Get current battery state
    let currentSoc = 0;
    const socValue = host.getCapabilitySafe(batteryDevice, 'measure_battery');
    if (socValue !== null) {
      currentSoc = socValue / 100;
    }

    const batteryCapacity = parseFloat(batteryDevice.getSetting('battery_capacity')) || DEFAULT_BATTERY_CAPACITY_KWH;
    const maxTargetSoc = host.normalizedTargetSoc;
    const maxBatteryKWh = batteryCapacity * (maxTargetSoc - currentSoc);
    const storedKWh = currentSoc * batteryCapacity;

    // Get tracked energy from charge log
    const trackedCost = host.calculateBatteryEnergyCost();

    // Combine tracked + unknown to account for full battery content
    let batteryCostInfo = null;
    if (currentSoc > 0.05) {
      batteryCostInfo = host.combineBatteryCost(trackedCost, storedKWh, batteryCapacity);
    }

    // Update batteryStatus in existing strategy
    host.currentStrategy.batteryStatus = {
      currentSoc,
      targetSoc: maxTargetSoc,
      availableCapacity: maxBatteryKWh,
      batteryCapacity,
      storedKWh,
      energyCost: batteryCostInfo,
    };

    host.log(`✅ Battery status updated: SoC ${(currentSoc * 100).toFixed(1)}%, energyCost: ${batteryCostInfo ? 'available' : 'null'}`);
  } catch (error) {
    host.error('Error updating battery status:', error);
  }
}

module.exports = {
  updateBatteryStatus,
};
