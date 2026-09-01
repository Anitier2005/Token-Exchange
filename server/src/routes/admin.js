import { query, pool } from '../db.js';
import { authHook, roleRequired, hashPassword, generateUniqueUserId } from '../auth.js';
import { engine } from '../engine.js';
import { runMonthlySettlement } from '../services/settlement.js';
import { cancelAllPending } from '../services/trading.js';
import { METRIC_LABELS } from './market.js';

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

// 创建一个模型时按 4 类计量指标生成 4 份合约
// 英文缩略名（ticker）后缀：CM 缓存未命中输入 / CH 缓存命中输入 / O 输出 / C 调用次数
// 交易代码（code）= 缩略名 + 4 位随机数字，数字与字母混合（参考 A股/港股代码风格）
const METRIC_DEFS = [
  { metric: 'cache_miss_input', suffix: 'CM', label: '缓存未命中输入' },
  { metric: 'cache_hit_input', suffix: 'CH', label: '缓存命中输入' },
  { metric: 'output', suffix: 'O', label: '输出' },
  { metric: 'call_count', suffix: 'C', label: '调用次数' },
];

async function genCode(base) {
  for (let i = 0; i < 10; i++) {
    const code = `${base}${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`;
    const rows = await query('SELECT 1 FROM futures WHERE code = $1', [code]);
    if (!rows.length) return code;
  }
  return `${base}${Date.now() % 10000}`;
}

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
  // 搜索：支持 role / status / q（邮箱或显示名关键词）筛选
  app.get('/api/admin/users', { preHandler: adminOnly }, async (req) => {
    const { role, status, q } = req.query;
    const conds = [];
    const params = [];
    if (role) { params.push(role); conds.push(`role = $${params.length}`); }
    if (status) { params.push(status); conds.push(`status = $${params.length}`); }
    if (q) {
      params.push(`%${q}%`);
      conds.push(`(email ILIKE $${params.length} OR display_name ILIKE $${params.length} OR id::text ILIKE $${params.length})`);
    }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    return query(
      `SELECT u.id, u.email, u.display_name, u.role, u.status, u.created_at,
              COALESCE(a.balance, 0) AS balance
       FROM users u LEFT JOIN accounts a ON a.user_id = u.id
       ${where} ORDER BY u.id`, params
    );
  });

  // 账户详情（含交易统计，供侧边栏展示）
  app.get('/api/admin/users/:id', { preHandler: adminOnly }, async (req, reply) => {
    const id = Number(req.params.id);
    const u = (await query(
      `SELECT u.id, u.email, u.display_name, u.role, u.status, u.created_at,
              COALESCE(a.balance, 0) AS balance
       FROM users u LEFT JOIN accounts a ON a.user_id = u.id WHERE u.id = $1`, [id]
    ))[0];
    if (!u) return reply.code(404).send({ error: '账户不存在' });
    const [orders, positions, subs] = await Promise.all([
      query('SELECT COUNT(*)::int AS n, COALESCE(SUM(volume),0)::int AS vol FROM orders WHERE user_id = $1', [id]),
      query('SELECT COUNT(*)::int AS n, COALESCE(SUM(volume),0)::int AS vol FROM positions WHERE user_id = $1', [id]),
      query('SELECT COUNT(*)::int AS n FROM subscriptions WHERE receiver_id = $1 AND status = $2', [id, 'active']),
    ]);
    return {
      ...u,
      stats: {
        orders: orders[0].n,
        orderVolume: orders[0].vol,
        positions: positions[0].n,
        positionVolume: positions[0].vol,
        subscriptions: subs[0].n,
      },
    };
  });

  app.post('/api/admin/users', { preHandler: adminOnly }, async (req, reply) => {
    const { email, password, role, displayName } = req.body || {};
    if (!email || !password) return reply.code(400).send({ error: '邮箱和密码必填' });
    if (!['admin', 'trader', 'provider', 'receiver'].includes(role)) {
      return reply.code(400).send({ error: '角色不合法' });
    }
    const exists = await query('SELECT id FROM users WHERE email = $1', [email]);
    if (exists.length) return reply.code(409).send({ error: '邮箱已存在' });
    const id = await generateUniqueUserId();
    await query(
      'INSERT INTO users (id, email, password_hash, role, display_name) VALUES ($1,$2,$3,$4,$5)',
      [id, email, hashPassword(password), role, displayName || email.split('@')[0]]
    );
    await query('INSERT INTO accounts (user_id, balance) VALUES ($1, 0)', [id]);
    return { ok: true, id };
  });

  // 状态流转：active 正常 / frozen 冻结 / risk_control 风控 / cancelled 注销
  app.put('/api/admin/users/:id/status', { preHandler: adminOnly }, async (req, reply) => {
    const { status, reason } = req.body || {};
    if (!['active', 'frozen', 'risk_control', 'cancelled'].includes(status)) {
      return reply.code(400).send({ error: '状态不合法' });
    }
    const id = Number(req.params.id);
    if (id === req.user.id && status !== 'active') {
      return reply.code(400).send({ error: '不能对自己执行该操作' });
    }
    const u = (await query('SELECT * FROM users WHERE id = $1', [id]))[0];
    if (!u) return reply.code(404).send({ error: '账户不存在' });
    if (u.status === 'cancelled') {
      return reply.code(400).send({ error: '已注销账户无法变更状态（数据保留）' });
    }

    let note = '';
    if (status === 'frozen') {
      // 冻结：无法登录查看、禁止新挂单；已挂出的单不受影响（引擎继续撮合）
      await query('DELETE FROM sessions WHERE user_id = $1', [id]);
      note = '已冻结：现有会话全部失效，无法登录；已挂出的单不受影响';
    } else if (status === 'risk_control') {
      // 风控：可登录查看，禁止挂单，已挂单立即撤回
      const n = await cancelAllPending(id);
      note = `已触发风控：可登录查看，禁止挂单；已撤回 ${n} 笔挂单`;
    } else if (status === 'cancelled') {
      // 注销：无法登录与操作，数据全部保留，未提取保证金转入交易所账户
      await query('DELETE FROM sessions WHERE user_id = $1', [id]);
      const n = await cancelAllPending(id);
      const acc = (await query('SELECT balance FROM accounts WHERE user_id = $1', [id]))[0];
      const balance = acc ? Number(acc.balance) : 0;
      if (balance > 0) {
        await query(
          `UPDATE exchange_config SET house_balance = house_balance + $1, updated_at = now() WHERE id = 1`,
          [balance]
        );
        await query('UPDATE accounts SET balance = 0, updated_at = now() WHERE user_id = $1', [id]);
      }
      note = `已注销：撤回 ${n} 笔挂单，未提取保证金 ¥${balance.toFixed(2)} 已转入交易所账户，数据全部保留`;
    } else {
      note = '已恢复正常';
    }

    await query('UPDATE users SET status = $1 WHERE id = $2', [status, id]);
    return { ok: true, status, note };
  });

  // ---- 期货（模型）管理：创建模型时按 4 类指标生成 4 份合约 ----
  app.post('/api/admin/futures', { preHandler: adminOnly }, async (req, reply) => {
    const { model, ticker, name, providerId, description, minVolume, monthlyFee, monthlyQuotaTokens, overagePricePer1k, initPrice } = req.body || {};
    if (!model || !name || !ticker) {
      return reply.code(400).send({ error: '模型代码、英文缩略名和中文名称必填' });
    }
    const modelKey = String(model).trim().toUpperCase();
    const baseTicker = String(ticker).trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (baseTicker.length < 2 || baseTicker.length > 8) {
      return reply.code(400).send({ error: '英文缩略名须为 2-8 位字母或数字' });
    }
    const exists = await query('SELECT id FROM futures WHERE model = $1', [modelKey]);
    if (exists.length) return reply.code(409).send({ error: `模型 ${modelKey} 已存在` });
    const price = Number(initPrice) > 0 ? Number(initPrice) : 1;
    const created = [];
    for (const def of METRIC_DEFS) {
      const contractTicker = `${baseTicker}${def.suffix}`;
      const code = await genCode(contractTicker);
      const rows = await query(
        `INSERT INTO futures (code, ticker, name, model, metric, provider_id, description, min_volume, monthly_fee,
                              monthly_quota_tokens, overage_price_per_1k, last_price, prev_close, day_open)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12,$12) RETURNING *`,
        [code, contractTicker, `${name}（${def.label}）`, modelKey, def.metric, providerId || null,
         description ? `${description}（计量指标：${def.label}）` : `计量指标：${def.label}`,
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
      created.push(rows[0]);
    }
    return { ok: true, model: modelKey, contracts: created };
  });

  app.put('/api/admin/futures/:id', { preHandler: adminOnly }, async (req, reply) => {
    const f = (await query('SELECT * FROM futures WHERE id = $1', [Number(req.params.id)]))[0];
    if (!f) return reply.code(404).send({ error: '合约不存在' });
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

  // 单个合约熔断 / 恢复
  app.post('/api/admin/futures/:id/halt', { preHandler: adminOnly }, async (req) => {
    const { halted, reason } = req.body || {};
    await engine.setHalted(Number(req.params.id), Boolean(halted), halted ? (reason || '管理员手动熔断') : null);
    return { ok: true };
  });

  // ---- 概览 ----
  app.get('/api/admin/overview', { preHandler: adminOnly }, async () => {
    const [users, futures, orders, volume, settle, pending] = await Promise.all([
      query('SELECT role, status, COUNT(*)::int AS n FROM users GROUP BY role, status'),
      query('SELECT COUNT(*)::int AS n, COUNT(DISTINCT model)::int AS models FROM futures WHERE status <> $1', ['delisted']),
      query('SELECT COUNT(*)::int AS n FROM orders'),
      query('SELECT COALESCE(SUM(volume), 0)::int AS n FROM orders'),
      query('SELECT type, COUNT(*)::int AS n, COALESCE(SUM(amount),0) AS total FROM settlements GROUP BY type'),
      query(`SELECT COUNT(*)::int AS n FROM orders WHERE status = 'pending'`),
    ]);
    const futs = await query('SELECT f.* FROM futures f WHERE f.status <> $1', ['delisted']);
    const cfg = (await query('SELECT house_balance, manual_halted, halt_reason FROM exchange_config WHERE id = 1'))[0];
    const usersByRole = {};
    for (const r of users) {
      usersByRole[r.role] = (usersByRole[r.role] || 0) + r.n;
    }
    const usersByStatus = {};
    for (const r of users) {
      usersByStatus[r.status] = (usersByStatus[r.status] || 0) + r.n;
    }
    return {
      usersByRole,
      usersByStatus,
      futuresCount: futures[0].n,
      modelsCount: futures[0].models,
      ordersCount: orders[0].n,
      totalVolume: volume[0].n,
      pendingOrders: pending[0].n,
      settlements: settle,
      houseBalance: Number(cfg.house_balance),
      manualHalted: cfg.manual_halted,
      haltReason: cfg.halt_reason,
      quotes: futs.map((f) => engine.quoteOf(f)),
    };
  });

  // ---- 运营监控（QPS 等指标，由 index.js 的指标中间件采集）----
  app.get('/api/admin/ops', { preHandler: adminOnly }, async () => {
    return {
      ...app.metrics.snapshot(),
      engine: engine.health(),
      db: {
        totalCount: pool.totalCount,
        idleCount: pool.idleCount,
        waitingCount: pool.waitingCount,
      },
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
      `SELECT s.*, u.email, u.display_name, f.code, f.name AS future_name
       FROM settlements s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN futures f ON f.id = s.future_id
       ORDER BY s.period DESC, s.id DESC LIMIT 200`
    );
  });
}
