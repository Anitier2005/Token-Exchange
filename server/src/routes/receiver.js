import crypto from 'node:crypto';
import { query } from '../db.js';
import { authHook, roleRequired } from '../auth.js';

const receiverOnly = [authHook, roleRequired('receiver')];

const METRIC_LABELS = {
  cache_miss_input: '缓存未命中输入',
  cache_hit_input: '缓存命中输入',
  output: '输出',
  call_count: '调用次数',
};

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

  // 可订阅的模型（每个模型含 4 个指标合约）
  app.get('/api/receiver/models', { preHandler: receiverOnly }, async (req) => {
    const rows = await query(
      `SELECT f.*, u.display_name AS provider_name,
              EXISTS(SELECT 1 FROM subscriptions s WHERE s.receiver_id = $1 AND s.model = f.model AND s.status = 'active') AS subscribed
       FROM futures f LEFT JOIN users u ON u.id = f.provider_id
       WHERE f.status = 'active' ORDER BY f.model, f.metric`, [req.user.id]
    );
    const groups = new Map();
    for (const f of rows) {
      if (!groups.has(f.model)) {
        groups.set(f.model, {
          model: f.model,
          providerId: f.provider_id,
          providerName: f.provider_name,
          description: f.description,
          monthlyFee: Number(f.monthly_fee),
          monthlyQuotaTokens: Number(f.monthly_quota_tokens),
          overagePricePer1k: Number(f.overage_price_per_1k),
          subscribed: f.subscribed,
          contracts: [],
        });
      }
      const g = groups.get(f.model);
      g.monthlyFee = Math.max(g.monthlyFee, Number(f.monthly_fee));
      g.subscribed = g.subscribed || f.subscribed;
      g.contracts.push({
        id: f.id,
        code: f.code,
        name: f.name,
        metric: f.metric,
        metricLabel: METRIC_LABELS[f.metric] || f.metric,
      });
    }
    return [...groups.values()];
  });

  // 订阅模型（生成统一接口密钥）
  app.post('/api/receiver/subscriptions', { preHandler: receiverOnly }, async (req, reply) => {
    const { model } = req.body || {};
    if (!model) return reply.code(400).send({ error: 'model 必填' });
    const futs = await query(
      `SELECT * FROM futures WHERE model = $1 AND status = 'active' LIMIT 1`, [model]
    );
    if (!futs.length) return reply.code(404).send({ error: '模型不存在或未上市' });
    const exists = await query(
      'SELECT * FROM subscriptions WHERE receiver_id = $1 AND model = $2 AND status = $3',
      [req.user.id, model, 'active']
    );
    if (exists.length) return reply.code(409).send({ error: '已订阅该模型' });
    const apiKey = 'tex-' + crypto.randomBytes(20).toString('hex');
    await query(
      'INSERT INTO subscriptions (receiver_id, model, api_key) VALUES ($1,$2,$3)',
      [req.user.id, model, apiKey]
    );
    return { apiKey, model };
  });

  app.get('/api/receiver/subscriptions', { preHandler: receiverOnly }, async (req) => {
    return query(
      `SELECT s.id, s.model, s.api_key, s.status, s.created_at
       FROM subscriptions s
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

  // 本月用量（按模型，区分指标）
  app.get('/api/receiver/usage', { preHandler: receiverOnly }, async (req) => {
    const month = new Date().toISOString().slice(0, 7);
    const rows = await query(
      `SELECT s.id AS subscription_id, f.model,
              MAX(f.monthly_quota_tokens) AS monthly_quota_tokens,
              COALESCE(SUM(u.tokens) FILTER (WHERE to_char(u.created_at,'YYYY-MM') = $2 AND f.metric <> 'call_count'), 0) AS month_tokens,
              COALESCE(SUM(u.tokens) FILTER (WHERE to_char(u.created_at,'YYYY-MM') = $2 AND f.metric = 'call_count'), 0) AS month_calls,
              COALESCE(SUM(u.tokens), 0) AS total_tokens
       FROM subscriptions s
       JOIN futures f ON f.model = s.model AND f.status <> 'delisted'
       LEFT JOIN usage_log u ON u.future_id = f.id AND u.receiver_id = s.receiver_id
       WHERE s.receiver_id = $1 AND s.status = 'active'
       GROUP BY s.id, f.model`,
      [req.user.id, month]
    );
    return rows.map((r) => ({ ...r, month }));
  });

  // 月度结转账单
  app.get('/api/receiver/settlements', { preHandler: receiverOnly }, async (req) => {
    return query(
      `SELECT s.* FROM settlements s
       WHERE s.user_id = $1 AND s.type = 'receiver' ORDER BY s.period DESC, s.id DESC`, [req.user.id]
    );
  });
}
