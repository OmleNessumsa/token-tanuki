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
