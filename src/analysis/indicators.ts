import type { OhlcvCandle } from "../schemas.js";

export type Candle = { t: number; o: number; h: number; l: number; c: number; v: number };

export function toCandles(rows: readonly OhlcvCandle[]): Candle[] {
  return rows.map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v }));
}

export function sma(values: readonly number[], period: number): number[] {
  if (period <= 0 || values.length < period) return [];
  const out: number[] = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!;
    if (i >= period) sum -= values[i - period]!;
    if (i >= period - 1) out.push(sum / period);
  }
  return out;
}

export function ema(values: readonly number[], period: number): number[] {
  if (period <= 0 || values.length === 0) return [];
  const k = 2 / (period + 1);
  const out: number[] = [];
  const seed = values.slice(0, period);
  if (seed.length < period) return [];
  const seedAvg = seed.reduce((a, b) => a + b, 0) / period;
  out.push(seedAvg);
  for (let i = period; i < values.length; i++) {
    const prev = out[out.length - 1]!;
    out.push((values[i]! - prev) * k + prev);
  }
  return out;
}

export function rsi(closes: readonly number[], period = 14): number[] {
  if (closes.length <= period) return [];
  const out: number[] = [];
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i]! - closes[i - 1]!;
    if (diff >= 0) avgGain += diff;
    else avgLoss += -diff;
  }
  avgGain /= period;
  avgLoss /= period;
  out.push(rsiFromAvg(avgGain, avgLoss));
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i]! - closes[i - 1]!;
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out.push(rsiFromAvg(avgGain, avgLoss));
  }
  return out;
}

function rsiFromAvg(gain: number, loss: number): number {
  if (loss === 0) return 100;
  const rs = gain / loss;
  return 100 - 100 / (1 + rs);
}

export function atr(candles: readonly Candle[], period = 14): number[] {
  if (candles.length <= period) return [];
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i]!;
    const prev = candles[i - 1]!;
    trs.push(Math.max(c.h - c.l, Math.abs(c.h - prev.c), Math.abs(c.l - prev.c)));
  }
  let prev = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const out: number[] = [prev];
  for (let i = period; i < trs.length; i++) {
    prev = (prev * (period - 1) + trs[i]!) / period;
    out.push(prev);
  }
  return out;
}

export function obv(candles: readonly Candle[]): number[] {
  if (candles.length === 0) return [];
  const out: number[] = [0];
  for (let i = 1; i < candles.length; i++) {
    const prev = out[out.length - 1]!;
    const c = candles[i]!.c;
    const pc = candles[i - 1]!.c;
    if (c > pc) out.push(prev + candles[i]!.v);
    else if (c < pc) out.push(prev - candles[i]!.v);
    else out.push(prev);
  }
  return out;
}

export function bollinger(closes: readonly number[], period = 20, mult = 2): { mid: number[]; upper: number[]; lower: number[] } {
  if (closes.length < period) return { mid: [], upper: [], lower: [] };
  const mid: number[] = [];
  const upper: number[] = [];
  const lower: number[] = [];
  for (let i = period - 1; i < closes.length; i++) {
    const slice = closes.slice(i - period + 1, i + 1);
    const m = slice.reduce((a, b) => a + b, 0) / period;
    const variance = slice.reduce((acc, x) => acc + (x - m) ** 2, 0) / period;
    const sd = Math.sqrt(variance);
    mid.push(m);
    upper.push(m + mult * sd);
    lower.push(m - mult * sd);
  }
  return { mid, upper, lower };
}

export interface Swing {
  index: number;
  price: number;
  kind: "high" | "low";
}

export function swings(candles: readonly Candle[], lookback = 3): Swing[] {
  const out: Swing[] = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const c = candles[i]!;
    let isHigh = true;
    let isLow = true;
    for (let j = 1; j <= lookback; j++) {
      if (candles[i - j]!.h >= c.h || candles[i + j]!.h >= c.h) isHigh = false;
      if (candles[i - j]!.l <= c.l || candles[i + j]!.l <= c.l) isLow = false;
    }
    if (isHigh) out.push({ index: i, price: c.h, kind: "high" });
    else if (isLow) out.push({ index: i, price: c.l, kind: "low" });
  }
  return out;
}

export interface Divergence {
  kind: "bullish" | "bearish" | "hiddenBullish" | "hiddenBearish";
  fromIndex: number;
  toIndex: number;
}

export function detectRsiDivergence(candles: readonly Candle[], rsiValues: readonly number[]): Divergence[] {
  const out: Divergence[] = [];
  if (rsiValues.length < 10) return out;
  const offset = candles.length - rsiValues.length;
  if (offset < 0) return out;
  const sw = swings(candles, 3).filter((s) => s.index - offset >= 0 && s.index - offset < rsiValues.length);
  const lows = sw.filter((s) => s.kind === "low");
  const highs = sw.filter((s) => s.kind === "high");
  for (let i = 1; i < lows.length; i++) {
    const a = lows[i - 1]!;
    const b = lows[i]!;
    if (b.index - a.index < 5 || b.index - a.index > 60) continue;
    const ra = rsiValues[a.index - offset]!;
    const rb = rsiValues[b.index - offset]!;
    if (b.price < a.price && rb > ra) out.push({ kind: "bullish", fromIndex: a.index, toIndex: b.index });
    else if (b.price > a.price && rb < ra) out.push({ kind: "hiddenBullish", fromIndex: a.index, toIndex: b.index });
  }
  for (let i = 1; i < highs.length; i++) {
    const a = highs[i - 1]!;
    const b = highs[i]!;
    if (b.index - a.index < 5 || b.index - a.index > 60) continue;
    const ra = rsiValues[a.index - offset]!;
    const rb = rsiValues[b.index - offset]!;
    if (b.price > a.price && rb < ra) out.push({ kind: "bearish", fromIndex: a.index, toIndex: b.index });
    else if (b.price < a.price && rb > ra) out.push({ kind: "hiddenBearish", fromIndex: a.index, toIndex: b.index });
  }
  return out;
}

export function trendDirection(closes: readonly number[]): "up" | "down" | "flat" {
  if (closes.length < 50) return "flat";
  const fast = ema(closes, 21);
  const slow = ema(closes, 50);
  if (fast.length === 0 || slow.length === 0) return "flat";
  const last = closes[closes.length - 1]!;
  const slowLast = slow[slow.length - 1]!;
  const fastLast = fast[fast.length - 1]!;
  if (last > slowLast && fastLast > slowLast) return "up";
  if (last < slowLast && fastLast < slowLast) return "down";
  return "flat";
}

export function pctChange(from: number, to: number): number {
  if (from === 0) return 0;
  return ((to - from) / from) * 100;
}

export function maxDrawdown(closes: readonly number[]): number {
  if (closes.length === 0) return 0;
  let peak = closes[0]!;
  let mdd = 0;
  for (const c of closes) {
    if (c > peak) peak = c;
    const dd = (peak - c) / peak;
    if (dd > mdd) mdd = dd;
  }
  return mdd;
}

/**
 * Average Directional Index (Wilder, 1978).
 * Returns ADX values smoothed by Wilder's averaging method (period default 14).
 * ADX > 25 = trending; > 30 = strongly trending; < 20 = ranging.
 */
export function adx(candles: readonly Candle[], period = 14): number[] {
  if (candles.length <= period + 1) return [];
  const tr: number[] = [];
  const plusDm: number[] = [];
  const minusDm: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i]!;
    const p = candles[i - 1]!;
    tr.push(Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c)));
    const upMove = c.h - p.h;
    const downMove = p.l - c.l;
    plusDm.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDm.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }
  // Wilder smoothing: first value is sum of first `period`, then prev*(1-1/p) + current
  const smooth = (arr: number[]): number[] => {
    if (arr.length < period) return [];
    const out: number[] = [];
    let sum = 0;
    for (let i = 0; i < period; i++) sum += arr[i]!;
    out.push(sum);
    for (let i = period; i < arr.length; i++) {
      out.push(out[out.length - 1]! - out[out.length - 1]! / period + arr[i]!);
    }
    return out;
  };
  const trS = smooth(tr);
  const pdmS = smooth(plusDm);
  const mdmS = smooth(minusDm);
  const dx: number[] = [];
  for (let i = 0; i < trS.length; i++) {
    if (trS[i] === 0) { dx.push(0); continue; }
    const pdi = (pdmS[i]! / trS[i]!) * 100;
    const mdi = (mdmS[i]! / trS[i]!) * 100;
    const sum = pdi + mdi;
    dx.push(sum === 0 ? 0 : (Math.abs(pdi - mdi) / sum) * 100);
  }
  // ADX = Wilder-smoothed DX
  if (dx.length < period) return [];
  const adxOut: number[] = [];
  let sum = 0;
  for (let i = 0; i < period; i++) sum += dx[i]!;
  adxOut.push(sum / period);
  for (let i = period; i < dx.length; i++) {
    adxOut.push((adxOut[adxOut.length - 1]! * (period - 1) + dx[i]!) / period);
  }
  return adxOut;
}

/** Rate of change: (close[i] / close[i-period] - 1) × 100. */
export function roc(closes: readonly number[], period: number): number[] {
  if (period <= 0 || closes.length <= period) return [];
  const out: number[] = [];
  for (let i = period; i < closes.length; i++) {
    const prev = closes[i - period]!;
    out.push(prev === 0 ? 0 : (closes[i]! / prev - 1) * 100);
  }
  return out;
}

/**
 * Pring's KST (Know Sure Thing).
 * Source: Martin Pring, "Technical Analysis Explained" (5th ed., McGraw-Hill 2014).
 *
 * Sum of 4 smoothed ROCs of different time spans, weighted 1-4 (longer = heavier).
 * Default = short-term (daily) variant. Pass {variant: "long"} for monthly use.
 *
 * Daily KST:    ROC(10) SMA(10) × 1 + ROC(15) SMA(10) × 2 + ROC(20) SMA(10) × 3 + ROC(30) SMA(15) × 4
 * Long-term:    ROC( 9) SMA( 6) × 1 + ROC(12) SMA( 6) × 2 + ROC(18) SMA( 6) × 3 + ROC(24) SMA( 9) × 4
 */
export interface KstResult {
  values: number[];
  signal: number[];   // KST smoothed by signal-line MA (default 9-period)
}

export function kst(closes: readonly number[], variant: "short" | "long" = "short", signalPeriod = 9): KstResult {
  const params = variant === "short"
    ? [{ roc: 10, sma: 10 }, { roc: 15, sma: 10 }, { roc: 20, sma: 10 }, { roc: 30, sma: 15 }]
    : [{ roc:  9, sma:  6 }, { roc: 12, sma:  6 }, { roc: 18, sma:  6 }, { roc: 24, sma:  9 }];
  const weights = [1, 2, 3, 4];

  const components: number[][] = params.map(({ roc: rocPeriod, sma: smaPeriod }) =>
    sma(roc(closes, rocPeriod), smaPeriod),
  );

  // Align to the shortest component (each has a different start offset)
  const minLen = Math.min(...components.map((c) => c.length));
  if (minLen === 0) return { values: [], signal: [] };
  const aligned = components.map((c) => c.slice(c.length - minLen));

  const values: number[] = [];
  for (let i = 0; i < minLen; i++) {
    let sum = 0;
    for (let k = 0; k < aligned.length; k++) sum += aligned[k]![i]! * weights[k]!;
    values.push(sum);
  }

  const signal = sma(values, signalPeriod);
  return { values, signal };
}

/**
 * Pring's Special K — extended KST combining short, intermediate, and long-term ROCs.
 * Standard Pring weights for daily charts.
 *
 * Use case: a single oscillator that captures multi-timeframe momentum confluence.
 * Especially good for spotting cycle turning points where short and long ROCs align.
 */
export function specialK(closes: readonly number[]): number[] {
  const params: Array<{ roc: number; sma: number; w: number }> = [
    { roc:  10, sma:  10, w: 1 }, { roc:  15, sma:  10, w: 2 }, { roc:  20, sma:  10, w: 3 }, { roc:  30, sma:  15, w: 4 },
    { roc:  40, sma:  50, w: 1 }, { roc:  65, sma:  65, w: 2 }, { roc:  75, sma:  75, w: 3 }, { roc: 100, sma: 100, w: 4 },
    { roc: 195, sma: 130, w: 1 }, { roc: 265, sma: 130, w: 2 }, { roc: 390, sma: 130, w: 3 }, { roc: 530, sma: 195, w: 4 },
  ];

  const components = params.map(({ roc: rp, sma: sp }) => sma(roc(closes, rp), sp));
  const minLen = Math.min(...components.map((c) => c.length));
  if (minLen === 0) return [];
  const aligned = components.map((c) => c.slice(c.length - minLen));

  const out: number[] = [];
  for (let i = 0; i < minLen; i++) {
    let sum = 0;
    for (let k = 0; k < aligned.length; k++) sum += aligned[k]![i]! * params[k]!.w;
    out.push(sum);
  }
  return out;
}

/**
 * KST signal: detect a recent crossover of KST and its signal line.
 * Returns "bullish" (KST crossed above), "bearish" (crossed below), or null.
 */
export function kstCrossover(result: KstResult, lookback = 3): "bullish" | "bearish" | null {
  const v = result.values;
  const s = result.signal;
  if (s.length < 2) return null;
  const offset = v.length - s.length;
  const start = s.length - 1;
  const end = Math.max(1, s.length - lookback - 1);
  for (let i = start; i >= end; i--) {
    if (i + offset - 1 < 0) continue;
    const k = v[i + offset]!;
    const sig = s[i]!;
    const kPrev = v[i + offset - 1]!;
    const sigPrev = s[i - 1]!;
    if (kPrev <= sigPrev && k > sig) return "bullish";
    if (kPrev >= sigPrev && k < sig) return "bearish";
  }
  return null;
}
