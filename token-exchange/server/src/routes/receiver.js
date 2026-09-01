import crypto from 'node:crypto';
import { query } from '../db.js';
import { authHook, roleRequired } from '../auth.js';

const receiverOnly = [authHook, roleRequired('receiver')];

export default async function receiverRoutes(app) {
  app.get('/api/receiver/account', { preHandler: receiverOnly }, async (req) => {
    const rows = await query('SELECT balance FROM accounts WHERE user_id = $1', [req.user.id]);
    return { balance: rows.length ? Number(rows[0].balance) : 0 };
  });

  app.post('/api/receiver/recharge', { preHandler: receiverOnly }, async (req, reply) => {
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

  // 可订阅的期货（含月费信息）
  app.get('/api/receiver/futures', { preHandler: receiverOnly }, async (req) => {
    return query(
      `SELECT f.id, f.code, f.name, f.description, f.monthly_fee, f.monthly_quota_tokens,
              f.overage_price_per_1k, u.display_name AS provider_name,
              EXISTS(SELECT 1 FROM subscriptions s WHERE s.receiver_id = $1 AND s.future_id = f.id AND s.status = 'active') AS subscribed
       FROM futures f LEFT JOIN users u ON u.id = f.provider_id
       WHERE f.status = 'active' ORDER BY f.id`, [req.user.id]
    );
  });

  // 订阅（生成统一接口密钥）
  app.post('/api/receiver/subscriptions', { preHandler: receiverOnly }, async (req, reply) => {
    const { futureId } = req.body || {};
    const f = (await query('SELECT * FROM futures WHERE id = $1 AND status = $2', [Number(futureId), 'active']))[0];
    if (!f) return reply.code(404).send({ error: '期货不存在或未上市' });
    const exists = await query(
      'SELECT * FROM subscriptions WHERE receiver_id = $1 AND future_id = $2 AND status = $3',
      [req.user.id, f.id, 'active']
    );
    if (exists.length) return reply.code(409).send({ error: '已订阅该期货' });
    const apiKey = 'tex-' + crypto.randomBytes(20).toString('hex');
    await query(
      'INSERT INTO subscriptions (receiver_id, future_id, api_key) VALUES ($1,$2,$3)',
      [req.user.id, f.id, apiKey]
    );
    return { apiKey };
  });

  app.get('/api/receiver/subscriptions', { preHandler: receiverOnly }, async (req) => {
    return query(
      `SELECT s.id, s.api_key, s.status, s.created_at, f.id AS future_id, f.code, f.name,
              f.monthly_fee, f.monthly_quota_tokens, f.overage_price_per_1k
       FROM subscriptions s JOIN futures f ON f.id = s.future_id
       WHERE s.receiver_id = $1 ORDER BY s.id DESC`, [req.user.id]
    );
  });

  app.post('/api/receiver/subscriptions/:id/regenerate-key', { preHandler: receiverOnly }, async (req, reply) => {
    const apiKey = 'tex-' + crypto.randomBytes(20).toString('hex');
    const rows = await query(
      'UPDATE subscriptions SET api_key = $1 WHERE id = $2 AND receiver_id = $3 RETURNING *',
      [apiKey, Number(req.params.id), req.user.id]
    );
    if (!rows.length) return reply.code(404).send({ error: '订阅不存在' });
    return { apiKey: rows[0].api_key };
  });

  app.post('/api/receiver/subscriptions/:id/cancel', { preHandler: receiverOnly }, async (req, reply) => {
    const rows = await query(
      'UPDATE subscriptions SET status = $1 WHERE id = $2 AND receiver_id = $3 RETURNING *',
      ['cancelled', Number(req.params.id), req.user.id]
    );
    if (!rows.length) return reply.code(404).send({ error: '订阅不存在' });
    return { ok: true };
  });

  // 本月用量（按订阅）
  app.get('/api/receiver/usage', { preHandler: receiverOnly }, async (req) => {
    const month = new Date().toISOString().slice(0, 7);
    const rows = await query(
      `SELECT s.id AS subscription_id, f.code, f.name, f.monthly_quota_tokens,
              COALESCE(SUM(u.tokens) FILTER (WHERE to_char(u.created_at,'YYYY-MM') = $2), 0) AS month_tokens,
              COALESCE(SUM(u.tokens), 0) AS total_tokens
       FROM subscriptions s JOIN futures f ON f.id = s.future_id
       LEFT JOIN usage_log u ON u.future_id = s.future_id AND u.receiver_id = s.receiver_id
       WHERE s.receiver_id = $1 AND s.status = 'active'
       GROUP BY s.id, f.code, f.name, f.monthly_quota_tokens`,
      [req.user.id, month]
    );
    return rows.map((r) => ({ ...r, month }));
  });

  // 月度结转账单
  app.get('/api/receiver/settlements', { preHandler: receiverOnly }, async (req) => {
    return query(
      `SELECT s.*, f.code, f.name FROM settlements s LEFT JOIN futures f ON f.id = s.future_id
       WHERE s.user_id = $1 AND s.type = 'receiver' ORDER BY s.period DESC, s.id DESC`, [req.user.id]
    );
  });
}
