'use strict';

const de = require('../locales/de.json');
const {
  calculateBatteryEnergyCost,
  createChargeEntry,
} = require('../drivers/energy-optimizer/battery-cost-core');

function t(key) {
  return key.split('.').reduce((value, segment) => value?.[segment], de) || key;
}

function formatText(key, variables = {}) {
  return t(key).replace(/\{(\w+)\}/g, (match, variableName) => {
    if (!Object.prototype.hasOwnProperty.call(variables, variableName)) {
      return match;
    }

    return String(variables[variableName]);
  });
}

function getDischargeIntervals(strategy = {}) {
  if (Array.isArray(strategy.dischargeIntervals) && strategy.dischargeIntervals.length > 0) {
    return strategy.dischargeIntervals;
  }

  if (Array.isArray(strategy.expensiveIntervals) && strategy.expensiveIntervals.length > 0) {
    return strategy.expensiveIntervals;
  }

  return [];
}

const DISPLAY_TIME_ZONE = 'Europe/Berlin';

function formatDisplayTime(value, locale = 'en-GB') {
  return new Date(value).toLocaleTimeString(locale, {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: DISPLAY_TIME_ZONE,
  });
}

function formatDisplayDate(value, locale = 'en-GB') {
  return new Date(value).toLocaleDateString(locale, {
    month: 'short',
    day: 'numeric',
    timeZone: DISPLAY_TIME_ZONE,
  });
}

function formatDisplayDateTime(value, locale = 'de-DE') {
  return new Date(value).toLocaleString(locale, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: DISPLAY_TIME_ZONE,
  });
}

/**
 * Settings Page Rendering Tests
 * 
 * These tests verify that the data processing and rendering logic
 * for the settings page (index.html) works correctly. They simulate
 * the data transformations that happen in the browser without requiring
 * a full DOM environment.
 */

describe('Settings Page Data Rendering', () => {
  describe('Device Status Rendering', () => {
    it('should format device status correctly', () => {
      const deviceCapabilities = {
        optimizer_status: 'Charging at 3.3kW',
        next_charge_start: '2024-01-15 22:00',
        onoff: true,
        estimated_savings: 2.45,
      };

      // Simulate status rendering logic
      const status = deviceCapabilities.optimizer_status || 'Unknown';
      const nextCharge = deviceCapabilities.next_charge_start || '-';
      const isEnabled = deviceCapabilities.onoff || false;
      const savings = deviceCapabilities.estimated_savings || 0;

      expect(status).toBe('Charging at 3.3kW');
      expect(nextCharge).toBe('2024-01-15 22:00');
      expect(isEnabled).toBe(true);
      expect(savings).toBeCloseTo(2.45, 2);
    });

    it('should handle missing capabilities gracefully', () => {
      const deviceCapabilities = {};

      const status = deviceCapabilities.optimizer_status || 'Unknown';
      const nextCharge = deviceCapabilities.next_charge_start || '-';
      const isEnabled = deviceCapabilities.onoff || false;
      const savings = deviceCapabilities.estimated_savings || 0;

      expect(status).toBe('Unknown');
      expect(nextCharge).toBe('-');
      expect(isEnabled).toBe(false);
      expect(savings).toBe(0);
    });

    it('should identify charging state from status text', () => {
      const chargingStatus = 'Charging at 3.3kW';
      const idleStatus = 'Idle - Waiting for cheap price';
      const dischargingStatus = 'Using battery power';

      expect(chargingStatus.toLowerCase().includes('charg')).toBe(true);
      expect(idleStatus.toLowerCase().includes('charg')).toBe(false);
      expect(dischargingStatus.toLowerCase().includes('charg')).toBe(false);
    });
  });

  describe('Statistics Rendering', () => {
    it('should format statistics correctly', () => {
      const strategy = {
        chargeIntervals: [
          { startsAt: '2024-01-15T22:00:00Z', total: 0.15 },
          { startsAt: '2024-01-15T22:15:00Z', total: 0.16 },
        ],
        expensiveIntervals: [
          { startsAt: '2024-01-16T18:00:00Z', total: 0.32 },
        ],
        avgPrice: 0.2234,
        neededKWh: 8.5,
      };

      const device = {
        capabilities: {
          estimated_savings: 3.25,
        },
      };

      const savings = device.capabilities.estimated_savings || 0;
      const chargeIntervals = strategy.chargeIntervals?.length || 0;
      const expensiveIntervals = getDischargeIntervals(strategy).length;
      const avgPrice = strategy.avgPrice ? strategy.avgPrice.toFixed(4) : '-';
      const neededKWh = strategy.neededKWh ? strategy.neededKWh.toFixed(2) : '-';

      expect(savings.toFixed(2)).toBe('3.25');
      expect(chargeIntervals).toBe(2);
      expect(expensiveIntervals).toBe(1);
      expect(avgPrice).toBe('0.2234');
      expect(neededKWh).toBe('8.50');
    });

    it('should handle missing strategy data', () => {
      const strategy = {};
      const device = { capabilities: {} };

      const chargeIntervals = strategy.chargeIntervals?.length || 0;
      const expensiveIntervals = getDischargeIntervals(strategy).length;
      const avgPrice = strategy.avgPrice ? strategy.avgPrice.toFixed(4) : '-';

      expect(chargeIntervals).toBe(0);
      expect(expensiveIntervals).toBe(0);
      expect(avgPrice).toBe('-');
    });

    it('should use dischargeIntervals when expensiveIntervals is missing', () => {
      const strategy = {
        dischargeIntervals: [
          { startsAt: '2024-01-16T18:00:00Z', total: 0.32 },
          { startsAt: '2024-01-16T18:15:00Z', total: 0.34 },
        ],
      };

      expect(getDischargeIntervals(strategy)).toHaveLength(2);
    });
  });

  describe('Price Chart Data Processing', () => {
    it('should define a clear legend for price chart colors and average line', () => {
      const legendItems = [
        {
          swatchClass: 'charging',
          title: t('settings_page.price_legend.planned_grid_charge.title'),
          detail: t('settings_page.price_legend.planned_grid_charge.detail'),
        },
        {
          swatchClass: 'expensive',
          title: t('settings_page.price_legend.expensive_use.title'),
          detail: t('settings_page.price_legend.expensive_use.detail'),
        },
        {
          swatchClass: 'cheap',
          title: t('settings_page.price_legend.cheap_window.title'),
          detail: t('settings_page.price_legend.cheap_window.detail'),
        },
        {
          swatchClass: '',
          title: t('settings_page.price_legend.normal_window.title'),
          detail: t('settings_page.price_legend.normal_window.detail'),
        },
        {
          swatchClass: 'avg-line',
          title: t('settings_page.price_legend.average.title'),
          detail: t('settings_page.price_legend.average.detail'),
        },
      ];

      expect(legendItems).toHaveLength(5);
      expect(legendItems.map((item) => item.title)).toEqual([
        t('settings_page.price_legend.planned_grid_charge.title'),
        t('settings_page.price_legend.expensive_use.title'),
        t('settings_page.price_legend.cheap_window.title'),
        t('settings_page.price_legend.normal_window.title'),
        t('settings_page.price_legend.average.title'),
      ]);
      expect(legendItems[0].detail).toMatch(/Gelb/);
      expect(legendItems[1].detail).toMatch(/Rot/);
      expect(legendItems[3].detail).toMatch(/Grau/);
      expect(legendItems[4].swatchClass).toBe('avg-line');
    });

    it('should calculate price range correctly', () => {
      const priceCache = [
        { startsAt: '2024-01-15T10:00:00Z', total: 0.15 },
        { startsAt: '2024-01-15T10:15:00Z', total: 0.18 },
        { startsAt: '2024-01-15T10:30:00Z', total: 0.12 },
        { startsAt: '2024-01-15T10:45:00Z', total: 0.25 },
      ];

      const prices = priceCache.map(p => p.total);
      const minPrice = Math.min(...prices);
      const maxPrice = Math.max(...prices);
      const priceRange = maxPrice - minPrice;

      expect(minPrice).toBe(0.12);
      expect(maxPrice).toBe(0.25);
      expect(priceRange).toBeCloseTo(0.13, 2);
    });

    it('should normalize bar heights correctly', () => {
      const priceCache = [
        { total: 0.15 },
        { total: 0.20 },
        { total: 0.25 },
      ];

      const prices = priceCache.map(p => p.total);
      const minPrice = Math.min(...prices);
      const maxPrice = Math.max(...prices);
      const priceRange = maxPrice - minPrice;

      // Calculate normalized heights (20-100% range)
      const heights = prices.map(price => 
        priceRange > 0 
          ? ((price - minPrice) / priceRange) * 80 + 20 
          : 50
      );

      expect(heights[0]).toBeCloseTo(20, 1); // Min price = 20%
      expect(heights[1]).toBeCloseTo(60, 1); // Mid price = 60%
      expect(heights[2]).toBeCloseTo(100, 1); // Max price = 100%
    });

    it('should calculate average price line position', () => {
      const priceCache = [
        { total: 0.10 },
        { total: 0.20 },
        { total: 0.30 },
      ];

      const prices = priceCache.map(p => p.total);
      const minPrice = Math.min(...prices);
      const maxPrice = Math.max(...prices);
      const priceRange = maxPrice - minPrice;
      const avgPrice = prices.reduce((sum, p) => sum + p, 0) / prices.length;

      const avgLinePosition = priceRange > 0
        ? ((avgPrice - minPrice) / priceRange) * 80 + 20
        : 50;

      expect(avgPrice).toBeCloseTo(0.20, 2);
      expect(avgLinePosition).toBeCloseTo(60, 1); // Middle = 60%
    });

    it('should classify bars correctly', () => {
      const strategy = {
        chargeIntervals: [
          { startsAt: '2024-01-15T22:00:00Z' },
        ],
        expensiveIntervals: [
          { startsAt: '2024-01-15T18:00:00Z' },
        ],
        avgPrice: 0.20,
      };

      const avgPrice = strategy.avgPrice;
      const cheapThreshold = avgPrice * 0.9; // 0.18
      const expensiveThreshold = avgPrice * 1.1; // 0.22

      const chargeTimestamps = new Set(
        (strategy.chargeIntervals || []).map(s => s.startsAt)
      );
      const expensiveTimestamps = new Set(
        getDischargeIntervals(strategy).map(s => s.startsAt)
      );

      // Test classification
      const testPrices = [
        { startsAt: '2024-01-15T22:00:00Z', total: 0.15 }, // Charging interval
        { startsAt: '2024-01-15T18:00:00Z', total: 0.30 }, // Expensive interval
        { startsAt: '2024-01-15T10:00:00Z', total: 0.16 }, // Cheap
        { startsAt: '2024-01-15T12:00:00Z', total: 0.24 }, // Expensive
        { startsAt: '2024-01-15T14:00:00Z', total: 0.19 }, // Normal
      ];

      const classifications = testPrices.map(priceData => {
        if (chargeTimestamps.has(priceData.startsAt)) return 'charging';
        if (expensiveTimestamps.has(priceData.startsAt)) return 'expensive';
        if (priceData.total <= cheapThreshold) return 'cheap';
        if (priceData.total >= expensiveThreshold) return 'expensive';
        return 'normal';
      });

      expect(classifications[0]).toBe('charging');
      expect(classifications[1]).toBe('expensive');
      expect(classifications[2]).toBe('cheap');
      expect(classifications[3]).toBe('expensive');
      expect(classifications[4]).toBe('normal');
    });

    it('should handle empty price cache', () => {
      const priceCache = [];

      expect(priceCache.length).toBe(0);
      // Should show "No price data available"
    });

    it('should fall back to expensiveIntervals when dischargeIntervals is empty', () => {
      const strategy = {
        dischargeIntervals: [],
        expensiveIntervals: [
          { startsAt: '2024-01-15T18:00:00Z' },
        ],
      };

      const expensiveTimestamps = new Set(getDischargeIntervals(strategy).map((interval) => interval.startsAt));
      expect(expensiveTimestamps.has('2024-01-15T18:00:00Z')).toBe(true);
    });

    it('should format chart labels in Europe/Berlin consistently', () => {
      const priceCache = [
        { startsAt: '2024-01-15T22:00:00Z', total: 0.15 },
        { startsAt: '2024-01-16T04:00:00Z', total: 0.16 },
      ];

      const labels = priceCache.map((entry) => formatDisplayTime(entry.startsAt));
      expect(labels).toEqual(['23:00', '05:00']);
    });
  });

  describe('Timeline Data Processing', () => {
    it('should phrase planned charging entries in user-facing language', () => {
      const describePlannedCharge = (entry) => {
        const symbol = entry?.plannedSymbol || '⚡';

        if (symbol === '☀') {
          return t('settings_page.timeline.describe_charge_solar');
        }

        return t('settings_page.timeline.describe_charge_grid');
      };

      expect(describePlannedCharge({ plannedSymbol: '⚡' })).toBe(t('settings_page.timeline.describe_charge_grid'));
      expect(describePlannedCharge({ plannedSymbol: '☀' })).toBe(t('settings_page.timeline.describe_charge_solar'));
      expect(describePlannedCharge({})).toBe(t('settings_page.timeline.describe_charge_grid'));
    });

    it('should phrase discharge periods as battery support for the house', () => {
      const describeBatterySupport = (demandKWh) => {
        if (typeof demandKWh === 'number' && Number.isFinite(demandKWh) && demandKWh > 0) {
          return formatText('settings_page.timeline.battery_support_with_demand', { demand: demandKWh.toFixed(2) });
        }

        return t('settings_page.timeline.battery_support');
      };

      expect(describeBatterySupport(2.5)).toBe(formatText('settings_page.timeline.battery_support_with_demand', { demand: '2.50' }));
      expect(describeBatterySupport(0)).toBe(t('settings_page.timeline.battery_support'));
    });

    it('should format charge intervals correctly', () => {
      // Backend provides explicit per-entry source + €/kWh and a precomputed summary.
      const chargeDisplayEntries = [
        {
          startsAt: '2024-01-15T22:00:00Z',
          plannedSymbol: '⚡',
          plannedEnergySource: 'grid',
          plannedEnergyKWh: 0.40,
          plannedPriceEurPerKWh: 0.15,
          plannedCostEur: 0.06,
        },
        {
          startsAt: '2024-01-15T22:15:00Z',
          plannedSymbol: '☀',
          plannedEnergySource: 'solar',
          plannedEnergyKWh: 0.20,
          plannedPriceEurPerKWh: 0.07,
          plannedCostEur: 0.014,
        },
      ];

      const plannedCharging = {
        totalEnergyKWh: 0.60,
        totalCostEur: 0.074,
        avgPriceEurPerKWh: 0.12333333333333334,
      };

      expect(chargeDisplayEntries[0].plannedSymbol).toBe('⚡');
      expect(chargeDisplayEntries[0].plannedPriceEurPerKWh).toBeCloseTo(0.15, 6);
      expect(chargeDisplayEntries[1].plannedSymbol).toBe('☀');
      expect(chargeDisplayEntries[1].plannedPriceEurPerKWh).toBeCloseTo(0.07, 6);

      expect(plannedCharging.totalEnergyKWh).toBeCloseTo(0.60, 6);
      expect(plannedCharging.totalCostEur).toBeCloseTo(0.074, 6);
      expect(plannedCharging.avgPriceEurPerKWh).toBeCloseTo(0.1233333333, 7);
    });

    it('should format time and date correctly', () => {
      const isoString = '2024-01-15T22:30:00Z';
      const timeStr = formatDisplayTime(isoString);
      const dateStr = formatDisplayDate(isoString);

      expect(timeStr).toMatch(/^\d{2}:\d{2}$/);
      expect(dateStr).toMatch(/^\d{1,2} \w{3}$/); // Format: "15 Jan"
    });

    it('should render chart and timeline times in Europe/Berlin', () => {
      const isoString = '2024-01-15T22:00:00Z';

      const chartTooltipTime = formatDisplayTime(isoString);
      const timelineTime = formatDisplayTime(isoString);
      const firstChargeDateTime = formatDisplayDateTime(isoString);

      expect(chartTooltipTime).toBe('23:00');
      expect(timelineTime).toBe('23:00');
      expect(firstChargeDateTime).toContain('23:00');
    });

    it('should render summer timestamps in Europe/Berlin DST', () => {
      const isoString = '2024-07-15T22:00:00Z';

      expect(formatDisplayTime(isoString)).toBe('00:00');
      expect(formatDisplayDate(isoString)).toBe('16 Jul');
    });

    it('should use backend-provided economics/savings (no UI recomputation)', () => {
      const strategy = {
        forecastedDemand: 5.0, // kWh
        chargeIntervals: [
          { total: 0.15 },
          { total: 0.16 },
        ],
        expensiveIntervals: [
          { total: 0.30 },
          { total: 0.32 },
        ],
        economics: {
          baselineCost: 1.55,
          optimizedCost: 0.775,
          savings: 0.775,
        },
      };

      const baselineCost = strategy.economics.baselineCost;
      const optimizedCost = strategy.economics.optimizedCost;
      const savings = strategy.economics.savings;

      expect(baselineCost).toBeCloseTo(1.55, 2);
      expect(optimizedCost).toBeCloseTo(0.775, 2);
      expect(savings).toBeCloseTo(0.775, 2);
    });

    it('should handle missing timeline data', () => {
      const strategy = {};

      const hasChargeIntervals = !!(strategy.chargeIntervals && strategy.chargeIntervals.length > 0);
      const hasExpensiveIntervals = getDischargeIntervals(strategy).length > 0;

      expect(hasChargeIntervals).toBe(false);
      expect(hasExpensiveIntervals).toBe(false);
      const noPlanMessage = t('settings_page.timeline.no_plan');
      expect(noPlanMessage).toContain('Optimierungsplan');
    });

    it('should use clearer copy when no cheap charging slot exists', () => {
      const noChargePlanMessage = t('settings_page.timeline.no_grid_charging_planned');

      expect(noChargePlanMessage).toContain('keine Netzladung geplant');
      expect(noChargePlanMessage).toContain('Haus direkt aus dem Netz');
    });

    it('should keep battery-only strategies renderable', () => {
      const strategy = {
        batteryStatus: {
          currentSoc: 0.65,
        },
      };

      const hasChargeIntervals = !!(strategy.chargeIntervals && strategy.chargeIntervals.length > 0);
      const hasDischargeIntervals = getDischargeIntervals(strategy).length > 0;
      const hasBatteryStatus = !!strategy.batteryStatus;

      expect(hasChargeIntervals || hasDischargeIntervals || hasBatteryStatus).toBe(true);
    });
  });

  describe('Battery Status Display', () => {
    it('should format battery status correctly', () => {
      const batteryStatus = {
        currentSoc: 0.65,
        targetSoc: 0.85,
        availableCapacity: 3.5,
        availableCapacityToTarget: 3.5,
        energyCost: {
          avgPrice: 0.1845,
          solarKWh: 2.0,
          gridKWh: 4.5,
          solarPercent: 30.77,
          gridPercent: 69.23,
          totalKWh: 6.5,
        },
      };

      const socPercent = (batteryStatus.currentSoc * 100).toFixed(1);
      const targetPercent = (batteryStatus.targetSoc * 100).toFixed(1);
      const availableKWh = batteryStatus.availableCapacity.toFixed(2);
      const batteryFull = batteryStatus.currentSoc >= batteryStatus.targetSoc;

      expect(socPercent).toBe('65.0');
      expect(targetPercent).toBe('85.0');
      expect(availableKWh).toBe('3.50');
      expect(batteryFull).toBe(false);

      // Energy cost formatting
      const cost = batteryStatus.energyCost;
      expect(cost.avgPrice.toFixed(4)).toBe('0.1845');
      expect(cost.solarKWh.toFixed(2)).toBe('2.00');
      expect(cost.gridKWh.toFixed(2)).toBe('4.50');
      expect(cost.solarPercent.toFixed(0)).toBe('31');
      expect(cost.gridPercent.toFixed(0)).toBe('69');
    });

    it('should detect when battery is full', () => {
      const batteryAtTarget = {
        currentSoc: 0.85,
        targetSoc: 0.85,
        availableCapacity: 0,
      };

      const batteryFull = batteryAtTarget.currentSoc >= batteryAtTarget.targetSoc;
      expect(batteryFull).toBe(true);
      expect(batteryAtTarget.availableCapacity).toBe(0);
    });

    it('should show planned charge price when no historical data', () => {
      const strategy = {
        chargeIntervals: [
          { total: 0.15 },
          { total: 0.16 },
          { total: 0.14 },
        ],
        batteryStatus: {
          currentSoc: 0.30,
          targetSoc: 0.85,
          energyCost: null, // No historical data
        },
      };

      const hasEnergyCost = strategy.batteryStatus.energyCost !== null;
      expect(hasEnergyCost).toBe(false);

      // Calculate planned charge price
      const avgPlannedPrice = strategy.chargeIntervals.reduce((sum, i) => sum + i.total, 0) / strategy.chargeIntervals.length;
      expect(avgPlannedPrice.toFixed(4)).toBe('0.1500');
    });

    it('should use battery-cost-core result for displayed battery energy price', () => {
      // Build a realistic charge log as device.js would
      const chargeLog = [
        createChargeEntry({
          chargedKWh: 4.0,
          solarKWh: 1.5,
          gridPrice: 0.20,
          soc: 60,
          timestamp: new Date('2024-01-15T10:00:00Z'),
        }),
      ];

      // Device module computes the actual battery energy cost
      const energyCost = calculateBatteryEnergyCost(chargeLog);
      expect(energyCost).not.toBeNull();

      // Strategy/batteryStatus structure as used in device → /strategy → index.html
      const strategy = {
        batteryStatus: {
          currentSoc: 0.60,
          targetSoc: 0.80,
          availableCapacity: 4.0,
          energyCost,
        },
      };

      const bat = strategy.batteryStatus;

      // This mirrors the formatting in renderTimeline() in settings/index.html
      const socPercent = (bat.currentSoc * 100).toFixed(1);
      const targetPercent = (bat.targetSoc * 100).toFixed(1);
      const availableKWh = bat.availableCapacity.toFixed(2);

      const cost = bat.energyCost;
      const avgPriceDisplay = cost.avgPrice.toFixed(4);
      const solarKWhDisplay = cost.solarKWh.toFixed(2);
      const gridKWhDisplay = cost.gridKWh.toFixed(2);
      const solarPercentDisplay = cost.solarPercent.toFixed(0);
      const gridPercentDisplay = cost.gridPercent.toFixed(0);

      // Assert SoC / capacity formatting (Battery Status header line)
      expect(socPercent).toBe('60.0');
      expect(targetPercent).toBe('80.0');
      expect(availableKWh).toBe('4.00');

      // For our 4 kWh charge (1.5 solar @ 0.07, 2.5 grid @ 0.20 €/kWh):
      //   totalCost = (1.5 * 0.07) + (2.5 * 0.20) = 0.605 €
      //   totalKWh = 4.0 → weighted avg = 0.605 / 4.0 = 0.15125 €/kWh
      //   solar share = 1.5 / 4.0 = 37.5% → ≈ 38%
      //   grid share = 2.5 / 4.0 = 62.5% → rounds to 63%
      expect(avgPriceDisplay).toBe('0.1512');
      expect(solarKWhDisplay).toBe('1.50');
      expect(gridKWhDisplay).toBe('2.50');
      expect(solarPercentDisplay).toBe('38');
      expect(gridPercentDisplay).toBe('63'); // 62.5% rounds to 63
    });

    it('should format battery energy cost as displayed in HTML', () => {
      // Create realistic charge log with mixed solar/grid
      const chargeLog = [
        createChargeEntry({
          chargedKWh: 3.0,
          solarKWh: 1.0, // 1 kWh solar
          gridPrice: 0.25,
          soc: 30,
          timestamp: new Date('2024-01-15T10:00:00Z'),
        }),
        createChargeEntry({
          chargedKWh: 2.0,
          solarKWh: 0.5, // 0.5 kWh solar
          gridPrice: 0.22,
          soc: 50,
          timestamp: new Date('2024-01-15T11:00:00Z'),
        }),
      ];

      // Device module calculates battery energy cost
      const energyCost = calculateBatteryEnergyCost(chargeLog);
      expect(energyCost).not.toBeNull();

      // Build strategy structure as API returns it
      const strategy = {
        batteryStatus: {
          currentSoc: 0.50,
          targetSoc: 0.85,
          availableCapacity: 5.0,
          availableCapacityToTarget: 5.0,
          energyCost,
        },
      };

      const bat = strategy.batteryStatus;
      const cost = bat.energyCost;

      // Format as HTML strings exactly as renderTimeline() does
      const avgPriceText = `${cost.avgPrice.toFixed(4)} €/kWh`;
      const solarText = `☀️ Solar: ${cost.solarKWh.toFixed(2)} kWh (${cost.solarPercent.toFixed(0)}%)`;
      const gridText = `⚡ Grid: ${cost.gridKWh.toFixed(2)} kWh (${cost.gridPercent.toFixed(0)}%)`;
      const headerText = `Ladestand: ${(bat.currentSoc * 100).toFixed(1)}% (Ziel: ${(bat.targetSoc * 100).toFixed(1)}%)`;
      const capacityText = `Freier Ladeplatz bis Ziel-SoC: ${bat.availableCapacity.toFixed(2)} kWh`;

      // Verify string formatting matches HTML display
      expect(avgPriceText).toMatch(/^0\.\d{4} €\/kWh$/);
      expect(solarText).toMatch(/^☀️ Solar: \d+\.\d{2} kWh \(\d+%\)$/);
      expect(gridText).toMatch(/^⚡ Grid: \d+\.\d{2} kWh \(\d+%\)$/);
      expect(headerText).toBe('Ladestand: 50.0% (Ziel: 85.0%)');
      expect(capacityText).toBe('Freier Ladeplatz bis Ziel-SoC: 5.00 kWh');

      // Total charge = 3.0 + 2.0 = 5.0 kWh
      // Solar = 1.0 + 0.5 = 1.5 kWh → 30%
      // Grid = 2.0 + 1.5 = 3.5 kWh → 70%
      // Grid cost = (2.0 * 0.25) + (1.5 * 0.22) = 0.50 + 0.33 = 0.83 €
      // Solar opportunity cost = 1.5 * 0.07 = 0.105 €
      // Avg = (0.83 + 0.105) / 5.0 = 0.187 €/kWh
      expect(avgPriceText).toBe('0.1870 €/kWh');
      expect(solarText).toBe('☀️ Solar: 1.50 kWh (30%)');
      expect(gridText).toBe('⚡ Grid: 3.50 kWh (70%)');
    });

    it('should display "No data yet" when energyCost is null', () => {
      const strategy = {
        batteryStatus: {
          currentSoc: 0.50,
          targetSoc: 0.85,
          batteryCapacity: 10.0,
          availableCapacity: 5.0,
          availableCapacityToTarget: 5.0,
          energyCost: null, // No battery cost data available
        },
        chargeIntervals: [],
      };

      const bat = strategy.batteryStatus;

      // Verify battery status is displayed
      expect(bat.currentSoc).toBe(0.50);
      expect(bat.targetSoc).toBe(0.85);
      expect(bat.availableCapacity).toBe(5.0);

      // energyCost is null - UI should show "No data yet"
      expect(bat.energyCost).toBeNull();

      // When energyCost is null, UI should display:
      // - "No data yet" as the value
      // - Info message about cost tracking
      const expectedMessage = 'Noch keine Daten';
      const expectedInfo = t('settings_page.timeline.no_data_info').replace(/^ℹ️\s*/, '');

      // These would be the strings rendered in the HTML
      expect(expectedMessage).toBe(t('settings_page.timeline.no_data_yet'));
      expect(expectedInfo).toMatch(/Kostenerfassung beginnt/);
    });

    it('should display estimated battery cost with warning when isEstimated flag is set', () => {
      const strategy = {
        batteryStatus: {
          currentSoc: 0.73,
          targetSoc: 0.85,
          batteryCapacity: 10.0,
          availableCapacity: 1.2,
          energyCost: {
            avgPrice: 0.1400, // Estimated price based on planned charges
            totalKWh: 7.3,
            solarKWh: 2.19, // 30% assumed solar
            gridKWh: 5.11,  // 70% assumed grid
            solarPercent: 30,
            gridPercent: 70,
            totalCost: 0.7154,
            gridOnlyAvgPrice: 0.1400,
            isEstimated: true, // Flag indicating this is estimated
          },
        },
      };

      const bat = strategy.batteryStatus;
      const cost = bat.energyCost;

      // Verify estimated cost is displayed
      expect(cost.isEstimated).toBe(true);
      expect(cost.avgPrice).toBe(0.1400);
      expect(cost.totalKWh).toBe(7.3);

      // UI should show:
      // - Label: "💰 Geschätzter Energiepreis in der Batterie:"
      // - Warning: "⚠️ Der Ursprung der Batterieladung ist noch nicht vollstaendig bekannt."
      // - Values with estimated breakdown
      const label = t('settings_page.timeline.avg_battery_energy_cost_estimated_label');
      const warning = t('settings_page.timeline.estimated_subtitle');
      const avgPriceText = `${cost.avgPrice.toFixed(4)} €/kWh`;
      const solarText = `☀️ Solar: ${cost.solarKWh.toFixed(2)} kWh (${cost.solarPercent.toFixed(0)}%)`;
      const gridText = `⚡ Grid: ${cost.gridKWh.toFixed(2)} kWh (${cost.gridPercent.toFixed(0)}%)`;

      expect(label).toMatch(/Geschätzter Energiepreis/);
      expect(warning).toMatch(/Ursprung der Batterieladung/);
      expect(avgPriceText).toBe('0.1400 €/kWh');
      expect(solarText).toBe('☀️ Solar: 2.19 kWh (30%)');
      expect(gridText).toBe('⚡ Grid: 5.11 kWh (70%)');
    });
  });

  describe('Device List Rendering', () => {
    it('should filter energy-optimizer devices correctly', () => {
      const allDevices = [
        { id: 'dev1', driverId: 'energy-optimizer', name: 'Optimizer 1' },
        { id: 'dev2', driverId: 'rct-power-storage-dc', name: 'Battery' },
        { id: 'dev3', driverId: 'energy-optimizer', name: 'Optimizer 2' },
        { id: 'dev4', driverId: 'grid-meter', name: 'Grid Meter' },
      ];

      const optimizerDevices = allDevices.filter(d => 
        d.driverId === 'energy-optimizer'
      );

      expect(optimizerDevices.length).toBe(2);
      expect(optimizerDevices[0].name).toBe('Optimizer 1');
      expect(optimizerDevices[1].name).toBe('Optimizer 2');
    });

    it('should handle no devices found', () => {
      const allDevices = [
        { id: 'dev1', driverId: 'rct-power-storage-dc', name: 'Battery' },
        { id: 'dev2', driverId: 'grid-meter', name: 'Grid Meter' },
      ];

      const optimizerDevices = allDevices.filter(d => 
        d.driverId === 'energy-optimizer'
      );

      expect(optimizerDevices.length).toBe(0);
      // Should show "No Energy Optimizer devices found"
    });
  });

  describe('Data Integration Flow', () => {
    it('should process complete device data correctly', () => {
      // Simulate complete data flow from API to rendering
      const apiResponse = {
        device: {
          id: 'optimizer1',
          name: 'Energy Optimizer',
          capabilities: {
            optimizer_status: 'Charging at 3.3kW',
            next_charge_start: '2024-01-15 22:00',
            onoff: true,
            estimated_savings: 2.45,
          },
        },
        strategy: {
          chargeIntervals: [
            { startsAt: '2024-01-15T22:00:00Z', total: 0.15 },
            { startsAt: '2024-01-15T22:15:00Z', total: 0.16 },
          ],
          expensiveIntervals: [
            { startsAt: '2024-01-16T18:00:00Z', total: 0.32 },
          ],
          avgPrice: 0.2234,
          neededKWh: 8.5,
          forecastedDemand: 5.0,
          batteryStatus: {
            currentSoc: 0.65,
            targetSoc: 0.85,
            availableCapacity: 3.5,
            energyCost: {
              avgPrice: 0.1845,
              solarKWh: 2.0,
              gridKWh: 4.5,
              totalKWh: 6.5,
              solarPercent: 30.77,
              gridPercent: 69.23,
            },
          },
        },
        dashboardSummary: {
          currentAction: {
            title: 'Batterie laedt aus dem Netz',
            detail: 'Gerade laeuft ein geplantes guenstiges Ladefenster.',
            tone: 'positive',
          },
          currentReason: 'Der aktuelle Strompreis liegt in einem geplanten guenstigen Ladefenster.',
          energyFlow: {
            title: 'Netz laedt die Batterie',
            detail: 'Der aktuelle Netzbezug enthaelt aktive Batterieladung aus dem geplanten Ladefenster.',
          },
          nextAction: {
            title: 'Naechstes Ladefenster',
            displayTime: '15.01.2024, 23:00',
          },
          chargePlan: {
            hasPlan: true,
            summary: 'Netzladung ist geplant, weil guenstige Preisfenster erkannt wurden.',
            totalEnergyKWh: 8.5,
            avgPriceEurPerKWh: 0.155,
          },
          savings: {
            todayForecastEur: 2.45,
            realized: {
              currentMonthEur: 1.25,
              lastMonthEur: 2.1,
              last365DaysEur: 8.4,
            },
          },
          battery: {
            currentSocPercent: 65,
            targetSocPercent: 85,
            freeCapacityToTargetKWh: 3.5,
            aboveTargetDeltaPercent: 0,
          },
        },
        priceCache: [
          { startsAt: '2024-01-15T22:00:00Z', total: 0.15 },
          { startsAt: '2024-01-15T22:15:00Z', total: 0.16 },
          { startsAt: '2024-01-16T18:00:00Z', total: 0.32 },
        ],
      };

      // Verify device data
      expect(apiResponse.device.capabilities.optimizer_status).toBe('Charging at 3.3kW');
      expect(apiResponse.device.capabilities.estimated_savings).toBeCloseTo(2.45, 2);

      // Verify strategy data
      expect(apiResponse.strategy.chargeIntervals.length).toBe(2);
      expect(apiResponse.strategy.expensiveIntervals.length).toBe(1);
      expect(apiResponse.strategy.avgPrice).toBeCloseTo(0.2234, 4);

      // Verify dashboard summary data
      expect(apiResponse.dashboardSummary.currentAction.title).toBe('Batterie laedt aus dem Netz');
      expect(apiResponse.dashboardSummary.energyFlow.title).toBe('Netz laedt die Batterie');
      expect(apiResponse.dashboardSummary.chargePlan.hasPlan).toBe(true);
      expect(apiResponse.dashboardSummary.savings.todayForecastEur).toBeCloseTo(2.45, 2);
      expect(apiResponse.dashboardSummary.savings.realized.last365DaysEur).toBeCloseTo(8.4, 2);

      // Verify price cache
      expect(apiResponse.priceCache.length).toBe(3);
      expect(apiResponse.priceCache[0].total).toBe(0.15);

      // Verify battery status
      const bat = apiResponse.strategy.batteryStatus;
      expect(bat.currentSoc).toBeCloseTo(0.65, 2);
      expect(bat.energyCost.avgPrice).toBeCloseTo(0.1845, 4);
      expect(bat.energyCost.solarPercent).toBeCloseTo(30.77, 2);
    });

    it('should handle partial data gracefully', () => {
      const partialResponse = {
        device: {
          id: 'optimizer1',
          name: 'Energy Optimizer',
          capabilities: {
            optimizer_status: 'Idle',
          },
        },
        strategy: {},
        priceCache: [],
      };

      // All rendering should work with defaults
      const status = partialResponse.device.capabilities.optimizer_status || 'Unknown';
      const savings = partialResponse.device.capabilities.estimated_savings || 0;
      const chargeIntervals = partialResponse.strategy.chargeIntervals?.length || 0;
      const priceDataAvailable = partialResponse.priceCache.length > 0;

      expect(status).toBe('Idle');
      expect(savings).toBe(0);
      expect(chargeIntervals).toBe(0);
      expect(priceDataAvailable).toBe(false);
    });

    it('should derive summary card lines with backend summary fallbacks', () => {
      const device = {
        capabilities: {
          optimizer_status: 'Optimizer active',
          next_charge_start: 'Not scheduled',
          estimated_savings: 0.75,
        },
      };

      const summary = {
        currentAction: {
          title: 'Batterie wartet auf Solar oder spaetere Nutzung',
          detail: 'Die Batterie wird im Haltemodus geschuetzt und nicht aktiv aus dem Netz geladen.',
          tone: 'neutral',
        },
        currentReason: 'Es gibt guenstige Preisfenster spaeter am Tag, daher wird jetzt gewartet.',
        energyFlow: {
          title: 'Solar versorgt das Haus und speist Ueberschuss ein',
          detail: 'Aktuell ist mehr Solarstrom verfuegbar als Haus und Batterie aufnehmen.',
        },
        nextAction: {
          title: 'Naechstes Ladefenster',
          key: 'next-charge-window',
          displayTime: '29.04.2026, 16:00',
        },
        chargePlan: {
          hasPlan: true,
          summary: 'Netzladung ist geplant, weil guenstige Preisfenster erkannt wurden.',
          totalEnergyKWh: 4.25,
          avgPriceEurPerKWh: 0.1325,
        },
        dischargePlan: {
          hasPlan: true,
          windowCount: 7,
          nextStart: '2026-04-29T16:30:00.000Z',
        },
        savings: {
          todayForecastEur: 0.75,
          realized: {
            currentMonthEur: 1.75,
            lastMonthEur: 2.5,
            last365DaysEur: 18.25,
          },
        },
        planHorizon: {
          hasPlan: true,
          endsAt: '2026-04-29T20:45:00.000Z',
          displayTime: '29.04.2026, 22:45',
        },
        battery: {
          currentSocPercent: 91,
          targetSocPercent: 80,
          freeCapacityToTargetKWh: 0,
          aboveTargetDeltaPercent: 11,
        },
      };

      const fallbackStatus = device.capabilities.optimizer_status || t('settings_page.summary.no_data');
      const actionTitle = summary.currentAction.title || fallbackStatus;
      const flowTitle = summary.energyFlow?.title || t('settings_page.summary.energy_flow_unknown');
      const nextTime = summary.nextAction.displayTime || t('settings_page.summary.next_not_scheduled');
      const nextPlanInfo = (summary.chargePlan.hasPlan && summary.nextAction.key === 'next-charge-window')
        ? formatText('settings_page.summary.plan_window_subtext', {
          energy: Number(summary.chargePlan.totalEnergyKWh || 0).toFixed(2),
          price: Number(summary.chargePlan.avgPriceEurPerKWh || 0).toFixed(4),
        })
        : '';
      const dischargePlanInfo = summary.dischargePlan.hasPlan
        ? formatText('settings_page.summary.discharge_plan_subtext', {
          count: Number(summary.dischargePlan.windowCount || 0),
          time: formatDisplayDateTime(summary.dischargePlan.nextStart, 'de-DE'),
        })
        : '';
      const forecastSubtext = summary.planHorizon?.displayTime
        ? formatText('settings_page.summary.today_forecast_until_subtext', {
          time: summary.planHorizon.displayTime,
        })
        : t('settings_page.summary.today_forecast_subtext');
      const realizedLine = formatText('settings_page.summary.realized_last_365', { amount: Number(summary.savings.realized?.last365DaysEur || 0).toFixed(2) });
      const realizedSubtext = formatText('settings_page.summary.realized_subtext', {
        currentMonth: Number(summary.savings.realized?.currentMonthEur || 0).toFixed(2),
        lastMonth: Number(summary.savings.realized?.lastMonthEur || 0).toFixed(2),
      });
      const batteryLine = formatText('settings_page.summary.battery_line', {
        soc: Number(summary.battery.currentSocPercent).toFixed(1),
        target: Number(summary.battery.targetSocPercent || 0).toFixed(1),
      });
      const capacityLine = formatText('settings_page.summary.capacity_line', {
        capacity: Number(summary.battery.freeCapacityToTargetKWh).toFixed(2),
      });
      const aboveTargetLine = summary.battery.aboveTargetDeltaPercent > 0
        ? `Batterie liegt ${Number(summary.battery.aboveTargetDeltaPercent).toFixed(1)}% ueber dem Zielwert. Dieser Anteil bleibt als Entladepuffer verfuegbar.`
        : '';

      expect(actionTitle).toBe('Batterie wartet auf Solar oder spaetere Nutzung');
      expect(flowTitle).toBe('Solar versorgt das Haus und speist Ueberschuss ein');
      expect(nextTime).toBe('29.04.2026, 16:00');
      expect(nextPlanInfo).toBe('4.25 kWh zu Ø 0.1325 €/kWh');
      expect(dischargePlanInfo).toBe('7 Entladefenster geplant · Erste Phase: 29.04.2026, 18:30');
      expect(forecastSubtext).toBe('Geschätzte Optimierungswirkung für den aktuellen Plan bis 29.04.2026, 22:45.');
      expect(realizedLine).toBe('365 Tage: €18.25');
      expect(realizedSubtext).toBe('Aktueller Monat: €1.75 · Letzter Monat: €2.50');
      expect(batteryLine).toBe('91.0% SoC · Ziel-SoC 80.0%');
      expect(capacityLine).toBe('Freier Ladeplatz bis Ziel-SoC: 0.00 kWh');
      expect(aboveTargetLine).toBe('Batterie liegt 11.0% ueber dem Zielwert. Dieser Anteil bleibt als Entladepuffer verfuegbar.');
    });

    it('should derive paused optimizer labels and copy from disabled summary state', () => {
      const device = {
        capabilities: {
          optimizer_status: 'Stopped',
          next_charge_start: 'Not scheduled',
          estimated_savings: 0.75,
          onoff: false,
        },
      };

      const summary = {
        optimizer: {
          enabled: false,
          planExecutionActive: false,
          hasLiveMeasurements: true,
        },
        currentAction: {
          key: 'optimizer-disabled',
          title: 'Optimizer ist ausgeschaltet',
          detail: 'Live-Messwerte koennen weiter sichtbar sein, der Optimierungsplan wird aktuell aber nicht ausgefuehrt.',
          tone: 'neutral',
        },
        currentReason: 'Der Optimizer ist deaktiviert. Vorhandene Lade- und Entladeplaene werden aktuell nicht angewendet.',
        energyFlow: {
          title: 'Solar versorgt das Haus und speist Ueberschuss ein',
          detail: 'Aktuell ist mehr Solarstrom verfuegbar als Haus und Batterie aufnehmen.',
        },
        nextAction: {
          title: 'Plan ist pausiert',
          key: 'optimizer-disabled',
          displayTime: '29.04.2026, 16:00',
        },
        chargePlan: {
          hasPlan: true,
          summary: 'Netzladung ist geplant, weil guenstige Preisfenster erkannt wurden.',
          totalEnergyKWh: 4.25,
          avgPriceEurPerKWh: 0.0625,
        },
        dischargePlan: {
          hasPlan: true,
          windowCount: 7,
          nextStart: '2026-04-29T16:30:00.000Z',
        },
        savings: {
          todayForecastEur: 0.75,
          realized: {
            currentMonthEur: 1.75,
            lastMonthEur: 2.5,
            last365DaysEur: 18.25,
          },
        },
        planHorizon: {
          hasPlan: true,
          endsAt: '2026-04-29T20:45:00.000Z',
          displayTime: '29.04.2026, 22:45',
        },
        battery: {
          currentSocPercent: 91,
          targetSocPercent: 80,
          freeCapacityToTargetKWh: 0,
          aboveTargetDeltaPercent: 11,
        },
      };

      const planPaused = summary?.optimizer?.enabled === false || device.capabilities.onoff === false;
      const eyebrowText = planPaused ? 'Optimizer-Status' : 'Aktueller Batteriemodus';
      const nextPanelLabel = planPaused ? 'Berechneter Plan' : 'Als Naechstes';
      const forecastLabel = planPaused ? 'Letzte Prognose' : 'Heutige Prognose';
      const nextTime = summary.nextAction.displayTime || t('settings_page.summary.next_not_scheduled');
      const nextPlanInfo = (summary.chargePlan.hasPlan && summary.nextAction.key === 'next-charge-window')
        ? formatText('settings_page.summary.plan_window_subtext', {
          energy: Number(summary.chargePlan.totalEnergyKWh || 0).toFixed(2),
          price: Number(summary.chargePlan.avgPriceEurPerKWh || 0).toFixed(4),
        })
        : '';
      const dischargePlanInfo = summary.dischargePlan.hasPlan
        ? formatText('settings_page.summary.discharge_plan_subtext', {
          count: Number(summary.dischargePlan.windowCount || 0),
          time: formatDisplayDateTime(summary.dischargePlan.nextStart, 'de-DE'),
        })
        : '';
      const pausedPlanNote = planPaused
        ? 'Der Optimizer ist deaktiviert. Berechnete Plaene werden aktuell nicht ausgefuehrt.'
        : '';
      const nextPanelSubtext = [pausedPlanNote, [nextTime, nextPlanInfo, dischargePlanInfo].filter(Boolean).join('<br>') || nextTime].filter(Boolean).join('<br>');
      const forecastSubtext = planPaused
        ? 'Dies ist die letzte berechnete Prognose und aktuell nur informativ.'
        : formatText('settings_page.summary.today_forecast_until_subtext', {
          time: summary.planHorizon.displayTime,
        });
      const energyFlowSubtext = [
        summary.energyFlow.detail,
        planPaused ? 'Dieser Energiefluss beschreibt nur den Live-Zustand, nicht die aktive Optimizer-Steuerung.' : '',
      ].filter(Boolean).join('<br>');
      const capacityLine = (planPaused
        ? 'Freier Ladeplatz bis Ziel-SoC laut letztem Plan: {capacity} kWh'
        : formatText('settings_page.summary.capacity_line', {
          capacity: Number(summary.battery.freeCapacityToTargetKWh).toFixed(2),
        })
      ).replace('{capacity}', Number(summary.battery.freeCapacityToTargetKWh).toFixed(2));

      expect(eyebrowText).toBe('Optimizer-Status');
      expect(nextPanelLabel).toBe('Berechneter Plan');
      expect(forecastLabel).toBe('Letzte Prognose');
      expect(nextPanelSubtext).toBe('Der Optimizer ist deaktiviert. Berechnete Plaene werden aktuell nicht ausgefuehrt.<br>29.04.2026, 16:00<br>7 Entladefenster geplant · Erste Phase: 29.04.2026, 18:30');
      expect(forecastSubtext).toBe('Dies ist die letzte berechnete Prognose und aktuell nur informativ.');
      expect(energyFlowSubtext).toBe('Aktuell ist mehr Solarstrom verfuegbar als Haus und Batterie aufnehmen.<br>Dieser Energiefluss beschreibt nur den Live-Zustand, nicht die aktive Optimizer-Steuerung.');
      expect(capacityLine).toBe('Freier Ladeplatz bis Ziel-SoC laut letztem Plan: 0.00 kWh');
    });

    it('should derive technical detail metrics from summary plus strategy', () => {
      const device = {
        capabilities: {
          optimizer_status: 'Charging at 3.3kW',
          next_charge_start: '2024-01-15 22:00',
          onoff: true,
        },
      };

      const summary = {
        currentAction: {
          tone: 'positive',
        },
        currentReason: 'Der aktuelle Strompreis liegt in einem geplanten guenstigen Ladefenster.',
        nextAction: {
          displayTime: '15.01.2024, 23:00',
        },
        energyFlow: {
          title: 'Netz laedt die Batterie',
        },
        battery: {
          freeCapacityToTargetKWh: 3.5,
        },
      };

      const strategy = {
        chargeIntervals: [{}, {}],
        expensiveIntervals: [{}],
        avgPrice: 0.2234,
        neededKWh: 8.5,
        forecastedDemand: 5,
      };

      const chargeIntervals = strategy.chargeIntervals?.length || 0;
      const expensiveIntervals = strategy.expensiveIntervals?.length || 0;
      const avgPrice = strategy.avgPrice ? strategy.avgPrice.toFixed(4) : '-';
      const neededKWh = Number.isFinite(strategy.neededKWh) ? strategy.neededKWh.toFixed(2) : '-';
      const forecastedDemand = Number.isFinite(strategy.forecastedDemand) ? strategy.forecastedDemand.toFixed(2) : '-';
      const freeCapacity = Number.isFinite(summary?.battery?.freeCapacityToTargetKWh)
        ? Number(summary.battery.freeCapacityToTargetKWh).toFixed(2)
        : '-';

      expect(chargeIntervals).toBe(2);
      expect(expensiveIntervals).toBe(1);
      expect(avgPrice).toBe('0.2234');
      expect(freeCapacity).toBe('3.50');
      expect(neededKWh).toBe('8.50');
      expect(forecastedDemand).toBe('5.00');
    });

    it('should calculate all statistics from complete data', () => {
      const strategy = {
        chargeIntervals: [
          { startsAt: '2024-01-15T22:00:00Z', total: 0.15 },
          { startsAt: '2024-01-15T22:15:00Z', total: 0.16 },
          { startsAt: '2024-01-15T22:30:00Z', total: 0.14 },
        ],
        chargeDisplayEntries: [
          { startsAt: '2024-01-15T22:00:00Z', plannedSymbol: '⚡', plannedEnergyKWh: 0.40, plannedPriceEurPerKWh: 0.15, plannedCostEur: 0.06 },
          { startsAt: '2024-01-15T22:15:00Z', plannedSymbol: '⚡', plannedEnergyKWh: 0.20, plannedPriceEurPerKWh: 0.16, plannedCostEur: 0.032 },
          { startsAt: '2024-01-15T22:30:00Z', plannedSymbol: '☀', plannedEnergyKWh: 0.10, plannedPriceEurPerKWh: 0.07, plannedCostEur: 0.007 },
        ],
        plannedCharging: {
          totalEnergyKWh: 0.70,
          totalCostEur: 0.099,
          avgPriceEurPerKWh: 0.14142857142857143,
        },
        expensiveIntervals: [
          { startsAt: '2024-01-16T18:00:00Z', total: 0.30 },
          { startsAt: '2024-01-16T18:15:00Z', total: 0.32 },
        ],
        forecastedDemand: 5.0,
        economics: {
          baselineCost: 1.55,
          optimizedCost: 0.75,
          savings: 0.80,
        },
      };

      // UI should rely on backend-provided plannedCharging for charge-side numbers
      const totalChargeEnergy = strategy.plannedCharging.totalEnergyKWh;
      const avgChargePrice = strategy.plannedCharging.avgPriceEurPerKWh;
      const totalChargeCost = strategy.plannedCharging.totalCostEur;

      const avgExpensivePrice = strategy.expensiveIntervals.reduce((sum, i) => sum + i.total, 0) / strategy.expensiveIntervals.length;
      const baselineCost = strategy.economics.baselineCost;
      const optimizedCost = strategy.economics.optimizedCost;
      const savings = strategy.economics.savings;

      // Verify calculations
      expect(totalChargeEnergy).toBeCloseTo(0.70, 6);
      expect(avgChargePrice).toBeCloseTo(0.1414285714, 7);
      expect(totalChargeCost).toBeCloseTo(0.099, 6);
      expect(avgExpensivePrice).toBeCloseTo(0.31, 2);
      expect(baselineCost).toBeCloseTo(1.55, 2);
      expect(optimizedCost).toBeCloseTo(0.75, 2);
      expect(savings).toBeCloseTo(0.80, 2);
    });
  });

  describe('Battery Status Display (End-to-End)', () => {
    it('should display complete battery status with storedKWh and tracked energy cost', () => {
      const strategy = {
        batteryStatus: {
          currentSoc: 0.65,
          targetSoc: 1.0,
          availableCapacity: 3.5,
          batteryCapacity: 10.0,
          storedKWh: 6.5,
          energyCost: {
            avgPrice: 0.1845,
            totalKWh: 6.5,
            storedKWh: 6.5,
            solarKWh: 2.0,
            gridKWh: 4.5,
            solarPercent: 30.77,
            gridPercent: 69.23,
            totalCost: 1.20,
            gridOnlyAvgPrice: 0.2667,
            isEstimated: false,
            trackedKWh: 6.5,
            unknownKWh: 0,
          },
        },
      };

      // Simulate UI rendering
      const bat = strategy.batteryStatus;
      const socPercent = (bat.currentSoc * 100).toFixed(1);
      const storedKWh = bat.storedKWh.toFixed(2);
      const cost = bat.energyCost;
      const hasUnknownPortion = cost.unknownKWh > 0.01;

      expect(socPercent).toBe('65.0');
      expect(storedKWh).toBe('6.50');
      expect(cost.avgPrice.toFixed(4)).toBe('0.1845');
      expect(hasUnknownPortion).toBe(false);
      expect(cost.isEstimated).toBe(false);
      expect(cost.trackedKWh).toBe(6.5);
    });

    it('should display battery status with fully estimated energy cost (no charge log)', () => {
      const strategy = {
        batteryStatus: {
          currentSoc: 0.80,
          targetSoc: 1.0,
          availableCapacity: 2.0,
          batteryCapacity: 10.0,
          storedKWh: 8.0,
          energyCost: {
            avgPrice: 0.14,
            totalKWh: 8.0,
            storedKWh: 8.0,
            solarKWh: 2.4,
            gridKWh: 5.6,
            solarPercent: 30,
            gridPercent: 70,
            totalCost: 1.12,
            gridOnlyAvgPrice: 0.20,
            unknownAvgPrice: 0.20,
            isEstimated: true,
            trackedKWh: 0,
            unknownKWh: 8.0,
          },
        },
      };

      // Simulate UI rendering
      const bat = strategy.batteryStatus;
      const storedKWh = bat.storedKWh.toFixed(2);
      const cost = bat.energyCost;
      const hasUnknownPortion = cost.unknownKWh > 0.01;
      const isFullyEstimated = cost.trackedKWh < 0.01;

      expect(storedKWh).toBe('8.00');
      expect(cost.avgPrice.toFixed(4)).toBe('0.1400');
      expect(hasUnknownPortion).toBe(true);
      expect(isFullyEstimated).toBe(true);
      expect(cost.isEstimated).toBe(true);
      expect(cost.trackedKWh).toBe(0);
      expect(cost.unknownKWh).toBe(8.0);
      expect(cost.unknownAvgPrice).toBe(0.20);
    });

    it('should display battery status with mixed energy cost (tracked + unknown)', () => {
      const strategy = {
        batteryStatus: {
          currentSoc: 0.70,
          targetSoc: 1.0,
          availableCapacity: 3.0,
          batteryCapacity: 10.0,
          storedKWh: 7.0,
          energyCost: {
            avgPrice: 0.1786,
            totalKWh: 7.0,
            storedKWh: 7.0,
            solarKWh: 1.5,
            gridKWh: 5.5,
            solarPercent: 21.43,
            gridPercent: 78.57,
            totalCost: 1.25,
            gridOnlyAvgPrice: 0.2273,
            isEstimated: true,
            trackedKWh: 3.0,
            unknownKWh: 4.0,
            unknownAvgPrice: 0.20,
          },
        },
      };

      // Simulate UI rendering
      const bat = strategy.batteryStatus;
      const storedKWh = bat.storedKWh.toFixed(2);
      const cost = bat.energyCost;
      const hasUnknownPortion = cost.unknownKWh > 0.01;
      const hasMixedData = cost.trackedKWh > 0.01 && cost.unknownKWh > 0.01;

      expect(storedKWh).toBe('7.00');
      expect(cost.avgPrice.toFixed(4)).toBe('0.1786');
      expect(hasUnknownPortion).toBe(true);
      expect(hasMixedData).toBe(true);
      expect(cost.isEstimated).toBe(true);
      expect(cost.trackedKWh).toBe(3.0);
      expect(cost.unknownKWh).toBe(4.0);
      expect(cost.unknownAvgPrice).toBe(0.20);

      // Verify UI labels
      const label = '💰 Durchschnittlicher Energiepreis in der Batterie:';
      const subtitle = `Teilweise gemessen: ${cost.trackedKWh.toFixed(2)} kWh bekannt, ${cost.unknownKWh.toFixed(2)} kWh geschätzt zu ${cost.unknownAvgPrice.toFixed(4)} €/kWh.`;
      
      expect(label).toBe('💰 Durchschnittlicher Energiepreis in der Batterie:');
      expect(subtitle).toContain('3.00 kWh bekannt');
      expect(subtitle).toContain('4.00 kWh geschätzt');
      expect(subtitle).toContain('0.2000 €/kWh');
    });

    it('should verify storedKWh equals currentSoc * batteryCapacity', () => {
      const currentSoc = 0.75;
      const batteryCapacity = 12.0;
      const storedKWh = currentSoc * batteryCapacity;

      expect(storedKWh).toBeCloseTo(9.0, 2);

      // Verify it's included in batteryStatus
      const batteryStatus = {
        currentSoc,
        batteryCapacity,
        storedKWh,
      };

      expect(batteryStatus.storedKWh).toBe(storedKWh);
    });

    it('should handle battery with no energy (SoC near zero)', () => {
      const strategy = {
        batteryStatus: {
          currentSoc: 0.03,
          targetSoc: 1.0,
          availableCapacity: 9.7,
          batteryCapacity: 10.0,
          storedKWh: 0.3,
          energyCost: null,
        },
      };

      const bat = strategy.batteryStatus;
      const storedKWh = bat.storedKWh.toFixed(2);
      const hasEnergyCost = bat.energyCost !== null;

      expect(storedKWh).toBe('0.30');
      expect(hasEnergyCost).toBe(false);
    });
  });

  describe('Error Handling', () => {
    it('should handle API errors gracefully', () => {
      const errorResponse = {
        error: 'Device not found',
        message: 'The requested device does not exist',
      };

      expect(errorResponse.error).toBeDefined();
      expect(errorResponse.message).toBeDefined();
      // Should show error message in UI
    });

    it('should handle malformed data', () => {
      const malformedData = {
        device: null,
        strategy: undefined,
        priceCache: 'not-an-array',
      };

      // Defensive checks
      const deviceExists = malformedData.device !== null && malformedData.device !== undefined;
      const strategyExists = malformedData.strategy !== null && malformedData.strategy !== undefined;
      const priceCacheValid = Array.isArray(malformedData.priceCache);

      expect(deviceExists).toBe(false);
      expect(strategyExists).toBe(false);
      expect(priceCacheValid).toBe(false);
      // Should show appropriate error messages
    });

    it('should handle missing timestamps', () => {
      const intervalWithoutTime = { total: 0.15 };

      const hasTimestamp = intervalWithoutTime.startsAt !== undefined;
      expect(hasTimestamp).toBe(false);
      // Should skip or show placeholder
    });
  });
});
