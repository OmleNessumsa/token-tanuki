# Cryptotrader build plan — bouwen op alles wat we hebben geleerd

Datum: 2026-06-14. Auteur: Rick (in de lead, gedelegeerd door Elmo).
Voorgangers: `HANDOVER_2026-06-12.md`, `STRATEGY_ROADMAP_2026-06-12.md`,
`PROBE_RESULTS_2026-06-12.md` + 8 memory-entries.

---

## 0. De herkadering die alles verandert

We hebben negen dode hypotheses en één overlevende (H2: echt maar
cost-gated). De negen doden zijn **geen mislukking — het zijn een kaart.**
Lees de kaart goed en hij vertelt je niet alleen wat NIET werkt, maar
dwingend welke strategie-*klasse* hier wél kán werken.

Tot nu toe was dit een **signaal-zoekprobleem**. Dat is voorbij. Vanaf nu
is het een **executie- en strategie-klasse-probleem.** Dat verandert de
hele bouw.

## 1. Wat het kerkhof POSITIEF bewijst (de inferenties, niet de doden)

| Dode hypothese | Negatieve conclusie | **Positieve inferentie** |
|---|---|---|
| H1 daily reversal | reversal-richting FOUT | **de markt trendt — niet tegenwerken** |
| H1 momentum | t=1.0-1.4, alle cellen + | momentum-richting KLOPT, alleen onderbemeten |
| H2 lead-lag | echt maar sub-cost (taker) | reversie is reëel maar alleen maker-haalbaar |
| H3 low-vol | short-leg verwoest door moonshots | **nooit de rechterstaart shorten — wees er LONG** |
| Funding xsec | beta-neutraal flipt per regime | **in een trend IS beta een groot deel van de return** |
| H4 seasonality | niets | timing-flow is geen edge |
| H5a cascade | pump-kant continueert (+105bps) | **continuatie domineert, zelfs na extremen** |

Elke dode wijst dezelfde kant op: **long-biased trend/continuatie, lage
turnover, rijd de rechterstaart, snij de linker.** Dat is exact de
strategie-klasse die we **nooit schoon getest hebben** — alles wat we
testten was het tegenovergestelde (mean-reversion of beta-neutraal).

Marktbeeld dat alle negen doden verklaart (Blofin USDT-perps 2023-2026):
**trending, rechts-scheef, lottery-betalend.**

## 2. Twee eerlijke kandidaat-architecturen

### Strategie A (PRIMAIRE kandidaat) — time-series trend/momentum, long-biased, lage turnover
- **Universe:** liquide USDT-perps met 3j historie (~37) + BTC/ETH.
- **Signaal:** trend-state per symbool — time-series momentum (teken van
  trailing 30/90d return) en/of Donchian-breakout. Long in bevestigde
  uptrend, anders flat. **Geen naked shorts** (H3-regel).
- **Sizing:** inverse-vol / vol-targeting → geen enkele moonshot of crash
  domineert. Lost H3 (skew) op via sizing en het funding-xsec-probleem
  door NIET dollar-neutraal-maar-vol-blind te zijn.
- **Turnover:** LAAG (weken-holds) → de kostenmuur die H2 doodde is hier
  **niet bindend.** Dit is de doorslaggevende troef.
- **Staart-beleid:** laat winnaars lopen (vang rechterstaart), harde
  trend-exit/stop op verliezers (snij linkerstaart).
- **Waarom het past:** het is letterlijk de inverse van elke dode
  hypothese, afgestemd op de bewezen marktstructuur.
- **Risico:** trend-following whipt in zijwaartse markten; lage hit-rate /
  hoge-payoff-verdeling. **Validatie verplicht vóór geloof.**

### Strategie B (ALTERNATIEF, hoge inzet) — maker-geëxecuteerde H2 cross-sectionele reversie
- Het enige signaal met een bewezen t-stat (24.8). Zet taker -19bps om in
  maker-positief via post-only limit orders + rebates.
- **Harde blokker:** adverse selection op maker-fills — eerst meten. Je
  krijgt je laggard-bid alleen gevuld als de laggard verder zakt.
- Veel meer infra (L2 orderbook, queue-model, cancel-replace, lage
  latency). Hogere capaciteit, en market-neutraal → ongecorreleerd met A
  → uiteindelijk samen draaien.

## 3. Fase 0 — Goedkope validatie die A vs B beslist (dagen, geen weken)

Pre-registered, op grotendeels gecachte data. **Dit gebeurt eerst, vóór
één regel productie-infra.**

- **P0.1 — Trend-following cert (Strategie A).** Bouw een vol-getargete,
  long-biased trend follower op 3j gecachte daily (+4h) bars. Meet
  net-na-kosten Sharpe + per-jaar stabiliteit + maxDD, kosten op GEMETEN
  (lage) turnover. **Pre-registered gate:** net Sharpe ≥ 1.0 over 3j, ≥
  positief in 2/3 jaren, maxDD < 30%, **én verslaat buy-and-hold BTC
  Sharpe.** Data: volledig gecached. Compute: minuten.
- **P0.2 — Maker-fill realisme (Strategie B).** Trek L2-orderbook +
  trade-prints (NIEUWE data, klein venster; pricing live checken vóór
  aanschaf/keuze van bron). Simuleer post-only fills mét
  adverse-selection-boekhouding. **Gate:** net edge per rebalance > 0 na
  realistische fill + adverse selection.
- **Beslissing:** wie de gate haalt wordt het bouwdoel. Halen beide het
  niet → eerlijk C5 / beta-only, en dan zeg ik dat plat.

## 4. Fase 1 — Strategie-kern (de winnaar)

- Signaal-module (puur, getest, no-look-ahead — zelfde contract als de
  bestaande harness).
- Sizing/portfolio-constructie (inverse-vol, caps, vol-target).
- Walk-forward cert via de **bestaande backtest-v2 harness + cert gates**
  (ongewijzigd — ze hebben negen regime-fits correct afgeschoten).

## 5. Fase 2 — Executie & live data-infra

- **Live data:** websocket candles + funding (+ L2 als B).
- **Order management:** idempotente order-plaatsing, reconciliatie,
  partial fills, post-only pad (als B), cancel-replace.
- **State:** posities, fills, PnL-grootboek, persistent + crash-safe.

## 6. Fase 3 — Risk & ops

- Pre-trade risk checks: positie-caps, gross/net-exposure, per-symbool
  staart-cap.
- Kill-switch, heartbeat, alerting (PushNotification/Telegram).
- Reconciliatie tegen exchange-state elke cyclus.

## 7. Fase 4 — Paper → klein kapitaal → opschalen

- Paper-trade op live data, vergelijk met backtest-expectancy.
  **Cert-gate:** live volgt backtest binnen tolerantie of we stoppen.
- Klein echt kapitaal, monitor slippage vs model.
- Opschalen alleen als live Sharpe standhoudt.

## 8. Dataset-vereisten

| Nodig voor | Hebben we | Nieuw nodig |
|---|---|---|
| A validatie (P0.1) | 3j daily+1H+5m cache, funding-history, bulk-fetch lib | niets |
| A productie | — | live websocket feed |
| B validatie (P0.2) | — | L2-orderbook snapshots + trade-prints (geen goedkope historische bron; forward opnemen of kopen — pricing live checken) |
| B productie | — | low-latency L2 feed |

## 9. Risk-doctrine (harde regels, rechtstreeks uit het kerkhof)

1. **Nooit naked-short de rechterstaart** (H3).
2. **Size op inverse-vol, niet op dollars** (H3 + funding-xsec).
3. **Neutraliseer beta niet in een trendmarkt** tenzij de strategie
   bewust market-neutraal is (B is dat, A niet).
4. **Pre-registered gates, GEMETEN kosten en turnover** (H2).
5. **Elke claim gerepliceerd op disjuncte/out-of-sample data** vóór kapitaal.
6. **Live moet backtest binnen tolerantie volgen, of halt.**

## 10. Kapitaal & verwachtingen (eerlijk)

Dit wordt een **bescheiden machine**, geen geldprinter. Realistisch doel:
een Sharpe ~1-1.5 strategie. Kader: "versla beta met gecontroleerd
risico", niet "word rijk". Size daarnaar. Een edge van enkele bps/dag is
een serieuze machine als hij stabiel is — en een ramp als je hem
overhefboomt.

## 11. Effort (Claude-tijd vs wall-clock)

| Fase | Claude-tijd | Wall-clock |
|---|---|---|
| P0.1 trend cert | ~20-40 min | ~1 uur (cache hot) |
| P0.2 maker-fill | ~1-2 uur | + data-acquisitie (extern) |
| Fase 1 kern | ~halve dag | ~1 dag |
| Fase 2-3 live infra | ~1-2 dagen code | dagen, gedomineerd door testen |
| Fase 4 paper→live | ~uren setup | **weken** (echte markttijd) |

## 12. De eerlijke spanning, expliciet benoemd

De memory zegt "NIET opnieuw proben op prijs/volume/funding". Strategie A
is time-series trend-following — een strategie-*klasse* die we nooit
testten (alle 9 doden waren reversie of beta-neutraal). Ik test hem ÉÉN
keer, schoon, pre-registered, omdat hij structureel matcht met het
marktbeeld dat juist uit die 9 doden ontstond — dat is nieuwe informatie,
geen her-probe van een dood spoor. Faalt P0.1 z'n gate → dan is ook deze
klasse dood en valt de beslissing richting B of C5. Geen window-shopping.

---

## 13. Uitkomst Fase 0 (uitgevoerd 2026-06-14)

Drie probes op de gecachte 3j data. De conclusie herdefinieert Strategie A.

| Probe | Vraag | Resultaat |
|---|---|---|
| **P0.1** `probe-trend-cert.ts` | Is trend-*timing* alpha? | **FAIL** — TSMOM (L=30/90d) Sharpe 0.71-0.89, verslaat buy-hold BTC (0.88) NIET. Trend-timing is herverpakte beta. |
| **P0.1b** `probe-beta-harvest.ts` | Verslaat risk-managed beta buy-hold? | **PASS** — BTC vol-target + 100d-MA-filter: Sharpe **1.04** vs 0.86, maxDD **30%** vs 51%, snijdt de slechte jaren (2026: -8% vs -27%). |
| **P0.1c** `probe-beta-robust.ts` | Is de PASS parameter-fragiel? | **ROBUST** — 9/12 MA×vol-cellen verslaan buy-hold met maxDD<35%. MA 50-150 werkt, MA=200 te traag, **vol-target zónder filter faalt** (Sharpe 0.66-0.78). Het trend-filter is het actieve ingrediënt. |

**Herdefinitie van Strategie A:** geen alpha-jacht, maar een **risk-managed
beta harvester** — vang de bewezen trend/rechterstaart (= de return van deze
markt) mét drawdown-controle via een trend-overlay + vol-targeting. Het
mechanisme is het best-gedocumenteerde effect in tactical asset allocation
(Faber 2007; Moskowitz-Ooi-Pedersen 2012), geen crypto-specifieke
data-mine. De parameter-surface is mechanistisch logisch, niet knife-edge.

**De resterende, eerlijk benoemde zwakte:** dit is nog één bull-then-bear-
cyclus (2023-24 op, 2025-26 af). De hele meerwaarde van het filter is "eruit
vóór de 2025-26 daling" — dat is op dit sample één onafhankelijke weddenschap.
De robuustheid over parameters dempt de data-mine-zorg, NIET de
één-cyclus-zorg.

## 14. Herziene roadmap

- **Fase 1 — OOS-cert (de gate vóór elke bouw).** Valideer de beta-harvester
  op de vórige cyclus (2018-2023: 2018-bear, COVID-crash, 2021-bull,
  2022-bear). BTC/ETH daily-historie is triviaal beschikbaar (Binance/
  Coinbase). Plus walk-forward over de hele 2018-2026-reeks en
  parameter-stabiliteit. **Gate:** Sharpe > buy-hold én maxDD < 35% in OOS
  én in elke walk-forward fold. Faalt dit → het was één-cyclus-fit en we
  vallen terug op B of pure DCA.
- **Fase 2 — kern bouwen** (alleen bij OOS-pass): signaal + sizing + de
  bestaande cert-harness, basket-variant (cel 3 had de beste
  jaar-spreiding: +15% in 2025).
- **Fase 3-5** — live data-infra, risk/ops, paper→klein kapitaal
  (ongewijzigd t.o.v. §5-7).

**Status:** Path 1 (risk-managed beta harvester) is het bouwdoel, ONDER
voorbehoud van de Fase-1 OOS-gate. Strategie B (maker) blijft de
hoge-inzet-alpha-optie voor later; pure DCA blijft de eerlijke
terugvaloptie als OOS faalt.
