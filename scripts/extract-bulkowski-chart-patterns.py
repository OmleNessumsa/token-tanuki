#!/usr/bin/env python3
"""Parse Bulkowski 'Encyclopedia of Chart Patterns' text dump → JSON of stats per pattern."""
import json
import re
import sys
from pathlib import Path

SRC = Path.home() / "code/cryptotrader/docs/source/text/bulkowski-chart-patterns.txt"
OUT = Path.home() / "code/cryptotrader/src/data/bulkowski-chart-patterns.json"


def pct(s: str) -> float | None:
    """'27%' or '–34%' → number; returns None if not a percent."""
    s = s.strip().replace("–", "-").replace("—", "-")
    m = re.match(r"^(-?\d+(?:\.\d+)?)%$", s)
    return float(m.group(1)) if m else None


def rank(s: str) -> tuple[int, int] | None:
    """'17 out of 23' → (17, 23)."""
    m = re.match(r"^(\d+)\s+out\s+of\s+(\d+)\s*$", s.strip())
    return (int(m.group(1)), int(m.group(2))) if m else None


def find_chapter_title(lines: list[str], snapshot_idx: int) -> str | None:
    """Walk backward from RESULTS SNAPSHOT line to find the chapter title."""
    # Pattern: a chapter starts with a "qxd" page-break line, then chapter number on its own line,
    # then the chapter title on its own line. We look back until we hit a chapter number line.
    for i in range(snapshot_idx - 1, max(0, snapshot_idx - 60), -1):
        line = lines[i].strip()
        # chapter number alone (1, 2, ..., 53)
        if re.match(r"^\d{1,2}$", line):
            # Title is the next non-empty line
            for j in range(i + 1, min(len(lines), i + 6)):
                title = lines[j].strip()
                if title and not title.startswith("4366_") and "qxd" not in title:
                    return title
        # Or "## TitleName" style header used in later chapters
        m = re.match(r"^(\d{1,2})\s+([A-Z][\w &\-,()'’]+)$", line)
        if m and len(m.group(2)) > 3:
            return m.group(2)
    return None


def parse_snapshot(lines: list[str], start: int) -> tuple[dict, int]:
    """Read one Results Snapshot block starting at the 'RESULTS SNAPSHOT' line.
    Returns (parsed dict, end index)."""
    i = start + 1
    out: dict = {}
    end = min(len(lines), start + 80)
    direction = None

    # 1) capture direction header
    while i < end:
        s = lines[i].strip()
        if s in ("Upward Breakouts", "Downward Breakouts"):
            direction = "up" if s.startswith("U") else "down"
            i += 1
            break
        i += 1

    out["direction"] = direction

    while i < end:
        line = lines[i]
        s = line.strip()
        if not s:
            i += 1
            continue
        if s.startswith("Tour") or "qxd" in s:
            break
        # Each row follows "Label spaces value". Split on 2+ spaces.
        parts = re.split(r"\s{2,}", s)
        # Some labels span two lines (e.g. "Percentage meeting price\n  target")
        # We collapse: if the line starts with a known label fragment, use it.
        label = parts[0].lower() if parts else ""
        rest = parts[1:] if len(parts) > 1 else []

        def grab_two(rest: list[str]) -> tuple[str, str] | None:
            """Bull/bear markets give two values."""
            if len(rest) >= 2:
                return rest[0], rest[1]
            return None

        if "performance rank" in label:
            tup = grab_two(rest)
            if tup:
                br, bk = rank(tup[0]), rank(tup[1])
                if br: out["rank_bull"] = {"position": br[0], "of": br[1]}
                if bk: out["rank_bear"] = {"position": bk[0], "of": bk[1]}
        elif "break-even failure" in label or "breakeven failure" in label:
            tup = grab_two(rest)
            if tup:
                a, b = pct(tup[0]), pct(tup[1])
                if a is not None: out["failure_bull_pct"] = a
                if b is not None: out["failure_bear_pct"] = b
        elif "average rise" in label or "average decline" in label:
            tup = grab_two(rest)
            if tup:
                a, b = pct(tup[0]), pct(tup[1])
                key = "avg_rise_pct" if "rise" in label else "avg_decline_pct"
                if a is not None: out[f"{key}_bull"] = a
                if b is not None: out[f"{key}_bear"] = b
        elif "change after trend ends" in label:
            tup = grab_two(rest)
            if tup:
                a, b = pct(tup[0]), pct(tup[1])
                if a is not None: out["change_after_trend_ends_bull_pct"] = a
                if b is not None: out["change_after_trend_ends_bear_pct"] = b
        elif "volume trend" in label:
            tup = grab_two(rest)
            if tup:
                out["volume_trend_bull"] = tup[0]
                out["volume_trend_bear"] = tup[1]
        elif "throwbacks" in label or "pullbacks" in label:
            tup = grab_two(rest)
            if tup:
                a, b = pct(tup[0]), pct(tup[1])
                key = "throwback_pct" if "throwback" in label else "pullback_pct"
                if a is not None: out[f"{key}_bull"] = a
                if b is not None: out[f"{key}_bear"] = b
        elif "percentage meeting" in label or "meeting price" in label:
            # may continue on next line
            target_line = s
            for j in range(i + 1, min(end, i + 3)):
                if "target" in lines[j].lower() and "%" in lines[j]:
                    target_line = lines[j]
                    i = j
                    break
            parts2 = re.split(r"\s{2,}", target_line.strip())
            tup = grab_two([p for p in parts2 if "%" in p or "out" in p])
            if tup:
                a, b = pct(tup[0]), pct(tup[1])
                if a is not None: out["target_hit_bull_pct"] = a
                if b is not None: out["target_hit_bear_pct"] = b
        elif "reversal or continuation" in label:
            out["nature"] = " ".join(rest).strip()
        elif "see also" in label:
            out["see_also"] = " ".join(rest).strip()
            break
        i += 1

    return out, i


def main() -> int:
    text = SRC.read_text(encoding="utf-8", errors="replace")
    lines = text.split("\n")
    snapshots: list[dict] = []

    for idx, line in enumerate(lines):
        if line.strip() == "RESULTS SNAPSHOT":
            title = find_chapter_title(lines, idx)
            block, _end = parse_snapshot(lines, idx)
            block["pattern"] = title
            block["source_line"] = idx + 1
            snapshots.append(block)

    # Group multiple snapshots per pattern (some have up + down)
    by_pattern: dict[str, dict] = {}
    for s in snapshots:
        name = s.get("pattern") or "UNKNOWN"
        slot = by_pattern.setdefault(name, {"pattern": name, "directions": {}})
        d = s.get("direction") or "unknown"
        s2 = {k: v for k, v in s.items() if k not in ("pattern", "direction", "source_line")}
        s2["source_line"] = s["source_line"]
        slot["directions"][d] = s2

    OUT.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "source": "Bulkowski, Thomas N. — Encyclopedia of Chart Patterns (Wiley, 2005, 2nd ed.)",
        "extracted_at": "2026-05-05",
        "patterns": list(by_pattern.values()),
        "raw_snapshot_count": len(snapshots),
    }
    OUT.write_text(json.dumps(payload, indent=2))
    print(f"wrote {OUT}")
    print(f"  raw snapshots:   {len(snapshots)}")
    print(f"  unique patterns: {len(by_pattern)}")
    print("")
    print("first 6 patterns extracted:")
    for p in list(by_pattern.values())[:6]:
        print(f"  - {p['pattern']}: directions={list(p['directions'].keys())}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
