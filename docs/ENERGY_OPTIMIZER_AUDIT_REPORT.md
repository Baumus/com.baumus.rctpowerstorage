# Energy Optimizer Audit Report

Status: verified against repo-only code paths on 2026-04-29.

## Verified Findings

### 1. High: Strategy invalidation missed real input changes
- Root cause: `getStrategyInputHash()` in `drivers/energy-optimizer/services/strategy-calculation.js` only tracked price-cache length, rounded SoC, and a few normalized settings.
- User impact: the optimizer could keep an outdated plan after quarter-hour rollover, changed spot prices with unchanged array length, or changed forecast/history inputs.
- Evidence:
  - Repro tests added in `test/device-resource-optimization.test.js` for unchanged length with changed prices and for quarter-hour bucket advancement.
  - The old hash shape did not include price values or histories.
- Fix status: fixed.
- Validation: `npm test -- device-resource-optimization.test.js`

### 2. Medium-High: Unknown battery cost estimation could overstate planned charge price
- Root cause: `drivers/energy-optimizer/services/battery-cost.js` estimated unknown stored-energy cost from raw `chargeIntervals[].total` averages instead of the backend-computed `plannedCharging` economics.
- User impact: mixed grid/solar planned charging could be shown and reused with a misleadingly high estimated battery price, especially when cheap solar charging dominated but spot prices of the same intervals were higher.
- Evidence:
  - New regression in `test/device-resource-optimization.test.js` proves the fallback now prefers `plannedCharging.avgPriceEurPerKWh`.
  - Existing UI semantics already relied on `plannedCharging`, so the old fallback was inconsistent with the rest of the data model.
- Fix status: fixed.
- Validation: `npm test -- device-resource-optimization.test.js`

### 3. Medium: Settings UI lost discharge plans on partial strategy objects
- Root cause: `settings/index.html` treated `strategy.dischargeIntervals || strategy.expensiveIntervals` as a plain `||` fallback. Empty arrays are truthy, so a present-but-empty `dischargeIntervals` suppressed populated `expensiveIntervals`.
- User impact: the chart/stats/timeline could hide expensive periods or discharge recommendations although backend data existed.
- Evidence:
  - New rendering regressions in `test/settings-rendering.test.js` cover both alias directions.
  - The same aliasing bug existed in multiple render helpers.
- Fix status: fixed.
- Validation: `npm test -- settings-rendering.test.js`

### 4. Medium-Low: Battery-only strategy states were rendered as "no optimization plan"
- Root cause: `renderTimeline()` required charge or discharge interval arrays and did not treat `batteryStatus` as sufficient state.
- User impact: valid battery status data could disappear from the settings page during no-op or partial-strategy states.
- Evidence:
  - Added rendering regression in `test/settings-rendering.test.js`.
- Fix status: fixed.
- Validation: `npm test -- settings-rendering.test.js`

### 5. Low: Battery cost core comments claimed FIFO while code used proportional accounting
- Root cause: stale documentation in `drivers/energy-optimizer/battery-cost-core.js`.
- User impact: developer confusion and wrong audit assumptions, not a runtime defect.
- Evidence:
  - Implementation and tests in `test/battery-cost-core.test.js` clearly model proportional discharge.
- Fix status: fixed.
- Validation: `npm test -- battery-cost-core.test.js`

## Scenario Verification

The manual simulator `tools/simulate-optimizer.js` was extended with deterministic audit scenarios:

- Clear day/night arbitrage
- Flat prices with empty battery -> verified no-op
- Full battery at target -> verified discharge-only behavior can still be rational
- Tiny spread below profit floor with empty battery -> verified no-op
- Solar-dominated midday with evening demand -> verified `☀️` charge display entries and solar-only planned charging average

Validation command:

```powershell
node tools/simulate-optimizer.js
```

## Fix Order

1. Recalc invalidation and stale-plan prevention
2. Charge-cost semantics used for unknown stored energy
3. Settings UI fallback correctness for discharge/expensive intervals
4. Battery-only rendering correctness
5. Comment/documentation alignment

## Commit And PR Steps

Suggested commit sequence:

1. `fix(optimizer): strengthen strategy invalidation inputs`
  - `drivers/energy-optimizer/services/strategy-calculation.js`
  - `test/device-resource-optimization.test.js`
2. `fix(battery-cost): use planned charging economics for unknown energy`
  - `drivers/energy-optimizer/services/battery-cost.js`
  - `test/device-resource-optimization.test.js`
3. `fix(settings): preserve discharge aliases and normalize display timezone`
  - `settings/index.html`
  - `test/settings-rendering.test.js`
4. `test(simulator): add deterministic optimizer audit scenarios`
  - `tools/simulate-optimizer.js`
  - `test/optimizer-lp.test.js`
5. `docs(audit): publish verified findings and residual risks`
  - `docs/ENERGY_OPTIMIZER_AUDIT_REPORT.md`
  - `drivers/energy-optimizer/battery-cost-core.js`

Suggested PR structure:

1. Problem statement
  - stale strategies, misleading battery-cost fallback, and partial-strategy UI rendering produced inconsistent optimizer behavior and settings output
2. Scope
  - optimizer invalidation, battery-cost semantics, settings rendering fallbacks, settings timezone normalization, deterministic simulator coverage, audit documentation
3. Validation
  - `npm test -- optimizer-lp.test.js optimizer-core.test.js settings-rendering.test.js strategy-execution-core.test.js device-resource-optimization.test.js battery-cost-core.test.js`
  - `node tools/simulate-optimizer.js`
4. Reviewer focus
  - confirm the strategy hash dimensions are sufficient without causing noisy recalculation
  - confirm `Europe/Berlin` is the intended UI timezone contract for settings rendering
  - confirm `plannedCharging` is the authoritative charge-cost source for unknown stored energy

## Remaining Risks

- No new repo-only defect was verified in the LP core after the focused audit pass; current residual risk is mostly in unmodeled runtime inputs outside this repo-only environment.
- Timezone and locale behavior is now normalized to `Europe/Berlin` in settings rendering, but live Homey/browser verification is still useful for end-to-end confidence.
- The simulator now covers representative edge cases, but it is still a manual diagnostic tool, not an assertion-based regression harness.

## Validation Summary

Executed successfully:

```powershell
npm test -- optimizer-lp.test.js optimizer-core.test.js settings-rendering.test.js strategy-execution-core.test.js device-resource-optimization.test.js battery-cost-core.test.js
node tools/simulate-optimizer.js
```