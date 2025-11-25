'use strict';

const RCTDevice = require('../../lib/rct-device');
const { Identifier, SOCStrategy } = require('../../lib/rctjavalib/datagram');

class MyDevice extends RCTDevice {

  /**
   * onInit is called when the device is initialized.
   */
  async onInit() {
    this.log('MyDevice has been initialized');
    await super.onInit();
    
    // Migrate device class from solarpanel to battery
    if (this.getClass() !== 'battery') {
      this.log('Migrating device class from solarpanel to battery');
      await this.setClass('battery').catch(this.error);
    }
    
    // Migrate meter_power capabilities for charged/discharged tracking
    if (!this.hasCapability('meter_power.charged')) {
      this.log('Adding meter_power.charged capability');
      await this.addCapability('meter_power.charged');
      // Migrate existing meter_power value if it exists
      if (this.hasCapability('meter_power')) {
        const oldValue = this.getCapabilityValue('meter_power') || 0;
        await this.setCapabilityValue('meter_power.charged', oldValue / 2);
        await this.setCapabilityValue('meter_power.discharged', oldValue / 2);
      } else {
        await this.setCapabilityValue('meter_power.charged', 0);
      }
    }
    if (!this.hasCapability('meter_power.discharged')) {
      this.log('Adding meter_power.discharged capability');
      await this.addCapability('meter_power.discharged');
      if (!this.getCapabilityValue('meter_power.discharged')) {
        await this.setCapabilityValue('meter_power.discharged', 0);
      }
    }
    // Remove old meter_power capability if it exists
    if (this.hasCapability('meter_power')) {
      this.log('Removing old meter_power capability');
      await this.removeCapability('meter_power');
    }
    
    // Check if migration is needed for capability
    if (this.hasCapability('soc_stratgey') === false) {
      await this.addCapability('soc_strategy');
    }

    // Initialize energy tracking
    this._lastUpdate = Date.now();
    this._lastBatteryPower = 0;

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

      const updateSettings = {
        // DeviceId: this.getData().id,
        // DeviceIP: this.getSetting('DeviceIP'),
        // DevicePort: this.getSetting('DevicePort'),
        battery_capacity: roundedCapacity.toString(),
      };

      for (let i = 0; i < batteryModules.length; i++) {
        const serial = await this.conn.queryString(batteryModules[i].serial);
        const umax = await this.conn.queryFloat32(batteryModules[i].umax);
        const umin = await this.conn.queryFloat32(batteryModules[i].umin);
        updateSettings[`battery_module_${i}_serial`] = serial;

        if (serial === '') {
          updateSettings[`battery_module_${i}_health`] = '';
        } else {
          updateSettings[`battery_module_${i}_health`] = (umax < 3.500 && umin >= 3.000) ? 'good' : 'bad';
        }
      }

      await this.setSettings(updateSettings);
    } catch (error) {
      this.log('Error during initialization:', error);
      await this.handleConnectionError(error);
    }
  }

  /**
   * onDeleted is called when the user deleted the device.
   */
  async onDeleted() {
    await super.onDeleted();
  }

  /**
   * updateDeviceData handles regular updates to device capabilities.
   */
  async updateDeviceData() {
    if (this.deleted) return;
    const ok = await this.ensureConnection();
    if (!ok) {
      this.log('Connection failed, skipping update');
      return;
    }

    try {
      // Get current timestamp for energy calculations
      const now = Date.now();
      const timeDeltaHours = (now - this._lastUpdate) / (1000 * 60 * 60);

      // IMPORTANT: RCT battery power convention
      // RCT reports: positive = charging, negative = discharging
      // Homey requires: positive = discharging, negative = charging
      // So we need to INVERT the sign
      const batteryPowerRaw = await this.conn.queryFloat32(Identifier.BATTERY_POWER_W);
      const batteryPowerHomey = -batteryPowerRaw; // INVERT for Homey convention
      
      // Set measure_power with Homey convention (+ discharging, - charging)
      await this.setCapabilityValue('measure_power', Math.round(batteryPowerHomey));

      // Keep custom capability with original RCT convention for backwards compatibility
      await this.setCapabilityValue('battery_power', Math.round(batteryPowerRaw));

      // Calculate cumulative energy separately for charging and discharging
      if (timeDeltaHours > 0) {
        const avgPower = (batteryPowerRaw + this._lastBatteryPower) / 2;
        const energyDelta = Math.abs(avgPower * timeDeltaHours) / 1000; // Convert Wh to kWh
        
        // RCT convention: negative = discharging, positive = charging
        if (avgPower < 0) {
          // Battery is discharging (providing power to home)
          const currentDischarged = this.getCapabilityValue('meter_power.discharged') || 0;
          const newDischarged = currentDischarged + energyDelta;
          await this.setCapabilityValue('meter_power.discharged', newDischarged);
          this.log(`Discharged: ${energyDelta.toFixed(3)} kWh, Total discharged: ${newDischarged.toFixed(2)} kWh`);
        } else if (avgPower > 0) {
          // Battery is charging (consuming power)
          const currentCharged = this.getCapabilityValue('meter_power.charged') || 0;
          const newCharged = currentCharged + energyDelta;
          await this.setCapabilityValue('meter_power.charged', newCharged);
          this.log(`Charged: ${energyDelta.toFixed(3)} kWh, Total charged: ${newCharged.toFixed(2)} kWh`);
        }
      }

      // Store for next calculation
      this._lastBatteryPower = batteryPowerRaw;
      this._lastUpdate = now;

      // Trigger flow card with Homey convention value
      const tokens = { measure_power: Math.round(batteryPowerHomey) };
      const state = {};
      this.homey.flow.getDeviceTriggerCard('measure_power_changed').trigger(this, tokens, state);

      // Battery SOC
      const battery = await this.conn.queryFloat32(Identifier.BATTERY_SOC);
      this.setCapMeasureBattery(Math.round(battery * 100));

      // Grid power (keep custom capability)
      const tgridpower = await this.conn.queryFloat32(Identifier.TOTAL_GRID_POWER_W);
      await this.setCapabilityValue('total_grid_power', Math.round(tgridpower));

      // Household load (keep custom capability)
      const loadhousehold = await this.conn.queryFloat32(Identifier.LOAD_HOUSEHOLD_POWER_W);
      await this.setCapabilityValue('load_household', Math.round(loadhousehold));

      // SOC Strategy
      const deviceSOCStrategy = await this.conn.query(Identifier.POWER_MNG_SOC_STRATEGY);
      await this.setCapSOCStrategy(deviceSOCStrategy);

      // Battery mode (using RCT convention for backwards compatibility)
      if (batteryPowerRaw < -15) {
        await this.setCapabilityValue('battery_modus', 'charge');
      } else if (batteryPowerRaw > 15) {
        await this.setCapabilityValue('battery_modus', 'discharge');
      } else {
        await this.setCapabilityValue('battery_modus', 'idle');
      }

      // Solar power (keep custom capability)
      const solarpowera = await this.conn.queryFloat32(Identifier.SOLAR_GEN_A_POWER_W);
      const solarpowerb = await this.conn.queryFloat32(Identifier.SOLAR_GEN_B_POWER_W);
      const solarpower = solarpowera + solarpowerb;
      await this.setCapSolarPower(Math.round(solarpower));

      this.setAvailable();
    } catch (error) {
      await this.handleConnectionError(error);
    }
  }

  async handleConnectionError(error) {
    this.log('Error in device operation:', error);
    if (this.conn) {
      try {
        this.conn.close();
      } catch (e) {}
      this.conn = null;
    }

    if (error.code === 'EHOSTUNREACH') {
      await this.setUnavailable(`The target device ${this.getStoreValue('address')}:${this.getStoreValue('port')} is unreachable.`);
    } else {
      await this.setUnavailable('Device is currently unavailable due to an error.');
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
    this.log('disableBatteryDischarge called');
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
        await this.setUnavailable(`The target device ${this.getSetting('DeviceIP')}:${this.getSetting('DevicePort')} is unreachable.`);
      } else {
        await this.setUnavailable('Device is currently unavailable due to an error:', error.message);
      }
    }
  }

  // Set Inverter to enable solar charging mode
  async enableDefaultOperatingMode() {
    this.log('enableDefaultOperatingMode called');
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
        await this.setUnavailable(`The target device ${this.getSetting('DeviceIP')}:${this.getSetting('DevicePort')} is unreachable.`);
      } else {
        await this.setUnavailable('Device is currently unavailable due to an error.');
      }
    }
  }

  // Set Inverter to enable grid charging mode
  async enableGridCharging() {
    this.log('enableGridCharging called');
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
        await this.setUnavailable(`The target device ${this.getSetting('DeviceIP')}:${this.getSetting('DevicePort')} is unreachable.`);
      } else {
        await this.setUnavailable('Device is currently unavailable due to an error.');
      }
    }
  }

}

module.exports = MyDevice;
