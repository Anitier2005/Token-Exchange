import { query } from '../db.js';
import { engine } from '../engine.js';

// 交易核心服务：下单（市价/限价）、撤单、撮合成交、保证金计算
// 冻结账户：已挂单不受影响（引擎照常撮合），但无法登录也无法新挂单（auth 层拦截）
// 风控账户：可登录查看，禁止新挂单（placeOrder 拦截），挂单被管理员触发风控时立即撤回

export function isWithinTradingHours(cfg) {
  const hhmm = new Date().toTimeString().slice(0, 5);
  return hhmm >= cfg.trading_start && hhmm <= cfg.trading_end;
}

export async function getCfg() {
  return (await query('SELECT * FROM exchange_config WHERE id = 1'))[0];
}

// 保证金占用信息：含挂单冻结部分
export async function marginInfo(userId) {
  const cfg = await getCfg();
  const ratio = Number(cfg.margin_ratio);
  const acc = (await query('SELECT balance FROM accounts WHERE user_id = $1', [userId]))[0];
  const balance = acc ? Number(acc.balance) : 0;
  const pos = await query('SELECT volume, avg_price FROM positions WHERE user_id = $1', [userId]);
  const used = pos.reduce((s, p) => s + p.volume * Number(p.avg_price) * ratio, 0);
  const pend = await query(
    `SELECT volume, COALESCE(limit_price, price) AS p FROM orders WHERE user_id = $1 AND status = 'pending'`,
    [userId]
  );
  const reserved = pend.reduce((s, o) => s + o.volume * Number(o.p) * ratio, 0);
  return {
    balance,
    usedMargin: +used.toFixed(2),
    reservedMargin: +reserved.toFixed(2),
    available: +(balance - used - reserved).toFixed(2),
  };
}

// 下单。返回 { order } 或抛出带 statusCode 的错误。
export async function placeOrder({ userId, userStatus, futureId, side, volume, orderType = 'market', limitPrice }) {
  const vol = Number(volume);
  if (!['long', 'short'].includes(side)) throw httpError(400, '方向不合法');
  if (!vol || vol <= 0 || !Number.isInteger(vol)) throw httpError(400, '手数必须为正整数');
  if (!['market', 'limit'].includes(orderType)) throw httpError(400, '订单类型不合法');

  // 状态权限：仅正常账户可挂单（风控禁单、冻结/注销不可登录）
  if (userStatus === 'risk_control') throw httpError(403, '账户风控中，禁止挂单');
  if (userStatus !== 'active') throw httpError(403, '账户当前状态不允许挂单');

  const lp = Number(limitPrice);
  if (orderType === 'limit' && (!lp || lp <= 0)) throw httpError(400, '限价单必须指定有效的限价');

  const cfg = await getCfg();

  if (!isWithinTradingHours(cfg)) {
    throw httpError(400, `当前不在交易时间内（${cfg.trading_start}-${cfg.trading_end}）`);
  }
  if (cfg.manual_halted) {
    throw httpError(400, `交易所已暂停交易：${cfg.halt_reason || '手动熔断'}`);
  }

  const f = (await query('SELECT * FROM futures WHERE id = $1', [Number(futureId)]))[0];
  if (!f) throw httpError(404, '期货不存在');
  if (f.status !== 'active') throw httpError(400, '该期货当前不可交易');
  if (f.halted) throw httpError(400, `该期货已熔断：${f.halt_reason}`);
  if (vol < f.min_volume) throw httpError(400, `低于交易门槛，最小手数为 ${f.min_volume}`);

  // 交易频率控制（对所有订单生效，含撤回后重新挂单）
  const last = await query(
    'SELECT created_at FROM orders WHERE user_id = $1 ORDER BY id DESC LIMIT 1', [userId]
  );
  if (last.length) {
    const elapsed = (Date.now() - new Date(last[0].created_at).getTime()) / 1000;
    if (elapsed < cfg.trade_interval_sec) {
      throw httpError(429, `交易频率超限，每 ${cfg.trade_interval_sec} 秒最多一笔`);
    }
  }

  const ratio = Number(cfg.margin_ratio);
  const feeRate = Number(cfg.fee_rate);

  if (orderType === 'market') {
    // ---- 市价单：立即成交 ----
    const price = engine.priceOf(f.id) ?? Number(f.last_price);
    const margin = await marginInfo(userId);
    const need = +(price * vol * ratio + price * vol * feeRate).toFixed(6);
    if (margin.available < need) {
      throw httpError(400, `保证金不足：需 ${need}，可用 ${margin.available}`);
    }
    const rows = await query(
      `INSERT INTO orders (user_id, future_id, side, order_type, price, volume, status, filled_at)
       VALUES ($1,$2,$3,'market',$4,$5,'filled', now()) RETURNING *`,
      [userId, f.id, side, price, vol]
    );
    const result = await fillOrder(rows[0], price);
    return { order: result.order, message: result.message };
  }

  // ---- 限价单：挂出等待撮合 ----
  const margin = await marginInfo(userId);
  const reserve = +(lp * vol * ratio).toFixed(6);
  if (margin.available < reserve) {
    throw httpError(400, `保证金不足：挂单需冻结 ${reserve}，可用 ${margin.available}`);
  }
  const rows = await query(
    `INSERT INTO orders (user_id, future_id, side, order_type, limit_price, price, volume, status)
     VALUES ($1,$2,$3,'limit',$4,$4,$5,'pending') RETURNING *`,
    [userId, f.id, side, lp, vol]
  );
  return {
    order: rows[0],
    message: `限价单已挂出：${side === 'long' ? '买入' : '卖出'} ${vol} 手 @ ${lp}，等待价格触发`,
  };
}

// 撮合成交（市价即时路径与引擎 tick 路径共用）
export async function fillOrder(order, fillPrice) {
  const cfg = await getCfg();
  const vol = order.volume;
  const feeRate = Number(cfg.fee_rate);
  const taxRate = Number(cfg.tax_rate);
  const oppo = order.side === 'long' ? 'short' : 'long';

  const ownPos = (await query(
    'SELECT * FROM positions WHERE user_id = $1 AND future_id = $2 AND side = $3',
    [order.user_id, order.future_id, order.side]
  ))[0];
  const oppoPos = (await query(
    'SELECT * FROM positions WHERE user_id = $1 AND future_id = $2 AND side = $3',
    [order.user_id, order.future_id, oppo]
  ))[0];

  let openVol = vol;
  let closeVol = 0;
  let realizedPnl = 0;
  if (oppoPos) {
    closeVol = Math.min(vol, oppoPos.volume);
    openVol = vol - closeVol;
    const diff = oppo === 'short'
      ? Number(oppoPos.avg_price) - fillPrice
      : fillPrice - Number(oppoPos.avg_price);
    realizedPnl = +(diff * closeVol).toFixed(6);
  }

  const fee = +(fillPrice * vol * feeRate).toFixed(6);
  const tax = +(Math.max(0, realizedPnl) * taxRate).toFixed(6);

  await query(
    'UPDATE accounts SET balance = balance - $1, updated_at = now() WHERE user_id = $2',
    [fee + tax, order.user_id]
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
      const newAvg = (Number(ownPos.avg_price) * ownPos.volume + fillPrice * openVol) / totalVol;
      await query('UPDATE positions SET volume = $1, avg_price = $2 WHERE id = $3', [totalVol, newAvg, ownPos.id]);
    } else {
      await query(
        'INSERT INTO positions (user_id, future_id, side, volume, avg_price) VALUES ($1,$2,$3,$4,$5)',
        [order.user_id, order.future_id, order.side, openVol, fillPrice]
      );
    }
  }

  const updated = (await query(
    `UPDATE orders SET status='filled', price=$1, fee=$2, tax=$3, realized_pnl=$4, filled_at=now()
     WHERE id=$5 RETURNING *`,
    [fillPrice, fee, tax, realizedPnl, order.id]
  ))[0];

  // 成交事件推动行情价格（真实引擎：价格仅在这里变化）
  try {
    await engine.onFill({
      futureId: order.future_id,
      side: order.side,
      fillPrice,
      volume: order.volume,
    });
  } catch (e) {
    console.error(`[trading] onFill error:`, e.message);
  }

  const message = closeVol > 0
    ? `成交：开仓 ${openVol} 手，平仓 ${closeVol} 手${realizedPnl >= 0 ? '，盈利' : '，亏损'} ${Math.abs(realizedPnl).toFixed(2)}`
    : `成交：开仓 ${vol} 手 @ ${fillPrice}`;

  return { order: updated, openVol, closeVol, realizedPnl, fee, tax, message };
}

// 撤单（仅限挂出的限价单）
export async function cancelOrder(orderId, userId) {
  const o = (await query('SELECT * FROM orders WHERE id = $1 AND user_id = $2', [Number(orderId), userId]))[0];
  if (!o) throw httpError(404, '订单不存在');
  if (o.status !== 'pending') throw httpError(400, '仅挂出中的限价单可撤回');
  await query(`UPDATE orders SET status='cancelled' WHERE id = $1`, [o.id]);
  return { ok: true, order: { id: o.id, status: 'cancelled' } };
}

// 撤回某用户全部挂单（风控触发时调用）
export async function cancelAllPending(userId) {
  const rows = await query(
    `UPDATE orders SET status='cancelled' WHERE user_id = $1 AND status = 'pending' RETURNING id`,
    [userId]
  );
  return rows.length;
}

// 引擎撮合：市价穿越限价即成交
// 多单（买入）：最新价 <= 限价 成交；空单（卖出）：最新价 >= 限价 成交
export async function matchPendingOrders() {
  const pend = await query(
    `SELECT o.*, f.halted FROM orders o JOIN futures f ON f.id = o.future_id
     WHERE o.status = 'pending' AND f.status = 'active'`
  );
  const results = [];
  for (const o of pend) {
    if (o.halted) continue;
    const price = engine.priceOf(o.future_id);
    if (price == null) continue;
    const lp = Number(o.limit_price);
    const crossed = o.side === 'long' ? price <= lp : price >= lp;
    if (crossed) {
      try {
        const r = await fillOrder(o, price);
        results.push({ orderId: o.id, ...r });
      } catch (e) {
        console.error(`[match] fill order ${o.id} failed:`, e.message);
      }
    }
  }
  return results;
}

export function httpError(statusCode, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}
