#!/usr/bin/env python3
"""Parse Bulkowski 'Encyclopedia of Candlestick Charts' for the master ranking
top-15 lists in chapter 2 — Statistics Summary. These are the most useful
empirical numbers in the book (overall rank + reversal/continuation rates)."""
import json
import re
from pathlib import Path

SRC = Path.home() / "code/cryptotrader/docs/source/text/bulkowski-candlestick-charts.txt"
OUT = Path.home() / "code/cryptotrader/src/data/bulkowski-candlestick.json"

# Section header → key in the output JSON
SECTIONS = {
    "Overall Rank": "overall_rank",
    "Reversals: Bull Market": "reversal_bull_pct",
    "Reversals: Bear Market": "reversal_bear_pct",
    "Continuations: Bull Market": "continuation_bull_pct",
    "Continuations: Bear Market": "continuation_bear_pct",
    "Performance after 10 Days: Bull Market/Up Breakouts": "perf_10d_bull_up_pct",
    "Performance after 10 Days: Bear Market/Up Breakouts": "perf_10d_bear_up_pct",
    "Performance after 10 Days: Bull Market/Down Breakouts": "perf_10d_bull_down_pct",
    "Performance after 10 Days: Bear Market/Down Breakouts": "perf_10d_bear_down_pct",
}

ENTRY_RE = re.compile(r"^\s*(\d+)\.\s+(.+?):\s+(-?\d+\.?\d*)%\s*$")

def main() -> int:
    text = SRC.read_text(encoding="utf-8", errors="replace")
    lines = text.split("\n")

    sections: dict[str, list[tuple[str, float]]] = {v: [] for v in SECTIONS.values()}
    current = None

    for line in lines:
        s = line.strip()
        # Detect a section header (with leniency for whitespace/punctuation)
        for header, key in SECTIONS.items():
            if s == header:
                current = key
                break
        else:
            if current:
                m = ENTRY_RE.match(line)
                if m:
                    rank, name, pct = int(m.group(1)), m.group(2).strip(), float(m.group(3))
                    sections[current].append((name, pct))
                # End of a top-15 list when rank reaches 15 (or we encounter blank lines later — handled by next header)
                # Stop accumulating after 15 entries
                if sections[current] and len(sections[current]) >= 15 and current not in [None]:
                    # Wait for next header
                    pass

    # Pivot: per-pattern aggregated metrics
    by_pattern: dict[str, dict] = {}
    for key, entries in sections.items():
        for name, val in entries:
            slot = by_pattern.setdefault(name, {"pattern": name, "metrics": {}})
            # If the pattern appears multiple times in same section (shouldn't), keep the first
            slot["metrics"].setdefault(key, val)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "source": "Bulkowski, Thomas N. — Encyclopedia of Candlestick Charts (Wiley, 2008)",
        "extracted_at": "2026-05-05",
        "note": "Per-section top-15 lists from Chapter 2 'Statistics Summary'. Patterns NOT appearing in a section did not rank in the top 15 for that metric. Source dataset: ~4.7M candle observations.",
        "sections": {key: [{"pattern": name, "value_pct": v} for name, v in entries] for key, entries in sections.items()},
        "patterns": list(by_pattern.values()),
    }
    OUT.write_text(json.dumps(payload, indent=2))
    print(f"wrote {OUT}")
    for key, entries in sections.items():
        print(f"  {key}: {len(entries)} patterns")
    print(f"  unique patterns across all rankings: {len(by_pattern)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
