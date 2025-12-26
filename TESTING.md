\# Testing

This repo uses Jest to test the extracted (mostly pure) energy-optimizer logic and a small amount of settings-page JS.

## Quick Start

Prerequisite: Node.js `>=22.0.0` (see `package.json`).

```bash
npm install
npm test
```

Common commands:

```bash
# Run all tests
npm test

# Watch mode
npm run test:watch

# Coverage (writes to ./coverage)
npm run test:coverage

# Lint
npm run lint
```

## What Jest Runs (Important)

Jest is configured via `jest.config.json` with:

- `testEnvironment`: `node`
- `testMatch`: `**/test/**/*.test.js`

The repo contains a build mirror under `.homeybuild/`, but **Jest is configured to ignore `.homeybuild/` by default** to avoid running every test twice.

Relevant config:

- `testPathIgnorePatterns`: includes `/\.homeybuild/`

To see the authoritative list of executed test files:

```bash
npx jest --listTests
```

### Optional: Intentionally include `.homeybuild` tests

If you *want* to run the mirrored tests as well (not recommended for day-to-day work), remove `/\.homeybuild/` from `testPathIgnorePatterns` in `jest.config.json`.

## Test Layout

Source tests live in `test/`:

- `test/battery-cost-core.test.js`
- `test/device-battery-tracking.test.js`
- `test/device-resource-optimization.test.js`
- `test/device-stability-hardening.test.js`
- `test/device-tibber-retry.test.js`
- `test/integration.test.js`
- `test/optimizer-core.test.js`
- `test/optimizer-lp.test.js`
- `test/settings-rendering.test.js`
- `test/strategy-execution-core.test.js`
- `test/time-scheduling-core.test.js`

The same files exist under `.homeybuild/test/` and are executed as well (see “What Jest Runs”).

Note: `.homeybuild/test/**` exists for the Homey build mirror, but is **ignored by Jest by default**.

## Modules Under Test (High Level)

The energy-optimizer driver is structured around small, testable modules:

- `drivers/energy-optimizer/optimizer-core.js`: strategy generation using LP (LP-only; no heuristic fallback)
- `drivers/energy-optimizer/strategy-execution-core.js`: battery mode decision logic
- `drivers/energy-optimizer/battery-cost-core.js`: battery charge/discharge accounting (solar vs grid split)
- `drivers/energy-optimizer/time-scheduling-core.js`: interval/time helpers for price caches
- `drivers/energy-optimizer/constants.js`: shared constants for the energy-optimizer driver
- `drivers/energy-optimizer/device.js`: Homey integration/orchestration layer

## Coverage

Coverage is collected from:

- `drivers/**/*.js`
- `lib/**/*.js`

Excluding `node_modules` and any `test/**` folders.

Global coverage thresholds are configured in `jest.config.json` and currently set to **50%** for branches/functions/lines/statements.

Run coverage:

```bash
npm run test:coverage
```

Outputs:

- `coverage/` (HTML report under `coverage/lcov-report/`)

## Manual Testing

There is a lightweight simulator for ad-hoc experiments:

```bash
node tools/simulate-optimizer.js
```

## Troubleshooting

1) Install deps: `npm install`

2) Check Node version: `node --version` (must satisfy `>=22`)

3) Clear Jest cache:

```bash
npx jest --clearCache
```

## CI Example

```yaml
- name: Install
   run: npm ci

- name: Test
   run: npm test

- name: Coverage
   run: npm run test:coverage
```

## References

- Jest: https://jestjs.io/
- Homey Apps SDK: https://apps.developer.homey.app/

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

### Battery Status Updates (1 test) ✨
- ✅ Maintains energyCost data even when strategy intervals don't change
- ✅ Simulates battery charging 3 hours ago with cost tracking
- ✅ Verifies energyCost persists in strategy.batteryStatus
- ✅ Tests updateBatteryStatus() pattern (recalculate energyCost without new strategy)
- ✅ Validates UI would display current battery cost information
- ✅ **Fixes bug where energyCost wasn't updated between strategy calculations**

## Device Battery Tracking Tests (4 tests) ✨ NEW

Tests that verify critical bugs in battery charge/discharge tracking have been fixed.

### Bug 1: Missing Capability Support (1 test)
- ✅ Tracks battery power even when only `measure_power` exists (not `measure_power.battery`)
- ✅ Falls back to `battery_power` if neither above is available
- ✅ **Fixes: Battery tracking never ran because capability check was too restrictive**

### Bug 2: Nullish Coalescing for Meter Deltas (2 tests)
- ✅ Logs solar charge when previous meter readings are 0 and batteryPower is ~0
- ✅ Correctly calculates deltas when previous readings are 0 (using `??` not `||`)
- ✅ **Fixes: Delta calculation treated 0 as "no previous value", causing delta = 0**

### Bug 3: First Run Protection (1 test)
- ✅ Initializes lastMeterReading on first run to prevent false deltas
- ✅ Skips first sample to establish baseline
- ✅ **Fixes: Large false deltas after app restart/device addition**

### Bug Impact
These bugs caused:
- No battery charge/discharge tracking → empty `batteryChargeLog`
- No actual solar/grid split → always showed "Estimated" instead of "Actual"
- False charge entries after restart

### Integration Test Benefits
- **End-to-end validation**: Ensures modules integrate correctly
- **Real-world scenarios**: Tests actual usage patterns
- **Regression prevention**: Catches breaking changes between modules
- **Fast execution**: No Homey SDK required (~1 second total)
- **Confidence**: Validates complete system behavior

## Settings UI Data Processing Tests (29 tests) ✨

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

### Battery Status Display (5 tests) ✨
- ✅ Formats battery SoC, target SoC, available capacity
- ✅ Formats energy cost breakdown (solar %, grid %, avg price)
- ✅ Detects when battery is at target (full)
- ✅ Shows "No data yet" when energyCost is null
- ✅ **Shows estimated cost with warning when source unknown (isEstimated flag)**
- ✅ Shows planned charge price when no historical data available

### Device-to-UI Integration (2 tests)
- ✅ Uses battery-cost-core module result for displayed battery energy price
- ✅ Formats battery energy cost exactly as displayed in HTML (emojis, units, formatting)
- ✅ Verifies complete data flow: device module → strategy → API → HTML display

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

## Debugging Battery Cost Display Issues

If battery energy cost information is not showing in the settings page:

### Check Homey Logs

The device now logs detailed information when `calculateBatteryEnergyCost()` is called:

```
🔍 calculateBatteryEnergyCost called:
   batteryChargeLog length: 5
   ✅ Result: 4.500 kWh @ 0.1250 €/kWh
      Solar: 1.50 kWh (33%)
      Grid: 3.00 kWh (67%)
```

Or if no data:

```
🔍 calculateBatteryEnergyCost called:
   batteryChargeLog length: 0
   ⚠️ Result: null (no data or battery empty)
```

### Check Settings UI Debug Section

The settings page now includes a debug section showing:
- Whether `batteryStatus` exists
- Whether `energyCost` exists
- If available: `totalKWh` and `avgPrice` values
- If null: Warning message to check logs

### Common Issues

1. **batteryChargeLog is empty**
   - Battery hasn't charged from grid yet
   - App recently started/restarted
   - Check if `collectCurrentData()` runs every 15 minutes

2. **energyCost is null (netTotalKWh < 0.01)**
   - Battery effectively empty (< 10 Wh)
   - Normal when battery near minimum SoC

3. **No charging detected**
   - Check battery device connection
   - Verify battery device ID in settings
   - Check if battery power capability is readable

4. **After Homey restart**
   - batteryChargeLog restored from device store
   - Should persist across restarts
   - Check logs for "Battery charged:" entries

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
