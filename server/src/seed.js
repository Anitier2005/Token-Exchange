import { pool, query, initSchema } from './db.js';
import { hashPassword, generateUniqueUserId } from './auth.js';

// 种子数据：邮箱演示账户 + 3 个模型 × 4 类计量指标合约
const METRIC_DEFS = [
  { metric: 'cache_miss_input', suffix: 'CM', label: '缓存未命中输入' },
  { metric: 'cache_hit_input', suffix: 'CH', label: '缓存命中输入' },
  { metric: 'output', suffix: 'O', label: '输出' },
  { metric: 'call_count', suffix: 'C', label: '调用次数' },
];

const MODELS = [
  {
    model: 'GPT5', ticker: 'GPT', name: 'GPT-5 词元期货', price: 2.5,
    desc: '基于 GPT-5 大模型的词元期货，每手代表 1K token 的未来使用权。',
  },
  {
    model: 'CLD4', ticker: 'CLD', name: 'Claude-4 词元期货', price: 1.8,
    desc: '基于 Claude-4 大模型的词元期货，覆盖缓存命中与未命中输入的差异化定价。',
  },
  {
    model: 'QWEN', ticker: 'QWN', name: '通义千问 词元期货', price: 0.9,
    desc: '基于通义千问大模型的词元期货，支持按输出与调用次数计量。',
  },
];

async function genCode(base) {
  for (let i = 0; i < 10; i++) {
    const code = `${base}${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`;
    const rows = await query('SELECT 1 FROM futures WHERE code = $1', [code]);
    if (!rows.length) return code;
  }
  return `${base}${Date.now() % 10000}`;
}

async function upsertUser(email, password, role, displayName, balance) {
  const exists = await query('SELECT id FROM users WHERE email = $1', [email]);
  if (exists.length) return exists[0].id;
  const id = await generateUniqueUserId();
  await query(
    'INSERT INTO users (id, email, password_hash, role, display_name) VALUES ($1,$2,$3,$4,$5)',
    [id, email, hashPassword(password), role, displayName]
  );
  await query('INSERT INTO accounts (user_id, balance) VALUES ($1, $2)', [id, balance]);
  return id;
}

async function main() {
  await initSchema();

  const adminId = await upsertUser('admin@tex.io', 'admin123', 'admin', '交易所管理员', 0);
  const traderId = await upsertUser('trader1@tex.io', 'trader123', 'trader', '星河交易商', 100000);
  await upsertUser('trader2@tex.io', 'trader123', 'trader', '凌云交易商', 100000);
  const providerA = await upsertUser('provider1@tex.io', 'provider123', 'provider', '智源大模型', 0);
  const providerB = await upsertUser('provider2@tex.io', 'provider123', 'provider', '昆仑万维模型', 0);
  const receiverA = await upsertUser('receiver1@tex.io', 'receiver123', 'receiver', 'AI 应用开发者', 5000);
  await upsertUser('receiver2@tex.io', 'receiver123', 'receiver', '智能客服平台', 5000);

  // 每个模型生成 4 份指标合约（代码 = 缩写+指标后缀+4 位随机数字）
  for (const m of MODELS) {
    for (const def of METRIC_DEFS) {
      const ticker = `${m.ticker}${def.suffix}`;
      const exists = await query('SELECT 1 FROM futures WHERE ticker = $1', [ticker]);
      if (exists.length) continue;
      const code = await genCode(ticker);
      const provider = m.model === 'QWEN' ? providerB : providerA;
      const rows = await query(
        `INSERT INTO futures (code, ticker, name, model, metric, provider_id, description, min_volume, monthly_fee,
                              monthly_quota_tokens, overage_price_per_1k, last_price, prev_close, day_open)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12,$12) RETURNING id`,
        [code, ticker, `${m.name}（${def.label}）`, m.model, def.metric, provider,
         `${m.desc}（计量指标：${def.label}）`, 1, 99, 500000, 0.3, m.price]
      );
      await query(
        `INSERT INTO price_settings (future_id, price, created_by, created_at) VALUES ($1,$2,$3, now() - interval '30 day')`,
        [rows[0].id, m.price, provider]
      );
    }
  }

  // 模拟上月用量（按指标合约分别计量，用于演示结转）
  const recvRows = await query("SELECT id FROM users WHERE role = 'receiver'");
  const usageCount = await query('SELECT COUNT(*)::int AS n FROM usage_log');
  if (usageCount[0].n === 0) {
    const prev = new Date();
    prev.setMonth(prev.getMonth() - 1);
    const prevMonth = prev.toISOString().slice(0, 10);
    const futs = await query('SELECT id FROM futures');
    for (const f of futs) {
      for (const r of recvRows) {
        for (let i = 0; i < 6; i++) {
          await query(
            `INSERT INTO usage_log (future_id, receiver_id, tokens, created_at) VALUES ($1,$2,$3,$4)`,
            [f.id, r.id, 5000 + Math.floor(Math.random() * 30000), `${prevMonth}T${String(8 + i).padStart(2, '0')}:00:00Z`]
          );
        }
      }
    }
  }

  // 交易商一笔演示持仓
  const posCount = await query('SELECT COUNT(*)::int AS n FROM positions');
  if (posCount[0].n === 0) {
    const gpt = (await query("SELECT id FROM futures WHERE ticker = 'GPTCM'"))[0];
    if (gpt) {
      await query(
        'INSERT INTO positions (user_id, future_id, side, volume, avg_price) VALUES ($1,$2,$3,$4,$5)',
        [traderId, gpt.id, 'long', 10, 2.5]
      );
    }
  }

  // 接收方演示订阅
  for (const model of ['GPT5', 'QWEN']) {
    const exists = await query(
      'SELECT 1 FROM subscriptions WHERE receiver_id = $1 AND model = $2', [receiverA, model]
    );
    if (!exists.length) {
      await query(
        'INSERT INTO subscriptions (receiver_id, model, api_key) VALUES ($1,$2,$3)',
        [receiverA, model, 'tex-' + Buffer.from(`${model}:${receiverA}`).toString('hex') + 'demo01']
      );
    }
  }

  console.log('种子数据完成。演示账户（邮箱登录）：');
  console.log('  管理员   admin@tex.io / admin123');
  console.log('  交易商   trader1@tex.io / trader123');
  console.log('  提供方   provider1@tex.io / provider123');
  console.log('  接收方   receiver1@tex.io / receiver123');
  console.log(`  管理员 ID：${adminId}`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
