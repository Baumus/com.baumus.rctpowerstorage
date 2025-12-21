'use strict';

const {
  INTERVAL_MINUTES,
  DEFAULT_FORECAST_DAYS,
} = require('../constants');

/**
 * Data collection for forecasting.
 * Host-based service module: operates on the EnergyOptimizerDevice instance.
 */
async function collectCurrentData(host) {
  if (!host.getCapabilityValue || !host.getCapabilityValue('onoff')) {
    return; // Optimizer is disabled
  }

  try {
    const now = new Date();
    const minutesSinceMidnight = now.getHours() * 60 + now.getMinutes();
    const intervalIndex = Math.floor(minutesSinceMidnight / INTERVAL_MINUTES); // 0-95

    const forecastDays = host.getSettingOrDefault('forecast_days', DEFAULT_FORECAST_DAYS);

    // Collect solar production data
    const solarDeviceId = typeof host.getSetting === 'function' ? host.getSetting('solar_device_id') : '';
    if (solarDeviceId && solarDeviceId.trim() !== '') {
      try {
        const solarDevice = host.getDeviceById('solar-panel', solarDeviceId);

        if (solarDevice && solarDevice.hasCapability('measure_power')) {
          const solarPower = solarDevice.getCapabilityValue('measure_power') || 0;

          if (!host.productionHistory[intervalIndex]) {
            host.productionHistory[intervalIndex] = [];
          }

          host.productionHistory[intervalIndex].push(solarPower);

          // Keep only last N days
          if (host.productionHistory[intervalIndex].length > forecastDays) {
            host.productionHistory[intervalIndex].shift();
          }
        }
      } catch (error) {
        // Solar device not found or error - not critical
        host.logThrottled('solar-device-error', 5 * 60 * 1000, 'Solar device not accessible:', error.message);
      }
    }

    // Collect consumption data from grid meter
    const gridDeviceId = typeof host.getSetting === 'function' ? host.getSetting('grid_device_id') : '';
    if (gridDeviceId && gridDeviceId.trim() !== '') {
      try {
        const gridDevice = host.getDeviceById('grid-meter', gridDeviceId);

        if (gridDevice && gridDevice.hasCapability('measure_power')) {
          const gridPower = gridDevice.getCapabilityValue('measure_power') || 0;

          if (!host.consumptionHistory[intervalIndex]) {
            host.consumptionHistory[intervalIndex] = [];
          }

          // Keep sign: +import, -export
          host.consumptionHistory[intervalIndex].push(gridPower);

          // Keep only last N days
          if (host.consumptionHistory[intervalIndex].length > forecastDays) {
            host.consumptionHistory[intervalIndex].shift();
          }
        }
      } catch (error) {
        // Grid device not found or error - not critical
        host.logThrottled('grid-device-error', 5 * 60 * 1000, 'Grid device not accessible:', error.message);
      }
    }

    // Collect battery power data
    const batteryDeviceId = typeof host.getSetting === 'function' ? host.getSetting('battery_device_id') : '';
    if (batteryDeviceId && batteryDeviceId.trim() !== '') {
      try {
        const batteryDevice = host.getDeviceById('rct-power-storage-dc', batteryDeviceId);

        if (batteryDevice) {
          // Battery driver provides measure_power
          const batteryPower = host.getCapabilitySafe(batteryDevice, 'measure_power');

          if (typeof batteryPower === 'number' && Number.isFinite(batteryPower)) {
            if (!host.batteryHistory[intervalIndex]) {
              host.batteryHistory[intervalIndex] = [];
            }

            host.batteryHistory[intervalIndex].push(batteryPower);

            // Keep only last N days
            if (host.batteryHistory[intervalIndex].length > forecastDays) {
              host.batteryHistory[intervalIndex].shift();
            }
          }

          // Track charging events with prices for cost calculation
          // Always call this regardless of current power to track meter deltas
          await host.trackBatteryCharging(batteryPower);
        }
      } catch (error) {
        // Battery device not found or error - not critical
        host.logThrottled('battery-device-error', 5 * 60 * 1000, 'Battery device not accessible:', error.message);
      }
    }

    // Save historical data every hour (at intervals 0, 4, 8, etc.)
    if (intervalIndex % 4 === 0) {
      await host.saveHistoricalData();
    }
  } catch (error) {
    host.error('Error collecting data:', error);
  }
}

module.exports = {
  collectCurrentData,
};
