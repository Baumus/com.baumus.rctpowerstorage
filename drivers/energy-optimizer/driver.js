'use strict';

const Homey = require('homey');

module.exports = class EnergyOptimizerDriver extends Homey.Driver {

  /**
   * onInit is called when the driver is initialized.
   */
  async onInit() {
    this.log('Energy Optimizer Driver has been initialized');
  }

  /**
   * onPair is called when a user starts pairing a device
   */
  async onPair(session) {
    this.log('Energy Optimizer pairing started');
    let deviceConfig = null;

    // Handler to get available devices
    session.setHandler('get_available_devices', async () => {
      this.log('Getting available devices...');

      try {
        const result = {
          battery: [],
          solar: [],
          grid: [],
        };

        // Get all drivers
        const drivers = this.homey.drivers.getDrivers();
        this.log(`Found ${Object.keys(drivers).length} drivers`);

        // Loop through all drivers and their devices
        for (const driver of Object.values(drivers)) {
          const devices = driver.getDevices();
          this.log(`Driver '${driver.id}' has ${devices.length} devices`);

          for (const device of devices) {
            // Get driver ID
            const driverId = driver.id;
            this.log(`  Checking device: ${device.getName()}, Driver ID: ${driverId}, Device ID: ${device.getData().id}`);

            // Check for RCT Power Storage DC (battery)
            if (driverId.endsWith('rct-power-storage-dc')) {
              result.battery.push({
                id: device.getData().id,
                name: device.getName(),
              });
              this.log(`  ✓ Found battery device: ${device.getName()} (${device.getData().id})`);
            }

            // Check for Solar Panel
            if (driverId.endsWith('solar-panel')) {
              result.solar.push({
                id: device.getData().id,
                name: device.getName(),
              });
              this.log(`  ✓ Found solar device: ${device.getName()} (${device.getData().id})`);
            }

            // Check for Grid Meter
            if (driverId.endsWith('grid-meter')) {
              result.grid.push({
                id: device.getData().id,
                name: device.getName(),
              });
              this.log(`  ✓ Found grid device: ${device.getName()} (${device.getData().id})`);
            }
          }
        }

        this.log('Available devices:', result);
        return result;
      } catch (error) {
        this.error('Error getting available devices:', error);
        return {
          battery: [],
          solar: [],
          grid: [],
        };
      }
    });

    session.setHandler('validate', async (data) => {
      this.log('Validating device IDs:', data);

      // Check if battery device ID is provided
      if (!data.battery_device_id || data.battery_device_id.trim() === '') {
        throw new Error('Battery Device ID is required');
      }

      // Optional: Verify that the devices exist
      try {
        const drivers = this.homey.drivers.getDrivers();
        let batteryFound = false;

        for (const driver of Object.values(drivers)) {
          const devices = driver.getDevices();

          for (const device of devices) {
            if (device.getData().id === data.battery_device_id) {
              batteryFound = true;
              this.log(`Found battery device: ${device.getName()}`);
              break;
            }
          }

          if (batteryFound) break;
        }

        if (!batteryFound) {
          this.log('Warning: Battery device ID not found in existing devices');
          // Don't fail - user might know what they're doing
        }
      } catch (error) {
        this.error('Error validating devices:', error);
        // Don't fail validation
      }

      // Store the configuration
      deviceConfig = {
        name: 'Energy Optimizer',
        data: {
          id: `energy-optimizer-${Date.now()}`,
        },
        settings: {
          battery_device_id: data.battery_device_id,
          solar_device_id: data.solar_device_id || '',
          grid_device_id: data.grid_device_id || '',
        },
      };

      this.log('Device config prepared:', deviceConfig);
      return true;
    });

    session.setHandler('list_devices', async () => {
      if (!deviceConfig) return [];

      return [
        {
          name: deviceConfig.name,
          data: deviceConfig.data,
          settings: deviceConfig.settings,
        },
      ];
    });
  }

  /**
   * onPairListDevices is called when a user is adding a device
   * and the 'list_devices' view is called.
   */
  async onPairListDevices() {
    this.log('Energy Optimizer pairing - list_devices');

    // Return a single optimizer device
    return [
      {
        name: 'Energy Optimizer',
        data: {
          id: `energy-optimizer-${Date.now()}`,
        },
      },
    ];
  }

};
