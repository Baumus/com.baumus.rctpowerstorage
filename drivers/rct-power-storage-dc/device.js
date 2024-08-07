'use strict';

const { Device } = require('homey');
const Connection = require('../../lib/rctjavalib/connection.js');
const { Identifier } = require('../../lib/rctjavalib/datagram.js');

class MyDevice extends Device {

  /**
   * onInit is called when the device is initialized.
   */
  async onInit() {
    this.log('MyDevice has been initialized');
    this.setAvailable();

    // Error handling for connection errors
    try {
      
      // Establish a connection
      const conn = new Connection(this.getStoreValue('address'), this.getStoreValue('port'), 5000);
      await conn.connect();

      // Query the Battery Capacity
      const bcapacity = await conn.queryFloat32(Identifier.BATTERY_CAPACITY_AH);
      const bvoltage = await conn.queryFloat32(Identifier.BATTERY_VOLTAGE);
      const roundedCapacity = (Math.round(bcapacity * bvoltage / 1000 * 10) / 10).toFixed(1);

      // Query Battery Module Health
      const bm0_Umax = await conn.queryFloat32(Identifier.BATTERY_MODULE_0_UMAX);
      const bm0_Umin = await conn.queryFloat32(Identifier.BATTERY_MODULE_0_UMIN);
      const bm0_serial = await conn.queryString(Identifier.BATTERY_MODULE_0_SERIAL);
      const bm1_Umax = await conn.queryFloat32(Identifier.BATTERY_MODULE_1_UMAX);
      const bm1_Umin = await conn.queryFloat32(Identifier.BATTERY_MODULE_1_UMIN);
      const bm1_serial = await conn.queryString(Identifier.BATTERY_MODULE_1_SERIAL);
      const bm2_Umax = await conn.queryFloat32(Identifier.BATTERY_MODULE_2_UMAX);
      const bm2_Umin = await conn.queryFloat32(Identifier.BATTERY_MODULE_2_UMIN);
      const bm2_serial = await conn.queryString(Identifier.BATTERY_MODULE_2_SERIAL);
      const bm3_Umax = await conn.queryFloat32(Identifier.BATTERY_MODULE_3_UMAX);
      const bm3_Umin = await conn.queryFloat32(Identifier.BATTERY_MODULE_3_UMIN);
      const bm3_serial = await conn.queryString(Identifier.BATTERY_MODULE_3_SERIAL);
      const bm4_Umax = await conn.queryFloat32(Identifier.BATTERY_MODULE_4_UMAX);
      const bm4_Umin = await conn.queryFloat32(Identifier.BATTERY_MODULE_4_UMIN);
      const bm4_serial = await conn.queryString(Identifier.BATTERY_MODULE_4_SERIAL);
      const bm5_Umax = await conn.queryFloat32(Identifier.BATTERY_MODULE_5_UMAX);
      const bm5_Umin = await conn.queryFloat32(Identifier.BATTERY_MODULE_5_UMIN);
      const bm5_serial = await conn.queryString(Identifier.BATTERY_MODULE_5_SERIAL);
      const bm6_Umax = await conn.queryFloat32(Identifier.BATTERY_MODULE_6_UMAX);
      const bm6_Umin = await conn.queryFloat32(Identifier.BATTERY_MODULE_6_UMIN);
      const bm6_serial = await conn.queryString(Identifier.BATTERY_MODULE_6_SERIAL);


      await this.setSettings({
        DeviceId: this.getData().id,
        DeviceIP: this.getStoreValue('address'),
        DevicePort: this.getStoreValue('port'),
        battery_capacity: roundedCapacity.toString(),
        battery_module_0_serial: bm0_serial,
        battery_module_0_health: (bm0_serial === '') ? '' : (bm0_Umax < 3.500 && bm0_Umin >= 3.000) ? 'good' : 'bad',
        battery_module_1_serial: bm1_serial,
        battery_module_1_health: (bm1_serial === '') ? '' : (bm1_Umax < 3.500 && bm1_Umin >= 3.000) ? 'good' : 'bad',
        battery_module_2_serial: bm2_serial,
        battery_module_2_health: (bm2_serial === '') ? '' : (bm2_Umax < 3.500 && bm2_Umin >= 3.000) ? 'good' : 'bad',
        battery_module_3_serial: bm3_serial,
        battery_module_3_health: (bm3_serial === '') ? '' : (bm3_Umax < 3.500 && bm3_Umin >= 3.000) ? 'good' : 'bad',
        battery_module_4_serial: bm4_serial,
        battery_module_4_health: (bm4_serial === '') ? '' : (bm4_Umax < 3.500 && bm4_Umin >= 3.000) ? 'good' : 'bad',
        battery_module_5_serial: bm5_serial,
        battery_module_5_health: (bm5_serial === '') ? '' : (bm5_Umax < 3.500 && bm5_Umin >= 3.000) ? 'good' : 'bad',
        battery_module_6_serial: bm6_serial,
        battery_module_6_health: (bm6_serial == '') ? '' : (bm6_Umax < 3.500 && bm6_Umin >= 3.000) ? 'good' : 'bad'
      });

      // Close the connection when done
      conn.close();

    } catch (error) {
      this.log('Error updating device:', error);

      // Specific handling for EHOSTUNREACH error
      if (error.code === 'EHOSTUNREACH') {
          this.setUnavailable(`The target device ${this.getStoreValue('address')}:${this.getStoreValue('port')} is unreachable.`);
      } else {
          // Handle other errors or set as unavailable
          this.setUnavailable('Device is currently unavailable due to an error.');
      }
    }

    this.updateMyDevice();
    //this.log('MyDevice has been updated');

    // Polling
    setInterval(() => {
      this.updateMyDevice();
    }, this.getSetting('polling_interval') * 1000);
  }

  /**
   * onAdded is called when the user adds the device, called just after pairing.
   */
  async onAdded() {
    this.log('MyDevice has been added');
  }

  /**
   * onSettings is called when the user updates the device's settings.
   * @param {object} event the onSettings event data
   * @param {object} event.oldSettings The old settings object
   * @param {object} event.newSettings The new settings object
   * @param {string[]} event.changedKeys An array of keys changed since the previous version
   * @returns {Promise<string|void>} return a custom message that will be displayed
   */
  async onSettings({ oldSettings, newSettings, changedKeys }) {
    this.log('MyDevice settings where changed');
  }

  /**
   * onRenamed is called when the user updates the device's name.
   * This method can be used this to synchronise the name to the device.
   * @param {string} name The new name
   */
  async onRenamed(name) {
    this.log('MyDevice was renamed');
  }

  /**
   * onDeleted is called when the user deleted the device.
   */
  async onDeleted() {
    this.log('MyDevice has been deleted');
    //this.polling = false;
  }

  //Daten mit Hilfe der RCT Java Library auslesen und in Homey übertragen
  async updateMyDevice() {

    try {

      // Establish a connection
      const conn = new Connection(this.getStoreValue('address'), this.getStoreValue('port'), 5000);
      await conn.connect();

      // Query the Inverter AC power value
      const power = await conn.queryFloat32(Identifier.INVERTER_AC_POWER_W);
      //console.log(`${Identifier.toString(Identifier.INVERTER_AC_POWER_W)}: ${Math.round(power)} W`);
      this.setCapabilityValue('measure_power', Math.round(power));
      
      // Query the Battery value
      const battery = await conn.queryFloat32(Identifier.BATTERY_SOC);
      //console.log(`Battery: ${Math.round(battery*100)} %`);
      this.setCapMeasureBattery(Math.round(battery*100));

      // Query the Total Grid Power value
      const tgridpower = await conn.queryFloat32(Identifier.TOTAL_GRID_POWER_W);
      //console.log(`Total Grid Power: ${Math.round(tgridpower)} W`);
      this.setCapabilityValue('total_grid_power', Math.round(tgridpower));

      // Query the Load Household Power value
      const loadhousehold = await conn.queryFloat32(Identifier.LOAD_HOUSEHOLD_POWER_W);
      //console.log(`Load Household Power: ${Math.round(loadhousehold)} W`);
      this.setCapabilityValue('load_household', Math.round(loadhousehold));

      // Query the Battery Power value
      const batterypower = await conn.queryFloat32(Identifier.BATTERY_POWER_W);
      //console.log(`Battery Power: ${Math.round(batterypower)*-1} W`);
      this.setCapabilityValue('battery_power', Math.round(batterypower)*-1);

      if (batterypower < 0) {
        this.setCapabilityValue('battery_modus', 'charge');
      } else if (batterypower > 0) {
        this.setCapabilityValue('battery_modus', 'discharge');
      } else {
        this.setCapabilityValue('battery_modus', 'idle');
      }

      // Query the Solar Power value as Sum of Solar Panel Power A und B
      const solarpowera = await conn.queryFloat32(Identifier.SOLAR_GEN_A_POWER_W);
      const solarpowerb = await conn.queryFloat32(Identifier.SOLAR_GEN_B_POWER_W);
      const solarpower = solarpowera + solarpowerb;
      //console.log(`Solar Power: ${Math.round(solarpower)} W`);
      this.setCapabilityValue('solar_power', Math.round(solarpower));
      
      // Set the device as available
      this.setAvailable();

      // Close the connection when done
      conn.close();

    } catch (error) {
      this.log('Error updating device:', error);

      // Specific handling for EHOSTUNREACH error
      if (error.code === 'EHOSTUNREACH') {
          this.setUnavailable(`The target device ${this.getStoreValue('address')}:${this.getStoreValue('port')} is unreachable.`);
      } else {
          // Handle other errors or set as unavailable
          this.setUnavailable('Device is currently unavailable due to an error.');
      }
  }
  } 

  //Check if SOC has changed and set the new value triggering the flow card "The SOC has changed"
  async setCapMeasureBattery(value) {
    if (this.getCapabilityValue('measure_battery') !== value) {
      this.setCapabilityValue('measure_battery', value);
      this.triggerSOCHasChanged(value);
    }
  }

  //Trigger the flow card "The SOC has changed"
  triggerSOCHasChanged(value) {
    let tokens = {
      soc: value
    };
    let state = {};

    this.driver.ready().then(() => {
      this.driver.triggerSOCChanged(this, tokens, state);
    });
  }
}

module.exports = MyDevice;

