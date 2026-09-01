import { query } from '../db.js';

// 统一 Token 接口：接收方使用 api_key 调用，风格兼容 OpenAI Chat Completions
// POST /v1/chat/completions  { model: <期货代码>, messages: [...] }
export default async function tokenGatewayRoutes(app) {
  app.post('/v1/chat/completions', async (req, reply) => {
    const apiKey = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || req.headers['x-api-key'];
    if (!apiKey) return reply.code(401).send({ error: { message: '缺少 API Key' } });

    const subs = await query(
      `SELECT s.id AS subscription_id, s.status AS sub_status, f.id AS future_id, f.code, f.name,
              f.endpoint, f.endpoint_api_key, f.status AS future_status, f.monthly_quota_tokens,
              u.username AS receiver_name, u.id AS receiver_id
       FROM subscriptions s
       JOIN futures f ON f.id = s.future_id
       JOIN users u ON u.id = s.receiver_id
       WHERE s.api_key = $1`,
      [apiKey]
    );
    const sub = subs[0];
    if (!sub || sub.sub_status !== 'active') {
      return reply.code(401).send({ error: { message: 'API Key 无效或订阅已取消' } });
    }
    if (sub.future_status !== 'active') {
      return reply.code(403).send({ error: { message: `期货 ${sub.code} 当前不可用` } });
    }

    const { model, messages } = req.body || {};
    if (!Array.isArray(messages) || !messages.length) {
      return reply.code(400).send({ error: { message: 'messages 必填' } });
    }

    // 模拟调用：优先透传到提供方真实接口（若已登记），否则本地模拟回复
    const promptTokens = Math.ceil(
      messages.reduce((s, m) => s + (m.content ? String(m.content).length : 0), 0) / 4
    );
    const completionTokens = 128 + Math.floor(Math.random() * 256);
    const totalTokens = promptTokens + completionTokens;

    let content;
    let proxied = false;
    if (sub.endpoint) {
      try {
        const resp = await fetch(sub.endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(sub.endpoint_api_key ? { Authorization: `Bearer ${sub.endpoint_api_key}` } : {}),
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
      content = `[${sub.code} 模拟回复] 你说的是：${(last.content || '').slice(0, 200)}。本回复由词元交易所统一接口生成（提供方接口未登记或不可达时回退）。`;
    }

    // 记录用量（结转依据）
    await query(
      'INSERT INTO usage_log (future_id, receiver_id, tokens) VALUES ($1,$2,$3)',
      [sub.future_id, sub.receiver_id, totalTokens]
    );

    return {
      id: 'chatcmpl-' + Date.now().toString(36),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: model || sub.code,
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: totalTokens },
    };
  });
}
