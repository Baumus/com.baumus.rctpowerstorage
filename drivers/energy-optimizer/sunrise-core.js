'use strict';

const DEFAULT_TIME_ZONE = 'Europe/Berlin';
const DEFAULT_INTERVAL_MINUTES = 15;
const DEFAULT_HISTORY_START_THRESHOLD_W = 30;

function toRadians(value) {
  return value * (Math.PI / 180);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function getDateKeyInTimeZone(date, timeZone = DEFAULT_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);

  const year = parts.find((p) => p.type === 'year')?.value;
  const month = parts.find((p) => p.type === 'month')?.value;
  const day = parts.find((p) => p.type === 'day')?.value;
  return `${year}-${month}-${day}`;
}

function getMinutesSinceMidnightInTimeZone(date, timeZone = DEFAULT_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const hour = Number.parseInt(parts.find((p) => p.type === 'hour')?.value, 10);
  const minute = Number.parseInt(parts.find((p) => p.type === 'minute')?.value, 10);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  return (hour * 60) + minute;
}

function getDayOfYearInTimeZone(date, timeZone = DEFAULT_TIME_ZONE) {
  const yearStr = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
  }).format(date);
  const year = Number.parseInt(yearStr, 10);
  if (!Number.isFinite(year)) return null;

  const monthDay = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    month: '2-digit',
    day: '2-digit',
  }).format(date);

  const jan1Utc = new Date(Date.UTC(year, 0, 1));
  const localDateUtc = new Date(`${year}-${monthDay}T00:00:00Z`);
  const diffDays = Math.floor((localDateUtc.getTime() - jan1Utc.getTime()) / (24 * 60 * 60 * 1000));
  return diffDays + 1;
}

function calculateAstronomicalSunriseMinutes(date, latitude, longitude, timeZone = DEFAULT_TIME_ZONE) {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return null;
  }

  const lat = clamp(latitude, -89.8, 89.8);
  const lon = clamp(longitude, -180, 180);

  const dayOfYear = getDayOfYearInTimeZone(date, timeZone);
  if (!Number.isFinite(dayOfYear)) return null;

  const gamma = (2 * Math.PI / 365) * (dayOfYear - 1);
  const eqTime = 229.18 * (
    0.000075
    + (0.001868 * Math.cos(gamma))
    - (0.032077 * Math.sin(gamma))
    - (0.014615 * Math.cos(2 * gamma))
    - (0.040849 * Math.sin(2 * gamma))
  );
  const solarDecl = 0.006918
    - (0.399912 * Math.cos(gamma))
    + (0.070257 * Math.sin(gamma))
    - (0.006758 * Math.cos(2 * gamma))
    + (0.000907 * Math.sin(2 * gamma))
    - (0.002697 * Math.cos(3 * gamma))
    + (0.00148 * Math.sin(3 * gamma));

  const zenithRad = toRadians(90.833);
  const latRad = toRadians(lat);
  const cosHourAngle = (Math.cos(zenithRad) / (Math.cos(latRad) * Math.cos(solarDecl)))
    - (Math.tan(latRad) * Math.tan(solarDecl));

  if (cosHourAngle < -1 || cosHourAngle > 1) {
    return null;
  }

  const hourAngleDeg = (Math.acos(cosHourAngle) * 180) / Math.PI;
  const solarNoonUtcMinutes = 720 - (4 * lon) - eqTime;
  const sunriseUtcMinutes = solarNoonUtcMinutes - (4 * hourAngleDeg);

  const midnightUtc = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0);
  const sunriseUtcMs = midnightUtc + (sunriseUtcMinutes * 60 * 1000);
  const sunriseDate = new Date(sunriseUtcMs);
  return getMinutesSinceMidnightInTimeZone(sunriseDate, timeZone);
}

function estimateHistoricalSunriseMinutes(productionHistory, intervalMinutes = DEFAULT_INTERVAL_MINUTES) {
  if (!productionHistory || typeof productionHistory !== 'object') return null;

  const intervalCount = Math.round((24 * 60) / intervalMinutes);
  for (let i = 0; i < intervalCount; i += 1) {
    const current = productionHistory[i];
    const next = productionHistory[i + 1];
    if (!Array.isArray(current) || !current.length) continue;

    const avgCurrent = current.reduce((sum, value) => sum + value, 0) / current.length;
    const avgNext = Array.isArray(next) && next.length
      ? (next.reduce((sum, value) => sum + value, 0) / next.length)
      : avgCurrent;

    if (avgCurrent >= DEFAULT_HISTORY_START_THRESHOLD_W && avgNext >= DEFAULT_HISTORY_START_THRESHOLD_W) {
      return i * intervalMinutes;
    }
  }

  return null;
}

function estimateSeasonalBerlinSunriseMinutes(date, timeZone = DEFAULT_TIME_ZONE) {
  const day = getDayOfYearInTimeZone(date, timeZone);
  if (!Number.isFinite(day)) return 390;

  const averageMinutes = 390;
  const amplitude = 107;
  const phaseDay = 172;
  const seasonal = averageMinutes - (amplitude * Math.cos((2 * Math.PI * (day - phaseDay)) / 365));
  return clamp(Math.round(seasonal), 250, 520);
}

function resolveSunriseEstimate({
  date,
  timeZone = DEFAULT_TIME_ZONE,
  geolocation = null,
  productionHistory = null,
  intervalMinutes = DEFAULT_INTERVAL_MINUTES,
} = {}) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return { minutes: null, source: 'invalid-date' };
  }

  const lat = geolocation && Number.isFinite(geolocation.latitude) ? geolocation.latitude : null;
  const lon = geolocation && Number.isFinite(geolocation.longitude) ? geolocation.longitude : null;
  const geoMinutes = calculateAstronomicalSunriseMinutes(date, lat, lon, timeZone);
  if (Number.isFinite(geoMinutes)) {
    return { minutes: geoMinutes, source: 'geo' };
  }

  const historicalMinutes = estimateHistoricalSunriseMinutes(productionHistory, intervalMinutes);
  if (Number.isFinite(historicalMinutes)) {
    return { minutes: historicalMinutes, source: 'history' };
  }

  return {
    minutes: estimateSeasonalBerlinSunriseMinutes(date, timeZone),
    source: 'seasonal-fallback',
  };
}

function isMinuteInWindow(currentMinute, startMinute, endMinute) {
  if (!Number.isFinite(currentMinute) || !Number.isFinite(startMinute) || !Number.isFinite(endMinute)) {
    return false;
  }

  const normalizedCurrent = ((currentMinute % 1440) + 1440) % 1440;
  const normalizedStart = ((startMinute % 1440) + 1440) % 1440;
  const normalizedEnd = ((endMinute % 1440) + 1440) % 1440;

  if (normalizedStart <= normalizedEnd) {
    return normalizedCurrent >= normalizedStart && normalizedCurrent <= normalizedEnd;
  }

  return normalizedCurrent >= normalizedStart || normalizedCurrent <= normalizedEnd;
}

module.exports = {
  getDateKeyInTimeZone,
  getMinutesSinceMidnightInTimeZone,
  calculateAstronomicalSunriseMinutes,
  estimateHistoricalSunriseMinutes,
  estimateSeasonalBerlinSunriseMinutes,
  resolveSunriseEstimate,
  isMinuteInWindow,
};