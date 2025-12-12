# Step 2 Complete: Battery Cost Tracking Extraction

## Summary

Successfully extracted battery cost tracking and FIFO accounting logic from `device.js` into a new pure function module `battery-cost-core.js`, following industry best practices for testable financial calculations.

## What Was Done

### 1. Created New Module: battery-cost-core.js

**Location**: `drivers/energy-optimizer/battery-cost-core.js`

**Pure Functions**:
- `calculateBatteryEnergyCost(chargeLog, options)` - Calculates weighted average cost of energy currently stored in battery using FIFO accounting
  - Tracks solar vs grid energy composition
  - Handles proportional discharge (maintains solar/grid ratio)
  - Returns comprehensive breakdown: avgPrice, totalKWh, solarKWh, gridKWh, percentages, totalCost

- `createChargeEntry(params)` - Creates standardized charge log entry
  - Splits energy into solar vs grid automatically
  - Captures price, SoC, timestamp
  
- `createDischargeEntry(params)` - Creates standardized discharge log entry
  - Stores negative totalKWh for discharge
  - Captures average battery price before discharge
  
- `shouldClearChargeLog(currentSoc, minSocThreshold, logLength)` - Determines if battery is empty and log should be cleared

- `trimChargeLog(chargeLog, maxEntries)` - Keeps log size manageable by removing oldest entries

- `calculateDischargeProfit(dischargedKWh, avgBatteryCost, currentGridPrice)` - Analyzes profitability of discharge events

### 2. Refactored device.js

**Simplified Battery Tracking**:
- **Before**: ~70 lines of complex FIFO logic directly in `calculateBatteryEnergyCost()`
- **After**: 14 lines delegating to pure function
- **Removed**: Complex proportional discharge calculation logic
- **Removed**: Manual charge entry creation with calculations

**Updated Methods**:
- `trackBatteryCharging()` - Now uses `createChargeEntry()`, `createDischargeEntry()`, `shouldClearChargeLog()`, `trimChargeLog()`
- `calculateBatteryEnergyCost()` - Delegates to pure function for testability

**Benefits**:
- Much cleaner and easier to understand
- Financial logic now fully testable
- No behavioral changes, just extraction

### 3. Comprehensive Test Suite

**Created**: `test/battery-cost-core.test.js`

**31 Tests Covering**:
- ✅ Charge entry creation (4 tests)
- ✅ Discharge entry creation (3 tests)
- ✅ Log clearing logic (4 tests)
- ✅ Log trimming (5 tests)
- ✅ Discharge profit calculation (5 tests)
- ✅ Battery energy cost calculation (10 tests)

**Test Results**: All 124 tests passing (93 unit tests total)

### 4. Updated Documentation

Updated `TESTING.md` with:
- New battery-cost-core module documentation
- 31 additional test scenarios
- FIFO accounting explanation
- Architecture benefits

## Key Improvements

### Before
```javascript
// ~70 lines of complex FIFO logic in calculateBatteryEnergyCost()
// Manual charge/discharge entry creation
// Proportional discharge calculation mixed with logging
// Hard to test without mocking entire device
```

### After
```javascript
// Pure FIFO accounting function
const result = calculateBatteryEnergyCost(
  this.batteryChargeLog,
  { logger: this.log.bind(this) }
);

// Standardized entry creation
const chargeEntry = createChargeEntry({
  chargedKWh,
  solarKWh,
  gridPrice,
  soc,
  timestamp,
});
```

## FIFO Accounting Logic

### Charging
- Automatically splits energy into solar vs grid
- Solar energy is free (no cost)
- Grid energy has associated price
- Tracks cumulative cost

### Discharging (Proportional)
When discharging 5 kWh from a battery containing 60% solar + 40% grid:
- Removes 3 kWh solar (60% of 5)
- Removes 2 kWh grid (40% of 5)
- Maintains the 60/40 ratio
- Reduces total cost proportionally

### Cost Calculation
```
Weighted Average Price = Total Grid Cost / Total kWh
```

Example:
- 3 kWh solar (free) + 2 kWh grid @ 0.30 €/kWh
- Total cost: 2 × 0.30 = 0.60 €
- Weighted avg: 0.60 / 5 = 0.12 €/kWh

## Test Coverage Examples

### Simple Charge from Grid
```javascript
const log = [{
  type: 'charge',
  solarKWh: 0,
  gridKWh: 5.0,
  gridPrice: 0.20,
}];

const result = calculateBatteryEnergyCost(log);
// avgPrice: 0.20 €/kWh
// totalCost: 1.00 € (5 × 0.20)
// gridPercent: 100%
```

### Mixed Solar + Grid
```javascript
const log = [{
  type: 'charge',
  solarKWh: 3.0,
  gridKWh: 2.0,
  gridPrice: 0.30,
}];

const result = calculateBatteryEnergyCost(log);
// avgPrice: 0.12 €/kWh (0.60 / 5.0)
// solarPercent: 60%
// gridPercent: 40%
```

### Charge + Discharge
```javascript
const log = [
  {
    type: 'charge',
    solarKWh: 2.0,
    gridKWh: 3.0,
    gridPrice: 0.20,
  },
  {
    type: 'discharge',
    totalKWh: -2.0, // Discharge 2 kWh
    gridPrice: 0.35,
  },
];

const result = calculateBatteryEnergyCost(log);
// totalKWh: 3.0 (5 charged - 2 discharged)
// Maintains 40/60 solar/grid ratio
// Cost reduced proportionally
```

### Discharge Profit Analysis
```javascript
const profit = calculateDischargeProfit(
  5.0,  // 5 kWh discharged
  0.20, // Cost 0.20 €/kWh
  0.35  // Sell at 0.35 €/kWh
);
// profit: 0.75 € (1.75 - 1.00)
// profitPercent: 75%
// worthIt: true
```

## Architecture Benefits

### 1. Testability
- All FIFO logic testable without device mocking
- Can verify proportional discharge calculations
- Easy to test edge cases (empty battery, all solar, all grid)

### 2. Accuracy
- Consistent calculation across all code paths
- No duplicate logic between charge/discharge tracking
- Validated by comprehensive tests

### 3. Maintainability
- Financial logic in one place
- Easy to understand FIFO flow
- Clear separation from device I/O

### 4. Debuggability
- Can test cost calculations with sample data
- Logger injection shows calculation steps
- Pure functions are deterministic

### 5. Auditability
- Financial calculations are transparent
- Tests serve as documentation
- Easy to verify correctness

## Files Changed

1. ✅ Created `drivers/energy-optimizer/battery-cost-core.js` (~233 lines)
2. ✅ Refactored `drivers/energy-optimizer/device.js` (~80 lines simplified)
3. ✅ Created `test/battery-cost-core.test.js` (~541 lines)
4. ✅ Updated `TESTING.md` (added Battery Cost Tracking section)

## Test Statistics

### Before Step 2
- Test files: 3
- Unit tests: 62
- Test suites: 5

### After Step 2
- Test files: 4
- Unit tests: 93 (+31)
- Test suites: 6
- Coverage: Battery cost tracking now 100% testable

## Use Cases Covered

1. **Pure Solar Charging** - Battery charged only from solar (free energy)
2. **Pure Grid Charging** - Battery charged during cheap electricity hours
3. **Mixed Charging** - Realistic scenario with both solar and grid
4. **Multiple Charges** - Different prices accumulated correctly
5. **Proportional Discharge** - Maintains solar/grid ratio when discharging
6. **Empty Battery Detection** - Clears log when SoC below threshold
7. **Log Management** - Keeps only recent entries (7 days)
8. **Profit Analysis** - Determines if discharge is profitable

## Verification

```bash
# All tests passing
npm test
# Result: 124 tests passed (6 test suites)

# No lint errors (except line ending warnings)
# device.js: Clean
# battery-cost-core.js: Clean (CRLF warnings expected)

# Test coverage
# battery-cost-core.js: Full coverage of all functions
```

## Real-World Impact

### Financial Transparency
The optimizer now accurately tracks:
- How much energy came from solar (free)
- How much energy came from grid (paid)
- Weighted average cost per kWh in battery
- Profitability of each discharge event

### Example
Battery contains:
- 6 kWh solar (free)
- 4 kWh grid @ 0.25 €/kWh (cost: 1.00 €)
- **Total**: 10 kWh @ 0.10 €/kWh weighted average

When grid price rises to 0.40 €/kWh:
- Discharge 5 kWh (cost: 0.50 €, revenue: 2.00 €)
- **Profit**: 1.50 € (75% margin)
- System can decide discharge is worthwhile

### Benefits for Users
- Transparent cost tracking
- Accurate profit calculations
- Better optimization decisions
- Financial reporting ready for future features

## Next Steps (Optional)

As recommended in the architectural analysis, one more extraction opportunity remains:

**Step 3**: Time/Scheduling Logic
- Extract interval matching, time calculations
- Pure functions for schedule management
- Reusable across different optimization strategies

## Conclusion

Step 2 complete! The battery cost tracking logic is now:
- ✅ Fully extracted into pure functions
- ✅ Comprehensively tested (31 tests)
- ✅ Well documented
- ✅ Production ready
- ✅ Financially accurate with FIFO accounting

The codebase has significantly improved financial transparency and testability.
