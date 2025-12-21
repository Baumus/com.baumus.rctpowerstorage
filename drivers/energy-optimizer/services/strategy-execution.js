'use strict';

const { decideBatteryMode, BATTERY_MODE } = require('../strategy-execution-core');
const {
  INTERVAL_MINUTES,
  DEFAULT_MIN_SOC_THRESHOLD,
  GRID_SOLAR_THRESHOLD_W,
  GRID_CONSUMPTION_THRESHOLD_W,
} = require('../constants');

/**
 * Execute the current optimization strategy.
 * Host-based service module: operates on the EnergyOptimizerDevice instance.
 */
async function executeOptimizationStrategy(host) {
  host.log('\n🔄 === EXECUTING OPTIMIZATION STRATEGY ===');
  host.log(`Timestamp: ${new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin' })}`);

  if (!host.getCapabilityValue || !host.getCapabilityValue('onoff')) {
    host.log('⚠️ Optimizer is disabled, skipping execution');
    return;
  }

  if (!host.currentStrategy) {
    host.log('⚠️ No strategy available, skipping execution');
    return;
  }

  host.log(`Strategy info: ${host.currentStrategy.chargeIntervals?.length || 0} charge intervals, ${host.currentStrategy.dischargeIntervals?.length || 0} discharge intervals`);

  // Keep UI in sync: next upcoming charge slot (not the first historical one)
  try {
    const now = new Date();
    const nextChargeInterval = (host.currentStrategy.chargeIntervals || [])
      .filter((ci) => ci && ci.startsAt && new Date(ci.startsAt) >= now)
      .sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt))[0];

    if (nextChargeInterval) {
      const nextCharge = new Date(nextChargeInterval.startsAt);
      const formattedTime = nextCharge.toLocaleString(host.homey.i18n.getLanguage(), {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Europe/Berlin',
      });
      await host.setCapabilityValueIfChanged('next_charge_start', formattedTime);
    } else {
      await host.setCapabilityValueIfChanged('next_charge_start', host.homey.__('status.no_cheap_slots'));
    }
  } catch (error) {
    host.log(`⚠️ Could not update next_charge_start: ${error.message}`);
  }

  // Get grid power for decision making
  const gridPower = await host.collectGridPower();

  const batteryDeviceId = host.getSettingOrDefault('battery_device_id', '');
  const batteryDevice = host.getDeviceById('rct-power-storage-dc', batteryDeviceId);

  if (!batteryDevice) {
    host.error(`Battery device not found with ID: ${batteryDeviceId}`);
    await host.setCapabilityValueIfChanged('optimizer_status', host.homey.__('error.battery_not_found'));
    return;
  }

  const currentSocPercent = host.getCapabilitySafe(batteryDevice, 'measure_battery');
  const minSocThresholdPercent = parseFloat(host.getSettingOrDefault('min_soc_threshold', DEFAULT_MIN_SOC_THRESHOLD));

  // Use pure function to decide battery mode
  const decision = decideBatteryMode({
    now: new Date(),
    priceCache: host.priceCache,
    strategy: host.currentStrategy,
    gridPower,
    lastMode: host.lastBatteryMode,
    currentSocPercent,
    minSocThresholdPercent,
    thresholds: {
      solarThreshold: GRID_SOLAR_THRESHOLD_W,
      consumptionThreshold: GRID_CONSUMPTION_THRESHOLD_W,
    },
    intervalMinutes: INTERVAL_MINUTES,
  });

  host.log(`Decision: ${decision.mode} (interval ${decision.intervalIndex})`);
  host.log(`Reason: ${decision.reason}`);

  if (decision.mode === BATTERY_MODE.IDLE) {
    host.log('⚠️ No action to take');
    return;
  }

  // Execute the decided mode
  try {
    await host.applyBatteryMode(batteryDevice, decision);

    // Store current mode for next comparison
    host.lastBatteryMode = decision.mode;

    // Update battery status in current strategy (energy cost may have changed)
    await host.updateBatteryStatus(batteryDevice);
  } catch (error) {
    host.error('Error executing optimization strategy:', error);
    await host.setCapabilityValueIfChanged('optimizer_status', `${host.homey.__('status.error')}: ${error.message}`);
  }
}

module.exports = {
  executeOptimizationStrategy,
};
