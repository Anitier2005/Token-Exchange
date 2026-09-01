import Fastify from 'fastify';
import cors from '@fastify/cors';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initSchema, pool } from './db.js';
import { engine } from './engine.js';
import { authHook } from './auth.js';
import { createMetrics } from './metrics.js';
import authRoutes from './routes/auth.js';
import marketRoutes from './routes/market.js';
import traderRoutes from './routes/trader.js';
import providerRoutes from './routes/provider.js';
import receiverRoutes from './routes/receiver.js';
import adminRoutes from './routes/admin.js';
import gatewayRoutes from './routes/gateway.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.join(__dirname, '../../client/dist');

const PORT = Number(process.env.PORT || 3001);

async function main() {
  const app = Fastify({ logger: true, bodyLimit: 2 * 1024 * 1024 });

  await app.register(cors, { origin: true });

  // 运营指标：QPS / 延迟 / 错误率（SSE 长连接不纳入延迟统计）
  app.decorate('metrics', createMetrics());
  app.addHook('onRequest', async (req) => {
    req._metricsStart = process.hrtime.bigint();
  });
  app.addHook('onResponse', async (req, reply) => {
    try {
      const isStream = (req.routeOptions?.url || req.url || '').startsWith('/api/market/stream');
      const elapsed = isStream ? null : Number(process.hrtime.bigint() - (req._metricsStart || 0n)) / 1e6;
      app.metrics.record(req, reply, elapsed);
    } catch { /* ignore */ }
  });

  // 挂载全局鉴 hook（路由内按需通过 preHandler 引用）
  app.decorate('authHook', authHook);

  await app.register(authRoutes);
  await app.register(marketRoutes);
  await app.register(traderRoutes);
  await app.register(providerRoutes);
  await app.register(receiverRoutes);
  await app.register(adminRoutes);
  await app.register(gatewayRoutes);

  app.get('/api/health', async () => ({ ok: true, ts: Date.now() }));

  // 静态托管前端构建产物（client/dist），支持前端路由回退到 index.html
  if (fs.existsSync(DIST_DIR)) {
    const mime = {
      '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
      '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
      '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
    };
    app.get('/*', async (req, reply) => {
      let file = path.normalize(path.join(DIST_DIR, req.url.split('?')[0]));
      if (!file.startsWith(DIST_DIR)) file = path.join(DIST_DIR, 'index.html');
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST_DIR, 'index.html');
      reply.type(mime[path.extname(file)] || 'application/octet-stream');
      return reply.send(fs.readFileSync(file));
    });
  }

  app.setErrorHandler((err, req, reply) => {
    const status = err.statusCode || 500;
    req.log.error(err);
    reply.code(status).send({ error: status >= 500 ? '服务器内部错误' : err.message });
  });

  await initSchema();
  await engine.start();

  await app.listen({ port: PORT, host: '0.0.0.0' });
  console.log(`[server] 词元交易所后端已启动: http://localhost:${PORT}`);
}

main().catch((err) => {
  console.error('启动失败:', err);
  process.exit(1);
});

process.on('SIGTERM', async () => {
  await pool.end();
  process.exit(0);
});
