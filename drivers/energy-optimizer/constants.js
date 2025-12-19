'use strict';

/**
 * Central constants for energy-optimizer driver
 * All configuration constants are defined here for easy maintenance
 */

// Time intervals
const INTERVAL_MINUTES = 15;
const INTERVAL_HOURS = INTERVAL_MINUTES / 60;
const INTERVALS_PER_DAY = 96; // 24 hours * 4 intervals per hour
const DEFAULT_DAILY_FETCH_HOUR = 15; // Fetch Tibber prices at 15:00

// Battery defaults
const DEFAULT_BATTERY_CAPACITY_KWH = 9.9;
const DEFAULT_CHARGE_POWER_KW = 6.0;
const DEFAULT_TARGET_SOC = 85; // %
const DEFAULT_MIN_SOC_THRESHOLD = 7; // %
const DEFAULT_EFFICIENCY_LOSS_PERCENT = 10; // %

// Optimization parameters
const DEFAULT_EXPENSIVE_PRICE_FACTOR = 1.05;
const DEFAULT_MIN_PROFIT_CENT_PER_KWH = 6;
const DEFAULT_FORECAST_DAYS = 7;
const SOLAR_FEED_IN_TARIFF_EUR_PER_KWH = 0.07;

// Grid power thresholds for mode decisions
const GRID_SOLAR_THRESHOLD_W = -50; // Below this = solar excess
const GRID_CONSUMPTION_THRESHOLD_W = 50; // Above this = grid consumption

// Battery charge log management
const MAX_BATTERY_LOG_DAYS = 7;
const MAX_BATTERY_LOG_ENTRIES = MAX_BATTERY_LOG_DAYS * INTERVALS_PER_DAY;

// Timezone for price data
const PRICE_TIMEZONE = 'Europe/Berlin';

module.exports = {
  INTERVAL_MINUTES,
  INTERVAL_HOURS,
  DEFAULT_DAILY_FETCH_HOUR,
  DEFAULT_BATTERY_CAPACITY_KWH,
  DEFAULT_CHARGE_POWER_KW,
  DEFAULT_TARGET_SOC,
  DEFAULT_MIN_SOC_THRESHOLD,
  DEFAULT_EFFICIENCY_LOSS_PERCENT,
  DEFAULT_EXPENSIVE_PRICE_FACTOR,
  DEFAULT_MIN_PROFIT_CENT_PER_KWH,
  DEFAULT_FORECAST_DAYS,
  SOLAR_FEED_IN_TARIFF_EUR_PER_KWH,
  GRID_SOLAR_THRESHOLD_W,
  GRID_CONSUMPTION_THRESHOLD_W,
  MAX_BATTERY_LOG_ENTRIES,
  PRICE_TIMEZONE,
};
