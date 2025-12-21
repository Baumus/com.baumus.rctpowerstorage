'use strict';

/**
 * Device/driver lookup cache helpers.
 * Host-based service module: operates on the EnergyOptimizerDevice instance.
 */

function invalidateDeviceCache(host, driverId = null, deviceId = null) {
  if (!host._driverCache) host._driverCache = new Map();
  if (!host._deviceCache) host._deviceCache = new Map();

  if (driverId && deviceId) {
    host._deviceCache.delete(`${driverId}:${deviceId}`);
  } else if (driverId) {
    host._driverCache.delete(driverId);
    // Also clear all device entries for this driver
    for (const key of host._deviceCache.keys()) {
      if (key.startsWith(`${driverId}:`)) {
        host._deviceCache.delete(key);
      }
    }
  } else {
    // Clear all
    host._driverCache.clear();
    host._deviceCache.clear();
  }
}

function getDriverSafe(host, id) {
  if (!host._driverCache) host._driverCache = new Map();
  const now = Date.now();
  const cached = host._driverCache.get(id);
  if (cached && now < cached.expiresAt) {
    return cached.driver;
  }

  try {
    const driver = host.homey.drivers.getDriver(id);
    host._driverCache.set(id, { driver, expiresAt: now + host._driverCacheTtlMs });
    return driver;
  } catch (error) {
    host.log(`Driver "${id}" not accessible:`, error.message);
    // Negative cache: remember "not found" for shorter TTL
    host._driverCache.set(id, { driver: null, expiresAt: now + host._negativeCacheTtlMs });
    return null;
  }
}

function getDeviceById(host, driverId, deviceId) {
  if (!deviceId || !deviceId.trim()) return null;

  if (!host._deviceCache) host._deviceCache = new Map();
  if (!host._deviceCacheTtlMs) host._deviceCacheTtlMs = 60000;
  if (!host._negativeCacheTtlMs) host._negativeCacheTtlMs = 5000;

  const cacheKey = `${driverId}:${deviceId}`;
  const now = Date.now();
  const cached = host._deviceCache.get(cacheKey);
  if (cached && now < cached.expiresAt) {
    return cached.device;
  }

  const driver = getDriverSafe(host, driverId);
  if (!driver) {
    // Negative cache for device when driver missing
    host._deviceCache.set(cacheKey, { device: null, expiresAt: now + host._negativeCacheTtlMs });
    return null;
  }

  try {
    const devices = driver.getDevices();
    const device = devices.find((d) => d.getData().id === deviceId);
    const ttl = device ? host._deviceCacheTtlMs : host._negativeCacheTtlMs;
    host._deviceCache.set(cacheKey, { device: device || null, expiresAt: now + ttl });
    return device || null;
  } catch (error) {
    host.log(`Error getting device ${deviceId} from driver ${driverId}:`, error.message);
    host._deviceCache.set(cacheKey, { device: null, expiresAt: now + host._negativeCacheTtlMs });
    return null;
  }
}

module.exports = {
  invalidateDeviceCache,
  getDriverSafe,
  getDeviceById,
};
