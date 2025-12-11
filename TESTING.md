# Testing Infrastructure

This document describes the testing architecture for the RCT Power Storage Homey app.

## Overview

The energy optimization logic has been extracted into pure, testable functions and is now thoroughly tested with Jest. Both heuristic and LP solver optimization strategies are tested.

## Test Structure

### Test Files

- `test/optimizer-core.test.js` - Heuristic optimization algorithm tests
- `test/optimizer-lp.test.js` - LP solver optimization and error handling tests
- `tools/simulate-optimizer.js` - CLI simulator for manual testing

### Core Modules Tested

- `drivers/energy-optimizer/optimizer-core.js` - Pure optimization functions
  - `computeHeuristicStrategy()` - Heuristic optimization algorithm
  - `optimizeStrategyWithLp()` - Linear Programming optimization
  - `forecastEnergyDemand()` - Energy demand forecasting
  - `getPercentile()` - Statistical calculations

## Running Tests

```bash
# Run all tests
npm test

# Run tests in watch mode (auto-rerun on file changes)
npm run test:watch

# Run tests with coverage report
npm run test:coverage
```

## Test Coverage

Current coverage for `optimizer-core.js`:
- **Statements**: 89.78%
- **Branches**: 76.78%
- **Functions**: 91.3%
- **Lines**: 93.16%

## Test Scenarios

### Unit Tests - Heuristic Strategy

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

### Unit Tests - LP Solver Strategy

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

### Realistic Scenarios

- ✅ **Winter day with morning peak**: Simulates typical German winter day with morning/evening price peaks

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

## Future Improvements

- [x] Add tests for LP solver fallback logic
- [x] Test error handling and edge cases
- [ ] Add integration tests with mock Homey devices
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
