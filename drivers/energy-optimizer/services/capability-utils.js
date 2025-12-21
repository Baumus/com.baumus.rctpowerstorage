'use strict';

/**
 * Capability and logging helpers.
 * Implemented as host-based functions to avoid binding/initialization pitfalls
 * in Homey device lifecycle and Jest tests.
 */

function setCapabilityValueIfChanged(host, capabilityId, nextValue, { tolerance = null } = {}) {
  if (!host || typeof host.hasCapability !== 'function' || typeof host.setCapabilityValue !== 'function') {
    return Promise.resolve(false);
  }

  if (!host.hasCapability(capabilityId)) return Promise.resolve(false);

  if (!host._capabilityLastValues) host._capabilityLastValues = new Map();

  let cached;
  if (host._capabilityLastValues.has(capabilityId)) {
    cached = host._capabilityLastValues.get(capabilityId);
  } else if (typeof host.getCapabilityValue === 'function') {
    cached = host.getCapabilityValue(capabilityId);
  } else {
    cached = undefined;
  }

  const bothNumbers = typeof cached === 'number'
    && typeof nextValue === 'number'
    && Number.isFinite(cached)
    && Number.isFinite(nextValue);

  const isSame = bothNumbers && typeof tolerance === 'number'
    ? Math.abs(cached - nextValue) <= tolerance
    : cached === nextValue;

  if (isSame) return Promise.resolve(false);

  return Promise.resolve(host.setCapabilityValue(capabilityId, nextValue))
    .then(() => {
      host._capabilityLastValues.set(capabilityId, nextValue);
      return true;
    });
}

function logThrottled(host, category, intervalMs, ...args) {
  if (!host || typeof host.log !== 'function') return;
  if (!host._logThrottle) host._logThrottle = new Map();

  const now = Date.now();
  const last = host._logThrottle.get(category) || 0;
  if (now - last < intervalMs) return;

  host._logThrottle.set(category, now);
  host.log(...args);
}

module.exports = {
  setCapabilityValueIfChanged,
  logThrottled,
};
