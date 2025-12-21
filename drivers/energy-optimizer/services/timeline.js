'use strict';

/**
 * Timeline/notification helpers.
 * Host-based service module: operates on the EnergyOptimizerDevice instance.
 */
async function logBatteryModeChange(host, mode, details = '') {
  try {
    let message = '';
    let icon = '';

    switch (mode) {
      case 'CHARGE':
        message = host.homey.__('timeline.charging');
        icon = '⚡';
        break;
      case 'NORMAL':
        message = host.homey.__('timeline.normal');
        icon = '🏠';
        break;
      case 'CONSTANT':
        message = host.homey.__('timeline.constant');
        icon = '🔒';
        break;
      default:
        host.log(`Unknown battery mode: ${mode}`);
        return;
    }

    const fullMessage = details ? `${icon} ${message} ${details}` : `${icon} ${message}`;

    await host.homey.notifications.createNotification({
      excerpt: fullMessage,
    });

    host.log(`📢 Timeline notification: ${fullMessage}`);
  } catch (error) {
    host.error('Error creating timeline notification:', error);
  }
}

module.exports = {
  logBatteryModeChange,
};
