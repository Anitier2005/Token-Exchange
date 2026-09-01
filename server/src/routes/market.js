import { query } from '../db.js';
import { authHook, extractToken, getUserByToken } from '../auth.js';
import { engine } from '../engine.js';

export const METRIC_LABELS = {
  cache_miss_input: '缓存未命中输入',
  cache_hit_input: '缓存命中输入',
  output: '输出',
  call_count: '调用次数',
};

// 期货行情列表（快照，所有角色一致）
export default async function marketRoutes(app) {
  app.get('/api/market/futures', { preHandler: authHook }, async () => {
    const futures = await query(
      `SELECT f.*, u.display_name AS provider_name,
              (SELECT price FROM price_settings ps WHERE ps.future_id = f.id ORDER BY created_at DESC LIMIT 1) AS base_price
       FROM futures f LEFT JOIN users u ON u.id = f.provider_id
       WHERE f.status <> 'delisted' ORDER BY f.model, f.metric`
    );
    return futures.map((f) => ({
      ...engine.quoteOf(f),
      metricLabel: METRIC_LABELS[f.metric] || f.metric,
      status: f.status,
      providerId: f.provider_id,
      providerName: f.provider_name,
      basePrice: f.base_price ? Number(f.base_price) : null,
      minVolume: f.min_volume,
      monthlyFee: Number(f.monthly_fee),
      monthlyQuotaTokens: Number(f.monthly_quota_tokens),
      description: f.description,
    }));
  });

  // 历史 tick
  app.get('/api/market/futures/:id/ticks', { preHandler: authHook }, async (req) => {
    const limit = Math.min(Number(req.query.limit || 120), 600);
    return engine.ticksOf(Number(req.params.id), limit);
  });

  // L2 深度快照
  app.get('/api/market/futures/:id/depth', { preHandler: authHook }, async (req, reply) => {
    const rows = await query('SELECT * FROM futures WHERE id = $1', [Number(req.params.id)]);
    if (!rows.length) return reply.code(404).send({ error: '期货不存在' });
    return engine.depthOf(rows[0]);
  });

  // SSE 行情推送（支持 L1 / L2，推送频率由管理员配置）
  app.get('/api/market/stream', async (req, reply) => {
    const user = await getUserByToken(extractToken(req));
    if (!user) return reply.code(401).send({ error: '未授权' });
    if (user.status === 'frozen' || user.status === 'cancelled') {
      return reply.code(403).send({ error: '账户状态不允许访问行情' });
    }

    const level = String(req.query.level || 'L1').toUpperCase();
    const futureId = req.query.futureId ? Number(req.query.futureId) : null;

    app.metrics.sseOpen();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.write(`event: connected\ndata: {"level":"${level}"}\n\n`);

    let pushTimer = null;
    let closed = false;

    const push = async () => {
      if (closed) return;
      try {
        if (level === 'L2' && futureId) {
          const rows = await query('SELECT * FROM futures WHERE id = $1', [futureId]);
          if (rows.length) reply.raw.write(`event: depth\ndata: ${JSON.stringify(engine.depthOf(rows[0]))}\n\n`);
        } else {
          const futures = await query(
            `SELECT f.* FROM futures f WHERE f.status <> 'delisted' ${futureId ? 'AND f.id = $1' : ''} ORDER BY f.id`,
            futureId ? [futureId] : []
          );
          const snapshot = futures.map((f) => engine.quoteOf(f)).filter(Boolean);
          reply.raw.write(`event: quote\ndata: ${JSON.stringify(snapshot)}\n\n`);
        }
      } catch { /* ignore */ }
    };

    const schedule = async () => {
      if (closed) return;
      const cfg = await query('SELECT l1_interval_ms, l2_interval_ms FROM exchange_config WHERE id = 1');
      const interval = level === 'L2' ? cfg[0].l2_interval_ms : cfg[0].l1_interval_ms;
      pushTimer = setTimeout(async () => {
        await push();
        await schedule();
      }, Math.max(200, interval));
    };

    await push();
    await schedule();

    const heartbeat = setInterval(() => !closed && reply.raw.write(': ping\n\n'), 15000);

    req.raw.on('close', () => {
      closed = true;
      clearInterval(heartbeat);
      clearTimeout(pushTimer);
      app.metrics.sseClose();
    });
  });
}
