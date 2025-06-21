'use strict';

const { Device } = require('homey');
const Connection = require('../../lib/rctjavalib/connection');
const { Identifier, SOCStrategy } = require('../../lib/rctjavalib/datagram');

class MyDevice extends Device {

  /**
   * onInit is called when the device is initialized.
   */
  async onInit() {
    this.log('MyDevice has been initialized');
    this.conn = null;
    // check if migration is needed
    if (this.hasCapability('soc_stratgey') === false) {
      await this.addCapability('soc_strategy');
    }

    this.setAvailable();
    await this.ensureConnection();

    // Error handling for connection errors
    try {
      // Query the Battery Capacity and Module Health (only during initialization)
      const bcapacity = await this.conn.queryFloat32(Identifier.BATTERY_CAPACITY_AH);
      const bvoltage = await this.conn.queryFloat32(Identifier.BATTERY_VOLTAGE);
      const roundedCapacity = (Math.round(((bcapacity * bvoltage) / 1000) * 10) / 10).toFixed(1);

      const batteryModules = [
        { serial: Identifier.BATTERY_MODULE_0_SERIAL, umax: Identifier.BATTERY_MODULE_0_UMAX, umin: Identifier.BATTERY_MODULE_0_UMIN },
        { serial: Identifier.BATTERY_MODULE_1_SERIAL, umax: Identifier.BATTERY_MODULE_1_UMAX, umin: Identifier.BATTERY_MODULE_1_UMIN },
        { serial: Identifier.BATTERY_MODULE_2_SERIAL, umax: Identifier.BATTERY_MODULE_2_UMAX, umin: Identifier.BATTERY_MODULE_2_UMIN },
        { serial: Identifier.BATTERY_MODULE_3_SERIAL, umax: Identifier.BATTERY_MODULE_3_UMAX, umin: Identifier.BATTERY_MODULE_3_UMIN },
        { serial: Identifier.BATTERY_MODULE_4_SERIAL, umax: Identifier.BATTERY_MODULE_4_UMAX, umin: Identifier.BATTERY_MODULE_4_UMIN },
        { serial: Identifier.BATTERY_MODULE_5_SERIAL, umax: Identifier.BATTERY_MODULE_5_UMAX, umin: Identifier.BATTERY_MODULE_5_UMIN },
        { serial: Identifier.BATTERY_MODULE_6_SERIAL, umax: Identifier.BATTERY_MODULE_6_UMAX, umin: Identifier.BATTERY_MODULE_6_UMIN },
      ];

      const settings = {
        DeviceId: this.getData().id,
        DeviceIP: this.getStoreValue('address'),
        DevicePort: this.getStoreValue('port'),
        battery_capacity: roundedCapacity.toString(),
      };

      for (let i = 0; i < batteryModules.length; i++) {
        const serial = await this.conn.queryString(batteryModules[i].serial);
        const umax = await this.conn.queryFloat32(batteryModules[i].umax);
        const umin = await this.conn.queryFloat32(batteryModules[i].umin);
        settings[`battery_module_${i}_serial`] = serial;

        if (serial === '') {
          settings[`battery_module_${i}_health`] = '';
        } else {
          settings[`battery_module_${i}_health`] = (umax < 3.500 && umin >= 3.000) ? 'good' : 'bad';
        }
      }

      await this.setSettings(settings);
    } catch (error) {
      this.log('Error during initialization:', error);

      // Specific handling for EHOSTUNREACH error
      if (error.code === 'EHOSTUNREACH') {
        await this.setUnavailable(`The target device ${this.getStoreValue('address')}:${this.getStoreValue('port')} is unreachable.`);
      } else {
        // Handle other errors or set as unavailable
        await this.setUnavailable('Device is currently unavailable due to an error.');
      }
    }

    // Polling for regular updates
    this.pollingInterval = setInterval(() => {
      this.updateDeviceData();
    }, this.getSetting('polling_interval') * 1000);
  }

  /**
   * onDeleted is called when the user deleted the device.
   */
  async onDeleted() {
    this.log('MyDevice has been deleted');
    this.deleted = true;
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
    }
    if (this.conn) {
      this.conn.close();
      this.conn = null;
    }
  }

  /**
   * updateDeviceData handles regular updates to device capabilities.
   */
  async updateDeviceData() {
    if (this.deleted) return;
    const ok = await this.ensureConnection();
    if (!ok) {
      // If connection failed, we don't want to throw an error here, just return
      this.log('Connection failed, skipping update');
      return;
    }

    try {
      // Query and update regularly changing data
      const power = await this.conn.queryFloat32(Identifier.INVERTER_AC_POWER_W);
      await this.setCapabilityValue('measure_power', Math.round(power));
      const tokens = { measure_power: Math.round(power) };
      const state = {};
      this.homey.flow.getDeviceTriggerCard('measure_power_changed').trigger(this, tokens, state);

      const battery = await this.conn.queryFloat32(Identifier.BATTERY_SOC);
      this.setCapMeasureBattery(Math.round(battery * 100));

      const tgridpower = await this.conn.queryFloat32(Identifier.TOTAL_GRID_POWER_W);
      await this.setCapabilityValue('total_grid_power', Math.round(tgridpower));

      const loadhousehold = await this.conn.queryFloat32(Identifier.LOAD_HOUSEHOLD_POWER_W);
      await this.setCapabilityValue('load_household', Math.round(loadhousehold));

      const batterypower = await this.conn.queryFloat32(Identifier.BATTERY_POWER_W);
      await this.setCapabilityValue('battery_power', Math.round(batterypower) * -1);

      const deviceSOCStrategy = await this.conn.query(Identifier.POWER_MNG_SOC_STRATEGY);
      await this.setCapSOCStrategy(deviceSOCStrategy);

      if (batterypower < -15) {
        await this.setCapabilityValue('battery_modus', 'charge');
      } else if (batterypower > 15) {
        await this.setCapabilityValue('battery_modus', 'discharge');
      } else {
        await this.setCapabilityValue('battery_modus', 'idle');
      }

      const solarpowera = await this.conn.queryFloat32(Identifier.SOLAR_GEN_A_POWER_W);
      const solarpowerb = await this.conn.queryFloat32(Identifier.SOLAR_GEN_B_POWER_W);
      const solarpower = solarpowera + solarpowerb;
      await this.setCapSolarPower(Math.round(solarpower));

      // Set the device as available
      this.setAvailable();
    } catch (error) {
      this.log('Error updating device:', error);
      if (this.conn) {
        try {
          this.conn.close();
        } catch (e) {}
        this.conn = null;
      }

      // Specific handling for EHOSTUNREACH error
      if (error.code === 'EHOSTUNREACH') {
        await this.setUnavailable(`The target device ${this.getStoreValue('address')}:${this.getStoreValue('port')} is unreachable.`);
      } else {
        await this.setUnavailable('Device is currently unavailable due to an error.');
      }
    }
  }

  // Check if solar_power has changed and set the new value triggering the flow card "Solar Power has changed"
  async setCapSolarPower(value) {
    if (this.getCapabilityValue('solar_power') !== value) {
      await this.setCapabilityValue('solar_power', value);
      const tokens = { Watt: value };
      const state = {};
      this.homey.flow.getDeviceTriggerCard('solar_power_changed').trigger(this, tokens, state);
    }
  }

  // Check if soc_strategy has changed and set the new value triggering the flow card "SOC Strategy has changed"
  async setCapSOCStrategy(value) {
    if (this.getCapabilityValue('soc_strategy') !== value) {
      await this.setCapabilityValue('soc_strategy', value);
      const tokens = { soc_strategy: value };
      const state = {};
      this.homey.flow.getDeviceTriggerCard('soc_strategy_changed').trigger(this, tokens, state);
    }
  }

  // Check if SOC has changed and set the new value triggering the flow card "The SOC has changed"
  async setCapMeasureBattery(value) {
    if (this.getCapabilityValue('measure_battery') !== value) {
      await this.setCapabilityValue('measure_battery', value);
      this.triggerSOCHasChanged(value);

      const tokens = { measure_battery: value };
      const state = {};
      this.homey.flow.getDeviceTriggerCard('measure_battery_changed').trigger(this, tokens, state);
    }
  }

  // Trigger the flow card "The SOC has changed"
  triggerSOCHasChanged(value) {
    const tokens = { soc: value };
    const state = {};

    this.driver.ready().then(() => {
      this.driver.triggerSOCChanged(this, tokens, state);
    });
  }

  // Set Inverter to disable battery discharge mode
  async disableBatteryDischarge() {
    const isEnabled = await this.getSetting('enable_inverter_management');
    if (!isEnabled) {
      throw new Error('Inverter Management is disabled. Enable it in the device settings to use this action.');
    }

    try {
      await this.ensureConnection({ throwOnError: true });
      // Set the inverter to disable battery discharge mode
      await this.conn.write(Identifier.POWER_MNG_SOC_STRATEGY, SOCStrategy.EXTERNAL);
      await this.setCapSOCStrategy(SOCStrategy.toString(SOCStrategy.EXTERNAL));
      await this.conn.write(Identifier.POWER_MNG_BATTERY_POWER_EXTERN_W, 0);
      await this.conn.write(Identifier.POWER_MNG_USE_GRID_POWER_ENABLE, true);
    } catch (error) {
      this.log('Error setting disable battery discharge mode:', error);
      if (this.conn) {
        try {
          this.conn.close();
        } catch (e) {}
        this.conn = null;
      }

      // Specific handling for EHOSTUNREACH error
      if (error.code === 'EHOSTUNREACH') {
        await this.setUnavailable(`The target device ${this.getStoreValue('address')}:${this.getStoreValue('port')} is unreachable.`);
      } else {
        await this.setUnavailable('Device is currently unavailable due to an error:', error.message);
      }
    }
  }

  // Set Inverter to enable solar charging mode
  async enableDefaultOperatingMode() {
    const isEnabled = await this.getSetting('enable_inverter_management');
    if (!isEnabled) {
      throw new Error('Inverter Management is disabled. Enable it in the device settings to use this action.');
    }
    const defaultMaxGridChargePower = await this.getSetting('default_max_grid_charge_power');
    const defaultSocStrategy = await this.getSetting('default_soc_strategy');
    const defaultUseGridPowerEnabled = await this.getSetting('default_use_grid_power_enabled');

    try {
      await this.ensureConnection({ throwOnError: true });
      // Set the inverter to enable solar charging mode
      await this.conn.write(Identifier.POWER_MNG_SOC_STRATEGY, Object.entries(SOCStrategy).find(([_, value]) => SOCStrategy.toString(value) === defaultSocStrategy)?.[1] ?? null);
      await this.setCapSOCStrategy(defaultSocStrategy);
      await this.conn.write(Identifier.POWER_MNG_BATTERY_POWER_EXTERN_W, defaultMaxGridChargePower);
      await this.conn.write(Identifier.POWER_MNG_USE_GRID_POWER_ENABLE, defaultUseGridPowerEnabled);
    } catch (error) {
      this.log('Error setting enable solar charging mode:', error);
      if (this.conn) {
        try {
          this.conn.close();
        } catch (e) {}
        this.conn = null;
      }

      // Specific handling for EHOSTUNREACH error
      if (error.code === 'EHOSTUNREACH') {
        await this.setUnavailable(`The target device ${this.getStoreValue('address')}:${this.getStoreValue('port')} is unreachable.`);
      } else {
        await this.setUnavailable('Device is currently unavailable due to an error.');
      }
    }
  }

  // Set Inverter to enable grid charging mode
  async enableGridCharging() {
    const isEnabled = await this.getSetting('enable_inverter_management');
    if (!isEnabled) {
      throw new Error('Inverter Management is disabled. Enable it in the device settings to use this action.');
    }
    const maxGridPower = await this.getSetting('max_grid_charge_power');

    try {
      await this.ensureConnection({ throwOnError: true });
      // Set the inverter to enable grid charging mode
      await this.conn.write(Identifier.POWER_MNG_SOC_STRATEGY, SOCStrategy.EXTERNAL);
      await this.setCapSOCStrategy(SOCStrategy.toString(SOCStrategy.EXTERNAL));
      await this.conn.write(Identifier.POWER_MNG_BATTERY_POWER_EXTERN_W, -1 * maxGridPower);
      await this.conn.write(Identifier.POWER_MNG_USE_GRID_POWER_ENABLE, true);
    } catch (error) {
      this.log('Error setting enable grid charging mode:', error);
      if (this.conn) {
        try {
          this.conn.close();
        } catch (e) {}
        this.conn = null;
      }

      // Specific handling for EHOSTUNREACH error
      if (error.code === 'EHOSTUNREACH') {
        await this.setUnavailable(`The target device ${this.getStoreValue('address')}:${this.getStoreValue('port')} is unreachable.`);
      } else {
        await this.setUnavailable('Device is currently unavailable due to an error.');
      }
    }
  }

  async ensureConnection({ throwOnError = false } = {}) {
    if (!this.conn) {
      const now = Date.now();
      if (this._lastConnectAttempt && now - this._lastConnectAttempt < 10000) {
        this.log('Delaying reconnect after recent failure');
        if (throwOnError) {
          throw new Error('Delaying reconnect after recent failure');
        }
        return false; // silent fail für Polling
      }
      this.conn = Connection.getPooledConnection(this.getStoreValue('address'), this.getStoreValue('port'), 5000);
      try {
        await this.conn.connect();
      } catch (error) {
        this._lastConnectAttempt = now;
        this.log('Error connecting to device:', error);
        this.conn = null;
        this.setUnavailable(`Could not connect to device at ${this.getStoreValue('address')}:${this.getStoreValue('port')}`);
        if (throwOnError) {
          throw new Error(`Could not connect to device at ${this.getStoreValue('address')}:${this.getStoreValue('port')}`);
        }
        return false;
      }
    }
    return true;
  }

}

module.exports = MyDevice;
