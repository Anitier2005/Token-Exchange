import { query } from '../db.js';

// 月度结转：
// - 提供方：按每月调用量 × 其设定价格，由交易所支付费用（账户入账）
// - 接收方：月费 + 超出额度部分按超额单价，从账户扣款
export async function runMonthlySettlement(period) {
  const results = [];

  // ---- 提供方结转 ----
  const providerRows = await query(
    `SELECT f.provider_id AS user_id, f.id AS future_id, f.code, f.name,
            COALESCE(SUM(u.tokens), 0) AS tokens
     FROM futures f
     LEFT JOIN usage_log u ON u.future_id = f.id AND to_char(u.created_at, 'YYYY-MM') = $1
     WHERE f.provider_id IS NOT NULL
     GROUP BY f.provider_id, f.id, f.code, f.name`,
    [period]
  );
  for (const row of providerRows) {
    const tokens = Number(row.tokens);
    if (tokens <= 0) continue;
    // 取该月内（或之前）最新一次价格设置
    const priceRows = await query(
      `SELECT price FROM price_settings
       WHERE future_id = $1 AND to_char(created_at, 'YYYY-MM') <= $2
       ORDER BY created_at DESC LIMIT 1`,
      [row.future_id, period]
    );
    const price = priceRows[0] ? Number(priceRows[0].price) : 0;
    const amount = +(tokens / 1000 * price).toFixed(2);
    await query(
      `INSERT INTO settlements (type, user_id, future_id, period, amount, detail)
       VALUES ('provider', $1, $2, $3, $4, $5)
       ON CONFLICT (type, user_id, future_id, period) DO UPDATE
       SET amount = EXCLUDED.amount, detail = EXCLUDED.detail, created_at = now()`,
      [row.user_id, row.future_id, period, amount, JSON.stringify({ tokens, unitPrice: price, code: row.code })]
    );
    await query(
      `UPDATE accounts SET balance = balance + $1, updated_at = now() WHERE user_id = $2`,
      [amount, row.user_id]
    );
    results.push({ type: 'provider', userId: row.user_id, code: row.code, tokens, amount });
  }

  // ---- 接收方结转 ----
  const receiverRows = await query(
    `SELECT s.receiver_id AS user_id, s.future_id, f.code, f.name,
            f.monthly_fee, f.monthly_quota_tokens, f.overage_price_per_1k,
            COALESCE(SUM(u.tokens), 0) AS tokens
     FROM subscriptions s
     JOIN futures f ON f.id = s.future_id
     LEFT JOIN usage_log u ON u.future_id = s.future_id AND u.receiver_id = s.receiver_id
          AND to_char(u.created_at, 'YYYY-MM') = $1
     WHERE s.status = 'active'
     GROUP BY s.receiver_id, s.future_id, f.code, f.name, f.monthly_fee, f.monthly_quota_tokens, f.overage_price_per_1k`,
    [period]
  );
  for (const row of receiverRows) {
    const tokens = Number(row.tokens);
    const quota = Number(row.monthly_quota_tokens);
    const overage = Math.max(0, tokens - quota);
    const amount = +(Number(row.monthly_fee) + overage / 1000 * Number(row.overage_price_per_1k)).toFixed(2);
    await query(
      `INSERT INTO settlements (type, user_id, future_id, period, amount, detail)
       VALUES ('receiver', $1, $2, $3, $4, $5)
       ON CONFLICT (type, user_id, future_id, period) DO UPDATE
       SET amount = EXCLUDED.amount, detail = EXCLUDED.detail, created_at = now()`,
      [row.user_id, row.future_id, period, amount, JSON.stringify({ tokens, quota, overage, monthlyFee: Number(row.monthly_fee), code: row.code })]
    );
    await query(
      `UPDATE accounts SET balance = balance - $1, updated_at = now() WHERE user_id = $2`,
      [amount, row.user_id]
    );
    results.push({ type: 'receiver', userId: row.user_id, code: row.code, tokens, amount });
  }

  console.log(`[settlement] ${period} done: ${results.length} bills`);
  return results;
}
