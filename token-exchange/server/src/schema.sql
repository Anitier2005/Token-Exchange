-- 词元交易所数据库结构
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','trader','provider','receiver')),
  display_name TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 资金账户（交易商保证金 / 提供方结算 / 接收方月费账户）
CREATE TABLE IF NOT EXISTS accounts (
  user_id INT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  balance NUMERIC(18,2) NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 交易所全局配置（单行表 id=1）
CREATE TABLE IF NOT EXISTS exchange_config (
  id INT PRIMARY KEY DEFAULT 1,
  trading_start TEXT NOT NULL DEFAULT '09:00',
  trading_end TEXT NOT NULL DEFAULT '17:00',
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
  last_settled_month TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO exchange_config (id) VALUES (1) ON CONFLICT DO NOTHING;

-- 期货（词元期货，由管理员创建并挂接到提供方）
CREATE TABLE IF NOT EXISTS futures (
  id SERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  provider_id INT REFERENCES users(id),
  endpoint TEXT,
  endpoint_api_key TEXT,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','pending','suspended','delisted')),
  min_volume INT NOT NULL DEFAULT 1,                    -- 交易门槛（最小手数）
  monthly_fee NUMERIC(18,2) NOT NULL DEFAULT 100,       -- 接收方月费
  monthly_quota_tokens BIGINT NOT NULL DEFAULT 1000000, -- 月度包含 token 额度
  overage_price_per_1k NUMERIC(18,4) NOT NULL DEFAULT 0.5, -- 超额单价（每 1K token）
  last_price NUMERIC(18,6) NOT NULL DEFAULT 1,
  prev_close NUMERIC(18,6) NOT NULL DEFAULT 1,
  day_open NUMERIC(18,6) NOT NULL DEFAULT 1,
  halted BOOLEAN NOT NULL DEFAULT FALSE,
  halt_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 提供方价格设置记录（按频率由管理员配置）
CREATE TABLE IF NOT EXISTS price_settings (
  id SERIAL PRIMARY KEY,
  future_id INT NOT NULL REFERENCES futures(id) ON DELETE CASCADE,
  price NUMERIC(18,6) NOT NULL,
  created_by INT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 订单（市价单，成交于最新价）
CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  future_id INT NOT NULL REFERENCES futures(id),
  side TEXT NOT NULL CHECK (side IN ('long','short')),
  price NUMERIC(18,6) NOT NULL,
  volume INT NOT NULL,
  fee NUMERIC(18,6) NOT NULL DEFAULT 0,
  tax NUMERIC(18,6) NOT NULL DEFAULT 0,
  realized_pnl NUMERIC(18,6) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 持仓（同一用户同一期货同方向合并）
CREATE TABLE IF NOT EXISTS positions (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  future_id INT NOT NULL REFERENCES futures(id) ON DELETE CASCADE,
  side TEXT NOT NULL CHECK (side IN ('long','short')),
  volume INT NOT NULL,
  avg_price NUMERIC(18,6) NOT NULL,
  UNIQUE (user_id, future_id, side)
);

-- 接收方订阅（获得统一 token 接口密钥）
CREATE TABLE IF NOT EXISTS subscriptions (
  id SERIAL PRIMARY KEY,
  receiver_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  future_id INT NOT NULL REFERENCES futures(id) ON DELETE CASCADE,
  api_key TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (receiver_id, future_id)
);

-- token 调用日志（提供方按调用量结转、接收方按用量计超额）
CREATE TABLE IF NOT EXISTS usage_log (
  id SERIAL PRIMARY KEY,
  future_id INT NOT NULL REFERENCES futures(id) ON DELETE CASCADE,
  receiver_id INT REFERENCES users(id) ON DELETE SET NULL,
  tokens INT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 提供方提交的大模型接口登记
CREATE TABLE IF NOT EXISTS provider_endpoints (
  id SERIAL PRIMARY KEY,
  provider_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL,
  api_key TEXT,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 月度结转账单
CREATE TABLE IF NOT EXISTS settlements (
  id SERIAL PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('provider','receiver')),
  user_id INT NOT NULL REFERENCES users(id),
  future_id INT REFERENCES futures(id),
  period TEXT NOT NULL, -- 'YYYY-MM'
  amount NUMERIC(18,2) NOT NULL,
  detail JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (type, user_id, future_id, period)
);
