'use strict';

const { filterCurrentAndFutureIntervals } = require('../time-scheduling-core');
const { INTERVAL_MINUTES } = require('../constants');

async function fetchPricesFromTibber(host) {
  try {
    // Simple circuit breaker to avoid hammering Tibber when unreachable.
    if (!host._tibberCircuit) {
      host._tibberCircuit = { failures: 0, nextAllowedAt: 0 };
    }

    const now = Date.now();
    if (host._tibberCircuit.nextAllowedAt && now < host._tibberCircuit.nextAllowedAt) {
      const waitSec = Math.ceil((host._tibberCircuit.nextAllowedAt - now) / 1000);
      if (typeof host.debug === 'function') host.debug(`⏳ Tibber fetch blocked by circuit breaker (${waitSec}s remaining)`);
      return false;
    }

    if (typeof host.log === 'function') host.log('📡 Fetching Tibber prices from API...');
    if (typeof host.setCapabilityValueIfChanged === 'function') {
      await host.setCapabilityValueIfChanged('optimizer_status', host.homey.__('status.fetching_prices'));
    }

    const tibberToken = typeof host.getSettingOrDefault === 'function'
      ? host.getSettingOrDefault('tibber_token', '')
      : '';
    const tibberHomeId = typeof host.getSettingOrDefault === 'function'
      ? host.getSettingOrDefault('tibber_home_id', '')
      : '';

    const query = `
        {
          viewer {
            homes {
              id
              currentSubscription {
                priceInfo(resolution: QUARTER_HOURLY) {
                  today { startsAt total }
                  tomorrow { startsAt total }
                }
              }
            }
          }
        }
      `;

    const response = await host._fetchWithRetry('https://api.tibber.com/v1-beta/gql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tibberToken}`,
      },
      body: JSON.stringify({ query }),
    }, {
      timeoutMs: 12000,
      maxAttempts: 3,
      baseDelayMs: 1000,
      maxDelayMs: 15000,
    });

    if (!response.ok) {
      throw new Error(`Tibber API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();

    // Validate response structure
    if (!data || !data.data || !data.data.viewer || !Array.isArray(data.data.viewer.homes)) {
      throw new Error('Unexpected Tibber API response format');
    }

    if (data.errors) {
      throw new Error(`Tibber API errors: ${JSON.stringify(data.errors)}`);
    }

    const home = data.data.viewer.homes.find((h) => h.id === tibberHomeId);

    if (!home) {
      throw new Error(host.homey.__('error.home_not_found'));
    }

    const { priceInfo } = home.currentSubscription;
    const today = priceInfo.today || [];
    const tomorrow = priceInfo.tomorrow || [];

    const nowDate = new Date();
    // Include current and future intervals using pure function
    host.priceCache = filterCurrentAndFutureIntervals(
      [...today, ...tomorrow],
      nowDate,
      INTERVAL_MINUTES,
    );

    if (typeof host.log === 'function') {
      host.log(`✅ Fetched ${host.priceCache.length} price intervals (from ${host.priceCache.length > 0 ? new Date(host.priceCache[0].startsAt).toLocaleString() : 'N/A'})`);
    }

    if (typeof host.setCapabilityValueIfChanged === 'function') {
      await host.setCapabilityValueIfChanged('optimizer_status', host.homey.__('status.active'));
    }

    if (typeof host.setAvailable === 'function') {
      await host.setAvailable();
    }

    // Reset circuit breaker on success
    host._tibberCircuit.failures = 0;
    host._tibberCircuit.nextAllowedAt = 0;
    return true;
  } catch (error) {
    if (typeof host.error === 'function') host.error('Error fetching prices:', error);

    if (typeof host.setCapabilityValueIfChanged === 'function') {
      await host.setCapabilityValueIfChanged('optimizer_status', `${host.homey.__('status.error')}: ${error.message}`);
    }

    // Trip circuit breaker progressively on repeated failures
    if (!host._tibberCircuit) {
      host._tibberCircuit = { failures: 0, nextAllowedAt: 0 };
    }
    host._tibberCircuit.failures += 1;
    const { failures } = host._tibberCircuit;
    if (failures >= 3) {
      const baseMs = 5 * 60 * 1000; // 5 minutes
      const backoffMs = Math.min(6 * 60 * 60 * 1000, baseMs * (2 ** (failures - 3)));
      host._tibberCircuit.nextAllowedAt = Date.now() + backoffMs;
    }

    // Don't set unavailable for temporary API errors
    if (typeof host.setUnavailable === 'function' && !error.message.includes('API error')) {
      await host.setUnavailable(error.message);
    }

    return false;
  }
}

module.exports = {
  fetchPricesFromTibber,
};
