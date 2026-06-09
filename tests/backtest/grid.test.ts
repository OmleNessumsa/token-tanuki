/**
 * Grid expansion invariants.
 *
 * From ARCHITECTURE.md §grid.ts:
 *   - `expandGrid(spec).length === product of array lengths`.
 *   - `configId(cfg)` produces a stable hash that is unique across the expansion.
 *   - Ordering is deterministic — lexicographic order of `Object.keys(spec)`.
 *   - `BacktestConfigV2 extends BacktestConfig` (so configs are runnable).
 */

import { describe, expect, it } from "vitest";
import {
  expandGrid,
  configId,
  type GridSpec,
  type BacktestConfigV2,
} from "../../src/backtest/grid.js";

function smallSpec(): GridSpec {
  return {
    thresholdComposite: [60, 70],
    requireStage2: [true, false],
    stopAtrMult: [1.5, 2.5],
    horizonBars: [36, 144],
    cooldownBars: [72],
    side: ["LONG", "SHORT"],
    fixed: {
      warmupBars: 200,
      stage2SmaPeriod: 150,
      requireBreakout: false,
    },
  };
}

function microSpec(): GridSpec {
  return {
    thresholdComposite: [60],
    requireStage2: [true],
    stopAtrMult: [2],
    horizonBars: [12],
    cooldownBars: [12],
    side: ["LONG"],
    fixed: {
      warmupBars: 200,
      stage2SmaPeriod: 150,
      requireBreakout: false,
    },
  };
}

describe("expandGrid — size", () => {
  it("returns Cartesian-product size for a multi-dim spec", () => {
    const spec = smallSpec();
    // 2 × 2 × 2 × 2 × 1 × 2 = 32
    const configs = expandGrid(spec);
    expect(configs.length).toBe(32);
  });

  it("returns 1 for a 1-cell spec", () => {
    const configs = expandGrid(microSpec());
    expect(configs.length).toBe(1);
  });

  it("size matches product across several spec shapes", () => {
    const cases: Array<{ spec: GridSpec; expected: number }> = [
      {
        spec: {
          thresholdComposite: [55, 60, 65, 70], // 4
          requireStage2: [true, false],          // 2
          stopAtrMult: [1.5, 2.0, 2.5],          // 3
          horizonBars: [36, 144],                // 2
          cooldownBars: [12, 72],                // 2
          side: ["LONG", "SHORT"],               // 2
          fixed: { warmupBars: 200, stage2SmaPeriod: 150, requireBreakout: false },
        },
        expected: 4 * 2 * 3 * 2 * 2 * 2, // 192
      },
      {
        spec: {
          thresholdComposite: [60, 70, 80],       // 3
          requireStage2: [false],                 // 1
          stopAtrMult: [2.0],                     // 1
          horizonBars: [36, 144],                 // 2
          cooldownBars: [12],                     // 1
          side: ["LONG"],                         // 1
          fixed: { warmupBars: 200, stage2SmaPeriod: 150, requireBreakout: false },
        },
        expected: 3 * 1 * 1 * 2 * 1 * 1, // 6
      },
    ];
    for (const { spec, expected } of cases) {
      expect(expandGrid(spec).length).toBe(expected);
    }
  });
});

describe("expandGrid — config uniqueness", () => {
  it("configId values are unique across the entire expansion", () => {
    const configs = expandGrid(smallSpec());
    const ids = configs.map((c) => configId(c));
    expect(new Set(ids).size).toBe(configs.length);
  });

  it("configId returns the same string for identical configs", () => {
    const configs = expandGrid(smallSpec());
    const a = configs[0]!;
    // Construct a structurally-identical copy and hash it.
    const aCopy: BacktestConfigV2 = { ...a };
    expect(configId(aCopy)).toBe(configId(a));
  });
});

describe("expandGrid — deterministic ordering", () => {
  it("identical specs produce byte-identical expansions across calls", () => {
    const a = expandGrid(smallSpec());
    const b = expandGrid(smallSpec());
    expect(b).toEqual(a);
  });

  it("expansion ordering is stable across many invocations", () => {
    const first = expandGrid(smallSpec());
    for (let i = 0; i < 5; i++) {
      const next = expandGrid(smallSpec());
      expect(next.map(configId)).toEqual(first.map(configId));
    }
  });
});

describe("expandGrid — fixed fields are present on every output", () => {
  it("every config carries the spec.fixed values verbatim", () => {
    const spec = smallSpec();
    const configs = expandGrid(spec);
    for (const cfg of configs) {
      expect(cfg.warmupBars).toBe(spec.fixed.warmupBars);
      expect(cfg.stage2SmaPeriod).toBe(spec.fixed.stage2SmaPeriod);
      expect(cfg.requireBreakout).toBe(spec.fixed.requireBreakout);
    }
  });

  it("every config carries a side that is one of the spec's side values", () => {
    const spec = smallSpec();
    const configs = expandGrid(spec);
    for (const cfg of configs) {
      expect(spec.side).toContain(cfg.side);
    }
  });
});

describe("expandGrid — key-insertion-order invariance", () => {
  it("two specs with the same content but different key insertion order produce the same expansion", () => {
    // From ARCHITECTURE.md: "ordering is the lexicographic order of Object.keys(spec) above".
    // Object literal key order shouldn't affect the output.
    const a: GridSpec = {
      thresholdComposite: [60, 70],
      requireStage2: [true, false],
      stopAtrMult: [1.5, 2.5],
      horizonBars: [36, 144],
      cooldownBars: [72],
      side: ["LONG", "SHORT"],
      fixed: { warmupBars: 200, stage2SmaPeriod: 150, requireBreakout: false },
    };
    // Same content, scrambled key insertion order:
    const b: GridSpec = {
      side: ["LONG", "SHORT"],
      cooldownBars: [72],
      stopAtrMult: [1.5, 2.5],
      horizonBars: [36, 144],
      thresholdComposite: [60, 70],
      requireStage2: [true, false],
      fixed: { requireBreakout: false, stage2SmaPeriod: 150, warmupBars: 200 },
    };
    const ea = expandGrid(a).map(configId);
    const eb = expandGrid(b).map(configId);
    expect(eb).toEqual(ea);
  });
});
