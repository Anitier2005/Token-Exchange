import { pool, query, initSchema } from './db.js';
import { hashPassword } from './auth.js';

// 初始化种子数据：管理员 + 各角色演示账户 + 3 个词元期货
async function main() {
  await initSchema();

  async function upsertUser(username, password, role, displayName) {
    const exists = await query('SELECT id FROM users WHERE username = $1', [username]);
    if (exists.length) return exists[0].id;
    const rows = await query(
      'INSERT INTO users (username, password_hash, role, display_name) VALUES ($1,$2,$3,$4) RETURNING id',
      [username, hashPassword(password), role, displayName]
    );
    await query('INSERT INTO accounts (user_id, balance) VALUES ($1, $2)', [rows[0].id, 10000]);
    return rows[0].id;
  }

  await upsertUser('admin', 'admin123', 'admin', '交易所管理员');
  const traderId = await upsertUser('trader1', 'trader123', 'trader', '星河交易商');
  await upsertUser('trader2', 'trader123', 'trader', '凌云交易商');
  const providerA = await upsertUser('provider1', 'provider123', 'provider', '智源大模型');
  const providerB = await upsertUser('provider2', 'provider123', 'provider', '昆仑万维模型');
  await upsertUser('receiver1', 'receiver123', 'receiver', 'AI 应用开发者');
  await upsertUser('receiver2', 'receiver123', 'receiver', '智能客服平台');

  const futures = [
    { code: 'GPT-5T', name: 'GPT-5 Token 期货', provider: providerA, price: 2.5, desc: '基于 GPT-5 大模型的 token 词元期货，每手代表 1K token 的未来使用权。' },
    { code: 'CLD-4T', name: 'Claude-4 Token 期货', provider: providerA, price: 1.8, desc: '基于 Claude-4 大模型的 token 词元期货。' },
    { code: 'ERN-5T', name: '通义千问 Token 期货', provider: providerB, price: 0.9, desc: '基于通义千问大模型的 token 词元期货。' },
  ];
  for (const f of futures) {
    const exists = await query('SELECT id FROM futures WHERE code = $1', [f.code]);
    if (exists.length) continue;
    const rows = await query(
      `INSERT INTO futures (code, name, provider_id, description, min_volume, monthly_fee,
                            monthly_quota_tokens, overage_price_per_1k, last_price, prev_close, day_open)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$9) RETURNING id`,
      [f.code, f.name, f.provider, f.desc, 1, 99, 500000, 0.3, f.price]
    );
    await query(
      'INSERT INTO price_settings (future_id, price, created_by, created_at) VALUES ($1,$2,$3, now() - interval $4 day)',
      [rows[0].id, f.price, f.provider, '30']
    );
  }

  // 模拟历史用量（用于演示结转）
  const futRows = await query('SELECT id, code FROM futures');
  const recvRows = await query("SELECT id FROM users WHERE role = 'receiver'");
  const now = new Date();
  const prev = new Date(now);
  prev.setMonth(prev.getMonth() - 1);
  const prevMonth = prev.toISOString().slice(0, 10);
  const usageCount = await query('SELECT COUNT(*)::int AS n FROM usage_log');
  if (usageCount[0].n === 0) {
    for (const f of futRows) {
      for (const r of recvRows) {
        for (let i = 0; i < 10; i++) {
          await query(
            `INSERT INTO usage_log (future_id, receiver_id, tokens, created_at)
             VALUES ($1,$2,$3,$4)`,
            [f.id, r.id, 5000 + Math.floor(Math.random() * 30000), prevMonth + `T${String(8 + i).padStart(2, '0')}:00:00Z`]
          );
        }
      }
    }
  }

  // 交易商一笔演示持仓
  const posCount = await query('SELECT COUNT(*)::int AS n FROM positions');
  if (posCount[0].n === 0) {
    const gpt = futRows.find((f) => f.code === 'GPT-5T');
    if (gpt) {
      await query(
        'INSERT INTO positions (user_id, future_id, side, volume, avg_price) VALUES ($1,$2,$3,$4,$5)',
        [traderId, gpt.id, 'long', 10, 2.5]
      );
    }
  }

  console.log('种子数据完成。演示账户：');
  console.log('  管理员   admin / admin123');
  console.log('  交易商   trader1 / trader123');
  console.log('  提供方   provider1 / provider123');
  console.log('  接收方   receiver1 / receiver123');
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
