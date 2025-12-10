'use strict';

const RCTDevice = require('../../lib/rct-device');
const { Identifier } = require('../../lib/rctjavalib/datagram');

module.exports = class MyDevice extends RCTDevice {

  /**
   * onInit is called when the device is initialized.
   */
  async onInit() {
    this.log('MyDevice has been initialized');

    // Initialize meter_power if it doesn't exist (cumulative energy in kWh)
    if (!this.hasCapability('meter_power')) {
      await this.addCapability('meter_power');
    }
    if (this.getCapabilityValue('meter_power') === null) {
      await this.setCapabilityValue('meter_power', 0);
    }

    // Store last update time for energy calculation
    this._lastUpdateTime = Date.now();
    this._lastPower = 0;

    await super.onInit();
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
    await super.onDeleted();
  }

  async updateDeviceData() {
    if (this.deleted) return;
    const ok = await this.ensureConnection();
    if (!ok) {
      this.log('Connection failed, skipping update');
      return;
    }

    try {
      const solarpowera = await this.conn.queryFloat32(Identifier.SOLAR_GEN_A_POWER_W);
      const solarpowerb = await this.conn.queryFloat32(Identifier.SOLAR_GEN_B_POWER_W);
      const solarpower = solarpowera + solarpowerb;

      // Calculate time delta in hours
      const now = Date.now();
      const deltaTime = (now - this._lastUpdateTime) / (1000 * 60 * 60); // hours

      // Calculate energy generated since last update (kWh)
      // Using trapezoidal rule for integration: (P1 + P2) / 2 * deltaTime
      const avgPower = (this._lastPower + solarpower) / 2; // W
      const energyDelta = (avgPower * deltaTime) / 1000; // kWh

      // Update cumulative meter_power (always increasing)
      if (energyDelta > 0) {
        const currentMeterValue = this.getCapabilityValue('meter_power') || 0;
        const newMeterValue = currentMeterValue + energyDelta;
        await this.setCapabilityValue('meter_power', newMeterValue);
        this.log(`Energy generated: ${energyDelta.toFixed(4)} kWh, Total: ${newMeterValue.toFixed(3)} kWh`);
      }

      // Store values for next iteration
      this._lastUpdateTime = now;
      this._lastPower = solarpower;

      // Update instantaneous power (must be positive when generating)
      if (this.getCapabilityValue('measure_power') !== solarpower) {
        await this.setCapabilityValue('measure_power', solarpower);
      }

      this.setAvailable();
    } catch (error) {
      this.log('Error updating device:', error);
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
  }

};
