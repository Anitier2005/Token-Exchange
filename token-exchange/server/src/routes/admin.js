import { query } from '../db.js';
import { authHook, roleRequired } from '../auth.js';
import { hashPassword } from '../auth.js';
import { engine } from '../engine.js';
import { runMonthlySettlement } from '../services/settlement.js';

const adminOnly = [authHook, roleRequired('admin')];

const CONFIG_FIELDS = {
  trading_start: 'HH:MM',
  trading_end: 'HH:MM',
  trade_interval_sec: Number,
  margin_ratio: Number,
  circuit_breaker_enabled: Boolean,
  circuit_breaker_pct: Number,
  tax_rate: Number,
  fee_rate: Number,
  l1_interval_ms: Number,
  l2_interval_ms: Number,
  provider_price_set_days: Number,
  tick_volatility: Number,
};

export default async function adminRoutes(app) {
  // ---- 交易所配置 ----
  app.get('/api/admin/config', { preHandler: adminOnly }, async () => {
    return (await query('SELECT * FROM exchange_config WHERE id = 1'))[0];
  });

  app.put('/api/admin/config', { preHandler: adminOnly }, async (req, reply) => {
    const body = req.body || {};
    const sets = [];
    const params = [];
    let i = 1;
    for (const [key, type] of Object.entries(CONFIG_FIELDS)) {
      if (body[key] === undefined) continue;
      let val = body[key];
      if (type === Number) {
        val = Number(val);
        if (Number.isNaN(val)) return reply.code(400).send({ error: `${key} 必须为数字` });
      } else if (type === Boolean) {
        val = Boolean(val);
      }
      sets.push(`${key} = $${i}`);
      params.push(val);
      i++;
    }
    if (!sets.length) return reply.code(400).send({ error: '无有效配置项' });
    params.push(1);
    await query(
      `UPDATE exchange_config SET ${sets.join(', ')}, updated_at = now() WHERE id = $${i}`,
      params
    );
    await engine.reloadConfig();
    return (await query('SELECT * FROM exchange_config WHERE id = 1'))[0];
  });

  // 手动熔断 / 恢复
  app.post('/api/admin/halt', { preHandler: adminOnly }, async (req) => {
    const { halted, reason } = req.body || {};
    await query(
      'UPDATE exchange_config SET manual_halted = $1, halt_reason = $2, updated_at = now() WHERE id = 1',
      [Boolean(halted), halted ? (reason || '管理员手动熔断') : null]
    );
    await engine.reloadConfig();
    return { ok: true, manualHalted: Boolean(halted) };
  });

  // ---- 账户管理 ----
  app.get('/api/admin/users', { preHandler: adminOnly }, async (req) => {
    const role = req.query.role;
    const where = role ? 'WHERE role = $1' : '';
    const rows = await query(
      `SELECT u.id, u.username, u.display_name, u.role, u.status, u.created_at,
              COALESCE(a.balance, 0) AS balance
       FROM users u LEFT JOIN accounts a ON a.user_id = u.id
       ${where} ORDER BY u.id`, role ? [role] : []
    );
    return rows;
  });

  app.post('/api/admin/users', { preHandler: adminOnly }, async (req, reply) => {
    const { username, password, role, displayName } = req.body || {};
    if (!username || !password) return reply.code(400).send({ error: '用户名和密码必填' });
    if (!['admin', 'trader', 'provider', 'receiver'].includes(role)) {
      return reply.code(400).send({ error: '角色不合法' });
    }
    const exists = await query('SELECT id FROM users WHERE username = $1', [username]);
    if (exists.length) return reply.code(409).send({ error: '用户名已存在' });
    const rows = await query(
      'INSERT INTO users (username, password_hash, role, display_name) VALUES ($1,$2,$3,$4) RETURNING id',
      [username, hashPassword(password), role, displayName || username]
    );
    await query('INSERT INTO accounts (user_id, balance) VALUES ($1, 0)', [rows[0].id]);
    return { ok: true, id: rows[0].id };
  });

  app.put('/api/admin/users/:id/status', { preHandler: adminOnly }, async (req, reply) => {
    const { status } = req.body || {};
    if (!['active', 'disabled'].includes(status)) return reply.code(400).send({ error: '状态不合法' });
    if (Number(req.params.id) === req.user.id && status === 'disabled') {
      return reply.code(400).send({ error: '不能禁用自己' });
    }
    const rows = await query('UPDATE users SET status = $1 WHERE id = $2 RETURNING id', [status, Number(req.params.id)]);
    if (!rows.length) return reply.code(404).send({ error: '用户不存在' });
    if (status === 'disabled') {
      await query('DELETE FROM sessions WHERE user_id = $1', [Number(req.params.id)]);
    }
    return { ok: true };
  });

  // ---- 期货管理 ----
  app.post('/api/admin/futures', { preHandler: adminOnly }, async (req, reply) => {
    const { code, name, providerId, description, minVolume, monthlyFee, monthlyQuotaTokens, overagePricePer1k, initPrice } = req.body || {};
    if (!code || !name) return reply.code(400).send({ error: '代码和名称必填' });
    const exists = await query('SELECT id FROM futures WHERE code = $1', [code]);
    if (exists.length) return reply.code(409).send({ error: '期货代码已存在' });
    const price = Number(initPrice) > 0 ? Number(initPrice) : 1;
    const rows = await query(
      `INSERT INTO futures (code, name, provider_id, description, min_volume, monthly_fee, monthly_quota_tokens, overage_price_per_1k, last_price, prev_close, day_open)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$9) RETURNING *`,
      [code, name, providerId || null, description || null,
       Number(minVolume) > 0 ? Number(minVolume) : 1,
       Number(monthlyFee) >= 0 ? Number(monthlyFee) : 100,
       Number(monthlyQuotaTokens) > 0 ? Number(monthlyQuotaTokens) : 1000000,
       Number(overagePricePer1k) >= 0 ? Number(overagePricePer1k) : 0.5,
       price]
    );
    engine.state.set(rows[0].id, {
      price, dayOpen: price, prevClose: price, basePrice: price,
      ticks: [{ price, ts: Date.now() }], date: new Date().toISOString().slice(0, 10),
      halted: false, haltReason: null,
    });
    return rows[0];
  });

  app.put('/api/admin/futures/:id', { preHandler: adminOnly }, async (req, reply) => {
    const f = (await query('SELECT * FROM futures WHERE id = $1', [Number(req.params.id)]))[0];
    if (!f) return reply.code(404).send({ error: '期货不存在' });
    const b = req.body || {};
    const rows = await query(
      `UPDATE futures SET
         name = COALESCE($1, name),
         description = COALESCE($2, description),
         min_volume = COALESCE($3, min_volume),
         monthly_fee = COALESCE($4, monthly_fee),
         monthly_quota_tokens = COALESCE($5, monthly_quota_tokens),
         overage_price_per_1k = COALESCE($6, overage_price_per_1k),
         status = COALESCE($7, status)
       WHERE id = $8 RETURNING *`,
      [b.name || null, b.description ?? null,
       b.minVolume !== undefined ? Number(b.minVolume) : null,
       b.monthlyFee !== undefined ? Number(b.monthlyFee) : null,
       b.monthlyQuotaTokens !== undefined ? Number(b.monthlyQuotaTokens) : null,
       b.overagePricePer1k !== undefined ? Number(b.overagePricePer1k) : null,
       b.status || null, f.id]
    );
    if (b.status === 'delisted') engine.state.delete(f.id);
    return rows[0];
  });

  // 单个期货熔断 / 恢复
  app.post('/api/admin/futures/:id/halt', { preHandler: adminOnly }, async (req) => {
    const { halted, reason } = req.body || {};
    await engine.setHalted(Number(req.params.id), Boolean(halted), halted ? (reason || '管理员手动熔断') : null);
    return { ok: true };
  });

  // ---- 概览 ----
  app.get('/api/admin/overview', { preHandler: adminOnly }, async () => {
    const [users, futures, orders, volume, settle] = await Promise.all([
      query('SELECT role, COUNT(*)::int AS n FROM users GROUP BY role'),
      query('SELECT COUNT(*)::int AS n FROM futures WHERE status <> $1', ['delisted']),
      query('SELECT COUNT(*)::int AS n FROM orders'),
      query('SELECT COALESCE(SUM(volume), 0)::int AS n FROM orders'),
      query('SELECT type, COUNT(*)::int AS n, COALESCE(SUM(amount),0) AS total FROM settlements GROUP BY type'),
    ]);
    const futs = await query('SELECT f.* FROM futures f WHERE f.status <> $1', ['delisted']);
    return {
      usersByRole: Object.fromEntries(users.map((r) => [r.role, r.n])),
      futuresCount: futures[0].n,
      ordersCount: orders[0].n,
      totalVolume: volume[0].n,
      settlements: settle,
      quotes: futs.map((f) => engine.quoteOf(f)),
    };
  });

  // 手动触发月度结转
  app.post('/api/admin/settle', { preHandler: adminOnly }, async (req) => {
    const period = req.body?.period || (() => {
      const d = new Date();
      d.setMonth(d.getMonth() - 1);
      return d.toISOString().slice(0, 7);
    })();
    const results = await runMonthlySettlement(period);
    return { period, bills: results };
  });

  // 全局结转记录
  app.get('/api/admin/settlements', { preHandler: adminOnly }, async () => {
    return query(
      `SELECT s.*, u.username, u.display_name, f.code, f.name AS future_name
       FROM settlements s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN futures f ON f.id = s.future_id
       ORDER BY s.period DESC, s.id DESC LIMIT 200`
    );
  });
}
