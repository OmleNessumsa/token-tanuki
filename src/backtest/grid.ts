/**
 * Declarative grid expansion for the backtest harness v2.
 *
 * PURE module — no I/O, no clocks, no randomness. Expanding the same `GridSpec`
 * twice produces byte-identical `BacktestConfigV2[]` outputs in the same order.
 *
 * Companion docs:
 * - docs/BACKTEST_HARNESS_V2_PRD.md §5.3
 * - docs/BACKTEST_V2_ARCHITECTURE.md §grid.ts
 */

import type { BacktestConfig } from "../analysis/backtest.js";

export interface GridSpec {
  thresholdComposite: number[];
  requireStage2: boolean[];
  stopAtrMult: number[];
  horizonBars: number[];
  cooldownBars: number[];
  side: Array<"LONG" | "SHORT">;
  /** Shared across every cell. */
  fixed: Pick<BacktestConfig, "warmupBars" | "stage2SmaPeriod" | "requireBreakout">;
}

export interface BacktestConfigV2 extends BacktestConfig {
  side: "LONG" | "SHORT";
}

/**
 * Deterministic Cartesian expansion. Iteration order matches the key
 * declaration order in `GridSpec` above:
 *   thresholdComposite → requireStage2 → stopAtrMult → horizonBars
 *   → cooldownBars → side.
 *
 * The outermost dimension is `thresholdComposite` (slowest-moving in the
 * output array); the innermost is `side`. Tester-morty asserts this in
 * `tests/backtest/grid.test.ts`.
 */
export function expandGrid(spec: GridSpec): BacktestConfigV2[] {
  const out: BacktestConfigV2[] = [];
  for (const thresholdComposite of spec.thresholdComposite) {
    for (const requireStage2 of spec.requireStage2) {
      for (const stopAtrMult of spec.stopAtrMult) {
        for (const horizonBars of spec.horizonBars) {
          for (const cooldownBars of spec.cooldownBars) {
            for (const side of spec.side) {
              out.push({
                thresholdComposite,
                horizonBars,
                stopAtrMult,
                warmupBars: spec.fixed.warmupBars,
                cooldownBars,
                requireBreakout: spec.fixed.requireBreakout,
                requireStage2,
                stage2SmaPeriod: spec.fixed.stage2SmaPeriod,
                side,
              });
            }
          }
        }
      }
    }
  }
  return out;
}

/**
 * Stable identifier for a config. Used as a cache key for per-config fold
 * results and as a row identifier in the report.
 *
 * Format: `SIDE-c{thresholdComposite}-s2{T|F}-atr{stopAtrMult}-h{horizonBars}-cd{cooldownBars}`
 * Example: `LONG-c60-s2T-atr2.0-h36-cd12`.
 *
 * Note: `stopAtrMult` is rendered with `.toFixed(1)` so 2 and 2.0 collapse to
 * the same id — matches the architecture-doc example verbatim.
 */
export function configId(cfg: BacktestConfigV2): string {
  const s2 = cfg.requireStage2 ? "T" : "F";
  const atr = cfg.stopAtrMult.toFixed(1);
  return `${cfg.side}-c${cfg.thresholdComposite}-s2${s2}-atr${atr}-h${cfg.horizonBars}-cd${cfg.cooldownBars}`;
}
