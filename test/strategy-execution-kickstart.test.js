'use strict';

const { executeOptimizationStrategy } = require('../drivers/energy-optimizer/services/strategy-execution');
const { BATTERY_MODE } = require('../drivers/energy-optimizer/strategy-execution-core');

function createPriceCache(startHour = 0, count = 96) {
  const cache = [];
  const baseDate = new Date(Date.UTC(2024, 0, 15, startHour, 0, 0, 0));

  for (let i = 0; i < count; i++) {
    const startsAt = new Date(baseDate.getTime() + i * 15 * 60 * 1000);
    cache.push({
      startsAt: startsAt.toISOString(),
      total: 0.20,
    });
  }

  return cache;
}

describe('strategy-execution PV kickstart', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function createHost({ berlinNowIso, solarW = 0, lastMode = BATTERY_MODE.CONSTANT } = {}) {
    if (berlinNowIso) {
      jest.setSystemTime(new Date(berlinNowIso));
    }

    const solarDevice = {
      hasCapability: (cap) => cap === 'measure_power',
      getCapabilityValue: () => solarW,
    };

    const batteryDevice = {};

    const host = {
      homey: {
        i18n: { getLanguage: () => 'de' },
        __: (key) => key,
      },
      log: jest.fn(),
      error: jest.fn(),
      logThrottled: jest.fn(),
      setCapabilityValueIfChanged: jest.fn().mockResolvedValue(undefined),

      getCapabilityValue: jest.fn().mockImplementation((cap) => (cap === 'onoff' ? true : null)),
      getSetting: jest.fn().mockImplementation((key) => {
        if (key === 'solar_device_id') return 'solar1';
        if (key === 'grid_device_id') return '';
        return '';
      }),
      getSettingOrDefault: jest.fn().mockImplementation((key, fallback) => {
        if (key === 'battery_device_id') return 'bat1';
        if (key === 'min_soc_threshold') return fallback;
        return fallback;
      }),

      getDeviceById: jest.fn().mockImplementation((driverId) => {
        if (driverId === 'solar-panel') return solarDevice;
        if (driverId === 'rct-power-storage-dc') return batteryDevice;
        return null;
      }),
      getCapabilitySafe: jest.fn().mockImplementation(() => 50),
      collectGridPower: jest.fn().mockResolvedValue(0),
      applyBatteryMode: jest.fn().mockResolvedValue(undefined),
      updateBatteryStatus: jest.fn().mockResolvedValue(undefined),

      priceCache: createPriceCache(),
      currentStrategy: { chargeIntervals: [], dischargeIntervals: [] },
      lastBatteryMode: lastMode,
    };

    return host;
  }

  it('forces NORMAL once in the morning window when PV is still <= 50W and last mode was CONSTANT', async () => {
    // 06:30Z = 07:30 Europe/Berlin (CET) on Jan 15
    const host = createHost({ berlinNowIso: '2024-01-15T06:30:00.000Z', solarW: 0, lastMode: BATTERY_MODE.CONSTANT });

    await executeOptimizationStrategy(host);

    expect(host.applyBatteryMode).toHaveBeenCalledTimes(1);
    const [, decision] = host.applyBatteryMode.mock.calls[0];
    expect(decision.mode).toBe(BATTERY_MODE.NORMAL);
    expect(decision.reason).toContain('PV kickstart');
  });

  it('does not force NORMAL outside the morning window', async () => {
    // 13:00Z = 14:00 Europe/Berlin (CET)
    const host = createHost({ berlinNowIso: '2024-01-15T13:00:00.000Z', solarW: 0, lastMode: BATTERY_MODE.CONSTANT });

    await executeOptimizationStrategy(host);

    expect(host.applyBatteryMode).toHaveBeenCalledTimes(1);
    const [, decision] = host.applyBatteryMode.mock.calls[0];
    expect(decision.mode).toBe(BATTERY_MODE.CONSTANT);
  });
});
