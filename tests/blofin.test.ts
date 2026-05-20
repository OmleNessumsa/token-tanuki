import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetSymbolCache,
  findCanonicalPerp,
  getFundingRate,
  getInstruments,
  getNativeCandles,
  getTicker,
  symbolExists,
  BLOFIN_FUNDING_CYCLE_HOURS,
} from "../src/clients/blofin.js";

/**
 * Stub global fetch with a queue of canned responses. Each subsequent fetch call
 * pops the next response; if the queue is empty, the test fails. This keeps the
 * Blofin client code under test exercising the real fetchJson path without
 * touching the network.
 */
function queueFetch(responses: Array<{ status?: number; json: unknown }>): void {
  const queue = [...responses];
  vi.stubGlobal("fetch", async () => {
    const next = queue.shift();
    if (!next) throw new Error("no canned response left for fetch");
    const status = next.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(next.json),
      json: async () => next.json,
    } as Response;
  });
}

beforeEach(() => {
  _resetSymbolCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getInstruments", () => {
  it("filters to live SWAP instruments only", async () => {
    queueFetch([
      {
        json: {
          code: "0",
          msg: "",
          data: [
            { instId: "BTC-USDT", baseCurrency: "BTC", quoteCurrency: "USDT", contractValue: "0.001", minSize: "0.1", maxLeverage: "125", instType: "SWAP", state: "live" },
            { instId: "ETH-USDT", baseCurrency: "ETH", quoteCurrency: "USDT", contractValue: "0.01",  minSize: "0.1", maxLeverage: "100", instType: "SWAP", state: "suspended" },
            { instId: "BTC-USDT-250930", baseCurrency: "BTC", quoteCurrency: "USDT", contractValue: "0.001", minSize: "0.1", maxLeverage: "50", instType: "FUTURES", state: "live" },
            { instId: "SOL-USDT", baseCurrency: "SOL", quoteCurrency: "USDT", contractValue: "1", minSize: "1", maxLeverage: "75", instType: "SWAP", state: "live" },
          ],
        },
      },
    ]);
    const out = await getInstruments();
    expect(out.map((i) => i.instId)).toEqual(["BTC-USDT", "SOL-USDT"]);
  });

  it("returns [] on non-zero code", async () => {
    queueFetch([{ json: { code: "1", msg: "system error", data: null } }]);
    expect(await getInstruments()).toEqual([]);
  });
});

describe("getNativeCandles", () => {
  it("parses Blofin candle rows, converts ms→s, picks quote volume (index 7), reverses to oldest-first", async () => {
    // Blofin: [ts_ms, o, h, l, c, vol_contracts, vol_base, vol_quote_usdt, confirm]
    // Newest first.
    queueFetch([
      {
        json: {
          code: "0",
          data: [
            ["1696640400000", "27530", "27540", "27520", "27535", "200", "0.2", "5506.5", "0"],
            ["1696636800000", "27491.5", "27495", "27483", "27489.5", "100", "0.1", "2748.95", "1"],
          ],
        },
      },
    ]);
    const out = await getNativeCandles("BTC-USDT", "1H", 2);
    expect(out).toHaveLength(2);
    // Oldest first after reverse
    expect(out[0]).toEqual({ t: 1696636800, o: 27491.5, h: 27495, l: 27483, c: 27489.5, v: 2748.95 });
    expect(out[1]).toEqual({ t: 1696640400, o: 27530, h: 27540, l: 27520, c: 27535, v: 5506.5 });
  });

  it("caps limit at 1440 (Blofin per-request max)", async () => {
    const seenUrls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      seenUrls.push(url);
      return {
        ok: true,
        status: 200,
        text: async () => "",
        json: async () => ({ code: "0", data: [] }),
      } as Response;
    });
    await getNativeCandles("BTC-USDT", "1H", 5000);
    expect(seenUrls[0]).toContain("limit=1440");
  });

  it("returns [] on error code", async () => {
    queueFetch([{ json: { code: "401", msg: "invalid instId", data: null } }]);
    expect(await getNativeCandles("FAKE-USDT", "1H", 10)).toEqual([]);
  });
});

describe("getTicker", () => {
  it("unwraps single-element data array", async () => {
    queueFetch([
      {
        json: {
          code: "0",
          data: [
            { instId: "BTC-USDT", last: "67000", askPrice: "67001", bidPrice: "66999",
              high24h: "68000", low24h: "66000", open24h: "66500", vol24h: "1000000",
              volCurrencyQuote24h: "65000000000", ts: "1714000000000" },
          ],
        },
      },
    ]);
    const t = await getTicker("BTC-USDT");
    expect(t).not.toBeNull();
    expect(t!.instId).toBe("BTC-USDT");
    expect(t!.last).toBe("67000");
  });

  it("returns null when data is empty", async () => {
    queueFetch([{ json: { code: "0", data: [] } }]);
    expect(await getTicker("BTC-USDT")).toBeNull();
  });
});

describe("getFundingRate", () => {
  it("returns the funding-rate row", async () => {
    queueFetch([
      {
        json: {
          code: "0",
          data: [{ instId: "BTC-USDT", fundingRate: "0.000332", fundingTime: "1703462400000" }],
        },
      },
    ]);
    const f = await getFundingRate("BTC-USDT");
    expect(f).not.toBeNull();
    expect(f!.fundingRate).toBe("0.000332");
  });
});

describe("symbolExists / findCanonicalPerp", () => {
  it("caches instruments and recognises listed symbols", async () => {
    queueFetch([
      {
        json: {
          code: "0",
          data: [
            { instId: "BTC-USDT", baseCurrency: "BTC", quoteCurrency: "USDT", contractValue: "0.001", minSize: "0.1", maxLeverage: "125", instType: "SWAP", state: "live" },
          ],
        },
      },
    ]);
    expect(await symbolExists("BTC-USDT")).toBe(true);
    // Second call should hit cache (no extra fetch needed). The empty queue
    // would throw on a second fetch.
    expect(await symbolExists("BTC-USDT")).toBe(true);
  });

  it("findCanonicalPerp tries USDT then USD", async () => {
    queueFetch([
      {
        json: {
          code: "0",
          data: [
            { instId: "ETH-USDT", baseCurrency: "ETH", quoteCurrency: "USDT", contractValue: "0.01", minSize: "0.1", maxLeverage: "100", instType: "SWAP", state: "live" },
          ],
        },
      },
    ]);
    expect(await findCanonicalPerp("ETH")).toBe("ETH-USDT");
  });

  it("findCanonicalPerp aliases MATIC → POL", async () => {
    queueFetch([
      {
        json: {
          code: "0",
          data: [
            { instId: "POL-USDT", baseCurrency: "POL", quoteCurrency: "USDT", contractValue: "1", minSize: "1", maxLeverage: "50", instType: "SWAP", state: "live" },
          ],
        },
      },
    ]);
    expect(await findCanonicalPerp("MATIC")).toBe("POL-USDT");
  });

  it("returns null when asset not listed", async () => {
    queueFetch([
      {
        json: { code: "0", data: [] },
      },
    ]);
    expect(await findCanonicalPerp("NEVERLISTED")).toBeNull();
  });
});

describe("BLOFIN_FUNDING_CYCLE_HOURS", () => {
  it("is 8 (standard perp funding cycle)", () => {
    expect(BLOFIN_FUNDING_CYCLE_HOURS).toBe(8);
  });
});
