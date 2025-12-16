'use strict';

// Allow requiring Homey SDK classes in plain Node tests
jest.mock('homey', () => ({ Device: class {} }), { virtual: true });

const EnergyOptimizerDevice = require('../drivers/energy-optimizer/device');

describe('EnergyOptimizerDevice Tibber retry/backoff', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2024-01-15T12:00:00Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
    delete global.fetch;
  });

  it('retries Tibber fetch on 5xx and succeeds', async () => {
    const optimizer = new EnergyOptimizerDevice();

    optimizer.log = jest.fn();
    optimizer.debug = jest.fn();
    optimizer.error = jest.fn();

    optimizer.hasCapability = jest.fn(() => true);
    optimizer.getCapabilityValue = jest.fn(() => null);
    optimizer.setCapabilityValue = jest.fn(async () => {});
    optimizer.setAvailable = jest.fn(async () => {});
    optimizer.setUnavailable = jest.fn(async () => {});

    optimizer.homey = {
      __: (k) => k,
      i18n: { getLanguage: () => 'en' },
    };

    optimizer.getSettingOrDefault = jest.fn((key, fallback) => {
      if (key === 'tibber_token') return 'token';
      if (key === 'tibber_home_id') return 'home1';
      return fallback;
    });

    // First call returns 503, second call succeeds.
    let call = 0;
    global.fetch = jest.fn(async () => {
      call += 1;
      if (call === 1) {
        return { ok: false, status: 503, statusText: 'Service Unavailable' };
      }
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          data: {
            viewer: {
              homes: [
                {
                  id: 'home1',
                  currentSubscription: {
                    priceInfo: {
                      today: [],
                      tomorrow: [],
                    },
                  },
                },
              ],
            },
          },
        }),
      };
    });

    // Make retry delay deterministic
    jest.spyOn(Math, 'random').mockReturnValue(0);

    const promise = optimizer.fetchPricesFromTibber();

    // Wait for all promises and timers to settle
    await jest.runAllTimersAsync();
    await promise;

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(optimizer._tibberCircuit.failures).toBe(0);

    Math.random.mockRestore();
  });
});
