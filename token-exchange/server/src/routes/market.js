import { Router } from 'express';
import { query } from '../db.js';
import { authRequired, extractToken, getUserByToken } from '../auth.js';
import { engine } from '../engine.js';

const router = Router();

// 期货行情列表（快照）
router.get('/futures', authRequired, async (req, res, next) => {
  try {
    const futures = await query(
      `SELECT f.*, u.display_name AS provider_name,
              (SELECT price FROM price_settings ps WHERE ps.future_id = f.id ORDER BY created_at DESC LIMIT 1) AS base_price
       FROM futures f LEFT JOIN users u ON u.id = f.provider_id
       WHERE f.status <> 'delisted' ORDER BY f.id`
    );
    res.json(futures.map((f) => ({
      ...engine.quoteOf(f),
      status: f.status,
      providerId: f.provider_id,
      providerName: f.provider_name,
      basePrice: f.base_price ? Number(f.base_price) : null,
      minVolume: f.min_volume,
      monthlyFee: Number(f.monthly_fee),
      monthlyQuotaTokens: Number(f.monthly_quota_tokens),
      description: f.description,
    })));
  } catch (e) { next(e); }
});

// 历史 tick
router.get('/futures/:id/ticks', authRequired, (req, res) => {
  const limit = Math.min(Number(req.query.limit || 120), 600);
  res.json(engine.ticksOf(Number(req.params.id), limit));
});

// L2 深度快照
router.get('/futures/:id/depth', authRequired, async (req, res, next) => {
  try {
    const rows = await query('SELECT * FROM futures WHERE id = $1', [Number(req.params.id)]);
    if (!rows.length) return res.status(404).json({ error: '期货不存在' });
    res.json(engine.depthOf(rows[0]));
  } catch (e) { next(e); }
});

// SSE 行情推送（支持 L1 / L2，推送频率由管理员配置）
router.get('/stream', async (req, res) => {
  const token = extractToken(req);
  const user = await getUserByToken(token);
  if (!user) return res.status(401).json({ error: '未授权' });

  const level = (req.query.level || 'L1').toUpperCase();
  const futureId = req.query.futureId ? Number(req.query.futureId) : null;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`event: connected\ndata: {"level":"${level}"}\n\n`);

  let pushTimer = null;
  let closed = false;

  const push = async () => {
    if (closed) return;
    try {
      if (level === 'L2' && futureId) {
        const rows = await query('SELECT * FROM futures WHERE id = $1', [futureId]);
        if (rows.length) res.write(`event: depth\ndata: ${JSON.stringify(engine.depthOf(rows[0]))}\n\n`);
      } else {
        const futures = await query(
          `SELECT f.* FROM futures f WHERE f.status <> 'delisted' ${futureId ? 'AND f.id = $1' : ''} ORDER BY f.id`,
          futureId ? [futureId] : []
        );
        const snapshot = futures.map((f) => engine.quoteOf(f)).filter(Boolean);
        res.write(`event: quote\ndata: ${JSON.stringify(snapshot)}\n\n`);
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

  push().then(schedule);

  const heartbeat = setInterval(() => !closed && res.write(': ping\n\n'), 15000);

  req.on('close', () => {
    closed = true;
    clearInterval(heartbeat);
    clearTimeout(pushTimer);
  });
});

export default router;
