# 词元交易所（Token Exchange）

一个以「大模型 Token 用量」为标的的期货交易所全栈项目。模型提供方提交接口并按周期定价，接收方按月费订阅统一接口，交易商对四类 Token 指标期货进行做多/做空，管理员负责交易所全局运营与风控。

## 技术栈

- **后端**：Node.js + Fastify + PostgreSQL（pg），JWT 会话鉴权，SSE 实时行情推送
- **前端**：React 18 + Ant Design 5 + Vite，响应式布局（无横向拖拽，控件可切换排布）
- **测试**：`server/e2e.mjs` 端到端验证脚本

## 目录结构

```
README.md            ← 与项目文件同级
server/              ← Fastify 后端
  src/
    index.js         入口（路由注册、指标中间件、静态托管）
    engine.js        行情引擎（价格生成、撮合、熔断）
    metrics.js       运营指标采集（QPS/延迟/错误率/SSE）
    auth.js          邮箱登录、15 位纯数字 ID、账户状态拦截
    schema.sql       数据库结构
    seed.js          种子数据（模型 × 4 指标合约）
    services/        交易核心（下单/撤单/保证金/撮合）
    routes/          auth / trader / provider / receiver / admin / market / gateway
  e2e.mjs            端到端测试
client/              ← React 前端
  src/
    components/      MarketPage（共享行情）、AccountManage、QuoteTable
    pages/           Login / TraderView / ProviderView / ReceiverView / AdminView / OpsView
```

## 快速开始

```bash
# 1. PostgreSQL
createdb token_exchange   # 或: psql -c "CREATE DATABASE token_exchange"

# 2. 后端
cd server
npm install
node src/seed.js      # 初始化种子数据
node src/index.js     # http://localhost:3001

# 3. 前端
cd client
npm install
npm run dev           # http://localhost:5173（代理 /api 与 /v1 到 3001）
```

生产构建：`cd client && npm run build`（产物输出至 `client/dist`，由后端静态托管）。

## 演示账户（邮箱登录，暂不验证邮箱）

| 角色 | 邮箱 | 密码 |
|---|---|---|
| 管理员 | admin@tex.io | admin123 |
| 期货交易商 | trader1@tex.io | trader123 |
| 期货提供方 | provider1@tex.io | provider123 |
| 期货接收方 | receiver1@tex.io | receiver123 |

账户 ID 为 15 位纯数字随机数（如 `555122051574147`）。

## 核心功能

### 四类 Token 指标合约

每个模型生成 4 份独立期货合约，各含英文缩略名（ticker）、数字字母混合代码（参考 A股/港股风格，如 `CLDCH6947`）、中文名与简介：

| 指标 | ticker 后缀 | 说明 |
|---|---|---|
| 缓存未命中输入 toks | `CM` | prompt cache miss 的输入 token |
| 缓存命中输入 toks | `CH` | prompt cache hit 的输入 token |
| 输出 toks | `O` | 模型输出 token |
| 调用次数 | `C` | API 调用次数 |

### 共享行情页

所有账户使用同一行情页面（红涨绿跌），支持左右/上下排布切换；管理员为最高级行情（L2 深度+逐笔），其余角色 L1 快照。SSE 推送频率由管理员配置。

### 账户状态

| 状态 | 登录/查看 | 挂单 | 已挂出的单 |
|---|---|---|---|
| 正常 active | ✅ | ✅ | 正常撮合 |
| 风控 risk_control | ✅ | ❌ 禁止 | **立即全部撤回** |
| 冻结 frozen | ❌ 会话失效 | ❌ | 不受影响，继续撮合 |
| 注销 cancelled | ❌ | ❌ | 撤回；未提取保证金转入交易所账户，数据全部保留 |

### 账户管理（管理员）

- 默认进入「搜索与操作」分页：不显示任何账户，必须筛选后才展示列表与字段
- 角色分页（交易商/提供方/接收方/管理员）：卡片或条目两种视图，仅显示名称、状态、ID
- 点击条目/卡片在右侧弹出侧边栏，详细信息与操作使用不同分页

### 交易机制

- 市价单即时成交、限价单挂出等待撮合（穿越限价成交）、可撤单（释放冻结保证金）
- 保证金比例、交易时间、交易频率、最小手数、手续费、熔断阈值均可由管理员配置
- 支持手动熔断与单合约熔断

### 统一 Token 接口（网关）

`POST /v1/chat/completions`，OpenAI 兼容风格，接收方以 API Key 调用；用量按 4 类指标分别计量到对应合约，重复 prompt 命中缓存计量为 `cached_tokens`。提供方按管理员设置的周期定价，按月结转。

### 运营监控页（管理员）

实时展示 QPS / 峰值 QPS / 总请求 / 错误率 / 延迟分位数（p50/p90/p99）/ SSE 活跃连接 / 网关调用量 / 内存 / 引擎 tick / 数据库连接池，以及 QPS 实时走势图与路由级明细，保障网站运行安全。

## 端到端验证

```bash
cd server && node e2e.mjs
```

覆盖：邮箱登录 → 行情合约（3 模型 × 4 指标）→ 市价/限价/撤单 → 风控（挂单撤回+禁单）→ 冻结（会话失效、挂单不受影响）→ 注销（保证金转入交易所）→ 运营指标与 SSE 计数 → 管理员创建模型（4 合约、混合代码）→ 网关缓存命中/未命中计量。
