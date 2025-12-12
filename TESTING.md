# Testing Infrastructure

This document describes the testing architecture for the RCT Power Storage Homey app.

## Overview

The energy optimization logic has been extracted into pure, testable functions and is now thoroughly tested with Jest. The architecture separates concerns into five main modules:

1. **optimizer-core.js** - Optimization algorithms (heuristic + LP solver)
2. **strategy-execution-core.js** - Battery mode decision logic
3. **battery-cost-core.js** - Battery energy cost tracking (FIFO accounting)
4. **time-scheduling-core.js** - Time/interval calculations and scheduling
5. **device.js** - Homey device integration

## Test Structure

### Test Files

- `test/optimizer-core.test.js` - Heuristic optimization algorithm (14 tests)
- `test/optimizer-lp.test.js` - LP solver optimization and error handling (16 tests)
- `test/strategy-execution-core.test.js` - Battery mode decisions (32 tests)
- `test/battery-cost-core.test.js` - Battery cost calculations (31 tests)
- `test/time-scheduling-core.test.js` - Time/interval logic (55 tests)
- `test/integration.test.js` - **Module integration (11 tests) ✨**
- `test/settings-rendering.test.js` - **Settings UI data processing (25 tests) ✨ NEW**
- `tools/simulate-optimizer.js` - CLI simulator for manual testing

**Total**: 159 unit tests + 11 integration tests + 25 UI tests = **215 tests** covering all logic

### Core Modules Tested

#### optimizer-core.js
- `computeHeuristicStrategy()` - Heuristic optimization algorithm
- `optimizeStrategyWithLp()` - Linear Programming optimization
- `forecastEnergyDemand()` - Energy demand forecasting
- `getPercentile()` - Statistical calculations

#### strategy-execution-core.js
- `decideBatteryMode()` - Decides battery mode based on strategy and conditions
- `findCurrentIntervalIndex()` - Finds current time slot in price cache
- `hasModeChanged()` - Detects mode transitions
- `BATTERY_MODE` - Battery mode constants

#### battery-cost-core.js
- `calculateBatteryEnergyCost()` - Calculates average cost of energy in battery
- `createChargeEntry()` - Creates charge log entry with solar/grid split
- `createDischargeEntry()` - Creates discharge log entry
- `shouldClearChargeLog()` - Determines if log should be cleared
- `trimChargeLog()` - Trims log to max entries
- `calculateDischargeProfit()` - Calculates profit/loss from discharge

#### time-scheduling-core.js (NEW)
- `getIntervalOfDay()` - Converts Date to interval index (0-95 for 15min)
- `getPriceAtTime()` - Finds price for specific timestamp
- `filterFutureIntervals()` - Filters intervals after current time
- `filterCurrentAndFutureIntervals()` - Filters with buffer time
- `enrichPriceData()` - Adds index and intervalOfDay to price entries
- `groupConsecutiveIntervals()` - Groups consecutive time slots
- `formatTime()` / `formatDateTime()` - Time formatting utilities
- `isToday()` / `isTomorrow()` / `isSameDay()` - Date comparison utilities
- `getNextIntervalStart()` - Finds next future interval
- `intervalMinutesToHours()` / `intervalsPerDay()` - Interval calculations

## Running Tests

```bash
# Run all tests
npm test

# Run tests in watch mode (auto-rerun on file changes)
npm run test:watch

# Run tests with coverage report
npm run test:coverage

# Run specific test file
npm test -- optimizer-core.test.js
npm test -- optimizer-lp.test.js
npm test -- strategy-execution-core.test.js
npm test -- battery-cost-core.test.js
npm test -- time-scheduling-core.test.js
npm test -- integration.test.js
npm test -- settings-rendering.test.js
```

## Test Coverage

### optimizer-core.js
- **Statements**: 89.78%
- **Branches**: 76.78%
- **Functions**: 91.3%
- **Lines**: 93.16%

### strategy-execution-core.js
- **Full coverage** of all decision paths
- Tests all battery modes: CHARGE, DISCHARGE, NORMAL_SOLAR, NORMAL_HOLD, IDLE
- Covers hysteresis behavior and oscillation prevention

### battery-cost-core.js
- **Full coverage** of FIFO accounting logic
- Tests charge/discharge entry creation
- Covers cost calculation with mixed solar/grid energy
- Tests proportional discharge tracking

### time-scheduling-core.js
- **Full coverage** of time/interval calculations
- Tests interval-of-day calculations for 15 and 30-minute intervals
- Covers price lookup with date matching
- Tests filtering and sorting of intervals
- Covers consecutive interval grouping
- Tests date comparison and formatting utilities

## Test Scenarios

### Unit Tests - Heuristic Strategy (14 tests)

#### `getPercentile()`
- ✅ Calculates 50th percentile (median) correctly
- ✅ Calculates 70th percentile correctly
- ✅ Handles empty array
- ✅ Handles single value

#### `forecastEnergyDemand()`
- ✅ Returns 0 for empty intervals
- ✅ Uses default 3kW when no history available
- ✅ Uses historical data when available
- ✅ Handles malformed history data gracefully
- ✅ Handles missing intervalOfDay

#### `computeHeuristicStrategy()`
- ✅ Charges during cheap hours and discharges during expensive hours
- ✅ Does not charge when battery is already at target SoC
- ✅ Respects minimum profit threshold
- ✅ Handles flat price profile (no optimization needed)
- ✅ Prioritizes highest price differences for maximum savings
- ✅ Respects battery capacity limits

### Unit Tests - LP Solver Strategy (16 tests)

#### `optimizeStrategyWithLp()`
- ✅ Returns null when LP solver not provided
- ✅ Returns null for empty price data
- ✅ Validates battery parameters (capacity, charge power)
- ✅ Validates SoC values (must be 0-1 range)
- ✅ Handles LP solver throwing error
- ✅ Handles LP solver returning invalid solution
- ✅ Successfully optimizes with valid LP solution
- ✅ Filters out intervals below threshold (0.01 kWh)
- ✅ Returns null when battery at target and empty
- ✅ Calls logger when provided

### Error Handling & Edge Cases

- ✅ Handles missing history gracefully
- ✅ Handles malformed history data (null/undefined)
- ✅ Handles missing intervalOfDay in price data
- ✅ Handles extreme efficiency loss (50%)
- ✅ Handles very small battery (1 kWh)
- ✅ Handles large number of intervals (96 intervals/day)

### Unit Tests - Strategy Execution (32 tests)

#### `findCurrentIntervalIndex()`
- ✅ Finds correct interval index in price cache
- ✅ Returns -1 if time is before first interval
- ✅ Returns -1 if time is after last interval
- ✅ Handles exact interval boundaries correctly

#### `hasModeChanged()`
- ✅ Returns true when mode changes
- ✅ Returns false when mode stays the same
- ✅ Returns false when lastMode is null

#### `decideBatteryMode()` - Input Validation
- ✅ Returns IDLE for invalid timestamp
- ✅ Returns IDLE for missing price cache
- ✅ Returns IDLE for empty price cache
- ✅ Returns IDLE for missing strategy
- ✅ Returns IDLE when current time not in any interval

#### `decideBatteryMode()` - Charge Decisions
- ✅ Decides CHARGE mode for planned charge intervals
- ✅ Prioritizes charge over discharge (if overlap)

#### `decideBatteryMode()` - Discharge Decisions
- ✅ Decides DISCHARGE mode for planned discharge intervals

#### `decideBatteryMode()` - Normal Mode Decisions
- ✅ Decides NORMAL_SOLAR for solar excess (< -300W)
- ✅ Decides NORMAL_HOLD for grid consumption (> 300W)
- ✅ Maintains lastMode in neutral zone (prevents oscillation)
- ✅ Defaults to NORMAL_HOLD when no lastMode
- ✅ Does not maintain non-normal modes (CHARGE/DISCHARGE)

#### `decideBatteryMode()` - Custom Thresholds
- ✅ Respects custom solar threshold
- ✅ Respects custom consumption threshold

#### `decideBatteryMode()` - Edge Cases
- ✅ Handles missing chargeIntervals in strategy
- ✅ Handles missing dischargeIntervals in strategy
- ✅ Handles undefined gridPower (defaults to 0)
- ✅ Handles 30-minute intervals
- ✅ Handles large interval counts (96 intervals)

#### `decideBatteryMode()` - Real-World Scenarios
- ✅ Typical morning charging scenario (02:00-03:00)
- ✅ Typical evening discharge scenario (18:00-19:00)
- ✅ Midday solar production handling
- ✅ Prevents oscillation during grid power fluctuations

### Unit Tests - Battery Cost Tracking (31 tests)

#### `createChargeEntry()`
- ✅ Creates charge entry with solar and grid split
- ✅ Handles all energy from solar
- ✅ Handles all energy from grid
- ✅ Uses default values for optional parameters

#### `createDischargeEntry()`
- ✅ Creates discharge entry with negative totalKWh
- ✅ Handles positive dischargedKWh and makes it negative
- ✅ Uses default values for optional parameters

#### `shouldClearChargeLog()`
- ✅ Returns true when SoC at or below threshold with entries
- ✅ Returns false when SoC above threshold
- ✅ Returns false when log is empty
- ✅ Handles different thresholds

#### `trimChargeLog()`
- ✅ Trims log to max entries
- ✅ Does not trim if log is smaller than max
- ✅ Handles empty log
- ✅ Handles null/undefined log
- ✅ Handles exact size match

#### `calculateDischargeProfit()`
- ✅ Calculates profit for profitable discharge
- ✅ Calculates loss for unprofitable discharge
- ✅ Handles zero discharge
- ✅ Handles negative values
- ✅ Handles break-even scenario

#### `calculateBatteryEnergyCost()`
- ✅ Returns null for empty log
- ✅ Calculates cost for simple charge from grid
- ✅ Calculates cost for simple charge from solar
- ✅ Calculates cost for mixed solar and grid charge
- ✅ Handles charge and discharge sequence
- ✅ Handles multiple charges at different prices
- ✅ Returns null when battery is effectively empty
- ✅ Handles complex charge/discharge sequences
- ✅ Handles edge case of very small remaining energy
- ✅ Calls logger when provided
- ✅ Handles proportional discharge correctly

## Architecture Benefits

### Separation of Concerns

1. **optimizer-core.js**: Pure optimization algorithms
   - No Homey dependencies
   - Fully testable with unit tests
   - Can be reused in other contexts

2. **strategy-execution-core.js**: Pure decision logic
   - No device I/O
   - No side effects
   - Deterministic behavior
   - Easy to test all edge cases

3. **battery-cost-core.js**: Pure cost tracking logic (NEW)
   - FIFO (First In, First Out) accounting
   - Tracks solar vs grid energy composition
   - Calculates weighted average costs
   - Proportional discharge tracking
   - No device dependencies

4. **device.js**: Homey integration layer
   - Orchestrates pure functions
   - Handles device I/O
   - Manages state and timing
   - Uses pure functions for all logic

### Testing Strategy

- **Unit tests** for all pure functions (optimizer-core, strategy-execution-core, battery-cost-core)
- **Edge case coverage** for error handling and boundary conditions
- **Real-world scenarios** to validate practical behavior
- **Manual CLI simulator** for integration testing

### Why This Approach?

1. **Testability**: Pure functions are easy to test without mocking
2. **Reliability**: High test coverage catches regressions early
3. **Maintainability**: Clear separation makes changes safer
4. **Debuggability**: Each layer can be tested independently
5. **Reusability**: Pure logic can be used in other contexts
6. **FIFO Accounting**: Battery cost tracking maintains accurate solar/grid composition

## Manual Testing with Simulator

The CLI simulator provides interactive testing with different scenarios:

```bash
node tools/simulate-optimizer.js
```

### Scenarios Included

1. **Clear Day/Night Pattern**: Tests optimization with distinct cheap/expensive periods
2. **Flat Prices**: Tests behavior when prices are uniform (no optimization opportunity)
3. **Battery Already Full**: Tests discharge-only strategy

### Example Output

```
=== SCENARIO 1: Clear Day/Night Pattern ===

Charge intervals: 5
Discharge intervals: 11
Total charge needed: 6.43 kWh
Total discharge forecast: 8.25 kWh
Estimated savings: €0.99
```

## Test Data Structure

Tests use realistic data structures matching the Homey device interface:

```javascript
const indexedData = [
  { 
    index: 0, 
    startsAt: '2025-01-01T00:00:00Z', 
    total: 0.10,  // Price in €/kWh
    intervalOfDay: 0 
  },
  // ... more intervals
];

const params = {
  batteryCapacity: 10,      // kWh
  currentSoc: 0.2,          // 20%
  targetSoc: 0.8,           // 80%
  chargePowerKW: 5,
  intervalHours: 0.25,
  efficiencyLoss: 0.1,
  expensivePriceFactor: 1.05,
  minProfitEurPerKWh: 0.08,
};

const history = {
  productionHistory: {},    // Solar production by interval
  consumptionHistory: {},   // Grid consumption by interval
  batteryHistory: {},       // Battery power by interval
};
```

## Benefits of This Architecture

1. **Pure Functions**: Core logic has no I/O dependencies, making it easy to test
2. **Fast Tests**: Run in ~650ms without needing Homey SDK or actual devices
3. **Comprehensive Coverage**: 30 test cases covering both strategies, edge cases, and realistic scenarios
4. **Dual Optimization Support**: Both heuristic and LP solver strategies are tested
5. **Error Resilience**: Robust handling of malformed data, missing parameters, and solver failures
6. **Continuous Testing**: Watch mode enables TDD workflow
7. **Regression Protection**: Tests catch bugs when making changes
8. **Documentation**: Tests serve as executable documentation of expected behavior

## Integration with Homey Device

The pure functions are imported and used in `device.js`:

```javascript
const { computeHeuristicStrategy, optimizeStrategyWithLp } = require('./optimizer-core');

// Try LP optimization first
const lpResult = optimizeStrategyWithLp(
  indexedData,
  { batteryCapacity, currentSoc, targetSoc, chargePowerKW, intervalHours, efficiencyLoss },
  { productionHistory, consumptionHistory, batteryHistory },
  { lpSolver, logger: this }
);

// Fallback to heuristic if LP fails
if (!lpResult) {
  const strategy = computeHeuristicStrategy(
    indexedData,
    params,
    history,
    { logger: this }
  );
}
```

### Unit Tests - Time Scheduling (55 tests)

#### `getIntervalOfDay()`
- ✅ Calculates correct interval for midnight (interval 0)
- ✅ Calculates correct interval for 15 minutes (interval 1)
- ✅ Calculates correct interval for noon (interval 48)
- ✅ Calculates correct interval for 23:45 (interval 95)
- ✅ Handles 30-minute intervals
- ✅ Returns -1 for invalid date

#### `getPriceAtTime()`
- ✅ Finds price for exact timestamp match
- ✅ Finds price for time within interval
- ✅ Returns null for time not in cache
- ✅ Returns null for empty cache
- ✅ Returns null for invalid inputs
- ✅ Handles different days correctly

#### `filterFutureIntervals()` / `filterCurrentAndFutureIntervals()`
- ✅ Filters to only future intervals
- ✅ Returns all intervals if all are in future
- ✅ Returns empty array if all intervals are past
- ✅ Includes current interval (started but not ended)
- ✅ Results are sorted by start time
- ✅ Handles different interval durations (15min, 30min)
- ✅ Returns empty array for invalid input

#### `enrichPriceData()`
- ✅ Adds index and intervalOfDay to each entry
- ✅ Preserves original data fields
- ✅ Handles empty array
- ✅ Handles invalid input

#### `groupConsecutiveIntervals()`
- ✅ Groups consecutive intervals into one block
- ✅ Splits non-consecutive intervals into separate blocks
- ✅ Sets start and end times correctly
- ✅ Calculates duration in minutes
- ✅ Handles single interval
- ✅ Returns empty array for empty input

#### `formatTime()` / `formatDateTime()`
- ✅ Formats time as HH:MM
- ✅ Pads single digits with zero
- ✅ Handles midnight
- ✅ Formats date and time together
- ✅ Returns 'Invalid Date' for invalid input

#### `isToday()` / `isTomorrow()` / `isSameDay()`
- ✅ Returns true for today/tomorrow correctly
- ✅ Returns false for other days
- ✅ Handles date comparisons accurately
- ✅ Returns false for invalid dates

#### `getNextIntervalStart()`
- ✅ Returns next future interval start time
- ✅ Returns null if no future intervals
- ✅ Returns null for empty array
- ✅ Handles unsorted intervals

#### `intervalMinutesToHours()` / `intervalsPerDay()`
- ✅ Converts 15 minutes to 0.25 hours
- ✅ Converts 30 minutes to 0.5 hours
- ✅ Converts 60 minutes to 1 hour
- ✅ Calculates 96 intervals per day for 15-minute intervals
- ✅ Calculates 48 intervals per day for 30-minute intervals
- ✅ Calculates 24 intervals per day for 60-minute intervals

## Integration Tests (11 tests) ✨

Integration tests verify that the extracted modules work together correctly without requiring a full Homey environment. They test real-world workflows and data flow between modules.

### Full Optimization Flow (2 tests)
- ✅ Complete cycle: price data → enrichment → filtering → forecasting → optimization → battery mode decision
- ✅ Optimization with solar forecast integration
- ✅ Verifies data flows correctly through all modules
- ✅ Tests that enriched data contains required fields (index, intervalOfDay)
- ✅ Validates battery mode decisions match strategy

### Battery Cost Tracking Integration (2 tests)
- ✅ Tracks costs through complete charge/discharge cycle
- ✅ Calculates average battery cost correctly
- ✅ Computes discharge profit accurately
- ✅ Handles mixed solar/grid charging with proper cost weighting

### Time-Based Decision Making (2 tests)
- ✅ Makes correct decisions based on time of day and price
- ✅ Charges during low-price periods (night)
- ✅ Discharges during high-price periods (evening)
- ✅ Respects battery SoC limits (no charge at max SoC)
- ✅ Integrates time-scheduling-core with strategy-execution-core

### Price Lookup and Interval Matching (1 test)
- ✅ Matches prices across time intervals correctly
- ✅ Groups consecutive intervals properly
- ✅ Formats time displays accurately

### Error Handling and Edge Cases (3 tests)
- ✅ Handles empty price data gracefully
- ✅ Works with missing optimization strategy
- ✅ Handles extreme battery states (empty/minimal charge)

### Real-World Scenario Simulation (1 test)
- ✅ Simulates complete 24-hour cycle
- ✅ Realistic price curves (low at night, high in evening)
- ✅ Solar production curve (0-6kW throughout day)
- ✅ Validates optimization runs at different times of day
- ✅ Tests night charging and evening discharging strategies

### Integration Test Benefits
- **End-to-end validation**: Ensures modules integrate correctly
- **Real-world scenarios**: Tests actual usage patterns
- **Regression prevention**: Catches breaking changes between modules
- **Fast execution**: No Homey SDK required (~1 second total)
- **Confidence**: Validates complete system behavior

## Settings UI Data Processing Tests (25 tests) ✨

Tests for the settings page (`settings/index.html`) that verify data processing and rendering logic works correctly. These tests validate the data transformations that happen in the browser without requiring a full DOM environment.

### Device Status Rendering (3 tests)
- ✅ Formats device status, next charge time, enabled state correctly
- ✅ Handles missing capabilities gracefully (defaults to 'Unknown', '-', false, 0)
- ✅ Identifies charging state from status text

### Statistics Rendering (2 tests)
- ✅ Formats savings, charge intervals, expensive intervals, avg price, needed kWh
- ✅ Handles missing strategy data (shows 0 or '-')

### Price Chart Data Processing (5 tests)
- ✅ Calculates price range (min, max, range) correctly
- ✅ Normalizes bar heights to 20-100% range
- ✅ Calculates average price line position
- ✅ Classifies bars correctly (charging, cheap, expensive, normal)
- ✅ Handles empty price cache gracefully

### Timeline Data Processing (4 tests)
- ✅ Formats charge intervals with energy and cost calculations
- ✅ Formats time (HH:MM) and date (DD Mon) correctly
- ✅ Calculates discharge savings (grid cost - battery cost)
- ✅ Handles missing timeline data

### Battery Status Display (3 tests)
- ✅ Formats battery SoC, target SoC, available capacity
- ✅ Formats energy cost breakdown (solar %, grid %, avg price)
- ✅ Detects when battery is at target (full)
- ✅ Shows planned charge price when no historical data available

### Device List Rendering (2 tests)
- ✅ Filters energy-optimizer devices from all devices
- ✅ Handles no devices found scenario

### Data Integration Flow (3 tests)
- ✅ Processes complete device data correctly (full API response)
- ✅ Handles partial data gracefully (missing fields)
- ✅ Calculates all statistics from complete data

### Error Handling (3 tests)
- ✅ Handles API errors gracefully
- ✅ Handles malformed data (null, undefined, wrong types)
- ✅ Handles missing timestamps

### Settings UI Test Benefits
- **UI reliability**: Ensures data displays correctly
- **Data validation**: Verifies transformations and calculations
- **Error handling**: Tests defensive programming
- **No browser required**: Pure JavaScript logic tests
- **Fast feedback**: <1 second execution time

## Future Improvements

- [x] Add tests for LP solver fallback logic
- [x] Test error handling and edge cases
- [x] Add comprehensive time/interval logic tests
- [x] Add lightweight integration tests
- [ ] Performance benchmarking tests
- [ ] Add snapshot testing for complex strategies

## CI/CD Integration

To integrate with CI/CD pipelines:

```yaml
# Example GitHub Actions workflow
- name: Run tests
  run: npm test
  
- name: Check coverage
  run: npm run test:coverage
```

## Troubleshooting

### Tests Failing

1. Check that all dependencies are installed: `npm install`
2. Verify Node.js version: `node --version` (should be 16+)
3. Clear Jest cache: `npx jest --clearCache`

### Coverage Too Low

- The coverage threshold is set to 50% in `jest.config.json`
- Focus is on `drivers/**/*.js` and `lib/**/*.js`
- Adjust thresholds if needed for different modules

## References

- Jest Documentation: https://jestjs.io/
- Homey SDK: https://apps.developer.homey.app/
- JavaScript Testing Best Practices: https://github.com/goldbergyoni/javascript-testing-best-practices
