// Washout dip-recovery bot for btc-race-24h-20261115-0828.
//
// Idea: the dev window drifts down most hours (-400 bps buy-and-hold) but
// punctuates the falls with sharp rebounds (one hour +287 bps). Holding
// loses; catching the washed-out dip and riding the rebound wins. So this
// bot only buys a dip that has already stopped falling, and only when the
// price is stretched well below its short trend.
//
// Entry (decided on a bar's close, filled at the next bar's open):
//   - close is at least DROP_BPS below the rolling HIGH_BARS-bar high, and
//   - the decline is moderating, not a free-fall: the last 3 bars together
//     are no worse than MOD_BPS, and the latest bar is no worse than
//     LAST_BPS, and
//   - the close sits at least BELOW_EMA_BPS under its EMA_TREND-bar EMA
//     (oversold versus trend, not just a wiggle near the highs).
// Exit (whole position, decided on each bar's close):
//   - take-profit at TP_BPS over cost, or
//   - stop-loss at STOP_BPS under cost, or
//   - trailing fade: once the trade peaked at least PEAK_BPS over cost,
//     exit when it gives back TRAIL_BPS from that peak, or
//   - time stop after HOLD_MAX bars.
// After any exit a short cooldown keeps the bot from re-buying the same
// falling knife on the very next bar; a fresh washout (a new dip off a new
// rolling high, i.e. a higher-low rebuy) can trigger again afterwards.
// Long only, one position, full equity per trade, deterministic: no clock,
// no network, no randomness at all (hello.seed is not even needed).

import { runBars, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// --- tunable parameters (swept locally, see grade notes) ---
// Deep washout only (drop >= 150 bps off the 45-bar high) with the decline
// already turning (3-bar return >= +10 bps, latest bar not down): shallow
// dips keep falling on this window, deep ones rebound over the next hour.
// Wide stop (200 bps) is a safety valve only — tight stops cut winners
// that dip again before rebounding. Long hold (120 bars) lets the rebound
// develop; the trailing exit locks in a run once it peaks >= 80 bps. The
// trail is 35 bps, not 50: on this window the rebounds are sharp, so a
// 50 bps give-back surrenders too much of a fast move — exiting at peak
// minus 35 still banks at least 45 bps gross (well clear of the ~26 bps
// round-trip cost) while tolerating normal pullback noise, and the
// 3-bar cooldown plus re-entry logic can catch a continuation leg.
const HIGH_BARS = 45;
const DROP_BPS = 150;
const MOD_BPS = 10; // worst allowed 3-bar return at entry (bps)
const LAST_BPS = 0; // worst allowed latest-bar return at entry (bps)
const EMA_TREND = 20;
const BELOW_EMA_BPS = 30;
const TP_BPS = 240;
const STOP_BPS = 200;
const PEAK_BPS = 80;
const TRAIL_BPS = 35;
const HOLD_MAX = 120;
const COOLDOWN_BARS = 3;
const MAX_SLIPPAGE_BPS = 200;

const closes: number[] = [];
let ema = 0;
let peakGainBps = 0;
let barsHeld = 0;
let cooldown = 0;

function emaUpdate(close: number): void {
  if (closes.length === 1) {
    ema = close;
    return;
  }
  const k = 2 / (EMA_TREND + 1);
  ema = close * k + ema * (1 - k);
}

function retBps(from: number, to: number): number {
  return ((to - from) / from) * 10_000;
}

await runBars({
  onBatch(state: BarsState, batch) {
    const orders: (BuyInput | SellInput)[] = [];
    if (state.warmingUp) return orders;
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar === undefined) return orders;
    const close = Number(bar.c);
    closes.push(close);
    emaUpdate(close);
    if (cooldown > 0) cooldown--;

    const held = state.positions.get(SYMBOL);
    if (held !== undefined) {
      barsHeld++;
      const value = state.value(SYMBOL, held.qty);
      const gainBps = ((Number(value) - Number(held.cost)) / Number(held.cost)) * 10_000;
      if (gainBps > peakGainBps) peakGainBps = gainBps;
      const fade = peakGainBps >= PEAK_BPS && gainBps <= peakGainBps - TRAIL_BPS;
      if (gainBps >= TP_BPS || gainBps <= -STOP_BPS || fade || barsHeld >= HOLD_MAX) {
        orders.push({ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
        peakGainBps = 0;
        barsHeld = 0;
        cooldown = COOLDOWN_BARS;
      }
      return orders;
    }

    // Flat: no open position.
    peakGainBps = 0;
    barsHeld = 0;
    if (cooldown > 0 || closes.length < HIGH_BARS + 1) return orders;
    if (state.cash < BigInt(state.hello.fees.min_notional_quote_units)) return orders;

    let high = 0;
    for (let i = closes.length - HIGH_BARS; i < closes.length; i++) {
      if (closes[i]! > high) high = closes[i]!;
    }
    const n = closes.length;
    const dropBps = retBps(close, high); // positive when below the high
    const last3Bps = retBps(closes[n - 4]!, close);
    const last1Bps = retBps(closes[n - 2]!, close);
    const belowEmaBps = retBps(close, ema); // positive when below the EMA
    const moderating = last3Bps >= MOD_BPS && last1Bps >= LAST_BPS;
    const washedOut = dropBps >= DROP_BPS && belowEmaBps >= BELOW_EMA_BPS;

    if (washedOut && moderating) {
      let size = state.cash;
      const room = state.weightRoom(SYMBOL);
      if (size > room) size = room;
      if (size >= BigInt(state.hello.fees.min_notional_quote_units)) {
        orders.push({ side: 'buy', symbol: SYMBOL, notional_quote_units: size, max_slippage_bps: MAX_SLIPPAGE_BPS });
      }
    }
    return orders;
  },
});
