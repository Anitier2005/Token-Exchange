import Fastify from 'fastify';
import cors from '@fastify/cors';
import { initSchema, pool } from './db.js';
import { engine } from './engine.js';
import { authHook } from './auth.js';
import authRoutes from './routes/auth.js';
import marketRoutes from './routes/market.js';
import traderRoutes from './routes/trader.js';
import providerRoutes from './routes/provider.js';
import receiverRoutes from './routes/receiver.js';
import adminRoutes from './routes/admin.js';
import gatewayRoutes from './routes/gateway.js';

const PORT = Number(process.env.PORT || 3001);

async function main() {
  const app = Fastify({ logger: true, bodyLimit: 2 * 1024 * 1024 });

  await app.register(cors, { origin: true });

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
