import { query } from '../db.js';
import { authHook, roleRequired } from '../auth.js';
import { engine } from '../engine.js';
import { placeOrder, cancelOrder, marginInfo, httpError } from '../services/trading.js';

const traderOnly = [authHook, roleRequired('trader')];

export default async function traderRoutes(app) {
  // 保证金账户（含挂单冻结）
  app.get('/api/trader/account', { preHandler: traderOnly }, async (req) => {
    const m = await marginInfo(req.user.id);
    return m;
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

  // 下单（市价单立即成交；限价单挂出等待引擎撮合）
  app.post('/api/trader/orders', { preHandler: traderOnly }, async (req, reply) => {
    try {
      const { futureId, side, volume, orderType, limitPrice } = req.body || {};
      const result = await placeOrder({
        userId: req.user.id,
        userStatus: req.user.status,
        futureId, side, volume,
        orderType: orderType || 'market',
        limitPrice,
      });
      return result;
    } catch (e) {
      if (e.statusCode) return reply.code(e.statusCode).send({ error: e.message });
      throw e;
    }
  });

  // 撤单（仅挂出中的限价单）
  app.post('/api/trader/orders/:id/cancel', { preHandler: traderOnly }, async (req, reply) => {
    try {
      const res = await cancelOrder(req.params.id, req.user.id);
      return { ...res, message: '挂单已撤回，冻结保证金已释放' };
    } catch (e) {
      if (e.statusCode) return reply.code(e.statusCode).send({ error: e.message });
      throw e;
    }
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
