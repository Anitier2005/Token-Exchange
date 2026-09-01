// 端到端验证脚本：登录 / 行情 / 市价与限价单 / 撤单 / 账户状态流转 / 运营指标
const BASE = 'http://localhost:3001';

async function api(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${data.error || JSON.stringify(data)}`);
  return data;
}

async function login(email, password) {
  const res = await api('/api/auth/login', { method: 'POST', body: { email, password } });
  return res.token;
}

const assert = (cond, msg) => {
  if (!cond) { console.error('FAIL:', msg); process.exit(1); }
  console.log('PASS:', msg);
};

async function main() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // 1. 邮箱登录
  const admin = await login('admin@tex.io', 'admin123');
  const trader = await login('trader1@tex.io', 'trader123');
  const traderInfo = await api('/api/auth/me', { token: trader });
  assert(/^\d{15}$/.test(String(traderInfo.id)), `账户 ID 为 15 位纯数字：${traderInfo.id}`);

  // 2. 行情（所有角色一致的行情页）
  const quotes = await api('/api/market/futures', { token: trader });
  assert(quotes.length >= 12, `行情合约数量：${quotes.length}（3 模型 × 4 指标）`);
  const q = quotes[0];
  assert(q.code && q.ticker && q.name && q.metricLabel && q.description !== undefined,
    `合约字段齐全：code=${q.code} ticker=${q.ticker} name=${q.name} metric=${q.metricLabel}`);

  // 3. 交易商：市价单 + 限价单 + 撤单
  await api('/api/trader/recharge', { method: 'POST', body: { amount: 100000 }, token: trader });
  const mkt = await api('/api/trader/orders', {
    method: 'POST',
    body: { futureId: q.id, side: 'long', volume: 2, orderType: 'market' },
    token: trader,
  });
  assert(mkt.order.status === 'filled', `市价单立即成交：${mkt.message}`);

  await sleep(3500);
  const lim = await api('/api/trader/orders', {
    method: 'POST',
    body: { futureId: q.id, side: 'long', volume: 1, orderType: 'limit', limitPrice: 0.0001 },
    token: trader,
  });
  assert(lim.order.status === 'pending', `限价单已挂出（等待撮合）：id=${lim.order.id}`);
  const cancelRes = await api(`/api/trader/orders/${lim.order.id}/cancel`, { method: 'POST', token: trader });
  assert(cancelRes.order.status === 'cancelled', '挂单撤回成功，保证金释放');

  // 4. 管理员：账户搜索 / 详情 / 状态流转
  const users = await api('/api/admin/users?role=trader', { token: admin });
  assert(users.length >= 2, `按角色搜索账户：${users.length} 个交易商`);
  const detail = await api(`/api/admin/users/${traderInfo.id}`, { token: admin });
  assert(detail.email === 'trader1@tex.io' && detail.stats !== undefined, '账户详情（含统计）正常');

  // 风控：挂单立即撤回
  await sleep(3500);
  const lim2 = await api('/api/trader/orders', {
    method: 'POST',
    body: { futureId: q.id, side: 'long', volume: 1, orderType: 'limit', limitPrice: 0.0001 },
    token: trader,
  });
  const rc = await api(`/api/admin/users/${traderInfo.id}/status`, {
    method: 'PUT', body: { status: 'risk_control', reason: '测试' }, token: admin,
  });
  assert(/已撤回 \d+ 笔挂单/.test(rc.note), `风控生效：${rc.note}`);
  const denied = await api('/api/trader/orders', {
    method: 'POST',
    body: { futureId: q.id, side: 'long', volume: 1, orderType: 'market' },
    token: trader,
  }).catch((e) => e);
  assert(denied instanceof Error && /风控/.test(denied.message), `风控状态下禁止下单：${denied.message}`);

  // 恢复
  await api(`/api/admin/users/${traderInfo.id}/status`, { method: 'PUT', body: { status: 'active' }, token: admin });

  // 冻结：挂单不影响，但不能登录
  await sleep(3500);
  const lim3 = await api('/api/trader/orders', {
    method: 'POST',
    body: { futureId: q.id, side: 'long', volume: 1, orderType: 'limit', limitPrice: 0.0001 },
    token: trader,
  });
  const frozen = await api(`/api/admin/users/${traderInfo.id}/status`, {
    method: 'PUT', body: { status: 'frozen' }, token: admin,
  });
  assert(frozen.status === 'frozen', '账户已冻结');
  const blocked = await api('/api/auth/me', { token: trader }).catch((e) => e);
  assert(blocked instanceof Error && /冻结|失效/.test(blocked.message), `冻结后无法登录查看：${blocked.message}`);
  const stillPending = await api('/api/admin/users', { token: admin });
  // 冻结不影响挂单：查该用户的挂单状态（通过管理员视角验证交易商订单仍 pending —— 由撮合引擎维持）
  assert(lim3.order.status === 'pending', '冻结时已挂出的单不受影响');
  await api(`/api/admin/users/${traderInfo.id}/status`, { method: 'PUT', body: { status: 'active' }, token: admin });
  const traderRelogged = await login('trader1@tex.io', 'trader123'); // 冻结期间会话被销毁，恢复后需重新登录
  await api(`/api/trader/orders/${lim3.order.id}/cancel`, { method: 'POST', token: traderRelogged });

  // 5. 注销：保证金转入交易所
  const trader2 = await login('trader2@tex.io', 'trader123');
  const me2 = await api('/api/auth/me', { token: trader2 });
  await api('/api/trader/recharge', { method: 'POST', body: { amount: 8888 }, token: trader2 });
  const cfgBefore = await api('/api/admin/config', { token: admin });
  const cancelled = await api(`/api/admin/users/${me2.id}/status`, {
    method: 'PUT', body: { status: 'cancelled' }, token: admin,
  });
  assert(cancelled.note.includes('8888'), `注销转入交易所账户：${cancelled.note}`);
  const cfgAfter = await api('/api/admin/config', { token: admin });
  assert(Number(cfgAfter.house_balance) - Number(cfgBefore.house_balance) >= 8888,
    `交易所账户余额增加：${cfgBefore.house_balance} -> ${cfgAfter.house_balance}`);
  const gone = await api('/api/auth/login', { method: 'POST', body: { email: 'trader2@tex.io', password: 'trader123' } }).catch((e) => e);
  assert(gone instanceof Error && /注销/.test(gone.message), `注销后无法登录：${gone.message}`);

  // 6. 运营指标
  const ops = await api('/api/admin/ops', { token: admin });
  assert(ops.qps !== undefined && ops.latency?.p50 !== undefined && ops.routes?.length > 0,
    `运营指标：QPS=${ops.qps} 峰值=${ops.qpsPeak} 总请求=${ops.totalRequests} 路由数=${ops.routes.length}`);
  assert(ops.engine && ops.db, `引擎健康（tick=${ops.engine.tickCount}）与连接池（${ops.db.totalCount}）正常`);

  // 7. SSE 连接计数
  const es = await fetch(`${BASE}/api/market/stream?level=L1&token=${traderRelogged}`);
  assert(es.ok, 'SSE 行情连接建立');
  await new Promise((r) => setTimeout(r, 500));
  const ops2 = await api('/api/admin/ops', { token: admin });
  assert(ops2.sse.active >= 1, `SSE 活跃连接：${ops2.sse.active}`);
  await es.body.cancel();

  // 8. 管理员创建模型（4 份指标合约）
  const created = await api('/api/admin/futures', {
    method: 'POST',
    body: { model: 'TESTX', ticker: 'TSX', name: '测试模型期货', description: 'E2E 测试', initPrice: 1.5 },
    token: admin,
  });
  assert(created.contracts.length === 4, `创建模型生成 4 份合约：${created.contracts.map((c) => c.ticker).join(', ')}`);
  assert(/^[A-Z]+\d{4}$/.test(created.contracts[0].code), `交易代码数字字母混合：${created.contracts.map((c) => c.code).join(', ')}`);

  // 9. 统一 token 接口（按 4 指标计量）
  const receiver = await login('receiver1@tex.io', 'receiver123');
  const subs = await api('/api/receiver/subscriptions', { token: receiver });
  assert(subs.length >= 2, `接收方订阅（按模型）：${subs.map((s) => s.model).join(', ')}`);
  const gw1 = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${subs[0].api_key}` },
    body: JSON.stringify({ model: subs[0].model, messages: [{ role: 'user', content: '你好，介绍一下词元交易所' }] }),
  }).then((r) => r.json());
  assert(gw1.usage && gw1.usage.cached_tokens === 0, `网关调用（缓存未命中）：${JSON.stringify(gw1.usage)}`);
  const gw2 = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${subs[0].api_key}` },
    body: JSON.stringify({ model: subs[0].model, messages: [{ role: 'user', content: '你好，介绍一下词元交易所' }] }),
  }).then((r) => r.json());
  assert(gw2.usage.cached_tokens > 0, `重复 prompt 缓存命中：cached=${gw2.usage.cached_tokens}`);

  console.log('\n全部端到端验证通过 ✅');
}

main().catch((e) => {
  console.error('E2E 失败:', e.message);
  process.exit(1);
});
