// 运营指标采集：QPS（滚动窗口）、延迟分位数、错误率、SSE 连接数、内存等
// 由 index.js 挂到 app.metrics，/api/admin/ops 输出快照
const WINDOW_SEC = 60;        // QPS 滚动窗口
const MAX_LATENCY_SAMPLES = 5000;

export function createMetrics() {
  const startAt = Date.now();
  const perSecond = new Map(); // 秒级时间戳 -> 请求数
  const latencies = [];        // 最近延迟样本（毫秒）
  const routes = new Map();    // 方法+路径 -> { count, errors, latencySum, maxLatency }
  const state = {
    total: 0,
    errors: 0,
    sseActive: 0,
    sseTotal: 0,
    gatewayCalls: 0,
  };

  function trimWindow(nowSec) {
    for (const ts of perSecond.keys()) {
      if (nowSec - ts > WINDOW_SEC) perSecond.delete(ts);
    }
  }

  function percentile(sorted, p) {
    if (!sorted.length) return 0;
    const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return sorted[idx];
  }

  return {
    // 记录一次 HTTP 请求（SSE 长连接不纳入延迟统计）
    record(req, reply, elapsedMs) {
      const nowSec = Math.floor(Date.now() / 1000);
      state.total++;
      perSecond.set(nowSec, (perSecond.get(nowSec) || 0) + 1);
      trimWindow(nowSec);

      const status = reply.statusCode;
      if (status >= 500) state.errors++;
      else if (status >= 400) state.clientErrors = (state.clientErrors || 0) + 1;

      if (elapsedMs != null) {
        latencies.push(elapsedMs);
        if (latencies.length > MAX_LATENCY_SAMPLES) latencies.splice(0, latencies.length - MAX_LATENCY_SAMPLES);
      }

      const key = `${req.method} ${req.routeOptions?.url || req.url || '?'}`;
      const r = routes.get(key) || { count: 0, errors: 0, latencySum: 0, maxLatency: 0 };
      r.count++;
      if (status >= 400) r.errors++;
      if (elapsedMs != null) {
        r.latencySum += elapsedMs;
        r.maxLatency = Math.max(r.maxLatency, elapsedMs);
      }
      routes.set(key, r);
    },

    sseOpen() { state.sseActive++; state.sseTotal++; },
    sseClose() { state.sseActive = Math.max(0, state.sseActive - 1); },
    gatewayCall() { state.gatewayCalls++; },

    snapshot() {
      const nowSec = Math.floor(Date.now() / 1000);
      trimWindow(nowSec);
      const counts = [...perSecond.values()];
      const qps = counts.length ? +(counts.reduce((a, b) => a + b, 0) / Math.min(counts.length, WINDOW_SEC)).toFixed(2) : 0;
      const qpsPeak = counts.length ? Math.max(...counts) : 0;
      const sorted = [...latencies].sort((a, b) => a - b);
      const mem = process.memoryUsage();
      return {
        uptimeSec: Math.floor((Date.now() - startAt) / 1000),
        totalRequests: state.total,
        errors: state.errors,
        clientErrors: state.clientErrors || 0,
        errorRate: state.total ? +((state.errors + (state.clientErrors || 0)) / state.total * 100).toFixed(2) : 0,
        qps,
        qpsPeak,
        perSecond: [...perSecond.entries()]
          .filter(([ts]) => nowSec - ts < WINDOW_SEC)
          .sort((a, b) => a[0] - b[0])
          .map(([ts, n]) => ({ ts, count: n })),
        latency: {
          samples: sorted.length,
          p50: percentile(sorted, 50),
          p90: percentile(sorted, 90),
          p99: percentile(sorted, 99),
          avg: sorted.length ? +(sorted.reduce((a, b) => a + b, 0) / sorted.length).toFixed(2) : 0,
        },
        sse: { active: state.sseActive, total: state.sseTotal },
        gatewayCalls: state.gatewayCalls,
        memory: {
          rssMb: +(mem.rss / 1048576).toFixed(1),
          heapUsedMb: +(mem.heapUsed / 1048576).toFixed(1),
          heapTotalMb: +(mem.heapTotal / 1048576).toFixed(1),
        },
        routes: [...routes.entries()]
          .map(([route, r]) => ({
            route,
            count: r.count,
            errors: r.errors,
            avgLatencyMs: r.count ? +(r.latencySum / r.count).toFixed(1) : 0,
            maxLatencyMs: +r.maxLatency.toFixed(1),
          }))
          .sort((a, b) => b.count - a.count),
      };
    },
  };
}
