-- 词元交易所数据库结构 v2
-- 账户：邮箱登录、15 位纯数字随机 ID、状态（active 正常 / frozen 冻结 / risk_control 风控 / cancelled 注销）
CREATE TABLE IF NOT EXISTS users (
  id BIGINT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','trader','provider','receiver')),
  display_name TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','frozen','risk_control','cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 资金账户（交易商保证金 / 提供方结算 / 接收方月费账户）
CREATE TABLE IF NOT EXISTS accounts (
  user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  balance NUMERIC(18,2) NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 交易所全局配置（单行表 id=1），house_balance 为交易所自有账户（承接注销账户转入的保证金）
CREATE TABLE IF NOT EXISTS exchange_config (
  id INT PRIMARY KEY DEFAULT 1,
  trading_start TEXT NOT NULL DEFAULT '00:00',
  trading_end TEXT NOT NULL DEFAULT '23:59',
  trade_interval_sec INT NOT NULL DEFAULT 3,
  margin_ratio NUMERIC(8,4) NOT NULL DEFAULT 0.10,
  circuit_breaker_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  circuit_breaker_pct NUMERIC(8,4) NOT NULL DEFAULT 0.05,
  manual_halted BOOLEAN NOT NULL DEFAULT FALSE,
  halt_reason TEXT,
  tax_rate NUMERIC(8,4) NOT NULL DEFAULT 0.05,
  fee_rate NUMERIC(8,4) NOT NULL DEFAULT 0.001,
  l1_interval_ms INT NOT NULL DEFAULT 1000,
  l2_interval_ms INT NOT NULL DEFAULT 2000,
  provider_price_set_days INT NOT NULL DEFAULT 7,
  tick_volatility NUMERIC(8,4) NOT NULL DEFAULT 0.002,
  house_balance NUMERIC(18,2) NOT NULL DEFAULT 0,
  last_settled_month TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO exchange_config (id) VALUES (1) ON CONFLICT DO NOTHING;

-- 词元期货合约：每个模型（model）按计量指标（metric）拆分为不同合约
-- metric: cache_miss_input 缓存未命中输入 toks / cache_hit_input 缓存命中输入 toks / output 输出 toks / call_count 调用次数
CREATE TABLE IF NOT EXISTS futures (
  id SERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,          -- 数字与字母混合的交易代码（参考 A股/港股风格）
  ticker TEXT UNIQUE NOT NULL,        -- 英文缩略名
  name TEXT NOT NULL,                 -- 中文名
  model TEXT NOT NULL,
  metric TEXT NOT NULL CHECK (metric IN ('cache_miss_input','cache_hit_input','output','call_count')),
  provider_id BIGINT REFERENCES users(id),
  endpoint TEXT,
  endpoint_api_key TEXT,
  description TEXT,                   -- 简介
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','pending','suspended','delisted')),
  min_volume INT NOT NULL DEFAULT 1,
  monthly_fee NUMERIC(18,2) NOT NULL DEFAULT 100,
  monthly_quota_tokens BIGINT NOT NULL DEFAULT 1000000,
  overage_price_per_1k NUMERIC(18,4) NOT NULL DEFAULT 0.5,
  last_price NUMERIC(18,6) NOT NULL DEFAULT 1,
  prev_close NUMERIC(18,6) NOT NULL DEFAULT 1,
  day_open NUMERIC(18,6) NOT NULL DEFAULT 1,
  day_high NUMERIC(18,6),
  day_low NUMERIC(18,6),
  tick_size NUMERIC(18,6) NOT NULL DEFAULT 0.0001, -- 最小变动价位
  hands_per_tick INT NOT NULL DEFAULT 10,            -- 每多少手推动一个 tick 的盘面深度
  halted BOOLEAN NOT NULL DEFAULT FALSE,
  halt_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_futures_model ON futures(model);

-- 提供方提交的大模型接口登记
CREATE TABLE IF NOT EXISTS provider_endpoints (
  id SERIAL PRIMARY KEY,
  provider_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL,
  api_key TEXT,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 提供方价格设置记录（按频率由管理员配置）
CREATE TABLE IF NOT EXISTS price_settings (
  id SERIAL PRIMARY KEY,
  future_id INT NOT NULL REFERENCES futures(id) ON DELETE CASCADE,
  price NUMERIC(18,6) NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 订单：市价单即时成交；限价单挂出（pending），由引擎在价格穿越时撮合
CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id),
  future_id INT NOT NULL REFERENCES futures(id),
  side TEXT NOT NULL CHECK (side IN ('long','short')),
  order_type TEXT NOT NULL DEFAULT 'market' CHECK (order_type IN ('market','limit')),
  limit_price NUMERIC(18,6),
  price NUMERIC(18,6) NOT NULL,
  volume INT NOT NULL,
  fee NUMERIC(18,6) NOT NULL DEFAULT 0,
  tax NUMERIC(18,6) NOT NULL DEFAULT 0,
  realized_pnl NUMERIC(18,6) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'filled' CHECK (status IN ('pending','filled','cancelled')),
  filled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_orders_pending ON orders(status) WHERE status = 'pending';

-- 持仓（同一用户同一期货同方向合并）
CREATE TABLE IF NOT EXISTS positions (
  id SERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  future_id INT NOT NULL REFERENCES futures(id) ON DELETE CASCADE,
  side TEXT NOT NULL CHECK (side IN ('long','short')),
  volume INT NOT NULL,
  avg_price NUMERIC(18,6) NOT NULL,
  UNIQUE (user_id, future_id, side)
);

-- 接收方订阅：按模型（model）订阅，获得统一 token 接口密钥
CREATE TABLE IF NOT EXISTS subscriptions (
  id SERIAL PRIMARY KEY,
  receiver_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  api_key TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (receiver_id, model)
);

-- token 调用日志：按合约（指标）计量，结转依据
CREATE TABLE IF NOT EXISTS usage_log (
  id SERIAL PRIMARY KEY,
  future_id INT NOT NULL REFERENCES futures(id) ON DELETE CASCADE,
  receiver_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  tokens INT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 月度结转账单：model 为合约代码（提供方）或订阅模型（接收方）
CREATE TABLE IF NOT EXISTS settlements (
  id SERIAL PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('provider','receiver')),
  user_id BIGINT NOT NULL REFERENCES users(id),
  future_id INT REFERENCES futures(id),
  model TEXT NOT NULL DEFAULT '',
  period TEXT NOT NULL,
  amount NUMERIC(18,2) NOT NULL,
  detail JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (type, user_id, model, period)
);
