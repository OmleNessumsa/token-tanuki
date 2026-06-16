# Strategy roadmap — van nul edge naar (misschien) een echte strategie

Status na 2026-06-11/12: scoreChart-TA (5m én 1h, alle varianten) en
funding-signalen (time-series én cross-sectioneel, 1y én 3y) zijn
definitief dood — zie `docs/PROBE_RESULTS_2026-06-12.md`. Wat WEL staat:
een betrouwbare meetmethodiek die negen regime-fits correct heeft
afgeschoten. Dit plan zet die methodiek in als funnel over een
geprioriteerde hypothese-backlog, met vooraf vastgelegde kill-criteria.

Het eerlijke uitgangspunt: de meeste hypotheses hieronder gaan sneuvelen.
Dat is geen falen van het plan — het plan bestaat om ze goedkoop te laten
sneuvelen vóórdat er kapitaal of dagen compute in verdwijnt. Als alles
sneuvelt is C5 (stoppen, of beta accepteren via DCA/holden) de uitkomst,
en dat is een valide uitkomst.

---

## Principes (niet onderhandelbaar, geleerd in dit project)

1. **Mechanisme eerst.** Geen hypothese de funnel in zonder antwoord op:
   wie is de tegenpartij, waarom betaalt die ons, en waarom is dit niet
   al weggearbitreerd? "Het correleerde in een backtest" is geen mechanisme.
2. **Signal-quality vóór backtest.** Eerst een kale IC/forward-return
   probe (à la `probe-funding-1y.ts`). Grid-sweeps en trade-sims pas na
   een IC-pass. Een sweep over een dood signaal vindt alleen regime-fits.
3. **Pre-registered criteria.** Kill-drempels staan in het probe-script
   gecommit vóór de run. Geen goalpost-moving, geen window-shopping na
   een FAIL.
4. **Replicatie op disjuncte data.** Een effect moet overeind blijven (of
   groeien) met 3× de sample. Het 1y-funding-resultaat dat kromp op 3y is
   het schoolvoorbeeld van waarom dit verplicht is.
5. **Overlap-correctie altijd.** Non-overlapping observaties of expliciete
   Newey-West; naïeve t-stats op overlappende windows zijn ~3× gelogen.
6. **Raw data vóór formatting naar `logs/`**, verdict naar memory — geen
   enkele toekomstige sessie test een dood spoor opnieuw.
7. **Kostenlat:** 14bps round-trip per leg (PRD §9.3+9.4, locked). Een
   gross effect moet ≥ ~2× de kosten van zijn eigen rebalance-frequentie
   zijn om Gate 3 te halen.

## De funnel (elke hypothese doorloopt dezelfde vijf gates)

| Gate | Test | Kill-criterium (default) | Kosten |
|---|---|---|---|
| 0 | Mechanisme-check, op papier | geen geloofwaardige tegenpartij/flow → skip | 10 min, geen code |
| 1 | IC-probe: 3y, multi-symbool, non-overlapping | pooled t < 2.0 én < 4/5 syms juiste teken | ~20-40 min |
| 2 | Stabiliteit: per-jaar splits | teken fout in ≥2/3 jaren, of effect >50% kleiner op 2e helft | gratis (zelfde data) |
| 3 | Cost-sim met gemeten turnover | net t < 2.0 of net < 5bps/dag | ~20-30 min |
| 4 | Walk-forward cert via backtest-v2 harness | bestaande cert gates, ongewijzigd | ~1-4 uur compute |

Budget-regel: max ~1 uur Claude-tijd per hypothese t/m Gate 3. FAIL bij
welke gate dan ook = stoppen, loggen, memory bijwerken, volgende hypothese.
Eén hypothese tegelijk volledig door de funnel.

## Hypothese-backlog (prioriteit = prior × data-beschikbaarheid)

### H1 — Cross-sectional momentum/reversal op daily bars
- **Mechanisme:** best gedocumenteerde factor-familie in crypto-academia:
  ~1-week reversal (retail overreactie) en ~2-4-week momentum (traag
  kapitaal). Tegenpartij: chasers en panic-sellers.
- **Data:** native 1D candles, 30-50 syms × 3y = 1 page per symbool. Vrijwel
  gratis.
- **Gate-1 probe:** rank op trailing 5d/10d/21d return, IC vs forward
  5d/10d return, cross-sectioneel, non-overlapping.

### H2 — BTC→alt lead-lag op 1-4h
- **Mechanisme:** liquiditeitscascade — BTC beweegt eerst, dunne alts
  prijzen het vertraagd in. Tegenpartij: trage market makers in de staart.
- **Data:** bestaande 1H fetch-infra, al gehard tegen de rate limiter.
- **Gate-1 probe:** BTC 1-4h return als signaal, alt forward returns als
  target, per-alt IC + pooled.

### H3 — Low-vol anomalie cross-sectioneel
- **Mechanisme:** lottery-preference — retail overbetaalt high-vol coins.
  Tegenpartij: gokkers.
- **Data:** bestaande.
- **Gate-1 probe:** rank op trailing 30d realized vol, IC vs forward return;
  let op: moet onderscheiden worden van pure beta (vol-neutrale spread).

### H4 — Seasonality / flow-windows
- **Mechanisme:** voorspelbare flow rond funding-settlements (00/08/16
  UTC), US-open, weekend. Tegenpartij: niemand — het is timing van
  bestaande flow, dus extra sceptisch op kosten (kleine effecten).
- **Data:** bestaande.
- **Gate-1 probe:** mean return per uur-van-dag/dag-van-week bucket, 3y,
  met Bonferroni-achtige correctie voor het aantal buckets.

### H5 — OI/liquidatie-extremen (vereist nieuwe databron)
- **Mechanisme:** gedwongen flow (liquidaties) is niet-informatief →
  prijsdruk keert. De sterkste prior van allemaal, maar Blofin exposeert
  geen OI/liquidatie-history voor zover bekend.
- **Data:** extern (Coinglass, Coinalyze, …). Pricing van die API's wordt
  pas live geverifieerd op het moment dat we hieraan beginnen — geen
  aannames over gratis tiers.
- Alleen starten na expliciete go van Elmo (nieuwe dependency).

### H6 — On-chain (MVRV, exchange flows) — laagste prioriteit
- Lange horizon → weinig onafhankelijke observaties → structureel lage
  statistische power. Alleen zinvol als boekenkast-onderzoek, niet als
  korte-termijn-strategie. Alleen bij expliciete wens.

## Fasering en go/no-go-momenten

- **Fase 1: H1 → H2.** Bestaande data + één kleine infra-stap (1D-candle
  fetch, ~15 min). Wall-clock ~2-3 uur totaal incl. fetches.
- **Fase 2: H3 → H4.** Bestaande data, zelfde dag mogelijk.
- **Beslismoment (met Elmo):** na 4× FAIL → óf nieuwe databron (H5), óf
  definitief C5. Geen stilzwijgend doorrollen naar fase 3.
- **Bij een Gate-3 pass:** Gate 4 (walk-forward cert) + paper-trading
  spec. Pas daarna óóit over echt geld praten — en dan klein: een edge
  van bps/dag is een bescheiden machine, geen lot uit de loterij.

## Wat we NIET gaan doen

- Geen nieuwe TA-composieten op alleen prijs (de hele scoreChart-les).
- Geen grid-sweeps vóór een Gate-1 IC-pass.
- Geen versoepeling van cert gates of kill-criteria, ooit.
- Geen hertest van begraven hypotheses op "nog één ander window".
- Geen multi-dag compute-runs; alles in dit plan past in minuten-tot-uren.

## Uitkomst Fase 1+2 (zelfde dag, 2026-06-12 middag)

Alle vier de hypotheses zijn dezelfde dag door de funnel gehaald — en alle
vier gesneuveld, elk op een andere, leerzame manier:

| Hypothese | Verdict | Doodsoorzaak | Probe |
|---|---|---|---|
| H1 momentum/reversal (daily) | FAIL Gate 1 | reversal-richting is FOUT (perps trenden); momentum consistent maar t=1.0-1.4 < 2.5 | `probe-xsec-momentum.ts` |
| H2 lead-lag (1-4h) | FAIL Gate 3 | signaal ONOMSTOTELIJK echt (IC=0.04, t=24.8, 3y stabiel) maar 2-8bps gross vs 21.6bps kosten bij gemeten 77% turnover | `probe-leadlag.ts` + `-gate3.ts` |
| H3 low-vol | FAIL Gate 3 | skew trap: rank-IC passt (t=3.25) maar tradeable spread -54bps/5d — moonshots slopen de short leg | `probe-lowvol.ts` |
| H4 seasonality | FAIL Gate 1 | geen van 31 buckets bij \|t\|≥3.5; beste cellen = verwachte toevalstreffers | `probe-seasonality.ts` |

Meta-beeld van deze markt (2023-2026, Blofin USDT-perps): **trending,
rechts-scheef, lottery-betalend, met een reëel maar sub-cost
microstructuur-reversal op 1h.** Constructies die impliciet short-trend of
short-tail zijn, sterven steeds op dezelfde manier.

Methodologische winst, herbruikbaar: `scripts/lib/bulk-fetch.ts` (disk-cache
+ rate-limit-hardening), het probe-patroon met pre-registered gates, de
q1mq5-+-skew-check (les van H3), de gemeten-turnover cost-sim (les van H2).

**Status: bij het pre-committed beslismoment (CB-015).** Opties: H5
(liquidatie/OI-extremen — sterkste resterende mechanisme, vereist externe
databron met live pricing-check) of definitief C5. Expliciete keuze van
Elmo vereist; niet stilzwijgend doorgerold.

## Eindverdict (2026-06-12, ~14:30 — beslissing door Elmo gedelegeerd)

Elmo delegeerde de keuze ("Jij bent in de lead"). Besluit: **H5a eerst als
gratis proxy-probe, daarna C5 bij FAIL — en het werd FAIL.**

H5a (`probe-cascade.ts`, |z|≥3 × volume≥3×mediaan, 8948 events, 3y):
- CRASH→bounce: +23 tot +32bps (4-12h), 3/3 thirds — consistent maar
  t=1.2-1.7 < 2.5 en op de stressed-cost-vloer in plaats van erboven.
- PUMP→fade: **actief weerlegd** — pumps gaan dóór (+105bps @48h, t=2.05
  in de verkeerde richting). Het halve forced-flow-mechanisme klopt niet
  op deze markt.
- H5b (externe liquidatie-data) niet gerechtvaardigd: benodigd effect is
  3-4× de proxy en het mechanisme is half weerlegd.

**C5 — definitief.** Negen hypothese-families getest en begraven in twee
dagen. Heropen-condities staan in de memory
(`final_verdict_c5_taker_alpha_dead`): een maker-execution-project rond
het bewezen 1h-reversal-signaal, een écht nieuwe informatiebron, of een
aantoonbare regime-shift. Verder niet.

## Effort (gekalibreerd op Claude-uitvoering)

| Onderdeel | Claude-tijd | Wall-clock |
|---|---|---|
| 1D-fetch infra | ~15 min | ~20 min |
| Per hypothese, Gate 1-3 | ~30-60 min | ~45-90 min (fetch = bottleneck) |
| Fase 1+2 compleet (H1-H4) | ~3-4 uur | ~4-6 uur |
| Gate 4 cert-run (alleen bij pass) | ~30 min setup | 1-4 uur compute |

---

## v2 — multi-premium portfolio (2026-06-16, Token Tanuki fork)

Na C5-op-alpha en de gevalideerde beta-harvester: tweede bouwroute, ingegeven
door twee onderzoeksdocs (betrouwbare risicopremies + vibecoders-realiteits-
toets). Stelling: winst zit in *structuur* (Grinold: IR ≈ IC × √breedte), niet
in één signaal. De harvester heeft breedte = 1. Plan: verbreed naar twee
laag-gecorreleerde premies met portfolio-sizing — **zonder** taker-alpha te
heropenen (C5 blijft staan).

Epic **CB-020**, gebouwd CB-021 t/m CB-026:
- **Sleeve A** (CB-022) — trend-harvester van BTC → N-asset basket. *Breedte,
  geen per-asset alpha* (CB-017: TSMOM = herverpakte beta).
- **Sleeve B** (CB-023) — delta-neutrale funding-carry (long spot / short perp),
  funding als *structurele yield*. Expliciet NIET de begraven
  funding-als-voorspeller-probe.
- **PortfolioAllocator** (CB-024) — correlatie-bewust risk-budget + fractionele
  Kelly (cap 0.25) + portfolio-vol-target. Mechaniek alle PASS, runtime-geverifieerd.

### Gate-uitslag (CB-025): **FAIL** — eerlijk, geen tuning

| OOS 2018-2026, net-of-cost | BTC-harvester | Basket → allocator |
|---|---|---|
| Sharpe | **1.04** | 0.92 |
| maxDD | **32%** | 48% |
| CAGR | **31%** | 22% |
| skew | **+0.99** | **−0.36** |
| walk-forward | — | 9/16 = 56% |

Verliest op beide gate-metrieken én flipt de gezonde rechtse skew naar
negatief — **de H3-les opnieuw**: alts zijn BTC-gecorreleerd in crashes, dus de
basket poolt tail-risk in plaats van het te diversifiëren. Het diversificatie-
dividend materialiseert niet OOS. Geen tuning toegepast (C5-discipline).

### Beslissingen

- **Multi-asset basket: shelved.** Verdient zijn complexiteit niet OOS.
  Gevalideerde single-asset BTC-harvester blijft het boek.
- **Allocator-framework: behouden** (herbruikbaar; BTC-only → allocator =
  Sharpe 1.06 / maxDD 25%). BTC-via-allocator wordt naar paper bedraad (CB-026).
- **Funding-carry: UNVALIDATED.** De proxy-spot (zelfde perp) nulde basisrisico
  → premie nooit eerlijk getest. Echte spot/index-basis als toekomst-ticket
  **CB-027** — de enige resterende ongecorreleerde premie die de docs aanbevelen.

Meta-les, consistent met het hele project: een correcte validatie-pijplijn
hoort goede-ogende-maar-zwakke uitbreidingen te laten sneuvelen vóór er
kapitaal in verdwijnt. v2 is daar het tweede schoolvoorbeeld van.
