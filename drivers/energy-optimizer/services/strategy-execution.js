'use strict';

const { decideBatteryMode, BATTERY_MODE } = require('../strategy-execution-core');
const {
  INTERVAL_MINUTES,
  DEFAULT_MIN_SOC_THRESHOLD,
  GRID_SOLAR_THRESHOLD_W,
  GRID_CONSUMPTION_THRESHOLD_W,
} = require('../constants');

const PV_START_THRESHOLD_W = 50;
const PV_KICKSTART_DURATION_MS = 5 * 60 * 1000; // 5 minutes
const PV_KICKSTART_WINDOW_START_MIN = 4 * 60; // 04:00 Europe/Berlin
const PV_KICKSTART_WINDOW_END_MIN = 11 * 60 + 30; // 11:30 Europe/Berlin
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

  const inWindow = minutes >= PV_KICKSTART_WINDOW_START_MIN && minutes <= PV_KICKSTART_WINDOW_END_MIN;
  if (!inWindow) return false;

  const solarW = (typeof solarProductionW === 'number' && Number.isFinite(solarProductionW)) ? solarProductionW : 0;
  if (solarW > PV_START_THRESHOLD_W) return false;

  const todayKey = getBerlinDateKey(now);
  const activeUntil = (host && Number.isFinite(host.pvKickstartUntilMs)) ? host.pvKickstartUntilMs : null;
  const kickstartDateKey = host?.pvKickstartDateKey || null;

  // If kickstart is currently active for today, keep it active until it expires.
  if (kickstartDateKey === todayKey && Number.isFinite(activeUntil) && now.getTime() < activeUntil) {
    return true;
  }

  // Only start once per day.
  if (kickstartDateKey === todayKey) return false;

  // Start when we were in CONSTANT (or just booted without last mode).
  return host?.lastBatteryMode === null || host?.lastBatteryMode === BATTERY_MODE.CONSTANT;
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
  let solarProductionW = 0;
  try {
    const solarDeviceId = typeof host.getSetting === 'function' ? host.getSetting('solar_device_id') : '';
    if (solarDeviceId && solarDeviceId.trim() !== '') {
      const solarDevice = host.getDeviceById('solar-panel', solarDeviceId);
      if (solarDevice && solarDevice.hasCapability('measure_power')) {
        const value = solarDevice.getCapabilityValue('measure_power');
        solarProductionW = (typeof value === 'number' && Number.isFinite(value)) ? value : 0;
        host.log(`   Solar production: ${solarProductionW.toFixed(0)} W`);
      } else {
        host.log('   ⚠️ Solar device found but no measure_power capability');
      }
    } else {
      host.log('   No solar device configured, defaulting to 0 W');
    }
  } catch (error) {
    host.log(`   ⚠️ Could not read solar production: ${error.message}`);
    solarProductionW = 0;
  }

  const batteryDeviceId = host.getSettingOrDefault('battery_device_id', '');
  const batteryDevice = host.getDeviceById('rct-power-storage-dc', batteryDeviceId);

  if (!batteryDevice) {
    host.error(`Battery device not found with ID: ${batteryDeviceId}`);
    await host.setCapabilityValueIfChanged('optimizer_status', host.homey.__('error.battery_not_found'));
    return;
  }

  const currentSocPercent = host.getCapabilitySafe(batteryDevice, 'measure_battery');
  const minSocThresholdPercent = parseFloat(host.getSettingOrDefault('min_soc_threshold', DEFAULT_MIN_SOC_THRESHOLD));

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
    intervalMinutes: INTERVAL_MINUTES,
  });

  // PV kickstart:
  // Some inverter setups won't start PV generation while in CONSTANT.
  // If PV is still <= 50W in the morning window and we'd be in CONSTANT,
  // force NORMAL once per day for a short duration to let PV ramp up.
  if (decision.mode === BATTERY_MODE.CONSTANT && shouldKickstartPv(host, now, solarProductionW)) {
    const todayKey = getBerlinDateKey(now);
    host.pvKickstartDateKey = todayKey;
    host.pvKickstartUntilMs = now.getTime() + PV_KICKSTART_DURATION_MS;
    decision = {
      ...decision,
      mode: BATTERY_MODE.NORMAL,
      reason: `PV kickstart (PV <= ${PV_START_THRESHOLD_W} W, morning window) → NORMAL for ${Math.round(PV_KICKSTART_DURATION_MS / 60000)} min`,
    };
    host.log(`   PV kickstart active until ${new Date(host.pvKickstartUntilMs).toLocaleString('de-DE', { timeZone: 'Europe/Berlin' })}`);
  }

  host.log(`Decision: ${decision.mode} (interval ${decision.intervalIndex})`);
  host.log(`Reason: ${decision.reason}`);

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
