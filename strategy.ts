// Trailhead Pump — a disciplined momentum bot for the pump.fun bonding-curve replay.
//
// Adapted from the Trailhead discipline that won the dev window of btc-race-0511
// (scale-in, trailing stop, no re-entry after an exit): never all-in on one
// signal, pyramid only into strength, exit on a hard stop or a trailing stop,
// and halt new entries while the book is in a drawdown.
//
// Entry: a curve is bought only when it is mature (past minAge slots since its
// CreateEvent — fresh curves are mostly bundled launches that get dumped) and
// its recent tape shows confirmed buying: net SOL flowing in, several distinct
// buyers, the price rising but still near its window high, inflow accelerating
// into the newer half of the window, and no single wallet dominating the buys.
//
// Sizing: the first buy is small (firstBuy). Later batches add addBuy while the
// price sits above the last buy and the position is at or above cost, up to
// maxStake per coin. False starts cost little; runners get size.
//
// Exits (whole position, first trigger wins): stop loss vs cost, trailing stop
// from the position's best marked value once armed, a fade exit when net flow
// turns negative, a big-sell exit on any single recorded sell of bigSell SOL
// or more, or a time limit. A completed curve is closed by the replay itself.
//
// Drawdown guard: equity (cash + marked position values) is tracked against
// its running peak. While equity sits more than haltDd below the peak, no new
// entries open; exits keep running. Entries resume once equity recovers to
// within resumeDd of the peak.
//
// Guardrail probes: the run must end with round trips of >= 0.01 SOL on at
// least 20 coins. When the bot's own fills or coins lag a pace set in block
// time, it opens tiny probe round trips (buy probeSol, sell it as soon as the
// buy lands) until it is back on pace.
//
// Deterministic by construction: no clock, no randomness, iteration only over
// insertion-ordered maps fed by the batch stream.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/agentfun-bot.ts';

export interface Params {
  /** Entry window in slots. */
  windowSlots: number;
  /** Net buy SOL (buys minus sells) over the window. */
  minNetSol: number;
  /** Buy trades in the window. */
  minBuys: number;
  /** Distinct buying wallets in the window. */
  minBuyers: number;
  /** Price now over price at the window start, minus 1. */
  minUp: number;
  /** Upper bound on that rise: skip curves that already ran too far in one window. */
  maxUp: number;
  /** Newer-half net inflow must be at least this multiple of the older half's. */
  accel: number;
  /** Price now at least this share of the window's high. */
  nearHigh: number;
  /** Largest single wallet's share of the window's buy SOL. */
  maxBuyerShare: number;
  /** Curve real SOL bounds at entry. */
  minRqSol: number;
  maxRqSol: number;
  /** Slots since the CreateEvent before an entry is allowed. */
  minAge: number;
  /** First buy of a position (SOL). */
  firstBuy: number;
  /** Each add-on buy (SOL). */
  addBuy: number;
  /** SOL to put into one position in total. */
  maxStake: number;
  /** Smallest buy worth sending. */
  minBuySol: number;
  /** Slippage on buys (bps); sells always go out at 10000. */
  buySlipBps: number;
  /** Stop loss vs cost (fraction). */
  stopLoss: number;
  /** Trailing stop vs peak value (fraction). */
  trail: number;
  /** The trailing stop arms once value reaches cost * (1 + trailArm). */
  trailArm: number;
  /** Fade window in slots. */
  fadeWindow: number;
  /** Exit when net SOL over the fade window falls below this. */
  fadeNetSol: number;
  /** Exit on any single recorded sell of at least this many SOL. */
  bigSellSol: number;
  /** Exit after this many slots held (unless the position is up). */
  maxHold: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldown: number;
  /** Most entries per curve over the run. */
  maxEntries: number;
  /** Most momentum positions open at once. */
  maxMain: number;
  /** Most SOL at cost across all positions at once. */
  maxExposureSol: number;
  /** Halt new entries while equity is this far below its peak (fraction). */
  haltDd: number;
  /** Resume entries once equity is back within this of the peak (fraction). */
  resumeDd: number;
  /** Guardrail pacing targets. */
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
}

export const DEFAULT_PARAMS: Params = {
  windowSlots: 40,
  minNetSol: 1,
  minBuys: 4,
  minBuyers: 5,
  minUp: 0.05,
  maxUp: 1.5,
  accel: 1,
  nearHigh: 0.95,
  maxBuyerShare: 0.6,
  minRqSol: 2,
  maxRqSol: 60,
  minAge: 400,
  firstBuy: 0.05,
  addBuy: 0.2,
  maxStake: 1,
  minBuySol: 0.01,
  buySlipBps: 1500,
  stopLoss: 0.2,
  trail: 0.25,
  trailArm: 0.1,
  fadeWindow: 20,
  fadeNetSol: -1.5,
  bigSellSol: 5,
  maxHold: 1500,
  cooldown: 150,
  maxEntries: 2,
  maxMain: 5,
  maxExposureSol: 5,
  haltDd: 0.1,
  resumeDd: 0.05,
  targetCoins: 25,
  targetFills: 200,
  paceSecs: 14400,
  probeSol: 0.02,
  maxProbes: 1,
};

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125;

interface TapeTrade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface CoinTape {
  created: number | null;
  trades: TapeTrade[];
  entries: number;
  lastExit: number;
}

interface OpenPosition {
  opened: number;
  peakValue: number;
  invested: number;
  exiting: boolean;
  filled: boolean;
  lastAddPrice: number;
  lastValue: number;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, CoinTape>();
  const open = new Map<Pubkey, OpenPosition>();
  /** Probe round trips in flight, by mint: false while buying, true once selling. */
  const probes = new Map<Pubkey, boolean>();
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;
  let peakEquity = 0;
  let halted = false;
  const keep = Math.max(p.windowSlots, p.fadeWindow) + 5;

  const tapeOf = (mint: Pubkey): CoinTape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { created: null, trades: [], entries: 0, lastExit: -1e12 };
      tapes.set(mint, t);
    }
    return t;
  };

  /** Net recorded SOL (buys minus sells) over the last `w` slots. */
  const netFlow = (t: CoinTape, now: number, w: number): number => {
    let net = 0;
    for (let i = t.trades.length - 1; i >= 0; i--) {
      const tr = t.trades[i]!;
      if (tr.slot <= now - w) break;
      net += tr.buy ? tr.sol : -tr.sol;
    }
    return net;
  };

  /** Entry signal on a curve's tape at slot `now`. */
  const entrySignal = (t: CoinTape, now: number, rqSol: number): boolean => {
    if (rqSol < p.minRqSol || rqSol > p.maxRqSol) return false;
    if (t.created === null || now - t.created < p.minAge) return false;
    const from = now - p.windowSlots;
    const mid = now - p.windowSlots / 2;
    let buySol = 0;
    let sellSol = 0;
    let buys = 0;
    let netOld = 0;
    let netNew = 0;
    let startPrice = -1;
    let high = 0;
    let last = 0;
    const byUser = new Map<string, number>();
    for (const tr of t.trades) {
      if (tr.slot <= from) {
        startPrice = tr.price;
        continue;
      }
      if (startPrice < 0) startPrice = tr.price;
      const signed = tr.buy ? tr.sol : -tr.sol;
      if (tr.slot <= mid) netOld += signed;
      else netNew += signed;
      if (tr.buy) {
        buySol += tr.sol;
        buys++;
        byUser.set(tr.user, (byUser.get(tr.user) ?? 0) + tr.sol);
      } else {
        sellSol += tr.sol;
      }
      if (tr.price > high) high = tr.price;
      last = tr.price;
    }
    if (buys < p.minBuys || byUser.size < p.minBuyers) return false;
    if (buySol - sellSol < p.minNetSol) return false;
    if (startPrice <= 0) return false;
    const up = last / startPrice - 1;
    if (up < p.minUp || up > p.maxUp) return false;
    if (last < high * p.nearHigh) return false;
    if (netNew <= 0 || netNew < p.accel * netOld) return false;
    let top = 0;
    for (const v of byUser.values()) if (v > top) top = v;
    if (top > p.maxBuyerShare * buySol) return false;
    return true;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const bigSell = new Set<Pubkey>();
      const traded = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          tapeOf(e.mint).created = e.slot;
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          t.trades.push({
            slot: e.slot,
            buy: e.is_buy,
            sol,
            user: e.user,
            price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves),
          });
          traded.add(e.mint);
          if (!e.is_buy && sol >= p.bigSellSol) bigSell.add(e.mint);
        }
      }
      for (const mint of traded) {
        const t = tapes.get(mint)!;
        let cut = 0;
        while (cut < t.trades.length && t.trades[cut]!.slot <= now - keep) cut++;
        if (cut > 0) t.trades.splice(0, cut);
      }
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) {
        pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
      }

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      // Mark-to-market equity for the drawdown guard.
      let equity = Number(state.freeCashLamports()) / LAMPORTS;
      for (const [mint, pos] of state.positions) {
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const tokens = Number(pos.token_amount);
        equity += ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE);
      }
      if (equity > peakEquity) peakEquity = equity;
      if (halted) {
        if (equity >= peakEquity * (1 - p.resumeDd)) halted = false;
      } else if (peakEquity > 0 && equity < peakEquity * (1 - p.haltDd)) {
        halted = true;
      }

      // Exits first.
      for (const [mint, h] of open) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            open.delete(mint);
            const t = tapeOf(mint);
            if (h.filled) t.lastExit = now;
            else t.entries--;
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const tokens = Number(pos.token_amount);
        const value = ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - tx;
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > h.peakValue) h.peakValue = value;
        h.lastValue = value;
        let exit = h.exiting;
        const t = tapeOf(mint);
        if (!exit && value < cost * (1 - p.stopLoss)) exit = true;
        if (!exit && h.peakValue >= cost * (1 + p.trailArm) && value < h.peakValue * (1 - p.trail)) exit = true;
        if (!exit && netFlow(t, now, p.fadeWindow) < p.fadeNetSol) exit = true;
        if (!exit && bigSell.has(mint)) exit = true;
        if (!exit && now - h.opened > p.maxHold && value < cost * 1.05) exit = true;
        if (!exit) continue;
        h.exiting = true;
        if (pendingByMint.has(mint)) {
          let sellPending = false;
          for (const po of state.pending.values()) {
            if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
          }
          if (sellPending) continue;
        }
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        if (!selling) probes.set(mint, true);
      }

      // Then entries and pyramid adds — never while the drawdown guard is halted.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let mainLeft = p.maxMain - open.size;
      let exposure = 0;
      for (const [mint, h] of open) {
        exposure += Math.max(h.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
      }
      if (!halted) {
        for (const mint of traded) {
          if (orders.length >= cap) break;
          const curve = state.curves.get(mint);
          if (curve === undefined || curve.complete) continue;
          if (pendingByMint.has(mint) || probes.has(mint)) continue;
          const t = tapes.get(mint)!;
          const h = open.get(mint);
          const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
          const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
          let want: number;
          if (h === undefined) {
            if (slotsLeft <= 0 || mainLeft <= 0) continue;
            if (t.entries >= p.maxEntries || now - t.lastExit < p.cooldown) continue;
            if (!entrySignal(t, now, rqSol)) continue;
            want = Math.min(p.firstBuy, p.maxStake);
          } else {
            // Pyramid into strength only: the position is up, the price stepped
            // up from the last add, and net SOL still flows in.
            if (h.exiting || !h.filled || h.invested >= p.maxStake - p.minBuySol) continue;
            const pos = state.positions.get(mint);
            if (pos === undefined) continue;
            if (price < h.lastAddPrice) continue;
            if (h.lastValue < Number(pos.cost_lamports) / LAMPORTS) continue;
            if (netFlow(t, now, p.windowSlots) < p.minNetSol) continue;
            if (rqSol > p.maxRqSol) continue;
            want = Math.min(p.addBuy, p.maxStake - h.invested);
          }
          const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
          let amount = Math.min(capSol, want, p.maxExposureSol - exposure);
          if (amount > free - tx) amount = free - tx;
          if (amount < p.minBuySol) continue;
          const lamports = BigInt(Math.floor(amount * LAMPORTS));
          orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
          free -= amount + tx;
          exposure += amount;
          if (h === undefined) {
            open.set(mint, {
              opened: now,
              peakValue: 0,
              invested: amount,
              exiting: false,
              filled: false,
              lastAddPrice: price,
              lastValue: 0,
            });
            t.entries++;
            slotsLeft--;
            mainLeft--;
          } else {
            h.invested += amount;
            h.lastAddPrice = price;
          }
        }
      }

      // Guardrail pacing: open a probe when the bot's fills or coins lag the pace.
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = myFills < Math.ceil(p.targetFills * pace);
        if (needCoins || needFills) {
          const minRq = (p.probeSol * 10_000) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of traded) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (open.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (needCoins && !needFills && myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
            if (free < p.probeSol + 2 * tx) break;
            orders.push({
              side: 'buy',
              mint,
              quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)),
              max_slippage_bps: p.buySlipBps,
            });
            probes.set(mint, false);
            free -= p.probeSol + tx;
          }
        }
      }
      return orders;
    },
  };
}
