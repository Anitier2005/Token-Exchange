import crypto from 'node:crypto';
import { query } from '../db.js';

// 统一 Token 接口：接收方使用 api_key 调用，风格兼容 OpenAI Chat Completions
// 用量按 4 类计量指标分别计入对应合约：缓存未命中输入 toks / 缓存命中输入 toks / 输出 toks / 调用次数
const promptCache = new Map(); // receiverId:promptHash -> true（模拟提示词缓存命中）

export default async function tokenGatewayRoutes(app) {
  app.post('/v1/chat/completions', async (req, reply) => {
    app.metrics.gatewayCall();
    const apiKey = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || req.headers['x-api-key'];
    if (!apiKey) return reply.code(401).send({ error: { message: '缺少 API Key' } });

    const subs = await query(
      `SELECT s.id AS subscription_id, s.status AS sub_status, s.model, s.receiver_id,
              u.email AS receiver_email, u.status AS receiver_status
       FROM subscriptions s
       JOIN users u ON u.id = s.receiver_id
       WHERE s.api_key = $1`,
      [apiKey]
    );
    const sub = subs[0];
    if (!sub || sub.sub_status !== 'active') {
      return reply.code(401).send({ error: { message: 'API Key 无效或订阅已取消' } });
    }
    if (sub.receiver_status !== 'active' && sub.receiver_status !== 'risk_control') {
      return reply.code(403).send({ error: { message: '账户当前状态不允许调用' } });
    }

    // 该模型的 4 份指标合约
    const futs = await query(
      `SELECT * FROM futures WHERE model = $1 AND status = 'active'`, [sub.model]
    );
    if (!futs.length) {
      return reply.code(403).send({ error: { message: `模型 ${sub.model} 当前不可用` } });
    }
    const byMetric = Object.fromEntries(futs.map((f) => [f.metric, f]));

    const { model, messages } = req.body || {};
    if (!Array.isArray(messages) || !messages.length) {
      return reply.code(400).send({ error: { message: 'messages 必填' } });
    }

    const promptTokens = Math.ceil(
      messages.reduce((s, m) => s + (m.content ? String(m.content).length : 0), 0) / 4
    );
    const completionTokens = 128 + Math.floor(Math.random() * 256);
    const totalTokens = promptTokens + completionTokens;

    // 模拟提示词缓存：同一接收方重复发送相同 prompt 视为缓存命中
    const promptHash = crypto.createHash('md5').update(JSON.stringify(messages)).digest('hex');
    const cacheKey = `${sub.receiver_id}:${promptHash}`;
    const cacheHit = promptCache.has(cacheKey);
    promptCache.set(cacheKey, true);
    if (promptCache.size > 10000) promptCache.clear();

    // 生成回复：优先透传提供方真实接口，不可达时回退模拟
    let content;
    let proxied = false;
    const sample = futs[0];
    if (sample.endpoint) {
      try {
        const resp = await fetch(sample.endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(sample.endpoint_api_key ? { Authorization: `Bearer ${sample.endpoint_api_key}` } : {}),
          },
          body: JSON.stringify(req.body),
          signal: AbortSignal.timeout(10000),
        });
        if (resp.ok) {
          const data = await resp.json();
          content = data?.choices?.[0]?.message?.content ?? JSON.stringify(data);
          proxied = true;
        }
      } catch { /* 透传失败则回退模拟 */ }
    }
    if (!proxied) {
      const last = messages[messages.length - 1];
      content = `[${sub.model} 模拟回复] 你说的是：${(last.content || '').slice(0, 200)}。本回复由词元交易所统一接口生成（提供方接口未登记或不可达时回退）。`;
    }

    // 按指标计量：缓存未命中/命中输入、输出、调用次数
    const logs = [];
    if (byMetric.cache_miss_input && !cacheHit) logs.push([byMetric.cache_miss_input.id, promptTokens]);
    if (byMetric.cache_hit_input && cacheHit) logs.push([byMetric.cache_hit_input.id, promptTokens]);
    if (byMetric.output) logs.push([byMetric.output.id, completionTokens]);
    if (byMetric.call_count) logs.push([byMetric.call_count.id, 1]);
    for (const [futureId, tokens] of logs) {
      await query(
        'INSERT INTO usage_log (future_id, receiver_id, tokens) VALUES ($1,$2,$3)',
        [futureId, sub.receiver_id, tokens]
      );
    }

    return {
      id: 'chatcmpl-' + Date.now().toString(36),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: model || sub.model,
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: promptTokens,
        cached_tokens: cacheHit ? promptTokens : 0,
        completion_tokens: completionTokens,
        total_tokens: totalTokens,
      },
    };
  });
}
