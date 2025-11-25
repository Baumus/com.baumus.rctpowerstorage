# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.0.0] - 2025-11-25

### ⚠️ BREAKING CHANGES

- **Requires Homey v12.0.0 or higher** - Due to use of `battery` device class and advanced energy features
- **RCT Power Storage DC device class changed** from `solarpanel` to `battery` - Existing devices will automatically migrate without re-pairing
- **Minimum Homey version increased** from 5.0.0 to 12.0.0

### Added

- **Grid Meter device** - New dedicated device for tracking total household grid consumption
  - Tracks grid import and export separately
  - Marked as cumulative meter for whole-home energy tracking
  - Enables Homey Energy to calculate "other" consumption
- **Separate energy tracking** for battery charged vs. discharged energy
  - `meter_power.charged` - Total energy charged into battery
  - `meter_power.discharged` - Total energy discharged from battery
  - Enables battery efficiency calculations in Homey Energy
- **Solar Panel device** - Proper cumulative energy tracking
  - Real-time power generation
  - Total energy produced over time
  - Full Homey Energy integration
- **Base classes** for better code organization
  - `RCTDriver` base class for shared pairing logic
  - `RCTDevice` base class for connection and polling management
- **Enhanced energy tracking**
  - Proper cumulative meter calculations using trapezoidal integration
  - Separate tracking for all energy flows (battery, solar, grid)
  - Time-based energy accumulation for accuracy

### Changed

- **Battery power sign convention** now matches Homey standard
  - Positive value = battery discharging (providing power to home)
  - Negative value = battery charging (consuming power)
  - Note: Custom `battery_power` capability retains RCT convention for backwards compatibility
- **Device architecture** - Three separate devices for different functions
  - RCT Power Storage DC (Battery) - Battery and inverter monitoring
  - Solar Panel - Solar generation tracking
  - Grid Meter - Whole-home consumption tracking
- **Energy configuration** - Full compliance with Homey Energy guidelines
  - Home battery properly configured with `homeBattery: true`
  - Solar panel with `meterPowerExportedCapability`
  - Grid meter with `cumulative: true` and import/export capabilities
- **Improved connection handling**
  - Better error recovery
  - Centralized error handling in base class
  - Proper connection cleanup on errors
- **Code structure** - Refactored for maintainability
  - DRY principles applied throughout
  - Shared logic moved to base classes
  - Better separation of concerns

### Fixed

- **Energy tracking accuracy** - Using proper integration methods for kWh calculations
- **Connection stability** - Better handling of network errors and timeouts
- **Migration logic** - Smooth upgrade path from previous versions without data loss
- **Device pairing** - Each device type now properly identified during pairing
- **Line endings** - Consistent LF line endings across all files

### Technical Details

#### Energy Calculations

All energy values are calculated using the trapezoidal rule for integration:
```
Energy (kWh) = (P1 + P2) / 2 × ΔT / 1000
```
where:
- P1, P2 = power measurements in Watts
- ΔT = time delta in hours

This ensures accurate cumulative energy tracking over time.

#### Device Classes

- **Battery Device**: `class: "battery"` with `homeBattery: true`
- **Solar Panel Device**: `class: "solarpanel"` 
- **Grid Meter Device**: `class: "sensor"` with `cumulative: true`

#### Migration Strategy

Existing devices automatically upgrade:
1. Device class changes from `solarpanel` to `battery`
2. Old `meter_power` capability migrated to `meter_power.charged` and `meter_power.discharged`
3. No re-pairing required
4. All custom capabilities preserved for backwards compatibility

### Deprecated

- Old `meter_power` capability (replaced by `.charged` and `.discharged` variants)
- **Legacy capabilities in Battery device** (kept for backwards compatibility):
  - `battery_power` - Use Battery device's `measure_power` instead
  - `solar_power` - Use dedicated Solar Panel device instead
  - `total_grid_power` - Use dedicated Grid Meter device instead
  - `load_household` - Use dedicated Grid Meter device instead
  - These capabilities will be removed in a future major version (v4.0 or later)
  - Existing flows will continue to work, but new users should use dedicated devices

### Security

- Grid charging management features remain behind explicit user enablement
- Warning messages displayed when enabling inverter control features

## [2.1.9] - Previous versions

See Git history for changes in versions prior to 3.0.0.
