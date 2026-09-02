import { EventEmitter } from 'node:events';
import { query } from './db.js';
import { runMonthlySettlement } from './services/settlement.js';
import { matchPendingOrders } from './services/trading.js';

// 真实交易引擎：价格仅由"成交"事件驱动。无成交则价格绝对静止。
// 市价多单 → 按方向吃掉卖盘深度（hands_per_tick 手/tick），价格向上推动；
// 市价空单 → 吃掉买盘深度，价格向下推动。
// 没有 tick 随机游走。行情快照按管理员配置频率广播。
class MarketEngine extends EventEmitter {
  constructor() {
    super();
    this.state = new Map();
    // futureId -> {
    //   price, dayOpen, prevClose, dayHigh, dayLow, basePrice,
    //   tickSize, handsPerTick, ticks, date, halted, haltReason
    // }
    this.config = null;
    this.timer = null;
    this.currentDate = null;
    this.tickCount = 0;
    this.matchCount = 0;
    this.lastTickAt = 0;
  }

  async loadConfig() {
    const rows = await query('SELECT * FROM exchange_config WHERE id = 1');
    this.config = rows[0];
    return this.config;
  }

  async start() {
    await this.loadConfig();
    const futures = await query(
      `SELECT id, last_price, prev_close, day_open, day_high, day_low, tick_size, hands_per_tick, halted, halt_reason FROM futures WHERE status <> 'delisted'`
    );
    const today = new Date().toISOString().slice(0, 10);
    for (const f of futures) {
      const last = Number(f.last_price);
      this.state.set(f.id, {
        price: last,
        dayOpen: Number(f.day_open || f.last_price),
        prevClose: Number(f.prev_close || f.last_price),
        dayHigh: f.day_high ? Number(f.day_high) : last,
        dayLow: f.day_low ? Number(f.day_low) : last,
        tickSize: Number(f.tick_size),
        handsPerTick: Number(f.hands_per_tick),
        basePrice: last,
        ticks: [{ price: last, ts: Date.now(), vol: 0 }],
        date: today,
        halted: f.halted,
        haltReason: f.halt_reason,
      });
    }
    this.currentDate = today;
    // tick 线程：只负责：日期切换、限价单撮合、熔断、广播快照。不再修改价格。
    this.timer = setInterval(() => this.tick(), 500);
    console.log(`[engine] started, ${futures.length} futures loaded. price driven by fills only.`);
  }

  async reloadConfig() {
    await this.loadConfig();
  }

  quoteOf(future) {
    const s = this.state.get(future.id);
    const price = s ? s.price : Number(future.last_price);
    const prevClose = s ? s.prevClose : Number(future.prev_close);
    const change = price - prevClose;
    return {
      id: future.id,
      code: future.code,
      ticker: future.ticker,
      name: future.name,
      model: future.model,
      metric: future.metric,
      price,
      prevClose,
      dayOpen: s ? s.dayOpen : Number(future.day_open),
      dayHigh: s ? s.dayHigh : Number(future.day_high),
      dayLow: s ? s.dayLow : Number(future.day_low),
      change,
      changePct: prevClose ? +(change / prevClose * 100).toFixed(2) : 0,
      tickSize: s ? s.tickSize : Number(future.tick_size),
      handsPerTick: s ? s.handsPerTick : Number(future.hands_per_tick),
      halted: s ? s.halted : future.halted,
      haltReason: s ? s.haltReason : future.halt_reason,
    };
  }

  priceOf(futureId) {
    const s = this.state.get(futureId);
    return s ? s.price : null;
  }

  async setHalted(futureId, halted, reason = null) {
    const s = this.state.get(futureId);
    if (s) {
      s.halted = halted;
      s.haltReason = reason;
    }
    await query('UPDATE futures SET halted = $1, halt_reason = $2 WHERE id = $3', [halted, reason, futureId]);
  }

  async setBasePrice(futureId, price) {
    const s = this.state.get(futureId);
    if (s) s.basePrice = price;
  }

  // 合约盘面的最小 tick 深度
  _tickSize(s) {
    // 使用合约设定的 tick_size；如果是 0 就按当前价的 0.01% 兜底
    return s.tickSize > 0 ? s.tickSize : Math.max(0.000001, s.price * 0.0001);
  }

  // 成交事件：真实价格变动的唯一来源
  // 按成交方向与手数，逐级"吃掉" N 档卖/买盘（每档 = handsPerTick 手 = 1 tick_size 价差）
  async onFill({ futureId, side, fillPrice, volume }) {
    const s = this.state.get(futureId);
    if (!s) return fillPrice;
    const step = this._tickSize(s);
    const hpt = Math.max(1, s.handsPerTick);
    // 该笔成交价需要推动的档位
    const steps = Math.ceil(Number(volume) / hpt);
    let newPrice = Number(fillPrice);
    const dirMul = side === 'long' ? +1 : -1;
    newPrice = +(newPrice + dirMul * steps * step).toFixed(6);
    if (newPrice < step) newPrice = step; // 最小值保护

    s.price = newPrice;
    if (!s.dayHigh || newPrice > s.dayHigh) s.dayHigh = newPrice;
    if (!s.dayLow || newPrice < s.dayLow) s.dayLow = newPrice;
    s.ticks.push({ price: newPrice, ts: Date.now(), vol: Number(volume) });
    if (s.ticks.length > 1200) s.ticks.splice(0, s.ticks.length - 1200);

    // 落库到 futures
    await query(
      'UPDATE futures SET last_price = $1, day_high = COALESCE(day_high, $1), day_low = COALESCE(day_low, $1), day_high = GREATEST(day_high, $1), day_low = LEAST(day_low, $1) WHERE id = $2',
      [newPrice, futureId]
    );
    return newPrice;
  }

  async tick() {
    try {
      this.tickCount++;
      this.lastTickAt = Date.now();
      const cfg = this.config;
      const today = new Date().toISOString().slice(0, 10);
      if (today !== this.currentDate) {
        this.currentDate = today;
        for (const [id, s] of this.state) {
          s.prevClose = s.price;
          s.dayOpen = s.price;
          s.dayHigh = s.price;
          s.dayLow = s.price;
          s.ticks = [{ price: s.price, ts: Date.now(), vol: 0 }];
          await query(
            'UPDATE futures SET prev_close = $1, day_open = $1, day_high = $1, day_low = $1 WHERE id = $2',
            [s.price, id]
          );
        }
        await this.maybeAutoSettle();
      }

      const futures = await query(`SELECT id, code FROM futures WHERE status = 'active'`);

      // 仅撮合限价单（撮合可能产生 fillOrder → 调 onFill → 推价）
      const matched = await matchPendingOrders();
      this.matchCount += matched.length;

      // 熔断检查（相对 day_open）
      if (cfg?.circuit_breaker_enabled) {
        for (const f of futures) {
          const s = this.state.get(f.id);
          if (!s || s.halted || cfg.manual_halted) continue;
          if (s.dayOpen) {
            const pct = Math.abs(s.price - s.dayOpen) / s.dayOpen;
            if (pct >= Number(cfg.circuit_breaker_pct)) {
              const dir = s.price > s.dayOpen ? '上涨' : '下跌';
              await this.setHalted(f.id, true, `自动熔断：日内${dir} ${(pct * 100).toFixed(2)}% 达到阈值`);
              console.log(`[engine] circuit breaker triggered on ${f.code}`);
            }
          }
        }
      }

      // 广播 L1 快照（频率靠订阅侧节流；这里每次 tick 都 emit 一个事件）
      const snapshot = futures
        .map((f) => (this.state.has(f.id) ? this.quoteOf(f) : null))
        .filter(Boolean);
      this.emit('l1', snapshot, Date.now());
    } catch (err) {
      console.error('[engine] tick error:', err.message);
    }
  }

  async maybeAutoSettle() {
    const month = new Date().toISOString().slice(0, 7);
    if (this.config.last_settled_month !== month) {
      const prev = new Date();
      prev.setMonth(prev.getMonth() - 1);
      const prevMonth = prev.toISOString().slice(0, 7);
      console.log(`[engine] auto monthly settlement for ${prevMonth}`);
      await runMonthlySettlement(prevMonth);
      await query('UPDATE exchange_config SET last_settled_month = $1 WHERE id = 1', [month]);
      await this.loadConfig();
    }
  }

  // 5 档深度盘（确定性盘口：离最新价越近，档位量越大）
  depthOf(future) {
    const s = this.state.get(future.id);
    const price = s ? s.price : Number(future.last_price);
    const step = s ? this._tickSize(s) : Math.max(0.000001, price * 0.0001);
    const hpt = s ? Math.max(1, s.handsPerTick) : 10;
    const asks = [];
    const bids = [];
    for (let i = 1; i <= 5; i++) {
      // 档位成交量：越远越少（倒三角深度），基量 5 × hpt
      const volBase = 5 * hpt;
      const vol = Math.max(hpt, Math.floor(volBase / i));
      asks.push({ level: i, price: +(price + step * i).toFixed(6), volume: vol });
      bids.push({ level: i, price: +(price - step * i).toFixed(6), volume: vol });
    }
    return {
      futureId: future.id, code: future.code, name: future.name,
      price, tickSize: +step.toFixed(6), handsPerTick: hpt,
      asks, bids, ts: Date.now(),
    };
  }

  ticksOf(futureId, limit = 120) {
    const s = this.state.get(futureId);
    if (!s) return [];
    return s.ticks.slice(-limit);
  }

  health() {
    return {
      tickCount: this.tickCount,
      matchCount: this.matchCount,
      lastTickAt: this.lastTickAt,
      lastTickAgoMs: this.lastTickAt ? Date.now() - this.lastTickAt : null,
      trackedFutures: this.state.size,
      haltedFutures: [...this.state.values()].filter((s) => s.halted).length,
    };
  }
}

export const engine = new MarketEngine();
