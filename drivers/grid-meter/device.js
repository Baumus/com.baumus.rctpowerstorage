'use strict';

const RCTDevice = require('../../lib/rct-device');
const { Identifier } = require('../../lib/rctjavalib/datagram');

module.exports = class MyDevice extends RCTDevice {

  async onInit() {
    this.log('Grid Meter Device has been initialized');
    
    // Initialize meter_power capabilities if missing
    if (!this.hasCapability('meter_power.imported')) {
      await this.addCapability('meter_power.imported');
      await this.setCapabilityValue('meter_power.imported', 0);
    }
    if (!this.hasCapability('meter_power.exported')) {
      await this.addCapability('meter_power.exported');
      await this.setCapabilityValue('meter_power.exported', 0);
    }
    
    // Initialize energy tracking
    this._lastUpdate = Date.now();
    this._lastGridPower = 0;
    
    await super.onInit();
  }

  async onAdded() {
    this.log('Grid Meter Device has been added');
  }

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    this.log('Grid Meter Device settings where changed');
  }

  async onRenamed(name) {
    this.log('Grid Meter Device was renamed');
  }

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
      // Get current timestamp for energy calculations
      const now = Date.now();
      const timeDeltaHours = (now - this._lastUpdate) / (1000 * 60 * 60);

      // Grid power (positive = importing from grid, negative = exporting to grid)
      const gridPower = await this.conn.queryFloat32(Identifier.TOTAL_GRID_POWER_W);
      
      // Update instantaneous power
      await this.setCapabilityValue('measure_power', Math.round(gridPower));

      // Calculate cumulative energy separately for import and export
      if (timeDeltaHours > 0) {
        const avgPower = (gridPower + this._lastGridPower) / 2;
        const energyDelta = Math.abs(avgPower * timeDeltaHours) / 1000; // Convert Wh to kWh
        
        if (avgPower > 0) {
          // Importing from grid
          const currentImported = this.getCapabilityValue('meter_power.imported') || 0;
          const newImported = currentImported + energyDelta;
          await this.setCapabilityValue('meter_power.imported', newImported);
          this.log(`Grid import: ${energyDelta.toFixed(3)} kWh, Total imported: ${newImported.toFixed(2)} kWh`);
        } else if (avgPower < 0) {
          // Exporting to grid
          const currentExported = this.getCapabilityValue('meter_power.exported') || 0;
          const newExported = currentExported + energyDelta;
          await this.setCapabilityValue('meter_power.exported', newExported);
          this.log(`Grid export: ${energyDelta.toFixed(3)} kWh, Total exported: ${newExported.toFixed(2)} kWh`);
        }
      }

      // Store for next calculation
      this._lastGridPower = gridPower;
      this._lastUpdate = now;

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
