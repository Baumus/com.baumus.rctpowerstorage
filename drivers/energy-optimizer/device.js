'use strict';

const RCTDevice = require('../../lib/rct-device');
const { computeHeuristicStrategy, optimizeStrategyWithLp } = require('./optimizer-core');
const { decideBatteryMode, BATTERY_MODE } = require('./strategy-execution-core');
const {
  calculateBatteryEnergyCost,
  createChargeEntry,
  createDischargeEntry,
  shouldClearChargeLog,
  trimChargeLog,
} = require('./battery-cost-core');
const {
  getIntervalOfDay,
  getPriceAtTime,
  filterCurrentAndFutureIntervals,
  enrichPriceData,
} = require('./time-scheduling-core');

// Try to load LP solver from submodule
let lpSolver;
try {
  // eslint-disable-next-line global-require
  lpSolver = require('../../lib/javascript-lp-solver/src/main');
} catch (error) {
  // LP solver not available, will fall back to heuristic
}

// Constants
const INTERVAL_MINUTES = 15;
const INTERVAL_HOURS = INTERVAL_MINUTES / 60;
const DEFAULT_DAILY_FETCH_HOUR = 15;
const DEFAULT_BATTERY_CAPACITY_KWH = 9.9;
const DEFAULT_CHARGE_POWER_KW = 6.0;
const DEFAULT_TARGET_SOC = 85; // %
const DEFAULT_EFFICIENCY_LOSS_PERCENT = 10; // %
const DEFAULT_EXPENSIVE_PRICE_FACTOR = 1.05;
const DEFAULT_MIN_PROFIT_CENT_PER_KWH = 6;
const DEFAULT_FORECAST_DAYS = 7;
const DEFAULT_MIN_SOC_THRESHOLD = 7;
const GRID_SOLAR_THRESHOLD_W = -50;
const GRID_CONSUMPTION_THRESHOLD_W = 50;
const MAX_BATTERY_LOG_DAYS = 7;
const INTERVALS_PER_DAY = 96;
const MAX_BATTERY_LOG_ENTRIES = MAX_BATTERY_LOG_DAYS * INTERVALS_PER_DAY;
const PRICE_TIMEZONE = 'Europe/Berlin';

class EnergyOptimizerDevice extends RCTDevice {

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async _fetchWithTimeout(url, options, timeoutMs) {
    // Prefer aborting the underlying request when supported.
    if (typeof AbortController === 'function') {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        return await fetch(url, { ...options, signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
    }

    // Fallback: race without abort.
    return Promise.race([
      fetch(url, options),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`Fetch timeout after ${timeoutMs}ms`)), timeoutMs)),
    ]);
  }

  _isRetriableHttpStatus(status) {
    return status === 429 || (status >= 500 && status <= 599);
  }

  async _fetchWithRetry(url, options, {
    timeoutMs = 10000,
    maxAttempts = 3,
    baseDelayMs = 1000,
    maxDelayMs = 15000,
  } = {}) {
    let lastError;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const response = await this._fetchWithTimeout(url, options, timeoutMs);
        if (!response || typeof response.ok !== 'boolean') {
          throw new Error('Unexpected fetch response');
        }

        if (!response.ok) {
          const { status } = response;
          const { statusText } = response;
          const error = new Error(`HTTP ${status} ${statusText}`);
          error.httpStatus = status;

          if (this._isRetriableHttpStatus(status) && attempt < maxAttempts) {
            lastError = error;
          } else {
            throw error;
          }
        } else {
          return response;
        }
      } catch (error) {
        lastError = error;
        const isAbort = error && (error.name === 'AbortError' || /aborted/i.test(String(error.message)));
        const httpStatus = error && error.httpStatus;
        const retriable = isAbort || (typeof httpStatus === 'number' && this._isRetriableHttpStatus(httpStatus));

        if (!retriable || attempt >= maxAttempts) {
          throw lastError;
        }
      }

      const jitterMs = Math.floor(Math.random() * 250);
      const expDelay = baseDelayMs * (2 ** (attempt - 1));
      const delay = Math.min(maxDelayMs, expDelay + jitterMs);
      await this._sleep(delay);
    }

    throw lastError || new Error('Fetch failed');
  }

  /**
   * Queue store writes and flush them in a throttled batch.
   * Reduces flash/IO churn from frequent setStoreValue() calls.
   */
  queueStoreValue(key, value, { immediate = false } = {}) {
    if (!this._pendingStoreWrites) this._pendingStoreWrites = new Map();
    this._pendingStoreWrites.set(key, value);

    if (immediate) {
      return this.flushStoreWrites();
    }

    this._scheduleStoreFlush();
    return Promise.resolve();
  }

  _scheduleStoreFlush() {
    if (this._storeWriteTimer) return;
    const delayMs = this._storeWriteDelayMs || 2000;
    this._storeWriteTimer = setTimeout(() => {
      this._storeWriteTimer = null;
      this.flushStoreWrites().catch((error) => {
        this.error('Error flushing queued store writes:', error);
      });
    }, delayMs);
  }

  async flushStoreWrites() {
    if (this._storeWriteTimer) {
      clearTimeout(this._storeWriteTimer);
      this._storeWriteTimer = null;
    }

    const entries = this._pendingStoreWrites ? [...this._pendingStoreWrites.entries()] : [];
    if (!entries.length) return;
    this._pendingStoreWrites.clear();

    const failed = [];
    await Promise.all(entries.map(async ([storeKey, storeValue]) => {
      try {
        await this.setStoreValue(storeKey, storeValue);
      } catch (error) {
        failed.push([storeKey, storeValue, error]);
      }
    }));

    if (failed.length) {
      failed.forEach(([storeKey, storeValue, error]) => {
        this.error(`Failed to persist store key "${storeKey}":`, error);
        this._pendingStoreWrites.set(storeKey, storeValue);
      });
      this._scheduleStoreFlush();
    }
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
    const value = this.getSetting(key);
    return (value === null || value === undefined || value === '') ? fallback : value;
  }

  /**
   * Invalidate device/driver caches (call when devices change or on error)
   */
  _invalidateDeviceCache(driverId = null, deviceId = null) {
    if (!this._driverCache) this._driverCache = new Map();
    if (!this._deviceCache) this._deviceCache = new Map();

    if (driverId && deviceId) {
      this._deviceCache.delete(`${driverId}:${deviceId}`);
    } else if (driverId) {
      this._driverCache.delete(driverId);
      // Also clear all device entries for this driver
      for (const key of this._deviceCache.keys()) {
        if (key.startsWith(`${driverId}:`)) {
          this._deviceCache.delete(key);
        }
      }
    } else {
      // Clear all
      this._driverCache.clear();
      this._deviceCache.clear();
    }
  }

  /**
   * Helper: Safely get a driver by ID (with TTL cache)
   */
  getDriverSafe(id) {
    if (!this._driverCache) this._driverCache = new Map();
    const now = Date.now();
    const cached = this._driverCache.get(id);
    if (cached && now < cached.expiresAt) {
      return cached.driver;
    }

    try {
      const driver = this.homey.drivers.getDriver(id);
      this._driverCache.set(id, { driver, expiresAt: now + this._driverCacheTtlMs });
      return driver;
    } catch (error) {
      this.log(`Driver "${id}" not accessible:`, error.message);
      // Negative cache: remember "not found" for shorter TTL
      this._driverCache.set(id, { driver: null, expiresAt: now + this._negativeCacheTtlMs });
      return null;
    }
  }

  /**
   * Helper: Get device by driver and device ID (with TTL cache)
   */
  getDeviceById(driverId, deviceId) {
    if (!deviceId || !deviceId.trim()) return null;

    if (!this._deviceCache) this._deviceCache = new Map();
    if (!this._deviceCacheTtlMs) this._deviceCacheTtlMs = 60000;
    if (!this._negativeCacheTtlMs) this._negativeCacheTtlMs = 5000;

    const cacheKey = `${driverId}:${deviceId}`;
    const now = Date.now();
    const cached = this._deviceCache.get(cacheKey);
    if (cached && now < cached.expiresAt) {
      return cached.device;
    }

    const driver = this.getDriverSafe(driverId);
    if (!driver) {
      // Negative cache for device when driver missing
      this._deviceCache.set(cacheKey, { device: null, expiresAt: now + this._negativeCacheTtlMs });
      return null;
    }

    try {
      const devices = driver.getDevices();
      const device = devices.find((d) => d.getData().id === deviceId);
      const ttl = device ? this._deviceCacheTtlMs : this._negativeCacheTtlMs;
      this._deviceCache.set(cacheKey, { device: device || null, expiresAt: now + ttl });
      return device || null;
    } catch (error) {
      this.log(`Error getting device ${deviceId} from driver ${driverId}:`, error.message);
      this._deviceCache.set(cacheKey, { device: null, expiresAt: now + this._negativeCacheTtlMs });
      return null;
    }
  }

  /**
   * Helper: Safely get capability value from a device
   */
  getCapabilitySafe(device, capabilityId) {
    if (!device || !device.hasCapability || !device.getCapabilityValue) return null;
    if (!device.hasCapability(capabilityId)) return null;
    try {
      return device.getCapabilityValue(capabilityId);
    } catch (error) {
      this.log(`Failed to get capability ${capabilityId}:`, error.message);
      return null;
    }
  }

  /**
   * Helper: Format date/time in localized format with timezone
   */
  formatLocalizedTime(date) {
    return date.toLocaleString(this.homey.i18n.getLanguage(), {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: PRICE_TIMEZONE,
    });
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
    if (!this._logThrottle) this._logThrottle = new Map();
    const now = Date.now();
    const last = this._logThrottle.get(category) || 0;
    if (now - last < intervalMs) return;
    this._logThrottle.set(category, now);
    this.log(...args);
  }

  /**
   * Helper: Set capability value only if it actually changed.
   * Reduces event spam and CPU usage.
   */
  async setCapabilityValueIfChanged(capabilityId, nextValue, { tolerance = null } = {}) {
    if (!this.hasCapability(capabilityId)) return false;

    if (!this._capabilityLastValues) this._capabilityLastValues = new Map();
    const cached = this._capabilityLastValues.has(capabilityId)
      ? this._capabilityLastValues.get(capabilityId)
      : this.getCapabilityValue(capabilityId);

    const bothNumbers = typeof cached === 'number' && typeof nextValue === 'number' && Number.isFinite(cached) && Number.isFinite(nextValue);
    const isSame = bothNumbers && typeof tolerance === 'number'
      ? Math.abs(cached - nextValue) <= tolerance
      : cached === nextValue;

    if (isSame) return false;

    await this.setCapabilityValue(capabilityId, nextValue);
    this._capabilityLastValues.set(capabilityId, nextValue);
    return true;
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
    this.consumptionHistory = this.getStoreValue('consumption_history') || {};
    this.batteryHistory = this.getStoreValue('battery_history') || {};
    this.gridHistory = this.getStoreValue('grid_history') || {};
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
    try {
      // Simple circuit breaker to avoid hammering Tibber when unreachable.
      if (!this._tibberCircuit) {
        this._tibberCircuit = { failures: 0, nextAllowedAt: 0 };
      }

      const now = Date.now();
      if (this._tibberCircuit.nextAllowedAt && now < this._tibberCircuit.nextAllowedAt) {
        const waitSec = Math.ceil((this._tibberCircuit.nextAllowedAt - now) / 1000);
        this.debug(`⏳ Tibber fetch blocked by circuit breaker (${waitSec}s remaining)`);
        return false;
      }

      this.log('📡 Fetching Tibber prices from API...');
      await this.setCapabilityValueIfChanged('optimizer_status', this.homey.__('status.fetching_prices'));

      const tibberToken = this.getSettingOrDefault('tibber_token', '');
      const tibberHomeId = this.getSettingOrDefault('tibber_home_id', '');

      const query = `
        {
          viewer {
            homes {
              id
              currentSubscription {
                priceInfo(resolution: QUARTER_HOURLY) {
                  today { startsAt total }
                  tomorrow { startsAt total }
                }
              }
            }
          }
        }
      `;

      const response = await this._fetchWithRetry('https://api.tibber.com/v1-beta/gql', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tibberToken}`,
        },
        body: JSON.stringify({ query }),
      }, {
        timeoutMs: 12000,
        maxAttempts: 3,
        baseDelayMs: 1000,
        maxDelayMs: 15000,
      });

      if (!response.ok) {
        throw new Error(`Tibber API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();

      // Validate response structure
      if (!data || !data.data || !data.data.viewer || !Array.isArray(data.data.viewer.homes)) {
        throw new Error('Unexpected Tibber API response format');
      }

      if (data.errors) {
        throw new Error(`Tibber API errors: ${JSON.stringify(data.errors)}`);
      }

      const home = data.data.viewer.homes.find((h) => h.id === tibberHomeId);

      if (!home) {
        throw new Error(this.homey.__('error.home_not_found'));
      }

      const { priceInfo } = home.currentSubscription;
      const today = priceInfo.today || [];
      const tomorrow = priceInfo.tomorrow || [];

      const nowDate = new Date();
      // Include current and future intervals using pure function
      this.priceCache = filterCurrentAndFutureIntervals(
        [...today, ...tomorrow],
        nowDate,
        INTERVAL_MINUTES,
      );

      this.log(`✅ Fetched ${this.priceCache.length} price intervals (from ${this.priceCache.length > 0 ? new Date(this.priceCache[0].startsAt).toLocaleString() : 'N/A'})`);

      await this.setCapabilityValueIfChanged('optimizer_status', this.homey.__('status.active'));
      await this.setAvailable();

      // Reset circuit breaker on success
      this._tibberCircuit.failures = 0;
      this._tibberCircuit.nextAllowedAt = 0;
      return true;
    } catch (error) {
      this.error('Error fetching prices:', error);
      await this.setCapabilityValueIfChanged('optimizer_status', `${this.homey.__('status.error')}: ${error.message}`);

      // Trip circuit breaker progressively on repeated failures
      if (!this._tibberCircuit) {
        this._tibberCircuit = { failures: 0, nextAllowedAt: 0 };
      }
      this._tibberCircuit.failures += 1;
      const { failures } = this._tibberCircuit;
      if (failures >= 3) {
        const baseMs = 5 * 60 * 1000; // 5 minutes
        const backoffMs = Math.min(6 * 60 * 60 * 1000, baseMs * (2 ** (failures - 3)));
        this._tibberCircuit.nextAllowedAt = Date.now() + backoffMs;
      }

      // Don't set unavailable for temporary API errors
      if (!error.message.includes('API error')) {
        await this.setUnavailable(error.message);
      }

      return false;
    }
  }

  /**
   * Calculate a simple hash of strategy inputs to detect changes
   */
  _getStrategyInputHash() {
    const batteryDeviceId = this.getSettingOrDefault('battery_device_id', '');
    const batteryDevice = this.getDeviceById('rct-power-storage-dc', batteryDeviceId);
    const socValue = this.getCapabilitySafe(batteryDevice, 'measure_battery');
    const soc = socValue !== null ? Math.round(socValue) : 0;

    const priceLen = this.priceCache ? this.priceCache.length : 0;
    const targetSoc = this.normalizedTargetSoc || 0;
    const chargePower = this.normalizedChargePowerKW || 0;
    const effLoss = this.normalizedEfficiencyLoss || 0;

    return `${priceLen}:${soc}:${targetSoc}:${chargePower}:${effLoss}`;
  }

  /**
   * Calculate optimal charging strategy based on price data
   * Uses cached price data - does NOT fetch from API
   */
  async calculateOptimalStrategy({ force = false } = {}) {
    // Skip recalc if inputs haven't changed (unless forced)
    if (!force && this._lastStrategyInputHash) {
      const currentHash = this._getStrategyInputHash();
      if (currentHash === this._lastStrategyInputHash) {
        this.debug('⏭️ Skipping strategy recalc (no input changes)');
        return;
      }
      this._lastStrategyInputHash = currentHash;
    } else if (!force) {
      this._lastStrategyInputHash = this._getStrategyInputHash();
    }

    this.log('\n🔄 Recalculating optimization strategy with current battery status...');

    if (!this.priceCache.length) {
      this.log('⚠️ No price data available - cannot optimize');
      return;
    }

    const now = new Date();
    const availableData = filterCurrentAndFutureIntervals(
      this.priceCache,
      now,
      INTERVAL_MINUTES,
    );

    if (!availableData.length) {
      this.log('No price data available');
      this.currentStrategy = { chargeIntervals: [] };
      await this.setCapabilityValueIfChanged('next_charge_start', this.homey.__('status.no_data'));
      return;
    }

    // Get battery configuration
    const batteryDeviceId = this.getSettingOrDefault('battery_device_id', '');
    const batteryDevice = this.getDeviceById('rct-power-storage-dc', batteryDeviceId);

    if (!batteryDevice) {
      this.error(`Battery device not found with ID: ${batteryDeviceId}`);
      await this.setCapabilityValueIfChanged('optimizer_status', this.homey.__('error.battery_not_found'));
      return;
    }

    let currentSoc = 0;
    const socValue = this.getCapabilitySafe(batteryDevice, 'measure_battery');
    if (socValue !== null) {
      currentSoc = socValue / 100;
    } else {
      this.log('Warning: Could not read current SoC from battery device');
    }

    const batteryCapacity = parseFloat(batteryDevice.getSetting('battery_capacity')) || DEFAULT_BATTERY_CAPACITY_KWH;
    const chargePowerKW = this.normalizedChargePowerKW;
    const energyPerInterval = chargePowerKW * INTERVAL_HOURS;
    const maxTargetSoc = this.normalizedTargetSoc;
    const BATTERY_EFFICIENCY_LOSS = this.normalizedEfficiencyLoss;
    const maxBatteryKWh = batteryCapacity * (maxTargetSoc - currentSoc);

    // Economic inputs / constraints (no new settings):
    // - min_soc_threshold is the lower SoC bound
    // - min_profit_cent_per_kwh is the minimum profit margin
    // - battery energy cost basis is derived from the same combined energyCost shown in the UI
    const minSocThresholdPercent = Number(this.getSettingOrDefault('min_soc_threshold', DEFAULT_MIN_SOC_THRESHOLD));
    const minSocThreshold = Math.max(0, Math.min(100, minSocThresholdPercent)) / 100;
    const configuredMinEnergyKWh = batteryCapacity * minSocThreshold;
    const currentEnergyKWh = currentSoc * batteryCapacity;
    const maxEnergyKWh = maxTargetSoc * batteryCapacity;
    const minEnergyKWh = Math.min(
      Math.min(configuredMinEnergyKWh, maxEnergyKWh),
      currentEnergyKWh,
    );

    const storedKWh = currentEnergyKWh;
    const trackedCost = this.calculateBatteryEnergyCost();
    const batteryCostInfo = currentSoc > 0.05
      ? this.combineBatteryCost(trackedCost, storedKWh, batteryCapacity)
      : null;

    const minProfitCent = Number(this.getSettingOrDefault('min_profit_cent_per_kwh', DEFAULT_MIN_PROFIT_CENT_PER_KWH));
    const minProfitEurPerKWh = Number.isFinite(minProfitCent) ? Math.max(0, minProfitCent) / 100 : 0;

    this.log('\n=== BATTERY STATUS ===');
    this.log(`Current SoC: ${(currentSoc * 100).toFixed(1)}%, Max target: ${(maxTargetSoc * 100).toFixed(1)}%`);
    this.log(`Available capacity: ${maxBatteryKWh.toFixed(2)} kWh (can charge from ${(currentSoc * 100).toFixed(1)}% to ${(maxTargetSoc * 100).toFixed(1)}%)`);
    this.log(`Charge power: ${chargePowerKW} kW = ${energyPerInterval.toFixed(2)} kWh per interval`);
    this.log(`Battery efficiency loss: ${(BATTERY_EFFICIENCY_LOSS * 100).toFixed(1)}%`);

    // Add index and intervalOfDay to all data using pure function
    const indexedData = enrichPriceData(availableData, INTERVAL_MINUTES);

    const avgPrice = indexedData.reduce((sum, p) => sum + p.total, 0) / indexedData.length;
    this.log(`Average price: ${avgPrice.toFixed(4)} €/kWh`);

    // Try LP-based optimization first
    const lpResult = optimizeStrategyWithLp(
      indexedData,
      {
        batteryCapacity,
        currentSoc,
        targetSoc: maxTargetSoc,
        chargePowerKW,
        intervalHours: INTERVAL_HOURS,
        efficiencyLoss: BATTERY_EFFICIENCY_LOSS,
        minEnergyKWh,
        batteryCostEurPerKWh: batteryCostInfo?.avgPrice,
        minProfitEurPerKWh,
      },
      {
        productionHistory: this.productionHistory || {},
        consumptionHistory: this.gridHistory || {},
        batteryHistory: this.batteryHistory || {},
      },
      {
        lpSolver,
        logger: this,
      },
    );

    if (lpResult) {
      const {
        chargeIntervals,
        dischargeIntervals,
        totalChargeKWh,
        totalDischargeKWh,
        savings,
      } = lpResult;

      this.currentStrategy = {
        chargeIntervals,
        dischargeIntervals,
        expensiveIntervals: dischargeIntervals,
        avgPrice,
        neededKWh: totalChargeKWh,
        forecastedDemand: totalDischargeKWh,
        batteryStatus: {
          currentSoc,
          targetSoc: maxTargetSoc,
          availableCapacity: maxBatteryKWh,
          batteryCapacity,
          storedKWh,
          energyCost: batteryCostInfo,
        },
      };

      this.lastOptimizationSoC = currentSoc;

      const nextChargeInterval = chargeIntervals
        .filter((ci) => new Date(ci.startsAt) >= now)
        .sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt))[0];

      if (nextChargeInterval) {
        const firstCharge = new Date(nextChargeInterval.startsAt);
        const formattedTime = firstCharge.toLocaleString(this.homey.i18n.getLanguage(), {
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          timeZone: 'Europe/Berlin',
        });

        await this.setCapabilityValueIfChanged('next_charge_start', formattedTime);
        await this.setCapabilityValueIfChanged('estimated_savings', Math.round(savings * 100) / 100, { tolerance: 0.01 });

        this.log('\n=== LP STRATEGY SUMMARY ===');
        this.log(`Charge intervals: ${chargeIntervals.length}`);
        this.log(`Discharge intervals: ${dischargeIntervals.length}`);
        this.log(`First charge: ${firstCharge.toLocaleString()}`);
        this.log(`Total charge: ${totalChargeKWh.toFixed(2)} kWh`);
        this.log(`Estimated savings: €${savings.toFixed(2)}`);
        this.log('======================\n');
      } else {
        await this.setCapabilityValueIfChanged('next_charge_start', this.homey.__('status.no_cheap_slots'));
        await this.setCapabilityValueIfChanged('estimated_savings', 0);
      }

      this.log('LP optimization completed successfully, skipping heuristic optimizer.');
      return;
    }

    // Fallback: heuristic optimization if LP fails or solver unavailable
    this.log('Using heuristic optimization (LP not available or failed)');

    // Prepare parameters for the pure optimization function
    const params = {
      batteryCapacity,
      currentSoc,
      targetSoc: maxTargetSoc,
      chargePowerKW,
      intervalHours: INTERVAL_HOURS,
      efficiencyLoss: BATTERY_EFFICIENCY_LOSS,
      expensivePriceFactor: this.normalizedExpensivePriceFactor,
      minProfitEurPerKWh,
      minEnergyKWh,
      batteryCostEurPerKWh: batteryCostInfo?.avgPrice,
    };

    // Build history object for forecasting
    const history = {
      productionHistory: this.productionHistory || {},
      consumptionHistory: this.gridHistory || {},
      batteryHistory: this.batteryHistory || {},
    };

    // Call the pure optimization function
    const strategy = computeHeuristicStrategy(indexedData, params, history, { logger: this });

    // Extract results from strategy
    const {
      chargeIntervals: selectedChargeIntervals,
      dischargeIntervals: selectedDischargeIntervals,
      expensiveIntervals,
      avgPrice: strategyAvgPrice,
      neededKWh: totalChargeKWh,
      forecastedDemand: totalDischargeKWh,
      savings: totalSavings,
    } = strategy;

    this.log('\n=== OPTIMIZATION RESULT ===');
    this.log(`Selected ${selectedChargeIntervals.length} charge intervals`);
    this.log(`Selected ${selectedDischargeIntervals.length} discharge intervals`);
    this.log(`Total charge: ${totalChargeKWh.toFixed(2)} kWh`);
    this.log(`Total estimated savings: €${totalSavings.toFixed(2)}`);

    // Debug: Log all charge interval times
    if (selectedChargeIntervals.length > 0) {
      this.log('\n=== CHARGE INTERVAL TIMES ===');
      selectedChargeIntervals.slice(0, 5).forEach((interval, idx) => {
        const time = new Date(interval.startsAt);
        this.log(`  [${idx}] ${time.toLocaleString()} (index: ${interval.index}, price: ${interval.total.toFixed(4)} €/kWh)`);
      });
      if (selectedChargeIntervals.length > 5) {
        this.log(`  ... and ${selectedChargeIntervals.length - 5} more intervals`);
      }
      this.log('===========================\n');
    }

    this.currentStrategy = {
      chargeIntervals: selectedChargeIntervals,
      dischargeIntervals: selectedDischargeIntervals,
      expensiveIntervals,
      avgPrice: strategyAvgPrice,
      neededKWh: totalChargeKWh,
      forecastedDemand: totalDischargeKWh,
      batteryStatus: {
        currentSoc,
        targetSoc: maxTargetSoc,
        availableCapacity: maxBatteryKWh,
        batteryCapacity,
        storedKWh,
        energyCost: batteryCostInfo,
      },
    };

    // Store current SoC for comparison in next check
    this.lastOptimizationSoC = currentSoc;

    const nextChargeInterval = selectedChargeIntervals
      .filter((ci) => new Date(ci.startsAt) >= now)
      .sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt))[0];

    if (nextChargeInterval) {
      const firstCharge = new Date(nextChargeInterval.startsAt);

      const formattedTime = firstCharge.toLocaleString(this.homey.i18n.getLanguage(), {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Europe/Berlin',
      });

      this.log('\n🔍 DEBUG: Setting next_charge_start capability');
      this.log(`   Raw timestamp: ${nextChargeInterval.startsAt}`);
      this.log(`   Parsed Date: ${firstCharge.toISOString()}`);
      this.log(`   Formatted for capability: ${formattedTime}`);
      this.log(`   Interval index: ${nextChargeInterval.index}`);

      await this.setCapabilityValueIfChanged('next_charge_start', formattedTime);
      await this.setCapabilityValueIfChanged('estimated_savings', Math.max(0, Math.round(totalSavings * 100) / 100), { tolerance: 0.01 });

      const avgChargePrice = selectedChargeIntervals.reduce((sum, s) => sum + s.total, 0) / selectedChargeIntervals.length;
      const effectiveAvgPrice = avgChargePrice * (1 + BATTERY_EFFICIENCY_LOSS);

      this.log('\n=== STRATEGY SUMMARY ===');
      this.log(`Charge intervals: ${selectedChargeIntervals.length}`);
      this.log(`First charge: ${firstCharge.toLocaleString()}`);
      this.log(`Avg charge price: ${avgChargePrice.toFixed(4)} €/kWh (effective: ${effectiveAvgPrice.toFixed(4)} €/kWh)`);
      this.log(`Estimated savings: €${totalSavings.toFixed(2)}`);
      this.log('======================\n');
    } else {
      this.log('No profitable charging opportunities found');
      await this.setCapabilityValueIfChanged('next_charge_start', this.homey.__('status.no_cheap_slots'));
      await this.setCapabilityValueIfChanged('estimated_savings', 0);
    }
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
    this.log('\n🔄 === EXECUTING OPTIMIZATION STRATEGY ===');
    this.log(`Timestamp: ${new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin' })}`);

    if (!this.getCapabilityValue('onoff')) {
      this.log('⚠️ Optimizer is disabled, skipping execution');
      return;
    }

    if (!this.currentStrategy) {
      this.log('⚠️ No strategy available, skipping execution');
      return;
    }

    this.log(`Strategy info: ${this.currentStrategy.chargeIntervals?.length || 0} charge intervals, ${this.currentStrategy.dischargeIntervals?.length || 0} discharge intervals`);

    // Keep UI in sync: next upcoming charge slot (not the first historical one)
    try {
      const now = new Date();
      const nextChargeInterval = (this.currentStrategy.chargeIntervals || [])
        .filter((ci) => ci && ci.startsAt && new Date(ci.startsAt) >= now)
        .sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt))[0];

      if (nextChargeInterval) {
        const nextCharge = new Date(nextChargeInterval.startsAt);
        const formattedTime = nextCharge.toLocaleString(this.homey.i18n.getLanguage(), {
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          timeZone: 'Europe/Berlin',
        });
        await this.setCapabilityValueIfChanged('next_charge_start', formattedTime);
      } else {
        await this.setCapabilityValueIfChanged('next_charge_start', this.homey.__('status.no_cheap_slots'));
      }
    } catch (error) {
      this.log(`⚠️ Could not update next_charge_start: ${error.message}`);
    }

    // Get grid power for decision making
    const gridPower = await this.collectGridPower();

    // Use pure function to decide battery mode
    const decision = decideBatteryMode({
      now: new Date(),
      priceCache: this.priceCache,
      strategy: this.currentStrategy,
      gridPower,
      lastMode: this.lastBatteryMode,
      thresholds: {
        solarThreshold: GRID_SOLAR_THRESHOLD_W,
        consumptionThreshold: GRID_CONSUMPTION_THRESHOLD_W,
      },
      intervalMinutes: INTERVAL_MINUTES,
    });

    this.log(`Decision: ${decision.mode} (interval ${decision.intervalIndex})`);
    this.log(`Reason: ${decision.reason}`);

    if (decision.mode === BATTERY_MODE.IDLE) {
      this.log('⚠️ No action to take');
      return;
    }

    // Execute the decided mode
    try {
      const batteryDeviceId = this.getSettingOrDefault('battery_device_id', '');
      const batteryDevice = this.getDeviceById('rct-power-storage-dc', batteryDeviceId);

      if (!batteryDevice) {
        this.error(`Battery device not found with ID: ${batteryDeviceId}`);
        await this.setCapabilityValueIfChanged('optimizer_status', this.homey.__('error.battery_not_found'));
        return;
      }

      await this.applyBatteryMode(batteryDevice, decision);

      // Store current mode for next comparison
      this.lastBatteryMode = decision.mode;

      // Update battery status in current strategy (energy cost may have changed)
      await this.updateBatteryStatus(batteryDevice);
    } catch (error) {
      this.error('Error executing optimization strategy:', error);
      await this.setCapabilityValueIfChanged('optimizer_status', `${this.homey.__('status.error')}: ${error.message}`);
    }
  }

  /**
   * Collect current grid power from grid meter device
   * @returns {number} Grid power in Watts (negative = solar export, positive = consumption)
   */
  async collectGridPower() {
    const gridDeviceId = this.getSetting('grid_device_id');

    if (!gridDeviceId || gridDeviceId.trim() === '') {
      this.log('   No grid device configured, defaulting to 0 W');
      return 0;
    }

    try {
      const gridDriver = this.homey.drivers.getDriver('grid-meter');
      const gridDevices = gridDriver.getDevices();
      const gridDevice = gridDevices.find((device) => device.getData().id === gridDeviceId);

      if (gridDevice && gridDevice.hasCapability('measure_power')) {
        const gridPower = gridDevice.getCapabilityValue('measure_power') || 0;
        this.log(`   Grid power: ${gridPower.toFixed(0)} W`);
        return gridPower;
      }

      this.log('   ⚠️ Grid device found but no measure_power capability');
      return 0;
    } catch (error) {
      this.log(`   ⚠️ Could not read grid power: ${error.message}`);
      return 0;
    }
  }

  /**
   * Apply the decided battery mode to the battery device
   * @param {Object} batteryDevice - Battery device instance
   * @param {Object} decision - Decision object from decideBatteryMode
   */
  async applyBatteryMode(batteryDevice, decision) {
    const { mode, intervalIndex, reason } = decision;
    const lastMode = this.lastBatteryMode;
    const priceInfo = intervalIndex >= 0 && this.priceCache[intervalIndex]
      ? `(${this.priceCache[intervalIndex].total.toFixed(4)} €/kWh)`
      : '';

    switch (mode) {
      case BATTERY_MODE.CHARGE:
        this.log(`✅ CHARGE INTERVAL ACTIVE (index ${intervalIndex})`);
        this.log(`   → ${reason}`);

        if (typeof batteryDevice.enableGridCharging === 'function') {
          await batteryDevice.enableGridCharging();
          this.log('   ✓ enableGridCharging() completed successfully');
          await this.setCapabilityValueIfChanged('optimizer_status', this.homey.__('status.charging'));

          if (lastMode !== mode) {
            await this.logBatteryModeChange(mode, priceInfo);
          }
        } else {
          this.error('❌ Battery device does not have enableGridCharging method');
        }
        break;

      case BATTERY_MODE.DISCHARGE:
        this.log(`⚡ DISCHARGE INTERVAL ACTIVE (index ${intervalIndex})`);
        this.log(`   → ${reason}`);

        if (typeof batteryDevice.enableDefaultOperatingMode === 'function') {
          await batteryDevice.enableDefaultOperatingMode();
          this.log('   ✓ enableDefaultOperatingMode() completed successfully');
          await this.setCapabilityValueIfChanged('optimizer_status', this.homey.__('status.discharging'));

          if (lastMode !== mode) {
            await this.logBatteryModeChange(mode, priceInfo);
          }
        } else {
          this.error('❌ Battery device does not have enableDefaultOperatingMode method');
        }
        break;

      case BATTERY_MODE.NORMAL_SOLAR:
        this.log(`🔒 NORMAL INTERVAL (index ${intervalIndex})`);
        this.log(`   → ${reason}`);

        if (typeof batteryDevice.enableDefaultOperatingMode === 'function') {
          await batteryDevice.enableDefaultOperatingMode();
          this.log('   ✓ enableDefaultOperatingMode() completed successfully');
          await this.setCapabilityValueIfChanged('optimizer_status', `${this.homey.__('status.monitoring')} (Solar)`);

          if (lastMode !== mode) {
            await this.logBatteryModeChange(mode);
          }
        } else {
          this.error('❌ Battery device does not have enableDefaultOperatingMode method');
        }
        break;

      case BATTERY_MODE.NORMAL_HOLD:
        this.log(`🔒 NORMAL INTERVAL (index ${intervalIndex})`);
        this.log(`   → ${reason}`);

        if (typeof batteryDevice.disableBatteryDischarge === 'function') {
          await batteryDevice.disableBatteryDischarge();
          this.log('   ✓ disableBatteryDischarge() completed successfully');
          await this.setCapabilityValueIfChanged('optimizer_status', this.homey.__('status.monitoring'));

          if (lastMode !== mode) {
            await this.logBatteryModeChange(mode);
          }
        } else {
          this.error('❌ Battery device does not have disableBatteryDischarge method');
        }
        break;

      default:
        this.log(`⚠️ Unknown mode: ${mode}`);
    }
  }

  /**
   * Log battery mode changes to Homey timeline
   */
  async logBatteryModeChange(mode, details = '') {
    try {
      let message = '';
      let icon = '';

      switch (mode) {
        case 'CHARGE':
          message = this.homey.__('timeline.charging');
          icon = '⚡';
          break;
        case 'DISCHARGE':
          message = this.homey.__('timeline.discharging');
          icon = '🔋';
          break;
        case 'NORMAL_SOLAR':
          message = this.homey.__('timeline.normal_solar');
          icon = '☀️';
          break;
        case 'NORMAL_HOLD':
          message = this.homey.__('timeline.normal_hold');
          icon = '🔒';
          break;
        default:
          this.log(`Unknown battery mode: ${mode}`);
          return;
      }

      const fullMessage = details ? `${icon} ${message} ${details}` : `${icon} ${message}`;

      await this.homey.notifications.createNotification({
        excerpt: fullMessage,
      });

      this.log(`📢 Timeline notification: ${fullMessage}`);
    } catch (error) {
      this.error('Error creating timeline notification:', error);
    }
  }

  /**
   * Collect current production and consumption data for forecasting
   */
  async collectCurrentData() {
    if (!this.getCapabilityValue('onoff')) {
      return; // Optimizer is disabled
    }

    try {
      const now = new Date();
      const minutesSinceMidnight = now.getHours() * 60 + now.getMinutes();
      const intervalIndex = Math.floor(minutesSinceMidnight / INTERVAL_MINUTES); // 0-95

      const forecastDays = this.getSettingOrDefault('forecast_days', DEFAULT_FORECAST_DAYS);

      // Collect solar production data
      const solarDeviceId = this.getSetting('solar_device_id');
      if (solarDeviceId && solarDeviceId.trim() !== '') {
        try {
          const solarDriver = this.homey.drivers.getDriver('solar-panel');
          const solarDevices = solarDriver.getDevices();
          const solarDevice = solarDevices.find((device) => device.getData().id === solarDeviceId);

          if (solarDevice && solarDevice.hasCapability('measure_power')) {
            const solarPower = solarDevice.getCapabilityValue('measure_power') || 0;

            if (!this.productionHistory[intervalIndex]) {
              this.productionHistory[intervalIndex] = [];
            }

            this.productionHistory[intervalIndex].push(solarPower);

            // Keep only last N days
            if (this.productionHistory[intervalIndex].length > forecastDays) {
              this.productionHistory[intervalIndex].shift();
            }
          }
        } catch (error) {
          // Solar device not found or error - not critical
          this.logThrottled('solar-device-error', 5 * 60 * 1000, 'Solar device not accessible:', error.message);
        }
      }

      // Collect consumption data from grid meter
      const gridDeviceId = this.getSetting('grid_device_id');
      if (gridDeviceId && gridDeviceId.trim() !== '') {
        try {
          const gridDriver = this.homey.drivers.getDriver('grid-meter');
          const gridDevices = gridDriver.getDevices();
          const gridDevice = gridDevices.find((device) => device.getData().id === gridDeviceId);

          if (gridDevice && gridDevice.hasCapability('measure_power')) {
            const gridPower = gridDevice.getCapabilityValue('measure_power') || 0;

            if (!this.consumptionHistory[intervalIndex]) {
              this.consumptionHistory[intervalIndex] = [];
            }

            this.consumptionHistory[intervalIndex].push(Math.abs(gridPower));

            // Keep only last N days
            if (this.consumptionHistory[intervalIndex].length > forecastDays) {
              this.consumptionHistory[intervalIndex].shift();
            }
          }
        } catch (error) {
          // Grid device not found or error - not critical
          this.logThrottled('grid-device-error', 5 * 60 * 1000, 'Grid device not accessible:', error.message);
        }
      }

      // Collect battery power data
      const batteryDeviceId = this.getSetting('battery_device_id');
      if (batteryDeviceId && batteryDeviceId.trim() !== '') {
        try {
          const batteryDriver = this.homey.drivers.getDriver('rct-power-storage-dc');
          const batteryDevices = batteryDriver.getDevices();
          const batteryDevice = batteryDevices.find((device) => device.getData().id === batteryDeviceId);

          if (batteryDevice) {
            // Battery driver provides measure_power
            const batteryPower = this.getCapabilitySafe(batteryDevice, 'measure_power');

            if (typeof batteryPower === 'number' && Number.isFinite(batteryPower)) {
              if (!this.batteryHistory[intervalIndex]) {
                this.batteryHistory[intervalIndex] = [];
              }

              this.batteryHistory[intervalIndex].push(batteryPower);

              // Keep only last N days
              if (this.batteryHistory[intervalIndex].length > forecastDays) {
                this.batteryHistory[intervalIndex].shift();
              }
            }

            // Track charging events with prices for cost calculation
            // Always call this regardless of current power to track meter deltas
            await this.trackBatteryCharging(batteryPower);
          }
        } catch (error) {
          // Battery device not found or error - not critical
          this.logThrottled('battery-device-error', 5 * 60 * 1000, 'Battery device not accessible:', error.message);
        }
      }

      // Save historical data every hour (at intervals 0, 4, 8, etc.)
      if (intervalIndex % 4 === 0) {
        await this.saveHistoricalData();
      }
    } catch (error) {
      this.error('Error collecting data:', error);
    }
  }

  /**
   * Prune history objects: trim arrays to max days, remove empty/invalid keys
   */
  pruneHistories(maxDays) {
    const historyObjects = [
      { name: 'productionHistory', obj: this.productionHistory },
      { name: 'consumptionHistory', obj: this.consumptionHistory },
      { name: 'gridHistory', obj: this.gridHistory },
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
      this.queueStoreValue('grid_history', this.gridHistory);
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
    try {
      // Get current price for this interval
      const now = new Date();
      const currentPrice = this.getCurrentIntervalPrice(now);

      // Get cumulative meter readings from solar and grid devices
      const solarDeviceId = this.getSetting('solar_device_id');
      const gridDeviceId = this.getSetting('grid_device_id');
      const batteryDeviceId = this.getSetting('battery_device_id');

      let solarMeterNow = 0;
      let gridImportedNow = 0;
      let gridExportedNow = 0;
      let batteryMeterNow = 0;
      let batteryMeterDischargedNow = 0;
      let currentSoc = 0;

      // Get solar meter reading (total production)
      if (solarDeviceId && solarDeviceId.trim() !== '') {
        try {
          const solarDriver = this.homey.drivers.getDriver('solar-panel');
          const solarDevices = solarDriver.getDevices();
          const solarDevice = solarDevices.find((device) => device.getData().id === solarDeviceId);
          if (solarDevice && solarDevice.hasCapability('meter_power')) {
            solarMeterNow = solarDevice.getCapabilityValue('meter_power') || 0;
          }
        } catch (error) {
          // Ignore
        }
      }

      // Get grid meter readings (import/export)
      if (gridDeviceId && gridDeviceId.trim() !== '') {
        try {
          const gridDriver = this.homey.drivers.getDriver('grid-meter');
          const gridDevices = gridDriver.getDevices();
          const gridDevice = gridDevices.find((device) => device.getData().id === gridDeviceId);
          if (gridDevice) {
            if (gridDevice.hasCapability('meter_power.imported')) {
              gridImportedNow = gridDevice.getCapabilityValue('meter_power.imported') || 0;
            } else if (gridDevice.hasCapability('meter_power')) {
              // Legacy fallback (some meters expose just meter_power)
              gridImportedNow = gridDevice.getCapabilityValue('meter_power') || 0;
            }

            if (gridDevice.hasCapability('meter_power.exported')) {
              gridExportedNow = gridDevice.getCapabilityValue('meter_power.exported') || 0;
            }
          }
        } catch (error) {
          // Ignore
        }
      }

      // Get battery meter reading (total charged and discharged) and current SoC
      if (batteryDeviceId && batteryDeviceId.trim() !== '') {
        try {
          const batteryDriver = this.homey.drivers.getDriver('rct-power-storage-dc');
          const batteryDevices = batteryDriver.getDevices();
          const batteryDevice = batteryDevices.find((device) => device.getData().id === batteryDeviceId);
          if (batteryDevice) {
            if (batteryDevice.hasCapability('meter_power.charged')) {
              batteryMeterNow = batteryDevice.getCapabilityValue('meter_power.charged') || 0;
            }
            if (batteryDevice.hasCapability('meter_power.discharged')) {
              batteryMeterDischargedNow = batteryDevice.getCapabilityValue('meter_power.discharged') || 0;
            }
            if (batteryDevice.hasCapability('measure_battery')) {
              currentSoc = batteryDevice.getCapabilityValue('measure_battery') || 0;
            }
          }
        } catch (error) {
          // Ignore
        }
      }

      // Check if battery is considered empty - if so, clear the log
      const minSocThreshold = this.getSetting('min_soc_threshold') || 7;
      if (shouldClearChargeLog(currentSoc, minSocThreshold, this.batteryChargeLog.length)) {
        this.log(`🔄 Battery at ${currentSoc.toFixed(1)}% (≤ ${minSocThreshold}%) - clearing charge log (${this.batteryChargeLog.length} entries)`);
        this.batteryChargeLog = [];
        await this.queueStoreValue('battery_charge_log', this.batteryChargeLog, { immediate: true });

        // Reset last meter reading to avoid double-counting
        this.lastMeterReading = {
          solar: solarMeterNow,
          grid: gridImportedNow,
          gridImported: gridImportedNow,
          gridExported: gridExportedNow,
          battery: batteryMeterNow,
          batteryDischarged: batteryMeterDischargedNow,
          timestamp: now,
        };
        return;
      }

      // Initialize lastMeterReading on first run to avoid false deltas
      if (!this.lastMeterReading) {
        this.log('📊 Initializing meter readings (first run or after restart)');
        this.lastMeterReading = {
          solar: solarMeterNow,
          grid: gridImportedNow,
          gridImported: gridImportedNow,
          gridExported: gridExportedNow,
          battery: batteryMeterNow,
          batteryDischarged: batteryMeterDischargedNow,
          timestamp: now,
        };
        return; // Skip first sample to establish baseline
      }

      // Calculate delta since last reading
      // IMPORTANT: Use nullish coalescing (??) so that 0 is treated as a valid previous reading
      const lastReading = this.lastMeterReading;
      const solarProducedKWh = Math.max(0, solarMeterNow - (lastReading.solar ?? solarMeterNow));
      const lastGridExported = lastReading.gridExported ?? 0;
      const gridExportedKWh = Math.max(0, gridExportedNow - (lastGridExported ?? gridExportedNow));
      // Solar available for local use = produced - exported to grid
      const solarAvailableKWh = Math.max(0, solarProducedKWh - gridExportedKWh);
      const batteryChargedKWh = Math.max(0, batteryMeterNow - (lastReading.battery ?? batteryMeterNow));
      const batteryDischargedKWh = Math.max(0, batteryMeterDischargedNow - (lastReading.batteryDischarged ?? batteryMeterDischargedNow));

      // Always advance baseline, even if nothing is logged.
      // This prevents unrelated solar/grid deltas from being attributed to a later battery charge.
      this.lastMeterReading = {
        solar: solarMeterNow,
        grid: gridImportedNow,
        gridImported: gridImportedNow,
        gridExported: gridExportedNow,
        battery: batteryMeterNow,
        batteryDischarged: batteryMeterDischargedNow,
        timestamp: now,
      };

      // If no energy moved since last sample, nothing to log
      if (batteryChargedKWh <= 0.001 && batteryDischargedKWh <= 0.001) {
        return;
      }

      // Handle battery CHARGING - add to log with positive values
      if (batteryChargedKWh > 0.001) {
        const chargeEntry = createChargeEntry({
          chargedKWh: batteryChargedKWh,
          // Use export-adjusted solar: energy exported to grid cannot charge battery
          solarKWh: solarAvailableKWh,
          gridPrice: currentPrice || 0,
          soc: currentSoc,
          timestamp: now,
        });

        const chargePrice = (currentPrice || 0).toFixed(4);
        const socInfo = currentSoc.toFixed(1);
        this.log(`Battery charged: ${batteryChargedKWh.toFixed(3)} kWh (${chargeEntry.solarKWh.toFixed(3)} solar + ${chargeEntry.gridKWh.toFixed(3)} grid @ ${chargePrice} €/kWh) [SoC: ${socInfo}%]`);

        // Add to charge log
        this.batteryChargeLog.push(chargeEntry);

        // Save to store (batched)
        this.queueStoreValue('battery_charge_log', this.batteryChargeLog);
      }

      // Handle battery DISCHARGING - add to log with negative values
      if (batteryDischargedKWh > 0.001) {
        // Calculate average cost of energy currently in battery before discharge
        const batteryCostBeforeDischarge = calculateBatteryEnergyCost(
          this.batteryChargeLog,
          { logger: this.log.bind(this) },
        );
        const avgBatteryPrice = batteryCostBeforeDischarge ? batteryCostBeforeDischarge.avgPrice : 0;

        this.log(`Battery discharged: ${batteryDischargedKWh.toFixed(3)} kWh [SoC: ${currentSoc.toFixed(1)}%]`);
        this.log(`  Avg battery cost before discharge: ${avgBatteryPrice.toFixed(4)} €/kWh`);
        this.log(`  Current grid price: ${(currentPrice || 0).toFixed(4)} €/kWh`);

        // Add to discharge log
        const dischargeEntry = createDischargeEntry({
          dischargedKWh: batteryDischargedKWh,
          gridPrice: currentPrice || 0,
          avgBatteryPrice,
          soc: currentSoc,
          timestamp: now,
        });
        this.batteryChargeLog.push(dischargeEntry);

        // Save to store (batched)
        this.queueStoreValue('battery_charge_log', this.batteryChargeLog);
      }

      // Cleanup old entries - keep only last several days
      if (this.batteryChargeLog.length > MAX_BATTERY_LOG_ENTRIES) {
        this.log(`⚠️ Battery log reached ${this.batteryChargeLog.length} entries - removing oldest`);
        this.batteryChargeLog = trimChargeLog(this.batteryChargeLog, MAX_BATTERY_LOG_ENTRIES);
        await this.queueStoreValue('battery_charge_log', this.batteryChargeLog, { immediate: true });
      }
    } catch (error) {
      this.error('Error tracking battery charging:', error);
    }
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
    try {
      this.log('\n🔍 calculateBatteryEnergyCost called:');
      this.log(`   batteryChargeLog length: ${this.batteryChargeLog ? this.batteryChargeLog.length : 'null/undefined'}`);

      // Show first and last entries for debugging
      if (this.batteryChargeLog && this.batteryChargeLog.length > 0) {
        this.log(`   First entry: ${JSON.stringify(this.batteryChargeLog[0]).substring(0, 150)}...`);
        if (this.batteryChargeLog.length > 1) {
          const lastIdx = this.batteryChargeLog.length - 1;
          this.log(`   Last entry: ${JSON.stringify(this.batteryChargeLog[lastIdx]).substring(0, 150)}...`);
        }
      }

      const result = calculateBatteryEnergyCost(
        this.batteryChargeLog,
        { logger: this.log.bind(this) },
      );

      if (result) {
        this.log(`   ✅ Result: ${result.totalKWh.toFixed(3)} kWh @ ${result.avgPrice.toFixed(4)} €/kWh`);
        this.log(`      Solar: ${result.solarKWh.toFixed(2)} kWh (${result.solarPercent.toFixed(0)}%)`);
        this.log(`      Grid: ${result.gridKWh.toFixed(2)} kWh (${result.gridPercent.toFixed(0)}%)`);
      } else {
        this.log('   ⚠️ Result: null (no data or battery empty)');
      }

      return result;
    } catch (error) {
      this.error('Error calculating battery energy cost:', error);
      return null;
    }
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
    try {
      // Calculate actual energy stored in battery
      const totalKWh = currentSoc * batteryCapacity;

      if (totalKWh < 0.01) {
        return null;
      }

      // Determine default price for unknown energy source
      let estimatedPrice = 0.20; // Fallback: typical German electricity price

      // Option 1: Use average price from planned charge intervals (best estimate)
      if (this.currentStrategy?.chargeIntervals && this.currentStrategy.chargeIntervals.length > 0) {
        const sum = this.currentStrategy.chargeIntervals.reduce((acc, interval) => acc + (interval.total || 0), 0);
        estimatedPrice = sum / this.currentStrategy.chargeIntervals.length;
        this.log(`   Using avg planned charge price as estimate: ${estimatedPrice.toFixed(4)} €/kWh`);

      // Option 2: Use average of recent price data
      } else if (this.priceCache && this.priceCache.length > 0) {
        const recentPrices = this.priceCache.slice(0, Math.min(96, this.priceCache.length)); // Last 24h
        const sum = recentPrices.reduce((acc, p) => acc + (p.total || 0), 0);
        estimatedPrice = sum / recentPrices.length;
        this.log(`   Using avg recent price as estimate: ${estimatedPrice.toFixed(4)} €/kWh`);
      } else {
        this.log(`   Using fallback price as estimate: ${estimatedPrice.toFixed(4)} €/kWh`);
      }

      // Assume unknown source (could be mix of grid and solar, but we don't know)
      // Conservative approach: assume mostly grid with some solar
      const estimatedGridPercent = 70; // Conservative estimate
      const estimatedSolarPercent = 30; // Optimistic solar contribution

      const gridKWh = totalKWh * (estimatedGridPercent / 100);
      const solarKWh = totalKWh * (estimatedSolarPercent / 100);
      const totalCost = gridKWh * estimatedPrice;
      const weightedAvgPrice = totalCost / totalKWh;

      this.log('   📊 Estimated battery cost (source unknown):');
      this.log(`      Total: ${totalKWh.toFixed(2)} kWh @ ${weightedAvgPrice.toFixed(4)} €/kWh (estimated)`);
      this.log(`      Assumed: ${gridKWh.toFixed(2)} kWh grid (${estimatedGridPercent}%) + ${solarKWh.toFixed(2)} kWh solar (${estimatedSolarPercent}%)`);

      return {
        avgPrice: weightedAvgPrice,
        totalKWh,
        solarKWh,
        gridKWh,
        solarPercent: estimatedSolarPercent,
        gridPercent: estimatedGridPercent,
        totalCost,
        gridOnlyAvgPrice: estimatedPrice,
        isEstimated: true, // Flag to indicate this is estimated, not tracked
      };
    } catch (error) {
      this.error('Error estimating battery energy cost:', error);
      return null;
    }
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
    if (totalKWh < 0.01) {
      return null;
    }

    const trackedKWh = tracked?.totalKWh || 0;
    const unknownKWh = Math.max(0, totalKWh - trackedKWh);

    // If everything is tracked, return it directly
    if (unknownKWh < 0.01) {
      return {
        ...tracked,
        storedKWh: totalKWh,
        trackedKWh,
        unknownKWh: 0,
        isEstimated: false,
      };
    }

    // If nothing is tracked, estimate everything
    if (trackedKWh < 0.01) {
      const estimated = this.estimateBatteryEnergyCost(totalKWh / batteryCapacity, batteryCapacity);
      if (!estimated) return null;
      return {
        ...estimated,
        storedKWh: totalKWh,
        trackedKWh: 0,
        unknownKWh: totalKWh,
        isEstimated: true,
      };
    }

    // Mixed case: combine tracked + unknown
    // Estimate the unknown portion
    let unknownAvgPrice = 0.20; // Fallback

    if (this.currentStrategy?.chargeIntervals && this.currentStrategy.chargeIntervals.length > 0) {
      const sum = this.currentStrategy.chargeIntervals.reduce((acc, interval) => acc + (interval.total || 0), 0);
      unknownAvgPrice = sum / this.currentStrategy.chargeIntervals.length;
    } else if (this.priceCache && this.priceCache.length > 0) {
      const recentPrices = this.priceCache.slice(0, Math.min(96, this.priceCache.length));
      const sum = recentPrices.reduce((acc, p) => acc + (p.total || 0), 0);
      unknownAvgPrice = sum / recentPrices.length;
    }

    // Assume unknown energy is mostly grid with some solar (conservative)
    const unknownSolarPercent = 30;
    const unknownGridPercent = 70;
    const unknownSolarKWh = unknownKWh * (unknownSolarPercent / 100);
    const unknownGridKWh = unknownKWh * (unknownGridPercent / 100);
    const unknownTotalCost = unknownGridKWh * unknownAvgPrice;

    // Combine tracked + unknown
    const combinedTotalKWh = trackedKWh + unknownKWh;
    const combinedSolarKWh = (tracked?.solarKWh || 0) + unknownSolarKWh;
    const combinedGridKWh = (tracked?.gridKWh || 0) + unknownGridKWh;
    const combinedTotalCost = (tracked?.totalCost || 0) + unknownTotalCost;
    const combinedAvgPrice = combinedTotalCost / combinedTotalKWh;

    this.log('   📊 Combined battery cost (tracked + unknown):');
    this.log(`      Total: ${combinedTotalKWh.toFixed(2)} kWh @ ${combinedAvgPrice.toFixed(4)} €/kWh`);
    this.log(`      Tracked: ${trackedKWh.toFixed(2)} kWh @ ${(tracked?.avgPrice || 0).toFixed(4)} €/kWh`);
    this.log(`      Unknown: ${unknownKWh.toFixed(2)} kWh @ ${unknownAvgPrice.toFixed(4)} €/kWh (estimated)`);

    return {
      avgPrice: combinedAvgPrice,
      totalKWh: combinedTotalKWh,
      storedKWh: totalKWh,
      solarKWh: combinedSolarKWh,
      gridKWh: combinedGridKWh,
      solarPercent: (combinedSolarKWh / combinedTotalKWh) * 100,
      gridPercent: (combinedGridKWh / combinedTotalKWh) * 100,
      totalCost: combinedTotalCost,
      gridOnlyAvgPrice: combinedGridKWh > 0 ? combinedTotalCost / combinedGridKWh : unknownAvgPrice,
      isEstimated: true, // Flag to indicate mixed/estimated data
      trackedKWh,
      unknownKWh,
      unknownAvgPrice,
    };
  }

  /**
   * Update battery status in current strategy with latest data
   * This ensures energyCost is always current even when strategy doesn't change
   */
  async updateBatteryStatus(batteryDevice) {
    if (!this.currentStrategy) {
      return;
    }

    try {
      // Get current battery state
      let currentSoc = 0;
      const socValue = this.getCapabilitySafe(batteryDevice, 'measure_battery');
      if (socValue !== null) {
        currentSoc = socValue / 100;
      }

      const batteryCapacity = parseFloat(batteryDevice.getSetting('battery_capacity')) || DEFAULT_BATTERY_CAPACITY_KWH;
      const maxTargetSoc = this.normalizedTargetSoc;
      const maxBatteryKWh = batteryCapacity * (maxTargetSoc - currentSoc);
      const storedKWh = currentSoc * batteryCapacity;

      // Get tracked energy from charge log
      const trackedCost = this.calculateBatteryEnergyCost();

      // Combine tracked + unknown to account for full battery content
      let batteryCostInfo = null;
      if (currentSoc > 0.05) {
        batteryCostInfo = this.combineBatteryCost(trackedCost, storedKWh, batteryCapacity);
      }

      // Update batteryStatus in existing strategy
      this.currentStrategy.batteryStatus = {
        currentSoc,
        targetSoc: maxTargetSoc,
        availableCapacity: maxBatteryKWh,
        batteryCapacity,
        storedKWh,
        energyCost: batteryCostInfo,
      };

      this.log(`✅ Battery status updated: SoC ${(currentSoc * 100).toFixed(1)}%, energyCost: ${batteryCostInfo ? 'available' : 'null'}`);
    } catch (error) {
      this.error('Error updating battery status:', error);
    }
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
