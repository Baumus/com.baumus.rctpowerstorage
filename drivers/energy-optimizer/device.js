'use strict';

const RCTDevice = require('../../lib/rct-device');

class EnergyOptimizerDevice extends RCTDevice {

  /**
   * onInit is called when the device is initialized.
   */
  // Override: Virtual device needs no physical connection
  async ensureConnection() {
    // No physical connection needed for optimizer
    return true;
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
    await this.setCapabilityValue('onoff', this.getStoreValue('optimizer_enabled') !== false);
    await this.setCapabilityValue('optimizer_status', this.homey.__('status.initializing'));
    await this.setCapabilityValue('next_charge_start', this.homey.__('status.not_scheduled'));
    await this.setCapabilityValue('estimated_savings', 0);

    // Register capability listeners
    this.registerCapabilityListener('onoff', this.onCapabilityOnoff.bind(this));

    // Initialize data structures
    this.productionHistory = this.getStoreValue('production_history') || {};
    this.consumptionHistory = this.getStoreValue('consumption_history') || {};
    this.batteryHistory = this.getStoreValue('battery_history') || {};
    this.batteryChargeLog = this.getStoreValue('battery_charge_log') || [];
    this.priceCache = [];
    this.currentStrategy = null;
    this.isDeleting = false;

    // Log current settings for debugging
    this.log('Current settings:', this.getSettings());

    // Start optimizer if enabled
    if (this.getCapabilityValue('onoff')) {
      await this.startOptimizer();
    } else {
      await this.setCapabilityValue('optimizer_status', this.homey.__('status.stopped'));
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
      await this.setCapabilityValue('optimizer_status', this.homey.__('status.starting'));

      // Validate configuration
      const config = this.validateConfiguration();
      if (!config.valid) {
        await this.setCapabilityValue('optimizer_status', this.homey.__('status.error_config'));
        this.error('Invalid configuration:', config.message);
        await this.setUnavailable(config.message);
        return;
      }

      // Run initial price fetch, optimization and data collection
      await this.fetchPricesFromTibber();
      await this.calculateOptimalStrategy();
      await this.collectCurrentData();

      // Execute the strategy immediately to set correct battery mode
      await this.executeOptimizationStrategy();

      await this.setAvailable();
      await this.setCapabilityValue('optimizer_status', this.homey.__('status.active'));

      this.log('✓ Energy Optimizer started successfully');
      this.log('  Polling is handled by RCTDevice.startPolling()');
    } catch (error) {
      this.error('Error starting optimizer:', error);
      await this.setCapabilityValue('optimizer_status', `${this.homey.__('status.error')}: ${error.message}`);
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
      await this.setCapabilityValue('optimizer_status', this.homey.__('status.stopped'));
      await this.setCapabilityValue('next_charge_start', this.homey.__('status.not_scheduled'));
      await this.saveHistoricalData();
    }

    this.log('Energy Optimizer stopped');
  }

  /**
   * onDeleted is called when the device is deleted
   */
  async onDeleted() {
    this.log('Energy Optimizer has been deleted');
    this.isDeleting = true;
    this.deleted = true;
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

    const now = new Date();
    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();
    const currentDate = now.toDateString();

    try {
      // 1. Check for daily price fetch (at configured hour, minute 0)
      const fetchHour = this.getSetting('daily_fetch_hour') || 15;
      if (currentHour === fetchHour && currentMinute === 0 && this.lastDailyFetchDate !== currentDate) {
        this.log(`🔄 Daily price fetch triggered at ${now.toLocaleTimeString('de-DE')}`);
        this.lastDailyFetchDate = currentDate;
        await this.fetchPricesFromTibber();
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
      this.log('📡 Fetching Tibber prices from API...');
      await this.setCapabilityValue('optimizer_status', this.homey.__('status.fetching_prices'));

      const tibberToken = this.getSetting('tibber_token');
      const tibberHomeId = this.getSetting('tibber_home_id');

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

      const response = await fetch('https://api.tibber.com/v1-beta/gql', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tibberToken}`,
        },
        body: JSON.stringify({ query }),
      });

      if (!response.ok) {
        throw new Error(`Tibber API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();

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

      const now = new Date();
      // Include current and future intervals (current = started but not ended yet)
      // An interval is 15 minutes, so we subtract 15 minutes to include the current one
      const fifteenMinutesAgo = new Date(now.getTime() - 15 * 60 * 1000);

      this.priceCache = [...today, ...tomorrow]
        .filter((p) => new Date(p.startsAt) >= fifteenMinutesAgo)
        .sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt));

      this.log(`✅ Fetched ${this.priceCache.length} price intervals (from ${this.priceCache.length > 0 ? new Date(this.priceCache[0].startsAt).toLocaleString() : 'N/A'})`);

      await this.setCapabilityValue('optimizer_status', this.homey.__('status.active'));
      await this.setAvailable();
    } catch (error) {
      this.error('Error fetching prices:', error);
      await this.setCapabilityValue('optimizer_status', `${this.homey.__('status.error')}: ${error.message}`);

      // Don't set unavailable for temporary API errors
      if (!error.message.includes('API error')) {
        await this.setUnavailable(error.message);
      }
    }
  }

  /**
   * Calculate optimal charging strategy based on price data
   * Uses cached price data - does NOT fetch from API
   */
  async calculateOptimalStrategy() {
    this.log('\n🔄 Recalculating optimization strategy with current battery status...');

    if (!this.priceCache.length) {
      this.log('⚠️ No price data available - cannot optimize');
      return;
    }

    const now = new Date();
    const availableData = this.priceCache.filter((p) => {
      const start = new Date(p.startsAt);
      return start >= now;
    });

    if (!availableData.length) {
      this.log('No price data available');
      this.currentStrategy = { chargeIntervals: [] };
      await this.setCapabilityValue('next_charge_start', this.homey.__('status.no_data'));
      return;
    }

    // Get battery configuration
    const batteryDeviceId = this.getSetting('battery_device_id');
    let batteryDevice;

    try {
      const batteryDriver = this.homey.drivers.getDriver('rct-power-storage-dc');
      const batteryDevices = batteryDriver.getDevices();
      batteryDevice = batteryDevices.find((device) => device.getData().id === batteryDeviceId);

      if (!batteryDevice) {
        throw new Error(`Battery device not found with ID: ${batteryDeviceId}`);
      }
    } catch (error) {
      this.error('Battery device not found:', error);
      await this.setCapabilityValue('optimizer_status', this.homey.__('error.battery_not_found'));
      return;
    }

    let currentSoc = 0;
    try {
      if (batteryDevice.capabilitiesObj && batteryDevice.capabilitiesObj.measure_battery) {
        currentSoc = (batteryDevice.capabilitiesObj.measure_battery.value || 0) / 100;
      } else if (batteryDevice.getCapabilityValue) {
        currentSoc = (batteryDevice.getCapabilityValue('measure_battery') || 0) / 100;
      }
    } catch (error) {
      this.log('Could not read battery SoC, using 0%:', error.message);
      currentSoc = 0;
    }

    const batteryCapacity = parseFloat(batteryDevice.getSetting('battery_capacity')) || 9.9;
    const chargePowerKW = this.getSetting('charge_power_kw') || 6.0;
    const INTERVAL_HOURS = 0.25;
    const energyPerInterval = chargePowerKW * INTERVAL_HOURS;
    const maxTargetSoc = (this.getSetting('target_soc') || 85) / 100;
    const BATTERY_EFFICIENCY_LOSS = (this.getSetting('battery_efficiency_loss') || 10) / 100;
    const maxBatteryKWh = batteryCapacity * (maxTargetSoc - currentSoc);

    this.log('\n=== BATTERY STATUS ===');
    this.log(`Current SoC: ${(currentSoc * 100).toFixed(1)}%, Max target: ${(maxTargetSoc * 100).toFixed(1)}%`);
    this.log(`Available capacity: ${maxBatteryKWh.toFixed(2)} kWh (can charge from ${(currentSoc * 100).toFixed(1)}% to ${(maxTargetSoc * 100).toFixed(1)}%)`);
    this.log(`Charge power: ${chargePowerKW} kW = ${energyPerInterval.toFixed(2)} kWh per interval`);
    this.log(`Battery efficiency loss: ${(BATTERY_EFFICIENCY_LOSS * 100).toFixed(1)}%`);

    // Add index and intervalOfDay to all data
    const indexedData = availableData.map((p, index) => ({
      ...p,
      index,
      intervalOfDay: this.getIntervalOfDay(new Date(p.startsAt)),
    }));

    const avgPrice = indexedData.reduce((sum, p) => sum + p.total, 0) / indexedData.length;
    this.log(`Average price: ${avgPrice.toFixed(4)} €/kWh`);

    // Compute dynamic price thresholds (average + percentile) for classifying expensive intervals
    const sortedPrices = indexedData.map((p) => p.total).sort((a, b) => a - b);
    const getPercentile = (values, q) => {
      if (!values.length) return avgPrice;
      const pos = (values.length - 1) * q;
      const base = Math.floor(pos);
      const rest = pos - base;
      if (values[base + 1] !== undefined) {
        return values[base] + rest * (values[base + 1] - values[base]);
      }
      return values[base];
    };

    // 70th percentile as dynamic expensive price reference
    const p70 = getPercentile(sortedPrices, 0.7);

    // Use the higher of (avg * factor) and percentile to adapt to flat/volatile days
    const avgFactor = (this.getSetting('expensive_price_factor') || 1.05); // default: 5% above average
    const expensiveThreshold = Math.max(avgPrice * avgFactor, p70);

    this.log(`Dynamic expensive threshold: ${expensiveThreshold.toFixed(4)} €/kWh (avgFactor=${avgFactor}, p70=${p70.toFixed(4)})`);

    // New approach: For each expensive interval, find the best charging opportunities before it
    // This handles multiple cheap-expensive cycles correctly

    this.log('\n=== CHRONOLOGICAL ENERGY OPTIMIZATION ===');

    // Step 1: Identify expensive intervals (above dynamic threshold) where battery usage is profitable
    const expensiveIntervals = indexedData.filter((p) => p.total > expensiveThreshold);

    this.log(`Found ${expensiveIntervals.length} expensive intervals (> ${expensiveThreshold.toFixed(4)} €/kWh)`);

    // Step 2: For each expensive interval, find the cheapest charging opportunities before it
    const chargeAssignments = new Map(); // Maps charge interval index -> total energy assigned
    const dischargeNeeds = new Map(); // Maps discharge interval index -> energy needed
    let totalSavings = 0;

    // Calculate energy demand for each expensive interval
    for (const expInterval of expensiveIntervals) {
      const demand = this.forecastEnergyDemand([expInterval]);
      dischargeNeeds.set(expInterval.index, demand);
      this.log(`Discharge ${new Date(expInterval.startsAt).toLocaleString()}: need ${demand.toFixed(2)} kWh @ ${expInterval.total.toFixed(4)} €/kWh`);
    }

    // Step 3: Assign charge energy to discharge needs optimally
    // Strategy: Go through all discharge intervals, assign from cheapest available charges

    // First, collect ALL cheap intervals (before any expensive interval)
    const lastExpensiveIndex = expensiveIntervals.length > 0
      ? expensiveIntervals[expensiveIntervals.length - 1].index
      : -1;
    const allCheapIntervals = indexedData.filter((p) => lastExpensiveIndex >= 0
      && p.index < lastExpensiveIndex
      && p.total <= expensiveThreshold);

    // Sort by price (cheapest first)
    allCheapIntervals.sort((a, b) => a.total - b.total);

    this.log(`Found ${allCheapIntervals.length} cheap intervals to distribute energy from`);

    // Track which discharge intervals actually get energy assigned
    const assignedDischarges = new Set();
    let totalAssignedCharge = 0;

    // Check if battery can be charged (only if below target SoC)
    const canChargeBattery = maxBatteryKWh > 0.01;
    const currentBatteryKWh = currentSoc * batteryCapacity; // Already available energy in battery
    let remainingBatteryEnergy = currentBatteryKWh; // Track remaining energy from current charge

    this.log(`\n⚡ Battery status: ${(currentSoc * 100).toFixed(1)}% = ${currentBatteryKWh.toFixed(2)} kWh available now`);
    if (canChargeBattery) {
      this.log(`   → Can charge additional ${maxBatteryKWh.toFixed(2)} kWh (up to ${(maxTargetSoc * 100).toFixed(1)}%)`);
    } else {
      this.log('   → Already at target SoC, will only use existing charge');
    }

    // Minimum profit per kWh (in €/kWh) to consider a charge-discharge pair worthwhile
    const minProfitEurPerKWh = (this.getSetting('min_profit_cent_per_kwh') || 8) / 100; // default: 8 ct/kWh

    // When battery capacity is tight, prioritize the most expensive intervals first
    const sortedExpensiveIntervals = [...expensiveIntervals].sort((a, b) => b.total - a.total);

    // Now assign energy: for each discharge, take from existing battery charge OR cheapest available charges
    // Priority: 1) Use existing battery charge, 2) Add new charging if needed and profitable
    for (const expInterval of sortedExpensiveIntervals) {
      const demandKWh = dischargeNeeds.get(expInterval.index);
      let assignedEnergy = 0;

      this.log(`\nDischarge ${new Date(expInterval.startsAt).toLocaleString()}: need ${demandKWh.toFixed(2)} kWh @ ${expInterval.total.toFixed(4)} €/kWh`);

      // First, try to use existing battery charge
      if (remainingBatteryEnergy > 0.01) {
        const useFromBattery = Math.min(demandKWh, remainingBatteryEnergy);
        remainingBatteryEnergy -= useFromBattery;
        assignedEnergy += useFromBattery;
        this.log(`  ✓ Using ${useFromBattery.toFixed(2)} kWh from existing battery charge (${remainingBatteryEnergy.toFixed(2)} kWh remaining)`);

        // If existing charge covers full demand, we're done
        if (assignedEnergy >= demandKWh - 0.01) {
          assignedDischarges.add(expInterval.index);
          continue;
        }
      }

      // If we still need more energy, try to charge from cheap intervals
      const stillNeeded = demandKWh - assignedEnergy;

      if (!canChargeBattery) {
        this.log(`  ⚠️ Skipped: Need ${stillNeeded.toFixed(2)} kWh more but battery already at target SoC`);
        continue;
      }

      // Check if we've already reached battery capacity limit
      if (totalAssignedCharge >= maxBatteryKWh - 0.01) {
        this.log(`  ⚠️ Skipped: Battery capacity limit reached (${maxBatteryKWh.toFixed(2)} kWh)`);
        break;
      }

      for (const chargeInterval of allCheapIntervals) {
        // Skip if this charge is AFTER the discharge (chronological constraint)
        if (chargeInterval.index >= expInterval.index) continue;

        const effectiveChargePrice = chargeInterval.total * (1 + BATTERY_EFFICIENCY_LOSS);

        // Check if profitable with required minimum margin
        const priceDiff = expInterval.total - effectiveChargePrice;
        if (priceDiff <= minProfitEurPerKWh) {
          this.log('  Stopping: effective charge not profitable enough');
          this.log(`    charge: ${effectiveChargePrice.toFixed(4)} €/kWh, discharge: ${expInterval.total.toFixed(4)} €/kWh, diff: ${priceDiff.toFixed(4)} €/kWh, min: ${minProfitEurPerKWh.toFixed(4)} €/kWh`);
          break;
        }

        // How much energy is already assigned from this charge interval?
        const alreadyAssigned = chargeAssignments.get(chargeInterval.index) || 0;
        const remainingCapacity = energyPerInterval - alreadyAssigned;

        if (remainingCapacity < 0.01) continue; // This charge interval is fully used

        // How much energy do we still need for this discharge (after using existing battery)?
        const stillNeededNow = demandKWh - assignedEnergy;
        if (stillNeededNow < 0.01) break; // This discharge is fully covered

        // Check available battery capacity
        const remainingBatteryCapacity = maxBatteryKWh - totalAssignedCharge;
        if (remainingBatteryCapacity < 0.01) {
          this.log('  Stopping: Battery capacity limit reached');
          break;
        }

        // Assign energy (limited by interval capacity, discharge need, AND battery capacity)
        const toAssign = Math.min(remainingCapacity, stillNeededNow, remainingBatteryCapacity);
        chargeAssignments.set(chargeInterval.index, alreadyAssigned + toAssign);
        assignedEnergy += toAssign;
        totalAssignedCharge += toAssign;

        // Calculate savings for this assignment
        const savings = (expInterval.total - effectiveChargePrice) * toAssign;
        totalSavings += savings;

        this.log(`  → Charge ${toAssign.toFixed(2)} kWh from ${new Date(chargeInterval.startsAt).toLocaleString()} @ ${chargeInterval.total.toFixed(4)} €/kWh (savings: €${savings.toFixed(2)})`);

        if (assignedEnergy >= demandKWh - 0.01) break;
        if (totalAssignedCharge >= maxBatteryKWh - 0.01) break;
      }

      // Mark this discharge as assigned if it got enough energy (from existing battery + new charging)
      if (assignedEnergy >= demandKWh - 0.01) {
        assignedDischarges.add(expInterval.index);
      } else {
        this.log(`  ⚠️ Skipped: Only ${assignedEnergy.toFixed(2)} kWh available, need ${demandKWh.toFixed(2)} kWh`);
      }
    }

    // Step 4: Build final interval lists - only include profitable discharges
    const selectedChargeIntervals = indexedData.filter((p) => chargeAssignments.has(p.index));
    const selectedDischargeIntervals = expensiveIntervals
      .filter((exp) => assignedDischarges.has(exp.index))
      .map((exp) => ({ ...exp, demandKWh: dischargeNeeds.get(exp.index) }));
    const totalChargeKWh = Array.from(chargeAssignments.values()).reduce((sum, val) => sum + val, 0);
    const totalDischargeKWh = selectedDischargeIntervals
      .map((exp) => exp.demandKWh)
      .reduce((sum, val) => sum + val, 0);

    this.log(`\n✅ Energy balance: ${totalChargeKWh.toFixed(2)} kWh charged = ${totalDischargeKWh.toFixed(2)} kWh needed`);
    this.log(`   (${selectedDischargeIntervals.length}/${expensiveIntervals.length} profitable discharge intervals)`);
    this.log(`   Battery capacity: ${totalChargeKWh.toFixed(2)}/${maxBatteryKWh.toFixed(2)} kWh (${((totalChargeKWh / maxBatteryKWh) * 100).toFixed(1)}%)`);

    // Sort selected intervals chronologically
    selectedChargeIntervals.sort((a, b) => a.index - b.index);
    selectedDischargeIntervals.sort((a, b) => a.index - b.index);

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

    // Calculate average cost of energy currently in battery
    const batteryCostInfo = this.calculateBatteryEnergyCost();

    this.currentStrategy = {
      chargeIntervals: selectedChargeIntervals,
      dischargeIntervals: selectedDischargeIntervals,
      expensiveIntervals,
      avgPrice,
      neededKWh: totalChargeKWh,
      forecastedDemand: this.forecastEnergyDemand(selectedDischargeIntervals),
      batteryStatus: {
        currentSoc,
        targetSoc: maxTargetSoc,
        availableCapacity: maxBatteryKWh,
        batteryCapacity,
        energyCost: batteryCostInfo,
      },
    };

    // Store current SoC for comparison in next check
    this.lastOptimizationSoC = currentSoc;

    if (selectedChargeIntervals.length > 0) {
      const firstCharge = new Date(selectedChargeIntervals[0].startsAt);

      const formattedTime = firstCharge.toLocaleString(this.homey.i18n.getLanguage(), {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Europe/Berlin',
      });

      this.log('\n🔍 DEBUG: Setting next_charge_start capability');
      this.log(`   Raw timestamp: ${selectedChargeIntervals[0].startsAt}`);
      this.log(`   Parsed Date: ${firstCharge.toISOString()}`);
      this.log(`   Formatted for capability: ${formattedTime}`);
      this.log(`   Interval index: ${selectedChargeIntervals[0].index}`);

      await this.setCapabilityValue('next_charge_start', formattedTime);
      await this.setCapabilityValue('estimated_savings', Math.max(0, Math.round(totalSavings * 100) / 100));

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
      await this.setCapabilityValue('next_charge_start', this.homey.__('status.no_cheap_slots'));
      await this.setCapabilityValue('estimated_savings', 0);
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
   */
  getIntervalOfDay(date) {
    const minutesSinceMidnight = date.getHours() * 60 + date.getMinutes();
    return Math.floor(minutesSinceMidnight / 15);
  }

  /**
   * Forecast energy demand for given intervals based on historical data
   */
  forecastEnergyDemand(intervals) {
    if (!intervals.length) {
      return 0;
    }

    let totalForecastedKWh = 0;
    const INTERVAL_HOURS = 0.25; // 15 minutes

    for (const interval of intervals) {
      const { intervalOfDay } = interval;

      // Get historical grid power data for this interval
      const gridHistory = this.consumptionHistory[intervalOfDay] || [];

      let forecastedGridKW = 0;

      if (gridHistory.length > 0) {
        // Use average of historical data (in W, convert to kW)
        const avgGridW = gridHistory.reduce((sum, val) => sum + val, 0) / gridHistory.length;
        forecastedGridKW = avgGridW / 1000;
      } else {
        // No historical data - use conservative estimate
        // Assume average household grid import of 3 kW
        forecastedGridKW = 3.0;
      }

      // Get expected solar production during this interval
      const productionHistory = this.productionHistory[intervalOfDay] || [];
      let forecastedSolarKW = 0;

      if (productionHistory.length > 0) {
        const avgSolarW = productionHistory.reduce((sum, val) => sum + val, 0) / productionHistory.length;
        forecastedSolarKW = avgSolarW / 1000;
      }

      // Get expected battery discharge during this interval
      const batteryHistoryData = this.batteryHistory[intervalOfDay] || [];
      let forecastedBatteryKW = 0;

      if (batteryHistoryData.length > 0) {
        const avgBatteryW = batteryHistoryData.reduce((sum, val) => sum + val, 0) / batteryHistoryData.length;
        forecastedBatteryKW = avgBatteryW / 1000;
      }

      // Net demand = gridPower + solarPower - batteryPower
      // Battery power is negative when discharging, so subtracting adds to demand
      const netDemandKW = forecastedGridKW + forecastedSolarKW - forecastedBatteryKW;
      const energyKWh = netDemandKW * INTERVAL_HOURS;

      totalForecastedKWh += energyKWh;
    }

    this.log(`Forecasted demand breakdown: ${intervals.length} expensive intervals = ${totalForecastedKWh.toFixed(2)} kWh total`);

    return totalForecastedKWh;
  }

  /**
   * Check if optimization plan should be recalculated due to significant battery SoC change
   */
  async shouldRecalculatePlan() {
    try {
      const batteryDeviceId = this.getSetting('battery_device_id');
      const batteryDriver = this.homey.drivers.getDriver('rct-power-storage-dc');
      const batteryDevices = batteryDriver.getDevices();
      const batteryDevice = batteryDevices.find((device) => device.getData().id === batteryDeviceId);

      if (!batteryDevice) return false;

      const currentSoc = (batteryDevice.getCapabilityValue('measure_battery') || 0) / 100;

      // Store last SoC if not set
      if (this.lastOptimizationSoC === undefined) {
        this.lastOptimizationSoC = currentSoc;
        return false;
      }

      // Recalculate if SoC changed by more than 10%
      const socChange = Math.abs(currentSoc - this.lastOptimizationSoC);
      if (socChange > 0.10) {
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
      return; // Optimizer is disabled
    }

    if (!this.currentStrategy) {
      this.log('⚠️ No strategy available, skipping execution');
      return; // No strategy available
    }

    // Strategy exists - we can execute even with 0 charge intervals
    // (we still need to control discharge/normal modes)
    this.log(`Strategy info: ${this.currentStrategy.chargeIntervals?.length || 0} charge intervals, ${this.currentStrategy.dischargeIntervals?.length || 0} discharge intervals`);

    const now = new Date();
    this.log(`Current time: ${now.toLocaleString('de-DE', { timeZone: 'Europe/Berlin' })}`);

    // Find current interval index in the price cache
    let currentIntervalIndex = -1;
    for (let i = 0; i < this.priceCache.length; i++) {
      const start = new Date(this.priceCache[i].startsAt);
      const end = new Date(start.getTime() + 15 * 60 * 1000);

      if (now >= start && now < end) {
        currentIntervalIndex = i;
        break;
      }
    }

    if (currentIntervalIndex === -1) {
      this.log('⚠️ Current time not in any price interval');
      this.log(`   Price cache length: ${this.priceCache.length}`);
      if (this.priceCache.length > 0) {
        this.log(`   First interval: ${new Date(this.priceCache[0].startsAt).toLocaleString('de-DE', { timeZone: 'Europe/Berlin' })}`);
        this.log(`   Last interval: ${new Date(this.priceCache[this.priceCache.length - 1].startsAt).toLocaleString('de-DE', { timeZone: 'Europe/Berlin' })}`);
      }
      return;
    }

    this.log(`📍 Current interval index: ${currentIntervalIndex} (${new Date(this.priceCache[currentIntervalIndex].startsAt).toLocaleString('de-DE', { timeZone: 'Europe/Berlin' })})`);
    this.log(`   Price: ${this.priceCache[currentIntervalIndex].total.toFixed(4)} €/kWh`);

    // Check if current interval is a planned charge slot
    const shouldCharge = this.currentStrategy.chargeIntervals
      && this.currentStrategy.chargeIntervals.some(
        (s) => s.index === currentIntervalIndex,
      );

    // Check if current interval is a planned discharge slot (expensive interval)
    const shouldDischarge = this.currentStrategy.dischargeIntervals
      && this.currentStrategy.dischargeIntervals.some(
        (s) => s.index === currentIntervalIndex,
      );

    this.log('Interval classification:');
    this.log(`   shouldCharge: ${shouldCharge}`);
    this.log(`   shouldDischarge: ${shouldDischarge}`);

    try {
      const batteryDeviceId = this.getSetting('battery_device_id');
      const batteryDriver = this.homey.drivers.getDriver('rct-power-storage-dc');
      const batteryDevices = batteryDriver.getDevices();
      const batteryDevice = batteryDevices.find((device) => device.getData().id === batteryDeviceId);

      if (!batteryDevice) {
        this.error('Battery device not found with ID:', batteryDeviceId);
        return;
      }

      // Store the last mode before making changes
      const lastMode = this.lastBatteryMode;
      let currentMode = null;

      if (shouldCharge) {
        this.log(`✅ CHARGE INTERVAL ACTIVE (index ${currentIntervalIndex})`);
        this.log('   → Calling enableGridCharging() on battery device');

        // Call the battery device's enableGridCharging method
        if (typeof batteryDevice.enableGridCharging === 'function') {
          await batteryDevice.enableGridCharging();
          this.log('   ✓ enableGridCharging() completed successfully');
          await this.setCapabilityValue('optimizer_status', this.homey.__('status.charging'));
          currentMode = 'CHARGE';

          // Notify if mode changed
          if (lastMode !== currentMode) {
            const priceInfo = `(${this.priceCache[currentIntervalIndex].total.toFixed(4)} €/kWh)`;
            await this.logBatteryModeChange(currentMode, priceInfo);
          }
        } else {
          this.error('❌ Battery device does not have enableGridCharging method');
        }
      } else if (shouldDischarge) {
        this.log(`⚡ DISCHARGE INTERVAL ACTIVE (index ${currentIntervalIndex})`);
        this.log('   → Calling enableDefaultOperatingMode() on battery device');

        // Call the battery device's enableDefaultOperatingMode method
        if (typeof batteryDevice.enableDefaultOperatingMode === 'function') {
          await batteryDevice.enableDefaultOperatingMode();
          this.log('   ✓ enableDefaultOperatingMode() completed successfully');
          await this.setCapabilityValue('optimizer_status', this.homey.__('status.discharging'));
          currentMode = 'DISCHARGE';

          // Notify if mode changed
          if (lastMode !== currentMode) {
            const priceInfo = `(${this.priceCache[currentIntervalIndex].total.toFixed(4)} €/kWh)`;
            await this.logBatteryModeChange(currentMode, priceInfo);
          }
        } else {
          this.error('❌ Battery device does not have enableDefaultOperatingMode method');
        }
      } else {
        this.log(`🔒 NORMAL INTERVAL (index ${currentIntervalIndex})`);

        // Check grid power to decide battery behavior
        const gridDeviceId = this.getSetting('grid_device_id');
        let gridPower = 0;

        if (gridDeviceId && gridDeviceId.trim() !== '') {
          try {
            const gridDriver = this.homey.drivers.getDriver('grid-meter');
            const gridDevices = gridDriver.getDevices();
            const gridDevice = gridDevices.find((device) => device.getData().id === gridDeviceId);
            if (gridDevice && gridDevice.hasCapability('measure_power')) {
              gridPower = gridDevice.getCapabilityValue('measure_power') || 0;
              this.log(`   Grid power: ${gridPower.toFixed(0)} W`);
            }
          } catch (error) {
            this.log('   ⚠️ Could not read grid power, defaulting to disableBatteryDischarge');
          }
        }

        // Hysteresis thresholds to prevent rapid mode switching
        const SOLAR_THRESHOLD = -300; // Switch to solar mode when grid power < -300W (significant solar excess)
        const GRID_THRESHOLD = 300; // Switch to hold mode when grid power > 300W (consuming from grid)

        // Use hysteresis: only switch modes when clearly above/below thresholds
        if (gridPower < SOLAR_THRESHOLD) {
          // Significant solar excess → allow battery charging from solar and discharging
          this.log(`   → Solar excess detected (${gridPower.toFixed(0)} W < ${SOLAR_THRESHOLD} W), calling enableDefaultOperatingMode()`);
          if (typeof batteryDevice.enableDefaultOperatingMode === 'function') {
            await batteryDevice.enableDefaultOperatingMode();
            this.log('   ✓ enableDefaultOperatingMode() completed successfully');
            await this.setCapabilityValue('optimizer_status', `${this.homey.__('status.monitoring')} (Solar)`);
            currentMode = 'NORMAL_SOLAR';

            // Notify if mode changed
            if (lastMode !== currentMode) {
              const solarInfo = `(${Math.abs(gridPower).toFixed(0)} W)`;
              await this.logBatteryModeChange(currentMode, solarInfo);
            }
          } else {
            this.error('❌ Battery device does not have enableDefaultOperatingMode method');
          }
        } else if (gridPower > GRID_THRESHOLD) {
          // Consuming from grid → prevent battery discharge to avoid buying expensive power
          this.log(`   → Grid consumption (${gridPower.toFixed(0)} W > ${GRID_THRESHOLD} W), calling disableBatteryDischarge()`);
          if (typeof batteryDevice.disableBatteryDischarge === 'function') {
            await batteryDevice.disableBatteryDischarge();
            this.log('   ✓ disableBatteryDischarge() completed successfully');
            await this.setCapabilityValue('optimizer_status', this.homey.__('status.monitoring'));
            currentMode = 'NORMAL_HOLD';

            // Notify if mode changed
            if (lastMode !== currentMode) {
              await this.logBatteryModeChange(currentMode);
            }
          } else {
            this.error('❌ Battery device does not have disableBatteryDischarge method');
          }
        } else {
          // In neutral zone (between -500W and +100W) → keep current mode to prevent oscillation
          this.log(`   → Grid power in neutral zone (${gridPower.toFixed(0)} W between ${SOLAR_THRESHOLD} W and ${GRID_THRESHOLD} W)`);
          this.log(`   → Keeping current battery mode: ${lastMode || 'NORMAL_HOLD (default)'}`);
          currentMode = lastMode || 'NORMAL_HOLD';

          // Update status without changing battery mode
          if (currentMode === 'NORMAL_SOLAR') {
            await this.setCapabilityValue('optimizer_status', `${this.homey.__('status.monitoring')} (Solar)`);
          } else {
            await this.setCapabilityValue('optimizer_status', this.homey.__('status.monitoring'));
          }
        }
      }

      // Store current mode for next comparison
      this.lastBatteryMode = currentMode;
    } catch (error) {
      this.error('Error executing optimization strategy:', error);
      await this.setCapabilityValue('optimizer_status', `${this.homey.__('status.error')}: ${error.message}`);
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
      const intervalIndex = Math.floor(minutesSinceMidnight / 15); // 0-95

      const forecastDays = this.getSetting('forecast_days') || 7;

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
          this.log('Solar device not accessible:', error.message);
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
          this.log('Grid device not accessible:', error.message);
        }
      }

      // Collect battery power data
      const batteryDeviceId = this.getSetting('battery_device_id');
      if (batteryDeviceId && batteryDeviceId.trim() !== '') {
        try {
          const batteryDriver = this.homey.drivers.getDriver('rct-power-storage-dc');
          const batteryDevices = batteryDriver.getDevices();
          const batteryDevice = batteryDevices.find((device) => device.getData().id === batteryDeviceId);

          if (batteryDevice && batteryDevice.hasCapability('measure_power.battery')) {
            const batteryPower = batteryDevice.getCapabilityValue('measure_power.battery') || 0;

            if (!this.batteryHistory[intervalIndex]) {
              this.batteryHistory[intervalIndex] = [];
            }

            this.batteryHistory[intervalIndex].push(batteryPower);

            // Keep only last N days
            if (this.batteryHistory[intervalIndex].length > forecastDays) {
              this.batteryHistory[intervalIndex].shift();
            }

            // Track charging events with prices for cost calculation
            await this.trackBatteryCharging(batteryPower, intervalIndex);
          }
        } catch (error) {
          // Battery device not found or error - not critical
          this.log('Battery device not accessible:', error.message);
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
   * Save historical data to device store
   */
  async saveHistoricalData() {
    try {
      await this.setStoreValue('production_history', this.productionHistory);
      await this.setStoreValue('consumption_history', this.consumptionHistory);
      await this.setStoreValue('grid_history', this.gridHistory);
      await this.setStoreValue('battery_history', this.batteryHistory);
      await this.setStoreValue('battery_charge_log', this.batteryChargeLog);
      this.log('Historical data saved');
    } catch (error) {
      this.error('Error saving historical data:', error);
    }
  }

  /**
   * Track battery charging and discharging events with prices
   * Uses FIFO (First In, First Out) to track actual energy remaining in battery
   */
  async trackBatteryCharging(batteryPower, intervalIndex) {
    try {
      // Track both charging and discharging
      if (Math.abs(batteryPower) <= 10) return; // Only track significant power flow (>10W)

      // Get current price for this interval
      const now = new Date();
      const currentPrice = this.getCurrentIntervalPrice(now);

      // Get cumulative meter readings from solar and grid devices
      const solarDeviceId = this.getSetting('solar_device_id');
      const gridDeviceId = this.getSetting('grid_device_id');
      const batteryDeviceId = this.getSetting('battery_device_id');

      let solarMeterNow = 0;
      let gridMeterNow = 0;
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

      // Get grid meter reading (total import)
      if (gridDeviceId && gridDeviceId.trim() !== '') {
        try {
          const gridDriver = this.homey.drivers.getDriver('grid-meter');
          const gridDevices = gridDriver.getDevices();
          const gridDevice = gridDevices.find((device) => device.getData().id === gridDeviceId);
          if (gridDevice && gridDevice.hasCapability('meter_power')) {
            gridMeterNow = gridDevice.getCapabilityValue('meter_power') || 0;
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
      if (currentSoc <= minSocThreshold && this.batteryChargeLog.length > 0) {
        this.log(`🔄 Battery at ${currentSoc.toFixed(1)}% (≤ ${minSocThreshold}%) - clearing charge log (${this.batteryChargeLog.length} entries)`);
        this.batteryChargeLog = [];
        await this.setStoreValue('battery_charge_log', this.batteryChargeLog);

        // Reset last meter reading to avoid double-counting
        this.lastMeterReading = {
          solar: solarMeterNow,
          grid: gridMeterNow,
          battery: batteryMeterNow,
          batteryDischarged: batteryMeterDischargedNow,
          timestamp: now,
        };
        return;
      }

      // Calculate delta since last reading
      const lastReading = this.lastMeterReading || {};
      const solarKWh = Math.max(0, solarMeterNow - (lastReading.solar || solarMeterNow));
      const batteryChargedKWh = Math.max(0, batteryMeterNow - (lastReading.battery || batteryMeterNow));
      const batteryDischargedKWh = Math.max(0, batteryMeterDischargedNow - (lastReading.batteryDischarged || batteryMeterDischargedNow));

      // Store current readings for next comparison
      this.lastMeterReading = {
        solar: solarMeterNow,
        grid: gridMeterNow,
        battery: batteryMeterNow,
        batteryDischarged: batteryMeterDischargedNow,
        timestamp: now,
      };

      // Handle battery CHARGING - add to log with positive values
      if (batteryChargedKWh > 0.001) {
        // Determine how much came from solar vs grid
        const chargeFromSolar = Math.min(batteryChargedKWh, solarKWh);
        const chargeFromGrid = Math.max(0, batteryChargedKWh - chargeFromSolar);

        const chargePrice = (currentPrice || 0).toFixed(4);
        const socInfo = currentSoc.toFixed(1);
        this.log(`Battery charged: ${batteryChargedKWh.toFixed(3)} kWh (${chargeFromSolar.toFixed(3)} solar + ${chargeFromGrid.toFixed(3)} grid @ ${chargePrice} €/kWh) [SoC: ${socInfo}%]`);

        // Add to charge log with positive values
        this.batteryChargeLog.push({
          timestamp: now.toISOString(),
          type: 'charge',
          solarKWh: chargeFromSolar,
          gridKWh: chargeFromGrid,
          totalKWh: batteryChargedKWh,
          gridPrice: currentPrice || 0,
          soc: currentSoc,
        });

        // Save to store
        await this.setStoreValue('battery_charge_log', this.batteryChargeLog);
      }

      // Handle battery DISCHARGING - add to log with negative values
      if (batteryDischargedKWh > 0.001) {
        // Calculate average cost of energy currently in battery before discharge
        const batteryCostBeforeDischarge = this.calculateBatteryEnergyCost();
        const avgBatteryPrice = batteryCostBeforeDischarge ? batteryCostBeforeDischarge.avgPrice : 0;

        this.log(`Battery discharged: ${batteryDischargedKWh.toFixed(3)} kWh [SoC: ${currentSoc.toFixed(1)}%]`);
        this.log(`  Avg battery cost before discharge: ${avgBatteryPrice.toFixed(4)} €/kWh`);
        this.log(`  Current grid price: ${(currentPrice || 0).toFixed(4)} €/kWh`);

        // Add to discharge log with negative values
        this.batteryChargeLog.push({
          timestamp: now.toISOString(),
          type: 'discharge',
          totalKWh: -batteryDischargedKWh, // Negative for discharge
          gridPrice: currentPrice || 0, // Current market price during discharge
          avgBatteryPrice, // Average cost of energy that was in battery
          soc: currentSoc,
        });

        // Save to store
        await this.setStoreValue('battery_charge_log', this.batteryChargeLog);
      }

      // Cleanup old entries - keep only last 7 days (96 intervals/day * 7 = 672 entries)
      if (this.batteryChargeLog.length > 672) {
        this.log(`⚠️ Battery log reached ${this.batteryChargeLog.length} entries - removing oldest`);
        this.batteryChargeLog = this.batteryChargeLog.slice(-672);
        await this.setStoreValue('battery_charge_log', this.batteryChargeLog);
      }
    } catch (error) {
      this.error('Error tracking battery charging:', error);
    }
  }

  /**
   * Get current interval price from cache
   */
  getCurrentIntervalPrice(timestamp) {
    if (!this.priceCache || this.priceCache.length === 0) return null;

    const targetTime = new Date(timestamp);
    const targetMinutes = targetTime.getHours() * 60 + targetTime.getMinutes();
    const targetInterval = Math.floor(targetMinutes / 15);

    for (const priceEntry of this.priceCache) {
      const entryTime = new Date(priceEntry.startsAt);
      const entryMinutes = entryTime.getHours() * 60 + entryTime.getMinutes();
      const entryInterval = Math.floor(entryMinutes / 15);

      if (entryTime.getDate() === targetTime.getDate()
          && entryTime.getMonth() === targetTime.getMonth()
          && entryInterval === targetInterval) {
        return priceEntry.total;
      }
    }

    return null;
  }

  /**
   * Calculate average cost and total amount of energy currently stored in battery
   * Sums all charge and discharge events since last battery empty state
   */
  calculateBatteryEnergyCost() {
    try {
      if (!this.batteryChargeLog || this.batteryChargeLog.length === 0) {
        this.log('No battery charge log data available');
        return null;
      }

      // Calculate net energy and costs by summing all charge/discharge events
      let netSolarKWh = 0;
      let netGridKWh = 0;
      let totalGridCost = 0;

      for (const entry of this.batteryChargeLog) {
        if (entry.type === 'charge') {
          // Charging: add solar and grid energy
          netSolarKWh += entry.solarKWh || 0;
          netGridKWh += entry.gridKWh || 0;
          totalGridCost += (entry.gridKWh || 0) * (entry.gridPrice || 0);
        } else if (entry.type === 'discharge') {
          // Discharging: subtract energy proportionally from solar and grid
          const dischargedKWh = Math.abs(entry.totalKWh || 0);
          const totalBeforeDischarge = netSolarKWh + netGridKWh;

          if (totalBeforeDischarge > 0.001) {
            // Calculate ratio of solar vs grid before discharge
            const solarRatio = netSolarKWh / totalBeforeDischarge;
            const gridRatio = netGridKWh / totalBeforeDischarge;

            // Subtract proportionally
            const solarDischarged = dischargedKWh * solarRatio;
            const gridDischarged = dischargedKWh * gridRatio;

            netSolarKWh = Math.max(0, netSolarKWh - solarDischarged);
            netGridKWh = Math.max(0, netGridKWh - gridDischarged);

            // Also subtract cost proportionally
            const avgCostBeforeDischarge = totalGridCost / totalBeforeDischarge;
            totalGridCost = Math.max(0, totalGridCost - (dischargedKWh * avgCostBeforeDischarge));
          }
        }
      }

      const netTotalKWh = netSolarKWh + netGridKWh;

      this.log(`Battery energy calculation from ${this.batteryChargeLog.length} log entries:`);
      this.log(`  Net remaining: ${netTotalKWh.toFixed(3)} kWh (${netSolarKWh.toFixed(3)} solar + ${netGridKWh.toFixed(3)} grid)`);

      if (netTotalKWh < 0.01) {
        this.log('  Battery effectively empty (< 0.01 kWh)');
        return null;
      }

      // Calculate weighted average price
      const avgPrice = totalGridCost / netTotalKWh;

      this.log(`  Weighted avg cost: ${avgPrice.toFixed(4)} €/kWh`);
      this.log(`  Total grid cost: €${totalGridCost.toFixed(2)}`);
      this.log(`  Solar: ${((netSolarKWh / netTotalKWh) * 100).toFixed(1)}% (free)`);
      this.log(`  Grid: ${((netGridKWh / netTotalKWh) * 100).toFixed(1)}% @ ${(totalGridCost / netGridKWh).toFixed(4)} €/kWh`);

      return {
        avgPrice,
        totalKWh: netTotalKWh,
        solarKWh: netSolarKWh,
        gridKWh: netGridKWh,
        solarPercent: (netSolarKWh / netTotalKWh) * 100,
        gridPercent: (netGridKWh / netTotalKWh) * 100,
        totalCost: totalGridCost,
      };
    } catch (error) {
      this.error('Error calculating battery energy cost:', error);
      return null;
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
    } else if (changedKeys.includes('target_soc') || changedKeys.includes('price_threshold_percent')) {
      // Recalculate strategy if optimization parameters changed
      this.log('Optimization parameters changed, recalculating strategy...');
      await this.calculateOptimalStrategy();
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
