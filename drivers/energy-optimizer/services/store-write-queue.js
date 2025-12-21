'use strict';

/**
 * Throttled store writes.
 *
 * Host-based implementation keeps state on the device instance:
 * - host._pendingStoreWrites: Map
 * - host._storeWriteTimer: Timeout
 * - host._storeWriteDelayMs: number
 */

let scheduleStoreFlush;
let flushStoreWrites;

function queueStoreValue(host, key, value, { immediate = false } = {}) {
  if (!host) return Promise.resolve();

  if (!host._pendingStoreWrites) host._pendingStoreWrites = new Map();
  host._pendingStoreWrites.set(key, value);

  if (immediate) {
    return flushStoreWrites(host);
  }

  scheduleStoreFlush(host);
  return Promise.resolve();
}

scheduleStoreFlush = function scheduleStoreFlush(host) {
  if (!host) return;
  if (host._storeWriteTimer) return;

  const delayMs = host._storeWriteDelayMs || 2000;
  host._storeWriteTimer = setTimeout(() => {
    host._storeWriteTimer = null;
    flushStoreWrites(host).catch((error) => {
      if (typeof host.error === 'function') host.error('Error flushing queued store writes:', error);
    });
  }, delayMs);
};

flushStoreWrites = async function flushStoreWrites(host) {
  if (!host) return;

  if (host._storeWriteTimer) {
    clearTimeout(host._storeWriteTimer);
    host._storeWriteTimer = null;
  }

  const entries = host._pendingStoreWrites ? [...host._pendingStoreWrites.entries()] : [];
  if (!entries.length) return;
  host._pendingStoreWrites.clear();

  const failed = [];
  await Promise.all(entries.map(async ([storeKey, storeValue]) => {
    try {
      if (typeof host.setStoreValue !== 'function') {
        throw new Error('setStoreValue is not a function');
      }
      await host.setStoreValue(storeKey, storeValue);
    } catch (error) {
      failed.push([storeKey, storeValue, error]);
    }
  }));

  if (failed.length) {
    failed.forEach(([storeKey, storeValue, error]) => {
      if (typeof host.error === 'function') host.error(`Failed to persist store key "${storeKey}":`, error);
      host._pendingStoreWrites.set(storeKey, storeValue);
    });
    scheduleStoreFlush(host);
  }
};

module.exports = {
  queueStoreValue,
  scheduleStoreFlush,
  flushStoreWrites,
};
