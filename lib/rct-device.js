'use strict';

const { Device } = require('homey');
const Connection = require('./rctjavalib/connection');

class RCTDevice extends Device {

  async onInit() {
    this.conn = null;
    this.deleted = false;
    this.setAvailable();
    await this.ensureConnection();
    this.startPolling();
  }

  /**
  * onDeleted is called when the user deleted the device.
  */
  async onDeleted() {
    this.log('MyDevice has been deleted');
    this.deleted = true;
    this.stopPolling();
    if (this.conn) {
      this.conn.close();
      this.conn = null;
    }
  }

  async ensureConnection({ throwOnError = false } = {}) {
    if (!this.conn) {
      const now = Date.now();
      if (this._lastConnectAttempt && now - this._lastConnectAttempt < 10000) {
        this.log('Delaying reconnect after recent failure');
        if (throwOnError) throw new Error('Delaying reconnect after recent failure');
        return false;
      }
      this.conn = Connection.getPooledConnection(this.getStoreValue('address'), this.getStoreValue('port'), 5000);
      try {
        await this.conn.connect();
      } catch (error) {
        this._lastConnectAttempt = now;
        this.log('Error connecting to device:', error);
        this.conn = null;
        this.setUnavailable(`Could not connect to device at ${this.getStoreValue('address')}:${this.getStoreValue('port')}`);
        if (throwOnError) throw new Error(`Could not connect to device at ${this.getStoreValue('address')}:${this.getStoreValue('port')}`);
        return false;
      }
    }
    return true;
  }

  startPolling() {
    const interval = (this.getSetting('polling_interval') || 60) * 1000;
    this.stopPolling();
    
    // Call update immediately on start
    this.updateDeviceData().catch(err => this.error('Initial update failed:', err));
    
    // Then set up recurring updates
    this.pollingInterval = setInterval(() => {
      this.updateDeviceData();
    }, interval);
  }

  stopPolling() {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
  }

  // To be overridden by subclasses
  async updateDeviceData() {
    this.log('updateDeviceData() not implemented in subclass');
  }

}

module.exports = RCTDevice;
