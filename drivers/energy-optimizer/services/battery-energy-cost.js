'use strict';

const { calculateBatteryEnergyCost: calculateBatteryEnergyCostCore } = require('../battery-cost-core');

/**
 * Wrapper around the pure battery cost core function.
 * Keeps the verbose logging on the host, but moves implementation out of device.js.
 */
function calculateBatteryEnergyCost(host) {
  try {
    host.log('\n🔍 calculateBatteryEnergyCost called:');
    host.log(`   batteryChargeLog length: ${host.batteryChargeLog ? host.batteryChargeLog.length : 'null/undefined'}`);

    // Show first and last entries for debugging
    if (host.batteryChargeLog && host.batteryChargeLog.length > 0) {
      host.log(`   First entry: ${JSON.stringify(host.batteryChargeLog[0]).substring(0, 150)}...`);
      if (host.batteryChargeLog.length > 1) {
        const lastIdx = host.batteryChargeLog.length - 1;
        host.log(`   Last entry: ${JSON.stringify(host.batteryChargeLog[lastIdx]).substring(0, 150)}...`);
      }
    }

    const result = calculateBatteryEnergyCostCore(
      host.batteryChargeLog,
      { logger: host.log.bind(host) },
    );

    if (result) {
      host.log(`   ✅ Result: ${result.totalKWh.toFixed(3)} kWh @ ${result.avgPrice.toFixed(4)} €/kWh`);
      host.log(`      Solar: ${result.solarKWh.toFixed(2)} kWh (${result.solarPercent.toFixed(0)}%)`);
      host.log(`      Grid: ${result.gridKWh.toFixed(2)} kWh (${result.gridPercent.toFixed(0)}%)`);
    } else {
      host.log('   ⚠️ Result: null (no data or battery empty)');
    }

    return result;
  } catch (error) {
    host.error('Error calculating battery energy cost:', error);
    return null;
  }
}

module.exports = {
  calculateBatteryEnergyCost,
};
