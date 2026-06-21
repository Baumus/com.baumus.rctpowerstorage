'use strict';

const { decideBatteryMode, BATTERY_MODE } = require('../strategy-execution-core');
const {
  INTERVAL_MINUTES,
  DEFAULT_MIN_SOC_THRESHOLD,
  GRID_SOLAR_THRESHOLD_W,
  GRID_CONSUMPTION_THRESHOLD_W,
} = require('../constants');
const {
  getMinutesSinceMidnightInTimeZone,
  resolveSunriseEstimate,
  isMinuteInWindow,
} = require('../sunrise-core');

const PV_START_THRESHOLD_W = 50;
const PV_KICKSTART_DURATION_MS = 5 * 60 * 1000; // 5 minutes
const PV_KICKSTART_WINDOW_START_MIN = 4 * 60; // 04:00 Europe/Berlin
const PV_KICKSTART_WINDOW_END_MIN = 11 * 60 + 30; // 11:30 Europe/Berlin
const PV_KICKSTART_RECOVERY_WINDOW_END_MIN = 14 * 60; // 14:00 Europe/Berlin
const PV_KICKSTART_RETRY_COOLDOWN_MS = 20 * 60 * 1000; // 20 minutes
const PV_KICKSTART_MAX_ATTEMPTS_PER_DAY = 4;
const PV_KICKSTART_RECOVERY_MIN_PEAK_W = 300;
const PV_KICKSTART_TIMEZONE = 'Europe/Berlin';

function getBerlinDateKey(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: PV_KICKSTART_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);

  const year = parts.find((p) => p.type === 'year')?.value;
  const month = parts.find((p) => p.type === 'month')?.value;
  const day = parts.find((p) => p.type === 'day')?.value;
  return `${year}-${month}-${day}`;
}

function getBerlinMinutesSinceMidnight(date) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: PV_KICKSTART_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const hour = parseInt(parts.find((p) => p.type === 'hour')?.value, 10);
  const minute = parseInt(parts.find((p) => p.type === 'minute')?.value, 10);

  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  return hour * 60 + minute;
}

function shouldKickstartPv(host, now, solarProductionW) {
  const minutes = getBerlinMinutesSinceMidnight(now);
  if (!Number.isFinite(minutes)) return false;

  const inMorningWindow = minutes >= PV_KICKSTART_WINDOW_START_MIN && minutes <= PV_KICKSTART_WINDOW_END_MIN;
  const inRecoveryWindow = minutes > PV_KICKSTART_WINDOW_END_MIN && minutes <= PV_KICKSTART_RECOVERY_WINDOW_END_MIN;
  if (!inMorningWindow && !inRecoveryWindow) return false;

  const solarW = (typeof solarProductionW === 'number' && Number.isFinite(solarProductionW)) ? solarProductionW : 0;
  if (solarW > PV_START_THRESHOLD_W) return false;

  const todayKey = getBerlinDateKey(now);
  if (host?.pvKickstartPeakDateKey !== todayKey) {
    host.pvKickstartPeakDateKey = todayKey;
    host.pvKickstartPeakWToday = 0;
  }
  host.pvKickstartPeakWToday = Math.max(host?.pvKickstartPeakWToday || 0, solarW);

  if (host?.pvKickstartAttemptDateKey !== todayKey) {
    host.pvKickstartAttemptDateKey = todayKey;
    host.pvKickstartAttemptsToday = 0;
    host.pvKickstartLastTriggerMs = null;
  }

  const activeUntil = (host && Number.isFinite(host.pvKickstartUntilMs)) ? host.pvKickstartUntilMs : null;
  const attemptsToday = Number.isFinite(host?.pvKickstartAttemptsToday) ? host.pvKickstartAttemptsToday : 0;
  const lastTriggerMs = Number.isFinite(host?.pvKickstartLastTriggerMs) ? host.pvKickstartLastTriggerMs : null;

  // If kickstart is currently active, keep it active until it expires.
  if (Number.isFinite(activeUntil) && now.getTime() < activeUntil) {
    return true;
  }

  if (attemptsToday >= PV_KICKSTART_MAX_ATTEMPTS_PER_DAY) return false;

  if (Number.isFinite(lastTriggerMs) && (now.getTime() - lastTriggerMs) < PV_KICKSTART_RETRY_COOLDOWN_MS) {
    return false;
  }

  if (inRecoveryWindow && (host?.pvKickstartPeakWToday || 0) < PV_KICKSTART_RECOVERY_MIN_PEAK_W) {
    return false;
  }

  // Start when we were in CONSTANT (or just booted without last mode).
  return host?.lastBatteryMode === null || host?.lastBatteryMode === BATTERY_MODE.CONSTANT;
}

function getHomeyGeolocationSnapshot(host) {
  try {
    const manager = host?.homey?.geolocation;
    if (!manager) return null;

    const latitude = typeof manager.getLatitude === 'function' ? manager.getLatitude() : null;
    const longitude = typeof manager.getLongitude === 'function' ? manager.getLongitude() : null;
    const accuracy = typeof manager.getAccuracy === 'function' ? manager.getAccuracy() : null;

    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      return null;
    }

    return {
      latitude,
      longitude,
      accuracy: Number.isFinite(accuracy) ? accuracy : null,
    };
  } catch (error) {
    return null;
  }
}

function getSunrisePriorityContext(host, now) {
  const geolocation = host?._sunriseGeolocation || getHomeyGeolocationSnapshot(host);
  const estimate = resolveSunriseEstimate({
    date: now,
    timeZone: PV_KICKSTART_TIMEZONE,
    geolocation,
    productionHistory: host?.productionHistory || {},
    intervalMinutes: INTERVAL_MINUTES,
  });

  const currentMinutes = getMinutesSinceMidnightInTimeZone(now, PV_KICKSTART_TIMEZONE);
  const sunriseMinutes = Number.isFinite(estimate?.minutes) ? estimate.minutes : null;
  if (!Number.isFinite(currentMinutes) || !Number.isFinite(sunriseMinutes)) {
    return {
      active: false,
      source: estimate?.source || 'none',
      sunriseMinutes,
      currentMinutes,
      startMinutes: null,
      endMinutes: null,
    };
  }

  const startMinutes = sunriseMinutes - 45;
  const endMinutes = sunriseMinutes + 120;

  return {
    active: isMinuteInWindow(currentMinutes, startMinutes, endMinutes),
    source: estimate.source,
    sunriseMinutes,
    currentMinutes,
    startMinutes,
    endMinutes,
  };
}

/**
 * Execute the current optimization strategy.
 * Host-based service module: operates on the EnergyOptimizerDevice instance.
 */
async function executeOptimizationStrategy(host) {
  host.log('\n🔄 === EXECUTING OPTIMIZATION STRATEGY ===');
  const now = new Date();
  host.log(`Timestamp: ${now.toLocaleString('de-DE', { timeZone: 'Europe/Berlin' })}`);

  if (!host.getCapabilityValue || !host.getCapabilityValue('onoff')) {
    host.log('⚠️ Optimizer is disabled, skipping execution');
    return;
  }

  if (!host.currentStrategy) {
    host.log('⚠️ No strategy available, skipping execution');
    return;
  }

  host.log(`Strategy info: ${host.currentStrategy.chargeIntervals?.length || 0} charge intervals, ${host.currentStrategy.dischargeIntervals?.length || 0} discharge intervals`);

  // Keep UI in sync: next upcoming charge slot (not the first historical one)
  try {
    const nextChargeInterval = (host.currentStrategy.chargeIntervals || [])
      .filter((ci) => ci && ci.startsAt && new Date(ci.startsAt) >= now)
      .sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt))[0];

    if (nextChargeInterval) {
      const nextCharge = new Date(nextChargeInterval.startsAt);
      const formattedTime = nextCharge.toLocaleString(host.homey.i18n.getLanguage(), {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Europe/Berlin',
      });
      await host.setCapabilityValueIfChanged('next_charge_start', formattedTime);
    } else {
      await host.setCapabilityValueIfChanged('next_charge_start', host.homey.__('status.no_cheap_slots'));
    }
  } catch (error) {
    host.log(`⚠️ Could not update next_charge_start: ${error.message}`);
  }

  // Get grid power for decision making
  const gridPower = await host.collectGridPower();

  // Get solar production power (used to prevent PV start issues in CONSTANT)
  let solarProductionW = null;
  try {
    const solarDeviceId = typeof host.getSetting === 'function' ? host.getSetting('solar_device_id') : '';
    if (solarDeviceId && solarDeviceId.trim() !== '') {
      const solarDevice = host.getDeviceById('solar-panel', solarDeviceId);
      if (solarDevice && solarDevice.hasCapability('measure_power')) {
        const value = solarDevice.getCapabilityValue('measure_power');
        solarProductionW = (typeof value === 'number' && Number.isFinite(value)) ? value : null;
        host.log(`   Solar production: ${Number.isFinite(solarProductionW) ? solarProductionW.toFixed(0) : 'n/a'} W`);
      } else {
        host.log('   ⚠️ Solar device found but no measure_power capability');
      }
    } else {
      host.log('   No solar device configured, solar telemetry unavailable');
    }
  } catch (error) {
    host.log(`   ⚠️ Could not read solar production: ${error.message}`);
    solarProductionW = null;
  }

  const batteryDeviceId = host.getSettingOrDefault('battery_device_id', '');
  const batteryDevice = host.getDeviceById('rct-power-storage-dc', batteryDeviceId);

  if (!batteryDevice) {
    host.error(`Battery device not found with ID: ${batteryDeviceId}`);
    await host.setCapabilityValueIfChanged('optimizer_status', host.homey.__('error.battery_not_found'));
    return;
  }

  const currentSocPercent = host.getCapabilitySafe(batteryDevice, 'measure_battery');
  const batteryPower = host.getCapabilitySafe(batteryDevice, 'measure_power');
  const minSocThresholdPercent = parseFloat(host.getSettingOrDefault('min_soc_threshold', DEFAULT_MIN_SOC_THRESHOLD));
  const sunrisePriority = getSunrisePriorityContext(host, now);
  if (sunrisePriority.active) {
    host.log(`   Sunrise priority window active (source=${sunrisePriority.source}, sunrise=${Math.floor(sunrisePriority.sunriseMinutes / 60).toString().padStart(2, '0')}:${(sunrisePriority.sunriseMinutes % 60).toString().padStart(2, '0')})`);
  }

  // Use pure function to decide battery mode
  let decision = decideBatteryMode({
    now,
    priceCache: host.priceCache,
    strategy: host.currentStrategy,
    gridPower,
    solarProductionW,
    lastMode: host.lastBatteryMode,
    currentSocPercent,
    minSocThresholdPercent,
    thresholds: {
      solarThreshold: GRID_SOLAR_THRESHOLD_W,
      consumptionThreshold: GRID_CONSUMPTION_THRESHOLD_W,
    },
    sunrisePriority,
    intervalMinutes: INTERVAL_MINUTES,
  });

  // PV kickstart:
  // Some inverter setups won't start PV generation while in CONSTANT.
  // If PV is still <= 50W in the morning window and we'd be in CONSTANT,
  // force NORMAL once per day for a short duration to let PV ramp up.
  if (decision.mode === BATTERY_MODE.CONSTANT && shouldKickstartPv(host, now, solarProductionW)) {
    const todayKey = getBerlinDateKey(now);
    const minutes = getBerlinMinutesSinceMidnight(now);
    const phaseLabel = Number.isFinite(minutes) && minutes > PV_KICKSTART_WINDOW_END_MIN
      ? 'recovery window'
      : 'morning window';

    host.pvKickstartAttemptDateKey = todayKey;
    host.pvKickstartAttemptsToday = (Number.isFinite(host.pvKickstartAttemptsToday) ? host.pvKickstartAttemptsToday : 0) + 1;
    host.pvKickstartLastTriggerMs = now.getTime();
    host.pvKickstartUntilMs = now.getTime() + PV_KICKSTART_DURATION_MS;
    decision = {
      ...decision,
      mode: BATTERY_MODE.NORMAL,
      reason: `PV kickstart (PV <= ${PV_START_THRESHOLD_W} W, ${phaseLabel}, attempt ${host.pvKickstartAttemptsToday}/${PV_KICKSTART_MAX_ATTEMPTS_PER_DAY}) → NORMAL for ${Math.round(PV_KICKSTART_DURATION_MS / 60000)} min`,
    };
    host.log(`   PV kickstart active until ${new Date(host.pvKickstartUntilMs).toLocaleString('de-DE', { timeZone: 'Europe/Berlin' })}`);
  }

  host.log(`Decision: ${decision.mode} (interval ${decision.intervalIndex})`);
  host.log(`Reason: ${decision.reason}`);

  if (typeof host.updateLiveEnergyState === 'function') {
    host.updateLiveEnergyState({
      gridPowerW: gridPower,
      solarPowerW: solarProductionW,
      batteryPowerW: (typeof batteryPower === 'number' && Number.isFinite(batteryPower)) ? batteryPower : null,
      decisionMode: decision.mode,
      decisionReason: decision.reason,
      source: 'strategy-execution',
      updatedAt: now.toISOString(),
    });
  }

  if (decision.mode === BATTERY_MODE.IDLE) {
    host.log('⚠️ No action to take');
    return;
  }

  // Execute the decided mode
  try {
    await host.applyBatteryMode(batteryDevice, decision);

    // Store current mode for next comparison
    host.lastBatteryMode = decision.mode;

    // Update battery status in current strategy (energy cost may have changed)
    await host.updateBatteryStatus(batteryDevice);
  } catch (error) {
    host.error('Error executing optimization strategy:', error);
    await host.setCapabilityValueIfChanged('optimizer_status', `${host.homey.__('status.error')}: ${error.message}`);
  }
}

module.exports = {
  executeOptimizationStrategy,
};
