'use strict';

function normalizeFraction(value) {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(1, value));
}

function getBatteryTargetState({ batteryCapacity, currentSoc, targetSoc }) {
  const safeBatteryCapacity = Number.isFinite(batteryCapacity) ? Math.max(0, batteryCapacity) : 0;
  const safeCurrentSoc = normalizeFraction(currentSoc);
  const safeTargetSoc = normalizeFraction(targetSoc);

  const currentEnergyKWh = safeCurrentSoc * safeBatteryCapacity;
  const targetEnergyKWh = safeTargetSoc * safeBatteryCapacity;
  const availableCapacityToTargetKWh = Math.max(0, targetEnergyKWh - currentEnergyKWh);
  const excessEnergyAboveTargetKWh = Math.max(0, currentEnergyKWh - targetEnergyKWh);

  return {
    currentEnergyKWh,
    targetEnergyKWh,
    availableCapacityToTargetKWh,
    excessEnergyAboveTargetKWh,
    aboveTargetDeltaSoc: Math.max(0, safeCurrentSoc - safeTargetSoc),
  };
}

module.exports = {
  getBatteryTargetState,
};