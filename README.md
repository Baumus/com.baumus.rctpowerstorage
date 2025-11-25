# RCT Power Storage DC

A Homey app for monitoring the RCT Power Storage DC. RCT Power is a registered trademark of RCT Power GmbH. This app is not provided by, endorsed by, supported by, or affiliated with RCT Power GmbH in any way.

## Features

- **Full Homey Energy integration** - Complete compliance with Homey Energy guidelines
- **Three dedicated devices** for comprehensive monitoring
- **Real-time monitoring** of power flows, battery state, and energy consumption
- **Flow card support** for automation based on energy data
- **Grid charging management** (optional, use at your own risk)

## Devices

### RCT Power Storage DC (Battery)

Monitors your RCT battery system with the following capabilities:

**Standard Capabilities (Homey Energy compliant):**
- **Battery Power** (`measure_power`) - Real-time power flow (positive = discharging, negative = charging)
- **Battery State of Charge** (`measure_battery`) - Current battery level in percentage
- **Charged Energy** (`meter_power.charged`) - Cumulative energy charged into the battery (kWh)
- **Discharged Energy** (`meter_power.discharged`) - Cumulative energy discharged from the battery (kWh)

**Custom Capabilities:**
- **Battery Mode** (`battery_modus`) - Current operating mode (charge/discharge/idle)
- **SOC Strategy** (`soc_strategy`) - Current state-of-charge management strategy

**Legacy Capabilities (deprecated - use dedicated devices instead):**
- **Battery Power (Legacy)** (`battery_power`) - Battery power in RCT convention
- **Solar Power (Legacy)** (`solar_power`) - Use Solar Panel device instead
- **Grid Power (Legacy)** (`total_grid_power`) - Use Grid Meter device instead
- **Household Load (Legacy)** (`load_household`) - Use Grid Meter device instead

> **Note:** The legacy capabilities are kept for backwards compatibility with existing flows. For complete Homey Energy integration and better insights, add the dedicated Solar Panel and Grid Meter devices.

### Solar Panel

Dedicated solar panel monitoring device:

- **Solar Power** - Real-time solar generation in Watts
- **Total Energy Generated** - Cumulative solar energy production in kWh
- Fully integrated with Homey Energy for production tracking

### Grid Meter

Tracks total household grid connection:

- **Grid Power** - Instantaneous grid power (positive = import, negative = export)
- **Imported Energy** - Cumulative energy imported from grid (kWh)
- **Exported Energy** - Cumulative energy exported to grid (kWh)
- Marked as cumulative meter for whole-home energy tracking
- Enables Homey Energy to calculate "other" consumption

## Upgrading from v2.x to v3.0

### Automatic Migration

When you upgrade to v3.0, your existing **RCT Power Storage DC** device will automatically:
- Migrate from `solarpanel` to `battery` device class
- Add new energy tracking capabilities (`meter_power.charged` and `meter_power.discharged`)
- Continue working without re-pairing
- Keep all legacy capabilities for backwards compatibility

### Recommended: Add Dedicated Devices

For complete Homey Energy integration, we recommend adding two additional devices:

1. **Solar Panel** - Dedicated solar generation tracking with cumulative energy
2. **Grid Meter** - Whole-home consumption tracking with import/export

Both devices use the **same IP address and port** as your existing RCT Power Storage DC device:

1. Go to **Devices** → **Add Device**
2. Search for **"RCT Power"**
3. Add **"Solar Panel"** and/or **"Grid Meter"**
4. Enter the **same IP address and port** as your battery device

### Legacy Capabilities

The following capabilities in the Battery device are now deprecated:
- `battery_power` → Use Battery device's `measure_power` instead
- `solar_power` → Use dedicated **Solar Panel** device
- `total_grid_power` → Use dedicated **Grid Meter** device
- `load_household` → Use dedicated **Grid Meter** device

These capabilities remain functional for backwards compatibility with existing flows. They will be removed in a future major version (v4.0 or later).

## Requirements

- Homey Pro (2023) or Homey Pro mini
- Homey firmware v12.0.0 or higher
- RCT Power Storage DC system
- Network connection to your RCT inverter

## Installation

1. Install the app from the Homey App Store
2. Add devices:
   - **RCT Power Storage DC** - Main battery and inverter device
   - **Solar Panel** - Solar generation monitoring (optional)
   - **Grid Meter** - Whole-home consumption tracking (optional)
3. Enter the IP address and port (default: 8899) of your RCT inverter
4. Configure polling interval in device settings (default: 60 seconds for battery, 20 seconds recommended for detailed monitoring)

## Configuration

### Basic Settings

- **Polling Interval** - How often to query the inverter (10-3600 seconds)
- Device information is automatically detected and displayed in settings

### Grid Charging Management (Advanced)

⚠️ **USE AT YOUR OWN RISK** - This feature writes values to the inverter's memory.

When enabled, you can:
- Set maximum grid charging power
- Configure default SOC strategy
- Enable/disable grid power usage
- Automate battery charging from grid via Flow cards

## Homey Energy Integration

This app fully supports Homey Energy:

- **Battery Device** - Tracks charge/discharge cycles and efficiency
- **Solar Panel Device** - Shows solar generation in Energy dashboard
- **Grid Meter Device** - Acts as whole-home meter for complete energy overview
- All energy values are cumulative and persistent
- Supports advanced features requiring import/export distinction

## Flow Cards

### Triggers (When...)

- Battery power changed
- Battery SOC changed
- Solar power changed
- Battery mode changed
- SOC strategy changed

### Conditions (And...)

- Battery SOC is greater than...
- Solar power is greater than...
- Grid power is greater than...
- Household load is greater than...
- Battery mode is...
- SOC strategy is...

### Actions (Then...)

- Enable grid charging
- Disable battery discharge
- Enable default operating mode

## Support

For issues, questions, or feature requests, please visit:
- GitHub: [https://github.com/Baumus/com.baumus.rctpowerstorage](https://github.com/Baumus/com.baumus.rctpowerstorage)

## Disclaimer

**USE AT YOUR OWN RISK** - The grid charging management features send commands to your inverter. While tested, you are fully responsible for any harm or damage caused. Please review the source code on GitHub before using these features.

This app is not affiliated with RCT Power GmbH.

## License

See LICENSE file for details.