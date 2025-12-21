'use strict';

const RCTDevice = require('../../lib/rct-device');
const {
  getIntervalOfDay,
  getPriceAtTime,
} = require('./time-scheduling-core');
const {
  INTERVAL_MINUTES,
  DEFAULT_DAILY_FETCH_HOUR,
  DEFAULT_CHARGE_POWER_KW,
  DEFAULT_TARGET_SOC,
  DEFAULT_MIN_SOC_THRESHOLD,
  DEFAULT_EFFICIENCY_LOSS_PERCENT,
  DEFAULT_EXPENSIVE_PRICE_FACTOR,
  DEFAULT_MIN_PROFIT_CENT_PER_KWH,
  DEFAULT_FORECAST_DAYS,
} = require('./constants');

const { fetchWithRetry } = require('./services/http-client');
const storeWriteQueue = require('./services/store-write-queue');
const capabilityUtils = require('./services/capability-utils');
const tibberPrices = require('./services/tibber-prices');
const batteryTracking = require('./services/battery-tracking');
const dataCollection = require('./services/data-collection');
const gridPowerService = require('./services/grid-power');
const strategyExecutionService = require('./services/strategy-execution');
const batteryModeService = require('./services/battery-mode');
const strategyCalculationService = require('./services/strategy-calculation');
const batteryCostService = require('./services/battery-cost');
const batteryStatusService = require('./services/battery-status');
const batteryEnergyCostService = require('./services/battery-energy-cost');
const timelineService = require('./services/timeline');
const deviceLookupCache = require('./services/device-lookup-cache');
const deviceUtils = require('./services/device-utils');

class EnergyOptimizerDevice extends RCTDevice {

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async _fetchWithRetry(url, options, retryOptions) {
    return fetchWithRetry(this, url, options, retryOptions);
  }

  /**
   * Queue store writes and flush them in a throttled batch.
   * Reduces flash/IO churn from frequent setStoreValue() calls.
   */
  queueStoreValue(key, value, { immediate = false } = {}) {
    return storeWriteQueue.queueStoreValue(this, key, value, { immediate });
  }

  _scheduleStoreFlush() {
    storeWriteQueue.scheduleStoreFlush(this);
  }

  async flushStoreWrites() {
    await storeWriteQueue.flushStoreWrites(this);
  }

  /**
   * onInit is called when the device is initialized.
   */
  // Override: Virtual device needs no physical connection
  async ensureConnection() {
    // No physical connection needed for optimizer
    return true;
  }

  /**
   * Helper: Get setting with fallback default value
   */
  getSettingOrDefault(key, fallback) {
    let value;
    if (typeof this.getSetting === 'function') {
      value = this.getSetting(key);
    } else if (typeof this.getSettings === 'function') {
      const settings = this.getSettings() || {};
      value = settings[key];
    }
    return (value === null || value === undefined || value === '') ? fallback : value;
  }

  /**
   * Invalidate device/driver caches (call when devices change or on error)
   */
  _invalidateDeviceCache(driverId = null, deviceId = null) {
    return deviceLookupCache.invalidateDeviceCache(this, driverId, deviceId);
  }

  /**
   * Helper: Safely get a driver by ID (with TTL cache)
   */
  getDriverSafe(id) {
    return deviceLookupCache.getDriverSafe(this, id);
  }

  /**
   * Helper: Get device by driver and device ID (with TTL cache)
   */
  getDeviceById(driverId, deviceId) {
    return deviceLookupCache.getDeviceById(this, driverId, deviceId);
  }

  /**
   * Helper: Safely get capability value from a device
   */
  getCapabilitySafe(device, capabilityId) {
    return deviceUtils.getCapabilitySafe(this, device, capabilityId);
  }

  /**
   * Helper: Format date/time in localized format with timezone
   */
  formatLocalizedTime(date) {
    return deviceUtils.formatLocalizedTime(this, date);
  }

  /**
   * Helper: Check if debug logging is enabled
   */
  isDebugEnabled() {
    return !!this.getSetting('debug_logging');
  }

  /**
   * Helper: Log only when debug is enabled
   */
  debug(...args) {
    if (this.isDebugEnabled()) this.log(...args);
  }

  /**
   * Helper: Rate-limited logging per category (max once per N ms)
   */
  logThrottled(category, intervalMs, ...args) {
    capabilityUtils.logThrottled(this, category, intervalMs, ...args);
  }

  /**
   * Helper: Set capability value only if it actually changed.
   * Reduces event spam and CPU usage.
   */
  async setCapabilityValueIfChanged(capabilityId, nextValue, { tolerance = null } = {}) {
    return capabilityUtils.setCapabilityValueIfChanged(this, capabilityId, nextValue, { tolerance });
  }

  /**
   * Normalize and validate numeric settings
   */
  normalizeNumericSettings() {
    const targetSoc = Number(this.getSettingOrDefault('target_soc', DEFAULT_TARGET_SOC));
    this.normalizedTargetSoc = Math.min(100, Math.max(0, targetSoc)) / 100;

    const chargePowerKW = Number(this.getSettingOrDefault('charge_power_kw', DEFAULT_CHARGE_POWER_KW));
    this.normalizedChargePowerKW = chargePowerKW > 0 ? chargePowerKW : DEFAULT_CHARGE_POWER_KW;

    const efficiencyLoss = Number(this.getSettingOrDefault('battery_efficiency_loss', DEFAULT_EFFICIENCY_LOSS_PERCENT));
    this.normalizedEfficiencyLoss = Math.min(50, Math.max(0, efficiencyLoss)) / 100;

    const minProfitCent = Number(this.getSettingOrDefault('min_profit_cent_per_kwh', DEFAULT_MIN_PROFIT_CENT_PER_KWH));
    this.normalizedMinProfitEurPerKWh = minProfitCent / 100;

    const expensivePriceFactor = Number(this.getSettingOrDefault('expensive_price_factor', DEFAULT_EXPENSIVE_PRICE_FACTOR));
    this.normalizedExpensivePriceFactor = expensivePriceFactor > 0 ? expensivePriceFactor : DEFAULT_EXPENSIVE_PRICE_FACTOR;
  }

  async onInit() {
    this.log('Energy Optimizer Device has been initialized');

    // Initialize tracking variables for time-based checks
    this.lastDailyFetchDate = null;
    this.lastOptimizationCheckMinute = -1;
    this.lastDataCollectionMinute = -1;
    this.lastBatteryMode = null;

    // Initialize capabilities if missing
    await this.initializeCapabilities();

    // Set initial capability values
    await this.setCapabilityValueIfChanged('onoff', this.getStoreValue('optimizer_enabled') !== false);
    await this.setCapabilityValueIfChanged('optimizer_status', this.homey.__('status.initializing'));
    await this.setCapabilityValueIfChanged('next_charge_start', this.homey.__('status.not_scheduled'));
    await this.setCapabilityValueIfChanged('estimated_savings', 0);

    // Register capability listeners
    this.registerCapabilityListener('onoff', this.onCapabilityOnoff.bind(this));

    // Initialize data structures
    this.productionHistory = this.getStoreValue('production_history') || {};
    // Signed net grid power history (+import, -export)
    this.consumptionHistory = this.getStoreValue('consumption_history') || {};
    this.batteryHistory = this.getStoreValue('battery_history') || {};
    this.batteryChargeLog = this.getStoreValue('battery_charge_log') || [];
    this.priceCache = [];
    this.currentStrategy = null;
    this.isDeleting = false;

    // Prevent overlapping ticks + throttle store writes
    this._updateDeviceDataRunning = false;
    this._pendingStoreWrites = new Map();
    this._storeWriteTimer = null;
    this._storeWriteDelayMs = 2000;

    // Device/driver lookup cache (TTL-based)
    this._driverCache = new Map();
    this._deviceCache = new Map();
    this._driverCacheTtlMs = 60000; // 60s
    this._deviceCacheTtlMs = 60000; // 60s
    this._negativeCacheTtlMs = 5000; // 5s for not-found

    // Normalize and cache numeric settings
    this.normalizeNumericSettings();

    // Prune histories to remove stale/invalid entries
    const forecastDays = this.getSettingOrDefault('forecast_days', DEFAULT_FORECAST_DAYS);
    this.pruneHistories(forecastDays);

    // Log current settings for debugging
    this.log('Current settings:', this.getSettings());

    // Start optimizer if enabled
    if (this.getCapabilityValue('onoff')) {
      await this.startOptimizer();
    } else {
      await this.setCapabilityValueIfChanged('optimizer_status', this.homey.__('status.stopped'));
    }

    // Call parent's onInit to start polling (no connection needed)
    await super.onInit();
  }

  /**
   * Initialize capabilities if they don't exist
   */
  async initializeCapabilities() {
    const capabilities = ['onoff', 'optimizer_status', 'next_charge_start', 'estimated_savings'];

    for (const capability of capabilities) {
      if (!this.hasCapability(capability)) {
        this.log(`Adding missing capability: ${capability}`);
        await this.addCapability(capability);
      }
    }
  }

  /**
   * Handle onoff capability changes
   */
  async onCapabilityOnoff(value) {
    this.log('Optimizer toggled:', value);

    await this.setStoreValue('optimizer_enabled', value);

    if (value) {
      await this.startOptimizer();
    } else {
      await this.stopOptimizer();
    }

    return true;
  }

  /**
   * Start the Energy Optimizer
   */
  async startOptimizer() {
    this.log('Starting Energy Optimizer...');

    try {
      await this.setCapabilityValueIfChanged('optimizer_status', this.homey.__('status.starting'));

      // Validate configuration
      const config = this.validateConfiguration();
      if (!config.valid) {
        await this.setCapabilityValueIfChanged('optimizer_status', this.homey.__('status.error_config'));
        this.error('Invalid configuration:', config.message);
        await this.setUnavailable(config.message);
        return;
      }

      // Run initial price fetch, optimization and data collection
      await this.fetchPricesFromTibber();
      await this.calculateOptimalStrategy({ force: true });
      await this.collectCurrentData();

      // Execute the strategy immediately to set correct battery mode
      await this.executeOptimizationStrategy();

      await this.setAvailable();
      await this.setCapabilityValueIfChanged('optimizer_status', this.homey.__('status.active'));

      this.log('✓ Energy Optimizer started successfully');
      this.log('  Polling is handled by RCTDevice.startPolling()');
    } catch (error) {
      this.error('Error starting optimizer:', error);
      await this.setCapabilityValueIfChanged('optimizer_status', `${this.homey.__('status.error')}: ${error.message}`);
      await this.setUnavailable(error.message);
    }
  }

  /**
   * Stop the Energy Optimizer
   */
  async stopOptimizer() {
    this.log('Stopping Energy Optimizer...');

    // Only update capabilities if device is not being deleted
    if (!this.isDeleting) {
      await this.setCapabilityValueIfChanged('optimizer_status', this.homey.__('status.stopped'));
      await this.setCapabilityValueIfChanged('next_charge_start', this.homey.__('status.not_scheduled'));
      await this.saveHistoricalData();
    }

    // Best-effort: flush any queued writes before stopping
    await this.flushStoreWrites();

    this.log('Energy Optimizer stopped');
  }

  /**
   * onDeleted is called when the device is deleted
   */
  async onDeleted() {
    this.log('Energy Optimizer has been deleted');
    this.isDeleting = true;
    this.deleted = true;

    // Best-effort: flush any queued writes before teardown
    await this.flushStoreWrites();
    // Call parent to stop polling (no connection to close)
    await super.onDeleted();
  }

  /**
   * Central update method - called by RCTDevice.startPolling()
   * This is the main heartbeat of the optimizer
   */
  async updateDeviceData() {
    if (!this.getCapabilityValue('onoff')) {
      return; // Skip if optimizer is disabled
    }

    // Mutex: avoid overlapping ticks if a previous tick is still running
    if (this._updateDeviceDataRunning) {
      this.debug('⏭️ Skipping update tick (previous still running)');
      return;
    }
    this._updateDeviceDataRunning = true;

    const now = new Date();
    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();
    const currentDate = now.toDateString();

    try {
      // 1. Check for daily price fetch (at configured hour, minute 0)
      const fetchHour = this.getSettingOrDefault('daily_fetch_hour', DEFAULT_DAILY_FETCH_HOUR);
      if (currentHour === fetchHour && currentMinute === 0 && this.lastDailyFetchDate !== currentDate) {
        this.log(`🔄 Daily price fetch triggered at ${now.toLocaleTimeString('de-DE')}`);
        const ok = await this.fetchPricesFromTibber();
        if (ok) {
          this.lastDailyFetchDate = currentDate;
          await this.calculateOptimalStrategy({ force: true });
        }
      }

      // 2. Check for data collection (every 15 minutes: 0, 15, 30, 45)
      const isQuarterHour = (currentMinute % 15 === 0);
      if (isQuarterHour && this.lastDataCollectionMinute !== currentMinute) {
        this.log(`📊 Data collection triggered at ${now.toLocaleTimeString('de-DE')}`);
        this.lastDataCollectionMinute = currentMinute;
        await this.collectCurrentData();
      }

      // 3. Check for optimization execution (every 15 minutes: 0, 15, 30, 45)
      if (isQuarterHour && this.lastOptimizationCheckMinute !== currentMinute) {
        this.log(`⚡ Optimization check triggered at ${now.toLocaleTimeString('de-DE')}`);
        this.lastOptimizationCheckMinute = currentMinute;
        await this.calculateOptimalStrategy();
        await this.executeOptimizationStrategy();
      }
    } catch (error) {
      this.error('Error in updateDeviceData:', error);
    } finally {
      this._updateDeviceDataRunning = false;
    }
  }

  /**
   * Validate configuration
   */
  validateConfiguration() {
    const tibberToken = this.getSetting('tibber_token');
    const tibberHomeId = this.getSetting('tibber_home_id');
    const batteryDeviceId = this.getSetting('battery_device_id');

    // Debug logging
    this.log('Validating configuration:', {
      hasToken: !!tibberToken,
      tokenLength: tibberToken ? tibberToken.length : 0,
      hasHomeId: !!tibberHomeId,
      hasBatteryId: !!batteryDeviceId,
    });

    if (!tibberToken || tibberToken.trim() === '') {
      return { valid: false, message: this.homey.__('error.missing_token') };
    }

    if (!tibberHomeId || tibberHomeId.trim() === '') {
      return { valid: false, message: this.homey.__('error.missing_home_id') };
    }

    if (!batteryDeviceId || batteryDeviceId.trim() === '') {
      return { valid: false, message: this.homey.__('error.missing_battery_id') };
    }

    return { valid: true };
  }

  /**
   * Fetch current prices from Tibber API (called once per day)
   */
  async fetchPricesFromTibber() {
    return tibberPrices.fetchPricesFromTibber(this);
  }

  /**
   * Calculate a simple hash of strategy inputs to detect changes
   */
  _getStrategyInputHash() {
    return strategyCalculationService.getStrategyInputHash(this);
  }

  /**
   * Calculate optimal charging strategy based on price data
   * Uses cached price data - does NOT fetch from API
   */
  async calculateOptimalStrategy({ force = false } = {}) {
    return strategyCalculationService.calculateOptimalStrategy(this, { force });
  }

  /**
   * Group consecutive expensive intervals into blocks
   */
  groupIntoBlocks(intervals) {
    if (!intervals.length) return [];

    const blocks = [];
    let currentBlock = { intervals: [intervals[0]] };

    for (let i = 1; i < intervals.length; i++) {
      // Check if this interval is consecutive to the previous one
      if (intervals[i].index === intervals[i - 1].index + 1) {
        currentBlock.intervals.push(intervals[i]);
      } else {
        // Non-consecutive, start a new block
        blocks.push(currentBlock);
        currentBlock = { intervals: [intervals[i]] };
      }
    }

    // Add the last block
    blocks.push(currentBlock);

    return blocks;
  }

  /**
   * Get interval of day (0-95) from date
   * Delegates to pure function for testability
   */
  getIntervalOfDay(date) {
    return getIntervalOfDay(date, INTERVAL_MINUTES);
  }

  /**
   * Check if optimization plan should be recalculated due to significant battery SoC change
   */
  async shouldRecalculatePlan() {
    try {
      const batteryDeviceId = this.getSettingOrDefault('battery_device_id', '');
      const batteryDevice = this.getDeviceById('rct-power-storage-dc', batteryDeviceId);

      if (!batteryDevice) return false;

      const socValue = this.getCapabilitySafe(batteryDevice, 'measure_battery');
      if (socValue === null) return false;

      const currentSoc = socValue / 100;

      // Store last SoC if not set
      if (this.lastOptimizationSoC === undefined) {
        this.lastOptimizationSoC = currentSoc;
        return false;
      }

      // Recalculate if SoC changed by more than threshold
      const socChange = Math.abs(currentSoc - this.lastOptimizationSoC);
      const minSocThreshold = DEFAULT_MIN_SOC_THRESHOLD / 100;
      if (socChange > minSocThreshold) {
        this.lastOptimizationSoC = currentSoc;
        return true;
      }

      return false;
    } catch (error) {
      return false;
    }
  }

  /**
   * Execute the current optimization strategy
   */
  async executeOptimizationStrategy() {
    return strategyExecutionService.executeOptimizationStrategy(this);
  }

  /**
   * Collect current grid power from grid meter device
   * @returns {number} Grid power in Watts (negative = solar export, positive = consumption)
   */
  async collectGridPower() {
    return gridPowerService.collectGridPower(this);
  }

  /**
   * Apply the decided battery mode to the battery device
   * @param {Object} batteryDevice - Battery device instance
   * @param {Object} decision - Decision object from decideBatteryMode
   */
  async applyBatteryMode(batteryDevice, decision) {
    return batteryModeService.applyBatteryMode(this, batteryDevice, decision);
  }

  /**
   * Log battery mode changes to Homey timeline
   */
  async logBatteryModeChange(mode, details = '') {
    return timelineService.logBatteryModeChange(this, mode, details);
  }

  /**
   * Collect current production and consumption data for forecasting
   */
  async collectCurrentData() {
    await dataCollection.collectCurrentData(this);
  }

  /**
   * Prune history objects: trim arrays to max days, remove empty/invalid keys
   */
  pruneHistories(maxDays) {
    const historyObjects = [
      { name: 'productionHistory', obj: this.productionHistory },
      { name: 'consumptionHistory', obj: this.consumptionHistory },
      { name: 'batteryHistory', obj: this.batteryHistory },
    ];

    historyObjects.forEach(({ name, obj }) => {
      if (!obj || typeof obj !== 'object') return;
      const keys = Object.keys(obj);
      keys.forEach((key) => {
        const arr = obj[key];
        if (!Array.isArray(arr)) {
          delete obj[key];
          return;
        }
        if (arr.length === 0) {
          delete obj[key];
          return;
        }
        // Trim to maxDays
        if (arr.length > maxDays) {
          obj[key] = arr.slice(-maxDays);
        }
      });
    });
  }

  /**
   * Save historical data to device store
   */
  async saveHistoricalData() {
    try {
      // Prune before saving to keep store bounded
      const forecastDays = this.getSettingOrDefault('forecast_days', DEFAULT_FORECAST_DAYS);
      this.pruneHistories(forecastDays);

      this.queueStoreValue('production_history', this.productionHistory);
      this.queueStoreValue('consumption_history', this.consumptionHistory);
      this.queueStoreValue('battery_history', this.batteryHistory);
      this.queueStoreValue('battery_charge_log', this.batteryChargeLog);
      await this.flushStoreWrites();
      this.log('Historical data saved');
    } catch (error) {
      this.error('Error saving historical data:', error);
    }
  }

  /**
   * Track battery charging and discharging events with prices
   * Uses FIFO (First In, First Out) to track actual energy remaining in battery
   */
  async trackBatteryCharging(batteryPower) {
    await batteryTracking.trackBatteryCharging(this, batteryPower);
  }

  /**
   * Get current interval price from cache
   * Delegates to pure function for testability
   */
  getCurrentIntervalPrice(timestamp) {
    return getPriceAtTime(timestamp, this.priceCache, INTERVAL_MINUTES);
  }

  /**
   * Calculate average cost and total amount of energy currently stored in battery
   * Delegates to pure function for testability
   */
  calculateBatteryEnergyCost() {
    return batteryEnergyCostService.calculateBatteryEnergyCost(this);
  }

  /**
   * Estimate battery energy cost when charge log is unavailable
   * Uses default price based on current price data or planned charge intervals
   *
   * @param {number} currentSoc - Current state of charge (0-1)
   * @param {number} batteryCapacity - Battery capacity in kWh
   * @returns {Object|null} Estimated energy cost breakdown
   */
  estimateBatteryEnergyCost(currentSoc, batteryCapacity) {
    return batteryCostService.estimateBatteryEnergyCost(this, currentSoc, batteryCapacity);
  }

  /**
   * Combine tracked and unknown battery energy costs
   * This ensures we always account for the full battery content based on SoC
   *
   * @param {Object|null} tracked - Tracked energy from charge log
   * @param {number} totalKWh - Total energy in battery from SoC
   * @param {number} batteryCapacity - Battery capacity in kWh
   * @returns {Object|null} Combined energy cost with tracked + unknown portions
   */
  combineBatteryCost(tracked, totalKWh, batteryCapacity) {
    return batteryCostService.combineBatteryCost(this, tracked, totalKWh, batteryCapacity);
  }

  /**
   * Update battery status in current strategy with latest data
   * This ensures energyCost is always current even when strategy doesn't change
   */
  async updateBatteryStatus(batteryDevice) {
    return batteryStatusService.updateBatteryStatus(this, batteryDevice);
  }

  /**
   * onAdded is called when the user adds the device
   */
  async onAdded() {
    this.log('Energy Optimizer Device has been added');
    this.log('Initial settings:', this.getSettings());
  }

  /**
   * onSettings is called when the user updates the device's settings
   */
  async onSettings({ oldSettings, newSettings, changedKeys }) {
    this.log('Energy Optimizer settings were changed');
    this.log('Changed keys:', changedKeys);

    // Re-normalize numeric settings
    this.normalizeNumericSettings();

    // Restart optimizer if critical settings changed
    const criticalSettings = [
      'tibber_token',
      'tibber_home_id',
      'battery_device_id',
      'daily_fetch_hour',
    ];

    const needsRestart = changedKeys.some((key) => criticalSettings.includes(key));

    if (needsRestart && this.getCapabilityValue('onoff')) {
      this.log('Critical settings changed, restarting optimizer...');
      await this.stopOptimizer();
      await this.startOptimizer();
    } else if (changedKeys.some((key) => [
      'target_soc',
      'charge_power_kw',
      'battery_efficiency_loss',
      'expensive_price_factor',
      'min_profit_cent_per_kwh',
      'forecast_days',
    ].includes(key))) {
      // Recalculate strategy if optimization parameters changed
      this.log('Optimization parameters changed, recalculating strategy...');
      if (this.priceCache && this.priceCache.length > 0) {
        await this.calculateOptimalStrategy({ force: true });
      }
    }
  }

  /**
   * onRenamed is called when the user updates the device's name
   */
  async onRenamed(name) {
    this.log('Energy Optimizer Device was renamed to:', name);
  }

}

module.exports = EnergyOptimizerDevice;
