'use strict';

const { BATTERY_MODE } = require('../strategy-execution-core');
const { summarizeSavingsHistory } = require('./savings-history');

const POWER_DEADBAND_W = 50;

function translate(host, key, fallback, variables = {}) {
  let text = fallback;

  if (host?.homey && typeof host.homey.__ === 'function') {
    try {
      const translated = host.homey.__(key);
      if (typeof translated === 'string' && translated.length > 0 && translated !== key) {
        text = translated;
      }
    } catch (error) {
      // Fall back to the provided default text when the locale layer is unavailable.
    }
  }

  return text.replace(/\{(\w+)\}/g, (match, variableName) => {
    if (!Object.prototype.hasOwnProperty.call(variables, variableName)) {
      return match;
    }

    return String(variables[variableName]);
  });
}

function getIntervalDate(interval) {
  if (!interval || !interval.startsAt) return null;
  const date = new Date(interval.startsAt);
  return Number.isNaN(date.getTime()) ? null : date;
}

function findActiveInterval(intervals, now) {
  return (Array.isArray(intervals) ? intervals : []).find((interval) => {
    const startsAt = getIntervalDate(interval);
    if (!startsAt) return false;

    const endsAt = interval.endsAt ? new Date(interval.endsAt) : new Date(startsAt.getTime() + (15 * 60 * 1000));
    return startsAt <= now && now < endsAt;
  }) || null;
}

function findNextInterval(intervals, now) {
  return (Array.isArray(intervals) ? intervals : [])
    .map((interval) => ({ interval, startsAt: getIntervalDate(interval) }))
    .filter(({ startsAt }) => startsAt && startsAt >= now)
    .sort((left, right) => left.startsAt - right.startsAt)[0]?.interval || null;
}

function getEarlierInterval(leftInterval, rightInterval) {
  const leftDate = getIntervalDate(leftInterval);
  const rightDate = getIntervalDate(rightInterval);

  if (!leftDate) return rightInterval || null;
  if (!rightDate) return leftInterval || null;

  return leftDate <= rightDate ? leftInterval : rightInterval;
}

function getIntervalEndDate(interval) {
  if (!interval) return null;

  if (interval.endsAt) {
    const explicitEnd = new Date(interval.endsAt);
    if (!Number.isNaN(explicitEnd.getTime())) {
      return explicitEnd;
    }
  }

  const startsAt = getIntervalDate(interval);
  if (!startsAt) return null;

  return new Date(startsAt.getTime() + (15 * 60 * 1000));
}

function getPlanHorizonSummary(host, strategy) {
  const allIntervals = [
    ...(Array.isArray(strategy?.chargeIntervals) ? strategy.chargeIntervals : []),
    ...(Array.isArray(strategy?.dischargeIntervals) ? strategy.dischargeIntervals : []),
  ];

  const latestEnd = allIntervals
    .map((interval) => getIntervalEndDate(interval))
    .filter((value) => value instanceof Date && !Number.isNaN(value.getTime()))
    .sort((left, right) => right - left)[0] || null;

  return {
    hasPlan: !!latestEnd,
    endsAt: latestEnd ? latestEnd.toISOString() : null,
    displayTime: latestEnd ? formatDisplayDateTime(host, latestEnd) : null,
  };
}

function formatDisplayDateTime(host, value) {
  if (!value) return null;

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  return date.toLocaleString(host.homey.i18n.getLanguage(), {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Berlin',
  });
}

function getBatterySummary(strategy) {
  const batteryStatus = strategy?.batteryStatus || null;
  if (!batteryStatus) return null;

  const currentSocPercent = (batteryStatus.currentSoc || 0) * 100;
  const targetSocPercent = (batteryStatus.targetSoc || 0) * 100;
  const freeCapacityToTargetKWh = Math.max(
    0,
    batteryStatus.availableCapacityToTarget ?? batteryStatus.availableCapacity ?? 0,
  );
  const aboveTargetDeltaPercent = Math.max(0, currentSocPercent - targetSocPercent);
  const aboveTargetBufferKWh = Math.max(0, batteryStatus.excessEnergyAboveTargetKWh || 0);

  return {
    currentSocPercent: Math.round(currentSocPercent * 10) / 10,
    targetSocPercent: Math.round(targetSocPercent * 10) / 10,
    storedKWh: batteryStatus.storedKWh || 0,
    freeCapacityToTargetKWh,
    aboveTargetDeltaPercent: Math.round(aboveTargetDeltaPercent * 10) / 10,
    aboveTargetBufferKWh: Math.round(aboveTargetBufferKWh * 100) / 100,
    avgEnergyPriceEurPerKWh: batteryStatus.energyCost?.avgPrice || null,
    energyPriceIsEstimated: !!batteryStatus.energyCost?.isEstimated,
  };
}

function getChargePlanSummary(strategy, nextChargeInterval) {
  const plannedCharging = strategy?.plannedCharging || null;
  const chargeIntervals = Array.isArray(strategy?.chargeIntervals) ? strategy.chargeIntervals : [];

  if (!plannedCharging || chargeIntervals.length === 0) {
    return {
      hasPlan: false,
      summary: 'Keine Netzladung geplant.',
      windowCount: 0,
      totalEnergyKWh: 0,
      avgPriceEurPerKWh: null,
      nextStart: null,
    };
  }

  return {
    hasPlan: true,
    summary: nextChargeInterval
      ? 'Netzladung ist geplant, weil guenstige Preisfenster erkannt wurden.'
      : 'Netzladung wurde fuer guenstige Preisfenster eingeplant.',
    windowCount: chargeIntervals.length,
    totalEnergyKWh: plannedCharging.totalEnergyKWh || 0,
    avgPriceEurPerKWh: plannedCharging.avgPriceEurPerKWh || null,
    nextStart: nextChargeInterval?.startsAt || null,
  };
}

function getDischargePlanSummary(strategy, nextDischargeInterval) {
  const dischargeIntervals = Array.isArray(strategy?.dischargeIntervals) ? strategy.dischargeIntervals : [];

  if (dischargeIntervals.length === 0) {
    return {
      hasPlan: false,
      windowCount: 0,
      nextStart: null,
    };
  }

  return {
    hasPlan: true,
    windowCount: dischargeIntervals.length,
    nextStart: nextDischargeInterval?.startsAt || null,
  };
}

function getCurrentAction(host, strategy, now, activeChargeInterval, activeDischargeInterval) {
  const mode = host.lastBatteryMode || BATTERY_MODE.IDLE;

  if (mode === BATTERY_MODE.CHARGE || activeChargeInterval) {
    return {
      key: 'charging',
      title: translate(host, 'dashboard.current_action.charging.title', 'Batterie laedt aus dem Netz'),
      detail: translate(host, 'dashboard.current_action.charging.detail', 'Gerade laeuft ein geplantes guenstiges Ladefenster.'),
      tone: 'positive',
    };
  }

  if (mode === BATTERY_MODE.NORMAL || activeDischargeInterval) {
    return {
      key: 'supplying-house',
      title: translate(host, 'dashboard.current_action.supplying_house.title', 'Batterie versorgt das Haus'),
      detail: translate(host, 'dashboard.current_action.supplying_house.detail', 'Gespeicherte Energie wird genutzt, um teuren Netzbezug zu vermeiden.'),
      tone: 'positive',
    };
  }

  if (mode === BATTERY_MODE.CONSTANT) {
    return {
      key: 'holding',
      title: translate(host, 'dashboard.current_action.holding.title', 'Batterie wartet auf Solar oder spaetere Nutzung'),
      detail: translate(host, 'dashboard.current_action.holding.detail', 'Die Batterie wird im Haltemodus geschuetzt und nicht aktiv aus dem Netz geladen.'),
      tone: 'neutral',
    };
  }

  const nextChargeInterval = findNextInterval(strategy?.chargeIntervals, now);
  return {
    key: 'idle',
    title: translate(host, 'dashboard.current_action.idle.title', 'Batterie wartet'),
    detail: nextChargeInterval
      ? translate(host, 'dashboard.current_action.idle.detail_with_next_charge', 'Aktuell ist kein Eingriff noetig, das naechste Ladefenster ist bereits geplant.')
      : translate(host, 'dashboard.current_action.idle.detail_without_plan', 'Aktuell ist weder Netzladung noch Entladung eingeplant.'),
    tone: 'neutral',
  };
}

function getCurrentReason(host, strategy, activeChargeInterval, activeDischargeInterval) {
  if (activeChargeInterval) {
    return translate(host, 'dashboard.current_reason.active_charge', 'Der aktuelle Strompreis liegt in einem geplanten guenstigen Ladefenster.');
  }

  if (activeDischargeInterval) {
    return translate(host, 'dashboard.current_reason.active_discharge', 'Die aktuelle Zeit wurde als teuer eingestuft, deshalb wird gespeicherte Energie bevorzugt genutzt.');
  }

  if (strategy?.plannedCharging?.totalEnergyKWh > 0) {
    return translate(host, 'dashboard.current_reason.waiting_for_later_cheap_slots', 'Es gibt guenstige Preisfenster spaeter am Tag, daher wird jetzt gewartet.');
  }

  return translate(host, 'dashboard.current_reason.no_economic_window', 'Es wurde aktuell kein wirtschaftlich sinnvolles Netzladefenster gefunden.');
}

function getNextAction(host, strategy, now) {
  const nextChargeInterval = findNextInterval(strategy?.chargeIntervals, now);
  const nextDischargeInterval = findNextInterval(strategy?.dischargeIntervals, now);
  const nextInterval = getEarlierInterval(nextChargeInterval, nextDischargeInterval);

  if (nextInterval === nextChargeInterval && nextChargeInterval) {
    return {
      key: 'next-charge-window',
      title: translate(host, 'dashboard.next_action.next_charge_window.title', 'Naechstes Ladefenster'),
      detail: translate(host, 'dashboard.next_action.next_charge_window.detail', 'Die naechste Netzladung startet, sobald das guenstige Preisfenster beginnt.'),
      startsAt: nextChargeInterval.startsAt,
      displayTime: formatDisplayDateTime(host, nextChargeInterval.startsAt),
    };
  }

  if (nextInterval === nextDischargeInterval && nextDischargeInterval) {
    return {
      key: 'next-expensive-window',
      title: translate(host, 'dashboard.next_action.next_expensive_window.title', 'Naechste teure Phase'),
      detail: translate(host, 'dashboard.next_action.next_expensive_window.detail', 'Dann wird die Batterie bevorzugt fuer den Hausverbrauch bereitgehalten.'),
      startsAt: nextDischargeInterval.startsAt,
      displayTime: formatDisplayDateTime(host, nextDischargeInterval.startsAt),
    };
  }

  return {
    key: 'no-next-event',
    title: translate(host, 'dashboard.next_action.none.title', 'Kein weiteres Ereignis geplant'),
    detail: translate(host, 'dashboard.next_action.none.detail', 'Es liegt aktuell kein weiteres Lade- oder Entladefenster im Plan.'),
    startsAt: null,
    displayTime: null,
  };
}

function getBatteryDirection(batteryPowerW) {
  if (!Number.isFinite(batteryPowerW)) return 'unknown';
  if (batteryPowerW >= POWER_DEADBAND_W) return 'charging';
  if (batteryPowerW <= -POWER_DEADBAND_W) return 'discharging';
  return 'idle';
}

function getEnergyFlowSummary(host) {
  const mode = host.lastBatteryMode || BATTERY_MODE.IDLE;
  const liveState = host.liveEnergyState || {};
  const gridPowerW = Number.isFinite(liveState.gridPowerW) ? liveState.gridPowerW : null;
  const solarPowerW = Number.isFinite(liveState.solarPowerW) ? liveState.solarPowerW : null;
  const batteryPowerW = Number.isFinite(liveState.batteryPowerW) ? liveState.batteryPowerW : null;
  const batteryDirection = getBatteryDirection(batteryPowerW);
  const solarActive = Number.isFinite(solarPowerW) && solarPowerW > POWER_DEADBAND_W;
  const importingFromGrid = Number.isFinite(gridPowerW) && gridPowerW > POWER_DEADBAND_W;
  const exportingToGrid = Number.isFinite(gridPowerW) && gridPowerW < -POWER_DEADBAND_W;

  let title = translate(host, 'dashboard.energy_flow.default.title', 'Haus wird direkt aus dem Netz versorgt');
  let detail = translate(host, 'dashboard.energy_flow.default.detail', 'Es liegt aktuell kein aktiver Batteriefluss vor.');

  if (batteryDirection === 'charging') {
    if (solarActive && !importingFromGrid) {
      title = translate(host, 'dashboard.energy_flow.solar_charging.title', 'Solar laedt die Batterie');
      detail = exportingToGrid
        ? translate(host, 'dashboard.energy_flow.solar_charging.detail_exporting', 'Es ist Solarueberschuss vorhanden, die Batterie nimmt einen Teil davon auf.')
        : translate(host, 'dashboard.energy_flow.solar_charging.detail', 'Solarproduktion wird gerade in die Batterie verschoben.');
    } else {
      title = translate(host, 'dashboard.energy_flow.grid_charging.title', 'Netz laedt die Batterie');
      detail = translate(host, 'dashboard.energy_flow.grid_charging.detail', 'Der aktuelle Netzbezug enthaelt aktive Batterieladung aus dem geplanten Ladefenster.');
    }
  } else if (batteryDirection === 'discharging') {
    title = solarActive
      ? translate(host, 'dashboard.energy_flow.solar_and_battery_support.title', 'Solar und Batterie versorgen das Haus')
      : translate(host, 'dashboard.energy_flow.battery_support.title', 'Batterie versorgt das Haus');
    detail = importingFromGrid
      ? translate(host, 'dashboard.energy_flow.battery_support.detail_importing', 'Die Batterie deckt einen Teil der Last, zusaetzlicher Bedarf kommt noch aus dem Netz.')
      : translate(host, 'dashboard.energy_flow.battery_support.detail', 'Gespeicherte Energie reduziert oder ersetzt den Netzbezug.');
  } else if (solarActive && exportingToGrid) {
    title = translate(host, 'dashboard.energy_flow.solar_export.title', 'Solar versorgt das Haus und speist Ueberschuss ein');
    detail = translate(host, 'dashboard.energy_flow.solar_export.detail', 'Aktuell ist mehr Solarstrom verfuegbar als Haus und Batterie aufnehmen.');
  } else if (solarActive && importingFromGrid) {
    title = translate(host, 'dashboard.energy_flow.solar_and_grid.title', 'Haus nutzt Solar und Netz');
    detail = translate(host, 'dashboard.energy_flow.solar_and_grid.detail', 'Solar ist aktiv, reicht aber momentan nicht fuer den gesamten Verbrauch.');
  } else if (solarActive) {
    title = translate(host, 'dashboard.energy_flow.solar_only.title', 'Solar versorgt das Haus');
    detail = translate(host, 'dashboard.energy_flow.solar_only.detail', 'Der aktuelle Hausverbrauch wird im Wesentlichen direkt aus Solar gedeckt.');
  } else if (mode === BATTERY_MODE.CONSTANT) {
    title = translate(host, 'dashboard.energy_flow.holding_from_grid.title', 'Batterie wartet, Haus nutzt Netz');
    detail = translate(host, 'dashboard.energy_flow.holding_from_grid.detail', 'Die Batterie wird gehalten und nicht zur Versorgung freigegeben.');
  }

  return {
    battery: batteryDirection,
    house: batteryDirection === 'discharging' ? 'battery-supported' : (solarActive ? 'solar-supported' : 'grid'),
    grid: importingFromGrid ? 'importing' : (exportingToGrid ? 'exporting' : 'balanced'),
    solar: solarActive ? 'active' : 'inactive',
    title,
    detail,
    measurements: {
      gridPowerW,
      solarPowerW,
      batteryPowerW,
    },
    source: liveState.source || null,
    updatedAt: liveState.updatedAt || null,
  };
}

function buildDashboardSummary(host, strategyOverride = null) {
  const strategy = strategyOverride || host.currentStrategy || {};
  const now = host._dashboardSummaryNow instanceof Date ? host._dashboardSummaryNow : new Date();
  const activeChargeInterval = findActiveInterval(strategy.chargeIntervals, now);
  const activeDischargeInterval = findActiveInterval(strategy.dischargeIntervals, now);
  const nextChargeInterval = findNextInterval(strategy.chargeIntervals, now);
  const nextDischargeInterval = findNextInterval(strategy.dischargeIntervals, now);
  const realizedSavings = summarizeSavingsHistory(host.savingsHistory, now);

  return {
    generatedAt: now.toISOString(),
    currentAction: getCurrentAction(host, strategy, now, activeChargeInterval, activeDischargeInterval),
    currentReason: getCurrentReason(host, strategy, activeChargeInterval, activeDischargeInterval),
    nextAction: getNextAction(host, strategy, now),
    energyFlow: getEnergyFlowSummary(host),
    chargePlan: (function buildChargePlanSummary() {
      const planSummary = getChargePlanSummary(strategy, nextChargeInterval);

      if (!planSummary.hasPlan) {
        return {
          ...planSummary,
          summary: translate(host, 'dashboard.charge_plan.none', 'Keine Netzladung geplant.'),
        };
      }

      return {
        ...planSummary,
        summary: nextChargeInterval
          ? translate(host, 'dashboard.charge_plan.detected_windows', 'Netzladung ist geplant, weil guenstige Preisfenster erkannt wurden.')
          : translate(host, 'dashboard.charge_plan.scheduled_windows', 'Netzladung wurde fuer guenstige Preisfenster eingeplant.'),
      };
    }()),
    dischargePlan: getDischargePlanSummary(strategy, nextDischargeInterval),
    planHorizon: getPlanHorizonSummary(host, strategy),
    savings: {
      todayForecastEur: strategy?.economics?.savings ?? strategy?.savings ?? 0,
      realized: realizedSavings,
    },
    battery: getBatterySummary(strategy),
  };
}

module.exports = {
  buildDashboardSummary,
};