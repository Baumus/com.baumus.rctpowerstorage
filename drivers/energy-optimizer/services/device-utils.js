'use strict';

const { PRICE_TIMEZONE } = require('../constants');

/**
 * Small device utility helpers.
 * Host-based service module: operates on the EnergyOptimizerDevice instance.
 */

function getCapabilitySafe(host, device, capabilityId) {
  if (!device || !device.hasCapability || !device.getCapabilityValue) return null;
  if (!device.hasCapability(capabilityId)) return null;
  try {
    return device.getCapabilityValue(capabilityId);
  } catch (error) {
    host.log(`Failed to get capability ${capabilityId}:`, error.message);
    return null;
  }
}

function formatLocalizedTime(host, date) {
  return date.toLocaleString(host.homey.i18n.getLanguage(), {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: PRICE_TIMEZONE,
  });
}

module.exports = {
  getCapabilitySafe,
  formatLocalizedTime,
};
