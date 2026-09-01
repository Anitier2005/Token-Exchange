import { EventEmitter } from 'node:events';
import { query } from './db.js';
import { runMonthlySettlement } from './services/settlement.js';

// 行情引擎：生成价格随机游动 tick、维护日内基准、触发熔断、广播 L1/L2 数据
class MarketEngine extends EventEmitter {
  constructor() {
    super();
    this.state = new Map(); // futureId -> { price, dayOpen, prevClose, ticks: [], date, halted, haltReason }
    this.config = null;
    this.timer = null;
    this.currentDate = null;
  }

  async loadConfig() {
    const rows = await query('SELECT * FROM exchange_config WHERE id = 1');
    this.config = rows[0];
    return this.config;
  }

  async start() {
    await this.loadConfig();
    const futures = await query(
      `SELECT id, last_price, prev_close, day_open, halted, halt_reason FROM futures WHERE status <> 'delisted'`
    );
    const today = new Date().toISOString().slice(0, 10);
    for (const f of futures) {
      this.state.set(f.id, {
        price: Number(f.last_price),
        dayOpen: Number(f.day_open || f.last_price),
        prevClose: Number(f.prev_close || f.last_price),
        ticks: [{ price: Number(f.last_price), ts: Date.now() }],
        date: today,
        halted: f.halted,
        haltReason: f.halt_reason,
      });
    }
    this.currentDate = today;
    this.timer = setInterval(() => this.tick(), 1000);
    console.log(`[engine] started, ${futures.length} futures loaded`);
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
      name: future.name,
      price,
      prevClose,
      change,
      changePct: prevClose ? +(change / prevClose * 100).toFixed(2) : 0,
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

  // 提供方设置新基准价
  async setBasePrice(futureId, price) {
    const s = this.state.get(futureId);
    if (s) s.basePrice = price;
  }

  async tick() {
    try {
      const cfg = this.config;
      // 日期切换：结转 prevClose / dayOpen，并触发上月自动结算
      const today = new Date().toISOString().slice(0, 10);
      if (today !== this.currentDate) {
        this.currentDate = today;
        for (const [id, s] of this.state) {
          s.prevClose = s.price;
          s.dayOpen = s.price;
          await query('UPDATE futures SET prev_close = $1, day_open = $1 WHERE id = $2', [s.price, id]);
        }
        await this.maybeAutoSettle();
      }

      const futures = await query(`SELECT id, code FROM futures WHERE status = 'active'`);
      const now = Date.now();
      for (const f of futures) {
        const s = this.state.get(f.id);
        if (!s) continue;
        if (s.halted || cfg.manual_halted) continue; // 熔断/手动暂停期间价格冻结
        // 随机游动（围绕提供方基准价均值回复）
        const base = s.basePrice || s.prevClose;
        const sigma = Number(cfg.tick_volatility);
        const drift = (base - s.price) * 0.05;
        const shock = (Math.random() * 2 - 1) * sigma * s.price;
        s.price = Math.max(0.000001, +(s.price + drift + shock).toFixed(6));
        s.ticks.push({ price: s.price, ts: now });
        if (s.ticks.length > 600) s.ticks.shift();

        // 熔断检测：相对 day_open 波动超阈值
        if (cfg.circuit_breaker_enabled && s.dayOpen) {
          const pct = Math.abs(s.price - s.dayOpen) / s.dayOpen;
          if (pct >= Number(cfg.circuit_breaker_pct)) {
            const dir = s.price > s.dayOpen ? '上涨' : '下跌';
            await this.setHalted(f.id, true, `自动熔断：日内${dir} ${(pct * 100).toFixed(2)}% 达到阈值`);
            console.log(`[engine] circuit breaker triggered on ${f.code}`);
          }
        }
      }

      // 广播行情（L1）
      const snapshot = futures
        .map((f) => (this.state.has(f.id) ? this.quoteOf(f) : null))
        .filter(Boolean);
      this.emit('l1', snapshot, now);
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

  // 生成 L2 深度盘（5 档）
  depthOf(future) {
    const s = this.state.get(future.id);
    const price = s ? s.price : Number(future.last_price);
    const asks = [];
    const bids = [];
    for (let i = 1; i <= 5; i++) {
      const gap = price * 0.0005 * i;
      asks.push({
        level: i,
        price: +(price + gap).toFixed(6),
        volume: Math.floor(50 + Math.random() * 500 * (6 - i)),
      });
      bids.push({
        level: i,
        price: +(price - gap).toFixed(6),
        volume: Math.floor(50 + Math.random() * 500 * (6 - i)),
      });
    }
    return { futureId: future.id, code: future.code, name: future.name, price, asks, bids, ts: Date.now() };
  }

  ticksOf(futureId, limit = 120) {
    const s = this.state.get(futureId);
    if (!s) return [];
    return s.ticks.slice(-limit);
  }
}

export const engine = new MarketEngine();
