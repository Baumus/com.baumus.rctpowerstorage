'use strict';

/**
 * Grid power collection.
 * Host-based service module: operates on the EnergyOptimizerDevice instance.
 */
async function collectGridPower(host) {
  const gridDeviceId = typeof host.getSetting === 'function' ? host.getSetting('grid_device_id') : '';

  if (!gridDeviceId || gridDeviceId.trim() === '') {
    host.log('   No grid device configured, defaulting to 0 W');
    return 0;
  }

  try {
    const gridDevice = host.getDeviceById('grid-meter', gridDeviceId);

    if (gridDevice && gridDevice.hasCapability('measure_power')) {
      const gridPower = gridDevice.getCapabilityValue('measure_power') || 0;
      host.log(`   Grid power: ${gridPower.toFixed(0)} W`);
      return gridPower;
    }

    host.log('   ⚠️ Grid device found but no measure_power capability');
    return 0;
  } catch (error) {
    host.log(`   ⚠️ Could not read grid power: ${error.message}`);
    return 0;
  }
}

module.exports = {
  collectGridPower,
};
