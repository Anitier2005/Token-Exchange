import { query } from '../db.js';
import { authHook, roleRequired } from '../auth.js';
import { engine } from '../engine.js';
import { METRIC_LABELS } from './market.js';

const providerOnly = [authHook, roleRequired('provider')];

export default async function providerRoutes(app) {
  app.get('/api/provider/account', { preHandler: providerOnly }, async (req) => {
    const rows = await query('SELECT balance FROM accounts WHERE user_id = $1', [req.user.id]);
    return { balance: rows.length ? Number(rows[0].balance) : 0 };
  });

  // 提交自家大模型接口
  app.post('/api/provider/endpoint', { preHandler: providerOnly }, async (req, reply) => {
    const { endpoint, apiKey, note } = req.body || {};
    if (!endpoint) return reply.code(400).send({ error: '接口地址必填' });
    await query(
      `UPDATE futures SET endpoint = $1, endpoint_api_key = $2 WHERE provider_id = $3`,
      [endpoint, apiKey || null, req.user.id]
    );
    await query(
      `INSERT INTO provider_endpoints (provider_id, endpoint, api_key, note) VALUES ($1,$2,$3,$4)`,
      [req.user.id, endpoint, apiKey || null, note || null]
    );
    return { ok: true };
  });

  app.get('/api/provider/endpoint', { preHandler: providerOnly }, async (req) => {
    const rows = await query(
      'SELECT * FROM provider_endpoints WHERE provider_id = $1 ORDER BY id DESC LIMIT 1', [req.user.id]
    );
    return rows[0] || null;
  });

  // 我的合约列表（按模型 × 指标）
  app.get('/api/provider/futures', { preHandler: providerOnly }, async (req) => {
    const rows = await query(
      `SELECT f.*, (SELECT price FROM price_settings ps WHERE ps.future_id = f.id ORDER BY created_at DESC LIMIT 1) AS current_price,
              (SELECT created_at FROM price_settings ps WHERE ps.future_id = f.id ORDER BY created_at DESC LIMIT 1) AS last_set_at
       FROM futures f WHERE f.provider_id = $1 ORDER BY f.model, f.metric`, [req.user.id]
    );
    return rows.map((r) => ({ ...r, metric_label: METRIC_LABELS[r.metric] || r.metric }));
  });

  // 设置价格（频率受管理员配置限制）
  app.post('/api/provider/futures/:id/price', { preHandler: providerOnly }, async (req, reply) => {
    const price = Number(req.body?.price);
    if (!price || price <= 0) return reply.code(400).send({ error: '价格必须大于 0' });
    const rows = await query(
      'SELECT * FROM futures WHERE id = $1 AND provider_id = $2', [Number(req.params.id), req.user.id]
    );
    if (!rows.length) return reply.code(404).send({ error: '合约不存在或不属于你' });

    const cfg = (await query('SELECT provider_price_set_days FROM exchange_config WHERE id = 1'))[0];
    const last = await query(
      'SELECT created_at FROM price_settings WHERE future_id = $1 ORDER BY id DESC LIMIT 1', [rows[0].id]
    );
    if (last.length) {
      const days = (Date.now() - new Date(last[0].created_at).getTime()) / 86400000;
      if (days < cfg.provider_price_set_days) {
        const wait = Math.ceil(cfg.provider_price_set_days - days);
        return reply.code(429).send({
          error: `价格设置频率限制：每 ${cfg.provider_price_set_days} 天一次，还需等待约 ${wait} 天`,
        });
      }
    }

    await query(
      'INSERT INTO price_settings (future_id, price, created_by) VALUES ($1,$2,$3)',
      [rows[0].id, price, req.user.id]
    );
    await engine.setBasePrice(rows[0].id, price);
    return { ok: true, price };
  });

  // 历史价格设置
  app.get('/api/provider/futures/:id/prices', { preHandler: providerOnly }, async (req) => {
    return query(
      'SELECT * FROM price_settings WHERE future_id = $1 ORDER BY id DESC LIMIT 50', [Number(req.params.id)]
    );
  });

  // 月度调用量统计（按合约）
  app.get('/api/provider/usage', { preHandler: providerOnly }, async (req) => {
    return query(
      `SELECT to_char(u.created_at, 'YYYY-MM') AS month, f.id AS future_id, f.code, f.name,
              f.metric, f.model, SUM(u.tokens) AS tokens, COUNT(*) AS calls
       FROM usage_log u JOIN futures f ON f.id = u.future_id
       WHERE f.provider_id = $1
       GROUP BY 1, 2, 3, 4, 5, 6 ORDER BY 1 DESC`, [req.user.id]
    );
  });

  // 月度结转记录
  app.get('/api/provider/settlements', { preHandler: providerOnly }, async (req) => {
    return query(
      `SELECT s.*, f.code, f.name FROM settlements s LEFT JOIN futures f ON f.id = s.future_id
       WHERE s.user_id = $1 AND s.type = 'provider' ORDER BY s.period DESC, s.id DESC`, [req.user.id]
    );
  });
}
