import { query } from '../db.js';
import { authHook, roleRequired } from '../auth.js';
import { engine } from '../engine.js';

const traderOnly = [authHook, roleRequired('trader')];

function isWithinTradingHours(cfg) {
  const hhmm = new Date().toTimeString().slice(0, 5);
  return hhmm >= cfg.trading_start && hhmm <= cfg.trading_end;
}

export default async function traderRoutes(app) {
  // 保证金账户
  app.get('/api/trader/account', { preHandler: traderOnly }, async (req) => {
    const rows = await query('SELECT balance FROM accounts WHERE user_id = $1', [req.user.id]);
    const pos = await query('SELECT volume, avg_price FROM positions WHERE user_id = $1', [req.user.id]);
    const cfg = (await query('SELECT * FROM exchange_config WHERE id = 1'))[0];
    const used = pos.reduce((s, p) => s + p.volume * Number(p.avg_price) * Number(cfg.margin_ratio), 0);
    const balance = rows.length ? Number(rows[0].balance) : 0;
    return { balance, usedMargin: +used.toFixed(2), available: +(balance - used).toFixed(2) };
  });

  // 虚拟充值（充多少有多少）
  app.post('/api/trader/recharge', { preHandler: traderOnly }, async (req, reply) => {
    const amount = Number(req.body?.amount);
    if (!amount || amount <= 0) return reply.code(400).send({ error: '充值金额必须大于 0' });
    await query(
      `INSERT INTO accounts (user_id, balance) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET balance = accounts.balance + $2, updated_at = now()`,
      [req.user.id, amount]
    );
    const rows = await query('SELECT balance FROM accounts WHERE user_id = $1', [req.user.id]);
    return { balance: Number(rows[0].balance) };
  });

  // 下单（市价单：做多 / 做空）
  app.post('/api/trader/orders', { preHandler: traderOnly }, async (req, reply) => {
    const { futureId, side, volume } = req.body || {};
    const vol = Number(volume);
    if (!['long', 'short'].includes(side)) return reply.code(400).send({ error: '方向不合法' });
    if (!vol || vol <= 0 || !Number.isInteger(vol)) return reply.code(400).send({ error: '手数必须为正整数' });

    const cfg = (await query('SELECT * FROM exchange_config WHERE id = 1'))[0];

    // 交易时间
    if (!isWithinTradingHours(cfg)) {
      return reply.code(400).send({ error: `当前不在交易时间内（${cfg.trading_start}-${cfg.trading_end}）` });
    }
    // 手动熔断
    if (cfg.manual_halted) {
      return reply.code(400).send({ error: `交易所已暂停交易：${cfg.halt_reason || '手动熔断'}` });
    }

    const futures = await query('SELECT * FROM futures WHERE id = $1', [Number(futureId)]);
    const f = futures[0];
    if (!f) return reply.code(404).send({ error: '期货不存在' });
    if (f.status !== 'active') return reply.code(400).send({ error: '该期货当前不可交易' });
    if (f.halted) return reply.code(400).send({ error: `该期货已熔断：${f.halt_reason}` });

    // 交易门槛
    if (vol < f.min_volume) {
      return reply.code(400).send({ error: `低于交易门槛，最小手数为 ${f.min_volume}` });
    }

    // 交易频率控制
    const last = await query(
      'SELECT created_at FROM orders WHERE user_id = $1 ORDER BY id DESC LIMIT 1', [req.user.id]
    );
    if (last.length) {
      const elapsed = (Date.now() - new Date(last[0].created_at).getTime()) / 1000;
      if (elapsed < cfg.trade_interval_sec) {
        return reply.code(429).send({ error: `交易频率超限，每 ${cfg.trade_interval_sec} 秒最多一笔` });
      }
    }

    const price = engine.priceOf(f.id) ?? Number(f.last_price);

    // 持仓处理：同向加仓，反向平仓
    const oppo = side === 'long' ? 'short' : 'long';
    const ownPos = (await query(
      'SELECT * FROM positions WHERE user_id = $1 AND future_id = $2 AND side = $3',
      [req.user.id, f.id, side]
    ))[0];
    const oppoPos = (await query(
      'SELECT * FROM positions WHERE user_id = $1 AND future_id = $2 AND side = $3',
      [req.user.id, f.id, oppo]
    ))[0];

    let openVol = vol;
    let closeVol = 0;
    if (oppoPos) {
      closeVol = Math.min(vol, oppoPos.volume);
      openVol = vol - closeVol;
    }

    const marginRatio = Number(cfg.margin_ratio);
    const feeRate = Number(cfg.fee_rate);
    const taxRate = Number(cfg.tax_rate);

    // 手续费（按全部成交金额）
    const fee = +(price * vol * feeRate).toFixed(6);
    // 平仓部分已实现盈亏
    let realizedPnl = 0;
    if (closeVol > 0) {
      const diff = oppo === 'short'
        ? Number(oppoPos.avg_price) - price
        : price - Number(oppoPos.avg_price);
      realizedPnl = +(diff * closeVol).toFixed(6);
    }
    // 税费：对已实现盈利征收
    const tax = +(Math.max(0, realizedPnl) * taxRate).toFixed(6);

    // 保证金：仅开仓部分占用；可用余额需覆盖 增量保证金 + 手续费 + 税
    const addMargin = +(price * openVol * marginRatio).toFixed(6);
    const acc = (await query('SELECT balance FROM accounts WHERE user_id = $1', [req.user.id]))[0];
    const balance = acc ? Number(acc.balance) : 0;
    const allPos = await query('SELECT volume, avg_price FROM positions WHERE user_id = $1', [req.user.id]);
    let used = allPos.reduce((s, p) => s + p.volume * Number(p.avg_price) * marginRatio, 0);
    if (oppoPos) used -= oppoPos.volume * Number(oppoPos.avg_price) * marginRatio;
    const released = oppoPos ? +(closeVol * Number(oppoPos.avg_price) * marginRatio).toFixed(6) : 0;
    const need = +(addMargin + fee + tax).toFixed(6);
    const available = +(balance - used + released).toFixed(6);
    if (available < need) {
      return reply.code(400).send({ error: `保证金不足：需 ${need}，可用 ${available}` });
    }

    // ---- 落库 ----
    await query('UPDATE accounts SET balance = balance - $1, updated_at = now() WHERE user_id = $2', [fee + tax, req.user.id]);

    const orderRows = await query(
      `INSERT INTO orders (user_id, future_id, side, price, volume, fee, tax, realized_pnl)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [req.user.id, f.id, side, price, vol, fee, tax, realizedPnl]
    );

    if (oppoPos) {
      const remain = oppoPos.volume - closeVol;
      if (remain === 0) {
        await query('DELETE FROM positions WHERE id = $1', [oppoPos.id]);
      } else {
        await query('UPDATE positions SET volume = $1 WHERE id = $2', [remain, oppoPos.id]);
      }
    }
    if (openVol > 0) {
      if (ownPos) {
        const totalVol = ownPos.volume + openVol;
        const newAvg = (Number(ownPos.avg_price) * ownPos.volume + price * openVol) / totalVol;
        await query('UPDATE positions SET volume = $1, avg_price = $2 WHERE id = $3', [totalVol, newAvg, ownPos.id]);
      } else {
        await query(
          'INSERT INTO positions (user_id, future_id, side, volume, avg_price) VALUES ($1,$2,$3,$4,$5)',
          [req.user.id, f.id, side, openVol, price]
        );
      }
    }

    return {
      order: orderRows[0],
      openVol,
      closeVol,
      realizedPnl,
      fee,
      tax,
      message: closeVol > 0
        ? `成交：开仓 ${openVol} 手，平仓 ${closeVol} 手${realizedPnl >= 0 ? '，盈利' : '，亏损'} ${Math.abs(realizedPnl).toFixed(2)}`
        : `成交：开仓 ${vol} 手`,
    };
  });

  app.get('/api/trader/orders', { preHandler: traderOnly }, async (req) => {
    return query(
      `SELECT o.*, f.code, f.name FROM orders o JOIN futures f ON f.id = o.future_id
       WHERE o.user_id = $1 ORDER BY o.id DESC LIMIT 100`, [req.user.id]
    );
  });

  app.get('/api/trader/positions', { preHandler: traderOnly }, async (req) => {
    const rows = await query(
      `SELECT p.*, f.code, f.name FROM positions p JOIN futures f ON f.id = p.future_id
       WHERE p.user_id = $1 ORDER BY p.id`, [req.user.id]
    );
    return rows.map((p) => {
      const price = engine.priceOf(p.future_id) ?? Number(p.avg_price);
      const diff = p.side === 'long' ? price - Number(p.avg_price) : Number(p.avg_price) - price;
      return {
        ...p,
        lastPrice: price,
        floatPnl: +(diff * p.volume).toFixed(2),
        floatPnlPct: +(diff / Number(p.avg_price) * 100).toFixed(2),
      };
    });
  });
}
