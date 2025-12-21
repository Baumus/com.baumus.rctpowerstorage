'use strict';

const {
  createChargeEntry,
  createDischargeEntry,
  calculateBatteryEnergyCost,
  shouldClearChargeLog,
  trimChargeLog,
} = require('../battery-cost-core');
const { getPriceAtTime } = require('../time-scheduling-core');
const { INTERVAL_MINUTES, MAX_BATTERY_LOG_ENTRIES } = require('../constants');

function getCurrentIntervalPrice(host, timestamp) {
  return getPriceAtTime(timestamp, host.priceCache, INTERVAL_MINUTES);
}

async function trackBatteryCharging(host, batteryPower) {
  try {
    // Get current price for this interval
    const now = new Date();
    const currentPrice = getCurrentIntervalPrice(host, now);

    // Get cumulative meter readings from solar and grid devices
    const solarDeviceId = typeof host.getSetting === 'function' ? host.getSetting('solar_device_id') : '';
    const gridDeviceId = typeof host.getSetting === 'function' ? host.getSetting('grid_device_id') : '';
    const batteryDeviceId = typeof host.getSetting === 'function' ? host.getSetting('battery_device_id') : '';

    let solarMeterNow = 0;
    let gridImportedNow = 0;
    let gridExportedNow = 0;
    let batteryMeterNow = 0;
    let batteryMeterDischargedNow = 0;
    let currentSoc = 0;

    // Get solar meter reading (total production)
    if (solarDeviceId && solarDeviceId.trim() !== '') {
      try {
        const solarDevice = host.getDeviceById('solar-panel', solarDeviceId);
        if (solarDevice && solarDevice.hasCapability('meter_power')) {
          solarMeterNow = solarDevice.getCapabilityValue('meter_power') || 0;
        }
      } catch (error) {
        // Ignore
      }
    }

    // Get grid meter readings (import/export)
    if (gridDeviceId && gridDeviceId.trim() !== '') {
      try {
        const gridDevice = host.getDeviceById('grid-meter', gridDeviceId);
        if (gridDevice) {
          if (gridDevice.hasCapability('meter_power.imported')) {
            gridImportedNow = gridDevice.getCapabilityValue('meter_power.imported') || 0;
          } else if (gridDevice.hasCapability('meter_power')) {
            gridImportedNow = gridDevice.getCapabilityValue('meter_power') || 0;
          }

          if (gridDevice.hasCapability('meter_power.exported')) {
            gridExportedNow = gridDevice.getCapabilityValue('meter_power.exported') || 0;
          }
        }
      } catch (error) {
        // Ignore
      }
    }

    // Get battery meter reading (total charged and discharged) and current SoC
    if (batteryDeviceId && batteryDeviceId.trim() !== '') {
      try {
        const batteryDevice = host.getDeviceById('rct-power-storage-dc', batteryDeviceId);
        if (batteryDevice) {
          batteryMeterNow = host.getCapabilitySafe(batteryDevice, 'meter_power.charged') || 0;
          batteryMeterDischargedNow = host.getCapabilitySafe(batteryDevice, 'meter_power.discharged') || 0;
          const socValue = host.getCapabilitySafe(batteryDevice, 'measure_battery');
          if (typeof socValue === 'number' && Number.isFinite(socValue)) {
            currentSoc = socValue;
          }
        }
      } catch (error) {
        // Ignore
      }
    }

    // Check if battery is considered empty - if so, clear the log
    const minSocThreshold = typeof host.getSetting === 'function' ? (host.getSetting('min_soc_threshold') || 7) : 7;
    if (shouldClearChargeLog(currentSoc, minSocThreshold, host.batteryChargeLog.length)) {
      if (typeof host.log === 'function') {
        host.log(`🔄 Battery at ${currentSoc.toFixed(1)}% (≤ ${minSocThreshold}%) - clearing charge log (${host.batteryChargeLog.length} entries)`);
      }
      host.batteryChargeLog = [];
      await host.queueStoreValue('battery_charge_log', host.batteryChargeLog, { immediate: true });

      // Reset last meter reading to avoid double-counting
      host.lastMeterReading = {
        solar: solarMeterNow,
        grid: gridImportedNow,
        gridImported: gridImportedNow,
        gridExported: gridExportedNow,
        battery: batteryMeterNow,
        batteryDischarged: batteryMeterDischargedNow,
        timestamp: now,
      };
      return;
    }

    // Initialize lastMeterReading on first run to avoid false deltas
    if (!host.lastMeterReading) {
      if (typeof host.log === 'function') host.log('📊 Initializing meter readings (first run or after restart)');
      host.lastMeterReading = {
        solar: solarMeterNow,
        grid: gridImportedNow,
        gridImported: gridImportedNow,
        gridExported: gridExportedNow,
        battery: batteryMeterNow,
        batteryDischarged: batteryMeterDischargedNow,
        timestamp: now,
      };
      return; // Skip first sample to establish baseline
    }

    // Calculate delta since last reading
    // IMPORTANT: Use nullish coalescing (??) so that 0 is treated as a valid previous reading
    const lastReading = host.lastMeterReading;
    const solarProducedKWh = Math.max(0, solarMeterNow - (lastReading.solar ?? solarMeterNow));
    const lastGridExported = lastReading.gridExported ?? 0;
    const gridExportedKWh = Math.max(0, gridExportedNow - (lastGridExported ?? gridExportedNow));
    // Solar available for local use = produced - exported to grid
    const solarAvailableKWh = Math.max(0, solarProducedKWh - gridExportedKWh);
    const batteryChargedKWh = Math.max(0, batteryMeterNow - (lastReading.battery ?? batteryMeterNow));
    const batteryDischargedKWh = Math.max(0, batteryMeterDischargedNow - (lastReading.batteryDischarged ?? batteryMeterDischargedNow));

    // Always advance baseline, even if nothing is logged.
    // This prevents unrelated solar/grid deltas from being attributed to a later battery charge.
    host.lastMeterReading = {
      solar: solarMeterNow,
      grid: gridImportedNow,
      gridImported: gridImportedNow,
      gridExported: gridExportedNow,
      battery: batteryMeterNow,
      batteryDischarged: batteryMeterDischargedNow,
      timestamp: now,
    };

    // If no energy moved since last sample, nothing to log
    if (batteryChargedKWh <= 0.001 && batteryDischargedKWh <= 0.001) {
      return;
    }

    // Handle battery CHARGING - add to log with positive values
    if (batteryChargedKWh > 0.001) {
      const chargeEntry = createChargeEntry({
        chargedKWh: batteryChargedKWh,
        solarKWh: solarAvailableKWh,
        gridPrice: currentPrice || 0,
        soc: currentSoc,
        timestamp: now,
      });

      host.batteryChargeLog.push(chargeEntry);

      // Keep log trimmed to avoid unbounded growth
      if (host.batteryChargeLog.length > MAX_BATTERY_LOG_ENTRIES) {
        host.batteryChargeLog = trimChargeLog(host.batteryChargeLog, MAX_BATTERY_LOG_ENTRIES);
      }

      await host.queueStoreValue('battery_charge_log', host.batteryChargeLog);
    }

    // Handle battery DISCHARGING - add to log with negative values
    if (batteryDischargedKWh > 0.001) {
      // Calculate average cost of energy currently in battery before discharge
      const batteryCostBeforeDischarge = calculateBatteryEnergyCost(host.batteryChargeLog);
      const avgBatteryPrice = batteryCostBeforeDischarge ? batteryCostBeforeDischarge.avgPrice : 0;

      const dischargeEntry = createDischargeEntry({
        dischargedKWh: batteryDischargedKWh,
        gridPrice: currentPrice || 0,
        avgBatteryPrice,
        soc: currentSoc,
        timestamp: now,
      });

      host.batteryChargeLog.push(dischargeEntry);

      // Keep log trimmed to avoid unbounded growth
      if (host.batteryChargeLog.length > MAX_BATTERY_LOG_ENTRIES) {
        host.batteryChargeLog = trimChargeLog(host.batteryChargeLog, MAX_BATTERY_LOG_ENTRIES);
      }

      await host.queueStoreValue('battery_charge_log', host.batteryChargeLog);
    }

    // Cleanup old entries - keep only last several days
    if (host.batteryChargeLog.length > MAX_BATTERY_LOG_ENTRIES) {
      host.batteryChargeLog = host.batteryChargeLog.slice(-MAX_BATTERY_LOG_ENTRIES);
      await host.queueStoreValue('battery_charge_log', host.batteryChargeLog);
    }
  } catch (error) {
    if (typeof host.error === 'function') host.error('Error tracking battery charging:', error);
  }
}

module.exports = {
  trackBatteryCharging,
};
