'use strict';

const { BATTERY_MODE } = require('../strategy-execution-core');

/**
 * Apply the decided battery mode to the battery device.
 * Host-based service module: operates on the EnergyOptimizerDevice instance.
 */
async function applyBatteryMode(host, batteryDevice, decision) {
  const { mode, intervalIndex, reason } = decision;
  const lastMode = host.lastBatteryMode;
  const priceInfo = intervalIndex >= 0 && host.priceCache[intervalIndex]
    ? `(${host.priceCache[intervalIndex].total.toFixed(4)} €/kWh)`
    : '';

  switch (mode) {
    case BATTERY_MODE.CHARGE:
      host.log(`✅ CHARGE INTERVAL ACTIVE (index ${intervalIndex})`);
      host.log(`   → ${reason}`);

      if (typeof batteryDevice.enableGridCharging === 'function') {
        await batteryDevice.enableGridCharging();
        host.log('   ✓ enableGridCharging() completed successfully');
        await host.setCapabilityValueIfChanged('optimizer_status', host.homey.__('status.grid_charging'));

        if (lastMode !== mode) {
          await host.logBatteryModeChange(mode, priceInfo);
        }
      } else {
        host.error('❌ Battery device does not have enableGridCharging method');
      }
      break;

    case BATTERY_MODE.NORMAL:
      host.log(`🏠 NORMAL MODE (index ${intervalIndex})`);
      host.log(`   → ${reason}`);

      if (typeof batteryDevice.enableDefaultOperatingMode === 'function') {
        await batteryDevice.enableDefaultOperatingMode();
        host.log('   ✓ enableDefaultOperatingMode() completed successfully');
        await host.setCapabilityValueIfChanged('optimizer_status', host.homey.__('status.battery_use_enabled'));

        if (lastMode !== mode) {
          await host.logBatteryModeChange(mode, priceInfo);
        }
      } else {
        host.error('❌ Battery device does not have enableDefaultOperatingMode method');
      }
      break;

    case BATTERY_MODE.CONSTANT:
      host.log(`🔒 CONSTANT MODE (index ${intervalIndex})`);
      host.log(`   → ${reason}`);

      if (typeof batteryDevice.disableBatteryDischarge === 'function') {
        await batteryDevice.disableBatteryDischarge();
        host.log('   ✓ disableBatteryDischarge() completed successfully');
        await host.setCapabilityValueIfChanged('optimizer_status', host.homey.__('status.solar_charging'));

        if (lastMode !== mode) {
          await host.logBatteryModeChange(mode);
        }
      } else {
        host.error('❌ Battery device does not have disableBatteryDischarge method');
      }
      break;

    default:
      host.log(`⚠️ Unknown mode: ${mode}`);
  }
}

module.exports = {
  applyBatteryMode,
};
