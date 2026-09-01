import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  Card, Col, Row, Statistic, Table, Tag, Typography, Space, Progress, Tooltip,
} from 'antd';
import { api } from '../api.js';

const { Text } = Typography;

// 管理员运营监控页：QPS / 延迟 / 错误率 / SSE 连接 / 引擎健康 / 数据库连接池
export default function OpsView() {
  const [ops, setOps] = useState(null);
  const [qpsHistory, setQpsHistory] = useState([]);
  const timerRef = useRef(null);

  const refresh = useCallback(async () => {
    try {
      const data = await api('/api/admin/ops');
      setOps(data);
      setQpsHistory((h) => [...h, { ts: Date.now(), qps: data.qps }].slice(-120));
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    refresh();
    timerRef.current = setInterval(refresh, 3000);
    return () => clearInterval(timerRef.current);
  }, [refresh]);

  if (!ops) return <Card size="small" loading style={{ minHeight: 200 }} />;

  const engineHealthy = ops.engine?.lastTickAgoMs != null && ops.engine.lastTickAgoMs < 5000;
  const errLevel = ops.errorRate > 5 ? 'exception' : ops.errorRate > 1 ? 'active' : 'success';

  return (
    <div>
      <Row gutter={[12, 12]}>
        <Col xs={12} md={6} xl={3}>
          <Card size="small">
            <Statistic title="QPS（近 60s 均值）" value={ops.qps} precision={2}
              valueStyle={{ color: '#1a3a6b' }} />
          </Card>
        </Col>
        <Col xs={12} md={6} xl={3}>
          <Card size="small">
            <Statistic title="峰值 QPS" value={ops.qpsPeak} precision={0} />
          </Card>
        </Col>
        <Col xs={12} md={6} xl={3}>
          <Card size="small">
            <Statistic title="总请求数" value={ops.totalRequests} />
          </Card>
        </Col>
        <Col xs={12} md={6} xl={3}>
          <Card size="small">
            <Statistic title="错误率" value={ops.errorRate} precision={2} suffix="%"
              valueStyle={{ color: ops.errorRate > 5 ? '#e03131' : '#0ca678' }} />
            <Progress percent={Math.min(100, ops.errorRate)} size="small" status={errLevel} showInfo={false} />
          </Card>
        </Col>
        <Col xs={12} md={6} xl={3}>
          <Card size="small">
            <Statistic title="p50 延迟" value={ops.latency.p50} precision={1} suffix="ms" />
          </Card>
        </Col>
        <Col xs={12} md={6} xl={3}>
          <Card size="small">
            <Statistic title="p90 延迟" value={ops.latency.p90} precision={1} suffix="ms" />
          </Card>
        </Col>
        <Col xs={12} md={6} xl={3}>
          <Card size="small">
            <Statistic title="p99 延迟" value={ops.latency.p99} precision={1} suffix="ms"
              valueStyle={{ color: ops.latency.p99 > 1000 ? '#e03131' : undefined }} />
          </Card>
        </Col>
        <Col xs={12} md={6} xl={3}>
          <Card size="small">
            <Statistic title="SSE 行情连接" value={ops.sse.active}
              suffix={`/ 累计 ${ops.sse.total}`} />
          </Card>
        </Col>
      </Row>

      <Row gutter={[12, 12]} style={{ marginTop: 12 }}>
        <Col xs={24} lg={14}>
          <Card size="small" title="QPS 实时走势（3 秒采样）">
            <QpsChart data={qpsHistory.map((p) => p.qps)} />
            <Text type="secondary" style={{ fontSize: 12 }}>服务端每秒请求计数（近 60 秒滚动窗口）</Text>
          </Card>
        </Col>
        <Col xs={24} lg={10}>
          <Card size="small" title="系统健康">
            <Space direction="vertical" style={{ width: '100%' }} size={6}>
              <HealthRow label="行情引擎" ok={engineHealthy}
                okText={`正常 · tick ${ops.engine.tickCount} 次（${ops.engine.lastTickAgoMs ?? '-'}ms 前）`}
                badText="异常：引擎长时间无 tick" />
              <HealthRow label="追踪合约" ok={ops.engine.trackedFutures > 0}
                okText={`${ops.engine.trackedFutures} 个（熔断 ${ops.engine.haltedFutures} 个）`}
                badText="无在市合约" />
              <HealthRow label="撮合成交" ok okText={`累计撮合 ${ops.engine.matchCount} 笔`} />
              <HealthRow label="数据库连接池" ok={ops.db.waitingCount === 0}
                okText={`总计 ${ops.db.totalCount} · 空闲 ${ops.db.idleCount} · 等待 ${ops.db.waitingCount}`}
                badText={`有 ${ops.db.waitingCount} 个请求在等待连接`} />
              <HealthRow label="统一接口调用" ok okText={`累计 ${ops.gatewayCalls} 次`} />
              <HealthRow label="运行时长" ok okText={fmtDuration(ops.uptimeSec)} />
              <HealthRow label="内存" ok={ops.memory.rssMb < 1024}
                okText={`RSS ${ops.memory.rssMb}MB · 堆 ${ops.memory.heapUsedMb}/${ops.memory.heapTotalMb}MB`}
                badText={`RSS ${ops.memory.rssMb}MB 偏高`} />
            </Space>
          </Card>
        </Col>
      </Row>

      <Card size="small" title="接口调用统计（按路由）" style={{ marginTop: 12 }}>
        <Table
          rowKey="route" size="small"
          dataSource={ops.routes.slice(0, 20)}
          pagination={false}
          scroll={{ x: 640 }}
          columns={[
            { title: '路由', dataIndex: 'route', render: (v) => <Text code style={{ fontSize: 12 }}>{v}</Text> },
            { title: '调用次数', dataIndex: 'count', width: 110, align: 'right', render: (v) => v.toLocaleString() },
            {
              title: '错误', dataIndex: 'errors', width: 90, align: 'right',
              render: (v) => v > 0 ? <Text type="danger">{v}</Text> : <Text type="secondary">0</Text>,
            },
            { title: '平均延迟', dataIndex: 'avgLatencyMs', width: 110, align: 'right', render: (v) => `${v} ms` },
            { title: '最大延迟', dataIndex: 'maxLatencyMs', width: 110, align: 'right', render: (v) => `${v} ms` },
          ]} />
      </Card>
    </div>
  );
}

function HealthRow({ label, ok, okText, badText }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
      <Text type="secondary">{label}</Text>
      {ok
        ? <Tag color="green" style={{ margin: 0 }}>{okText}</Tag>
        : <Tag color="red" style={{ margin: 0 }}>{badText || '异常'}</Tag>}
    </div>
  );
}

function QpsChart({ data }) {
  const width = 640, height = 140, pad = 4;
  if (!data || data.length < 2) {
    return <div style={{ height, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#999' }}>采样中…</div>;
  }
  const max = Math.max(...data, 1);
  const pts = data.map((v, i) =>
    `${pad + (i / (data.length - 1)) * (width - pad * 2)},${height - pad - (v / max) * (height - pad * 2 - 12)}`
  ).join(' ');
  const last = data[data.length - 1];
  return (
    <svg viewBox={`0 0 ${width} ${height}`} style={{ width: '100%', height: 140 }}>
      <polyline points={pts} fill="none" stroke="#1a3a6b" strokeWidth="2" />
      <circle cx={pad + (width - pad * 2)} cy={height - pad - (last / max) * (height - pad * 2 - 12)} r="3" fill="#e03131" />
      <text x={8} y={14} fontSize="11" fill="#888">峰值 {max.toFixed(1)}</text>
      <text x={8} y={height - 6} fontSize="11" fill="#888">当前 {last.toFixed(1)} req/s</text>
    </svg>
  );
}

function fmtDuration(sec) {
  if (sec == null) return '-';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h > 0 ? `${h} 小时 ${m} 分` : m > 0 ? `${m} 分 ${s} 秒` : `${s} 秒`;
}
