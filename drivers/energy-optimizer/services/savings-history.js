'use strict';

const { calculateDischargeProfit } = require('../battery-cost-core');

const DISPLAY_TIME_ZONE = 'Europe/Berlin';
const DAY_MS = 24 * 60 * 60 * 1000;

function getBerlinDateParts(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: DISPLAY_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);

  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  if (!year || !month || !day) return null;

  return { year, month, day };
}

function getBerlinDayKey(value) {
  const parts = getBerlinDateParts(value);
  return parts ? `${parts.year}-${parts.month}-${parts.day}` : null;
}

function getDayNumberFromKey(dayKey) {
  if (typeof dayKey !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) {
    return null;
  }

  const [year, month, day] = dayKey.split('-').map((part) => Number(part));
  return Math.floor(Date.UTC(year, month - 1, day) / DAY_MS);
}

function roundCurrency(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function createEmptyDailyRollup(dayKey) {
  return {
    dayKey,
    realizedSavingsEur: 0,
    dischargedKWh: 0,
    eventCount: 0,
    updatedAt: null,
  };
}

function getRealizedSavingsForDischarge(entry) {
  if (!entry || entry.type !== 'discharge') {
    return 0;
  }

  const dischargedKWh = Math.abs(entry.totalKWh || 0);
  const avgBatteryPrice = Number(entry.avgBatteryPrice || 0);
  const gridPrice = Number(entry.gridPrice || 0);
  const result = calculateDischargeProfit(dischargedKWh, avgBatteryPrice, gridPrice);
  return result.worthIt ? result.profit : 0;
}

function updateSavingsHistoryWithEntry(history, entry) {
  const nextHistory = { ...(history || {}) };
  const dayKey = getBerlinDayKey(entry?.timestamp);

  if (!dayKey || entry?.type !== 'discharge') {
    return nextHistory;
  }

  const realizedSavingsEur = getRealizedSavingsForDischarge(entry);
  const dischargedKWh = Math.abs(entry.totalKWh || 0);
  const previous = nextHistory[dayKey] || createEmptyDailyRollup(dayKey);

  nextHistory[dayKey] = {
    dayKey,
    realizedSavingsEur: roundCurrency((previous.realizedSavingsEur || 0) + realizedSavingsEur),
    dischargedKWh: roundCurrency((previous.dischargedKWh || 0) + dischargedKWh),
    eventCount: (previous.eventCount || 0) + 1,
    updatedAt: entry.timestamp || new Date().toISOString(),
  };

  return nextHistory;
}

function rebuildSavingsHistoryFromChargeLog(chargeLog) {
  return (Array.isArray(chargeLog) ? chargeLog : []).reduce((history, entry) => updateSavingsHistoryWithEntry(history, entry), {});
}

function summarizeSavingsHistory(history, now = new Date()) {
  const entries = Object.values(history || {});
  const currentDayKey = getBerlinDayKey(now);
  const currentDayNumber = getDayNumberFromKey(currentDayKey);
  const currentMonthKey = currentDayKey ? currentDayKey.slice(0, 7) : null;

  let lastMonthKey = null;
  if (currentMonthKey) {
    const [year, month] = currentMonthKey.split('-').map((part) => Number(part));
    const previousMonth = month === 1 ? 12 : month - 1;
    const previousYear = month === 1 ? year - 1 : year;
    lastMonthKey = `${previousYear}-${String(previousMonth).padStart(2, '0')}`;
  }

  const summary = {
    currentMonthEur: 0,
    lastMonthEur: 0,
    last365DaysEur: 0,
    lifetimeEur: 0,
    historyDays: 0,
    lastUpdated: null,
  };

  for (const entry of entries) {
    if (!entry || typeof entry.dayKey !== 'string') continue;

    const savings = Number(entry.realizedSavingsEur || 0);
    const dayNumber = getDayNumberFromKey(entry.dayKey);
    summary.historyDays += 1;
    summary.lifetimeEur += savings;

    if (entry.updatedAt && (!summary.lastUpdated || entry.updatedAt > summary.lastUpdated)) {
      summary.lastUpdated = entry.updatedAt;
    }

    if (entry.dayKey.slice(0, 7) === currentMonthKey) {
      summary.currentMonthEur += savings;
    }

    if (entry.dayKey.slice(0, 7) === lastMonthKey) {
      summary.lastMonthEur += savings;
    }

    if (currentDayNumber !== null && dayNumber !== null && dayNumber >= (currentDayNumber - 364) && dayNumber <= currentDayNumber) {
      summary.last365DaysEur += savings;
    }
  }

  summary.currentMonthEur = roundCurrency(summary.currentMonthEur);
  summary.lastMonthEur = roundCurrency(summary.lastMonthEur);
  summary.last365DaysEur = roundCurrency(summary.last365DaysEur);
  summary.lifetimeEur = roundCurrency(summary.lifetimeEur);

  return summary;
}

module.exports = {
  getBerlinDayKey,
  getRealizedSavingsForDischarge,
  updateSavingsHistoryWithEntry,
  rebuildSavingsHistoryFromChargeLog,
  summarizeSavingsHistory,
};