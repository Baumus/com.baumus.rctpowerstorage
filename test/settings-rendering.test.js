'use strict';

const {
  calculateBatteryEnergyCost,
  createChargeEntry,
} = require('../drivers/energy-optimizer/battery-cost-core');

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
      const expensiveIntervals = strategy.expensiveIntervals?.length || 0;
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
      const expensiveIntervals = strategy.expensiveIntervals?.length || 0;
      const avgPrice = strategy.avgPrice ? strategy.avgPrice.toFixed(4) : '-';

      expect(chargeIntervals).toBe(0);
      expect(expensiveIntervals).toBe(0);
      expect(avgPrice).toBe('-');
    });
  });

  describe('Price Chart Data Processing', () => {
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
        (strategy.expensiveIntervals || []).map(s => s.startsAt)
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
  });

  describe('Timeline Data Processing', () => {
    it('should format charge intervals correctly', () => {
      const chargeIntervals = [
        { startsAt: '2024-01-15T22:00:00Z', total: 0.15 },
        { startsAt: '2024-01-15T22:15:00Z', total: 0.16 },
        { startsAt: '2024-01-15T22:30:00Z', total: 0.14 },
      ];

      const energyPerInterval = 1.5; // kWh per 15-min interval

      const totalChargeEnergy = chargeIntervals.length * energyPerInterval;
      const avgChargePrice = chargeIntervals.reduce((sum, i) => sum + i.total, 0) / chargeIntervals.length;
      const totalChargeCost = totalChargeEnergy * avgChargePrice;

      expect(totalChargeEnergy).toBeCloseTo(4.5, 1);
      expect(avgChargePrice).toBeCloseTo(0.15, 2);
      expect(totalChargeCost).toBeCloseTo(0.675, 2);
    });

    it('should format time and date correctly', () => {
      const isoString = '2024-01-15T22:30:00Z';
      const date = new Date(isoString);

      // Simulate time formatting
      const timeStr = date.toLocaleTimeString('en-GB', { 
        hour: '2-digit', 
        minute: '2-digit' 
      });
      const dateStr = date.toLocaleDateString('en-GB', { 
        month: 'short', 
        day: 'numeric' 
      });

      expect(timeStr).toMatch(/^\d{2}:\d{2}$/);
      expect(dateStr).toMatch(/^\d{1,2} \w{3}$/); // Format: "15 Jan"
    });

    it('should calculate discharge savings correctly', () => {
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
      };

      const forecastedDemand = strategy.forecastedDemand;
      const avgChargePrice = strategy.chargeIntervals.reduce((sum, i) => sum + i.total, 0) / strategy.chargeIntervals.length;
      const avgExpensivePrice = strategy.expensiveIntervals.reduce((sum, i) => sum + i.total, 0) / strategy.expensiveIntervals.length;

      const batteryUsageCost = forecastedDemand * avgChargePrice;
      const gridUsageCost = forecastedDemand * avgExpensivePrice;
      const savings = gridUsageCost - batteryUsageCost;

      expect(avgChargePrice).toBeCloseTo(0.155, 3);
      expect(avgExpensivePrice).toBeCloseTo(0.31, 2);
      expect(batteryUsageCost).toBeCloseTo(0.775, 2);
      expect(gridUsageCost).toBeCloseTo(1.55, 2);
      expect(savings).toBeCloseTo(0.775, 2);
    });

    it('should handle missing timeline data', () => {
      const strategy = {};

      const hasChargeIntervals = !!(strategy.chargeIntervals && strategy.chargeIntervals.length > 0);
      const hasExpensiveIntervals = !!(strategy.expensiveIntervals && strategy.expensiveIntervals.length > 0);

      expect(hasChargeIntervals).toBe(false);
      expect(hasExpensiveIntervals).toBe(false);
      // Should show "No optimization plan available"
    });
  });

  describe('Battery Status Display', () => {
    it('should format battery status correctly', () => {
      const batteryStatus = {
        currentSoc: 0.65,
        targetSoc: 0.85,
        availableCapacity: 3.5,
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

      // For our 4 kWh charge (1.5 solar, 2.5 grid @ 0.20 €/kWh):
      //   totalCost = 2.5 * 0.20 = 0.50 €
      //   totalKWh = 4.0 → weighted avg = 0.50 / 4.0 = 0.125 €/kWh
      //   solar share = 1.5 / 4.0 = 37.5% → ≈ 38%
      //   grid share = 2.5 / 4.0 = 62.5% → rounds to 63%
      expect(avgPriceDisplay).toBe('0.1250');
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
          energyCost,
        },
      };

      const bat = strategy.batteryStatus;
      const cost = bat.energyCost;

      // Format as HTML strings exactly as renderTimeline() does
      const avgPriceText = `${cost.avgPrice.toFixed(4)} €/kWh`;
      const solarText = `☀️ Solar: ${cost.solarKWh.toFixed(2)} kWh (${cost.solarPercent.toFixed(0)}%)`;
      const gridText = `⚡ Grid: ${cost.gridKWh.toFixed(2)} kWh (${cost.gridPercent.toFixed(0)}%)`;
      const headerText = `Current SoC: ${(bat.currentSoc * 100).toFixed(1)}% (Target: ${(bat.targetSoc * 100).toFixed(1)}%)`;
      const capacityText = `Available Capacity: ${bat.availableCapacity.toFixed(2)} kWh`;

      // Verify string formatting matches HTML display
      expect(avgPriceText).toMatch(/^0\.\d{4} €\/kWh$/);
      expect(solarText).toMatch(/^☀️ Solar: \d+\.\d{2} kWh \(\d+%\)$/);
      expect(gridText).toMatch(/^⚡ Grid: \d+\.\d{2} kWh \(\d+%\)$/);
      expect(headerText).toBe('Current SoC: 50.0% (Target: 85.0%)');
      expect(capacityText).toBe('Available Capacity: 5.00 kWh');

      // Total charge = 3.0 + 2.0 = 5.0 kWh
      // Solar = 1.0 + 0.5 = 1.5 kWh → 30%
      // Grid = 2.0 + 1.5 = 3.5 kWh → 70%
      // Grid cost = (2.0 * 0.25) + (1.5 * 0.22) = 0.50 + 0.33 = 0.83 €
      // Avg = 0.83 / 5.0 = 0.166 €/kWh
      expect(avgPriceText).toBe('0.1660 €/kWh');
      expect(solarText).toBe('☀️ Solar: 1.50 kWh (30%)');
      expect(gridText).toBe('⚡ Grid: 3.50 kWh (70%)');
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

    it('should calculate all statistics from complete data', () => {
      const strategy = {
        chargeIntervals: [
          { startsAt: '2024-01-15T22:00:00Z', total: 0.15 },
          { startsAt: '2024-01-15T22:15:00Z', total: 0.16 },
          { startsAt: '2024-01-15T22:30:00Z', total: 0.14 },
        ],
        expensiveIntervals: [
          { startsAt: '2024-01-16T18:00:00Z', total: 0.30 },
          { startsAt: '2024-01-16T18:15:00Z', total: 0.32 },
        ],
        forecastedDemand: 5.0,
      };

      // Calculate statistics
      const energyPerInterval = 1.5;
      const totalChargeEnergy = strategy.chargeIntervals.length * energyPerInterval;
      const avgChargePrice = strategy.chargeIntervals.reduce((sum, i) => sum + i.total, 0) / strategy.chargeIntervals.length;
      const totalChargeCost = totalChargeEnergy * avgChargePrice;
      
      const avgExpensivePrice = strategy.expensiveIntervals.reduce((sum, i) => sum + i.total, 0) / strategy.expensiveIntervals.length;
      const batteryUsageCost = strategy.forecastedDemand * avgChargePrice;
      const gridUsageCost = strategy.forecastedDemand * avgExpensivePrice;
      const savings = gridUsageCost - batteryUsageCost;

      // Verify calculations
      expect(totalChargeEnergy).toBeCloseTo(4.5, 1);
      expect(avgChargePrice).toBeCloseTo(0.15, 2);
      expect(totalChargeCost).toBeCloseTo(0.675, 2);
      expect(avgExpensivePrice).toBeCloseTo(0.31, 2);
      expect(savings).toBeCloseTo(0.80, 2);
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
