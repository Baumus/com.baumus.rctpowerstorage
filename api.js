'use strict';

module.exports = {
  async getDevices({ homey }) {
    try {
      const driver = homey.drivers.getDriver('energy-optimizer');
      const devices = driver.getDevices();

      return {
        devices: devices.map((device) => ({
          id: device.getData().id,
          name: device.getName(),
          driverId: 'energy-optimizer',
          status: device.getCapabilityValue('optimizer_status') || 'Unknown',
        })),
      };
    } catch (error) {
      throw new Error(`Failed to get devices: ${error.message}`);
    }
  },

  async getDevice({ homey, params }) {
    const { deviceId } = params;

    try {
      const driver = homey.drivers.getDriver('energy-optimizer');
      const devices = driver.getDevices();
      const device = devices.find((d) => d.getData().id === deviceId);

      if (!device) {
        throw new Error('Device not found');
      }

      return {
        device: {
          id: device.getData().id,
          name: device.getName(),
          driverId: 'energy-optimizer',
          capabilities: {
            optimizer_status: device.getCapabilityValue('optimizer_status'),
            next_charge_start: device.getCapabilityValue('next_charge_start'),
            estimated_savings: device.getCapabilityValue('estimated_savings'),
            onoff: device.getCapabilityValue('onoff'),
          },
        },
      };
    } catch (error) {
      throw new Error(`Failed to get device: ${error.message}`);
    }
  },

  async getDeviceStrategy({ homey, params }) {
    const { deviceId } = params;

    try {
      // Get the energy optimizer driver
      const driver = homey.drivers.getDriver('energy-optimizer');
      const devices = driver.getDevices();

      // Find the device by ID
      const device = devices.find((d) => d.getData().id === deviceId);

      if (!device) {
        throw new Error('Device not found');
      }

      // Log for debugging
      homey.log('getDeviceStrategy called for device:', deviceId);
      homey.log('Price cache length:', device.priceCache ? device.priceCache.length : 0);
      homey.log('Current strategy:', device.currentStrategy ? 'exists' : 'null');

      // Log first price entry to see structure
      if (device.priceCache && device.priceCache.length > 0) {
        homey.log('First price entry:', JSON.stringify(device.priceCache[0]));
      }

      // Return strategy and cache data
      return {
        strategy: device.currentStrategy || null,
        priceCache: device.priceCache || [],
        productionHistory: device.productionHistory || {},
        consumptionHistory: device.consumptionHistory || {},
      };
    } catch (error) {
      homey.error('Failed to get strategy:', error);
      throw new Error(`Failed to get strategy: ${error.message}`);
    }
  },
};
