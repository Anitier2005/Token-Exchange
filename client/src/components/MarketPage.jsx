import React, { useEffect, useRef, useState } from 'react';
import { Card, Col, Row, Tag, Typography, Descriptions, Segmented, Button, Empty, Tooltip } from 'antd';
import { LayoutOutlined, OrderedListOutlined, AppstoreOutlined } from '@ant-design/icons';
import QuoteTable, { Sparkline } from './QuoteTable.jsx';
import { api, fmtPrice, getToken, priceClass } from '../api.js';

const { Text, Paragraph } = Typography;

// 共享行情页：所有账户看到的行情一致；管理员为最高级（L2 深度实时推送）
// 布局支持「左右 / 上下」排布切换，窄屏自动上下排布，保证无横向拖拽
export default function MarketPage({ role, onTrade }) {
  const [layout, setLayout] = useState('side');       // side 左右 / stacked 上下
  const [selected, setSelected] = useState(null);
  const [ticks, setTicks] = useState([]);
  const [depth, setDepth] = useState(null);
  const depthRef = useRef(null);

  // 选中合约后拉取历史 tick
  useEffect(() => {
    if (!selected) return;
    setTicks([]);
    (async () => {
      try {
        const data = await api(`/api/market/futures/${selected.id}/ticks?limit=120`);
        setTicks(data.map((t) => t.price));
      } catch { /* ignore */ }
    })();
  }, [selected?.id]);

  // 管理员：订阅 L2 深度（最高级行情）
  useEffect(() => {
    if (role !== 'admin' || !selected) return;
    const es = new EventSource(
      `/api/market/stream?level=L2&futureId=${selected.id}&token=${getToken()}`);
    depthRef.current = es;
    es.addEventListener('depth', (e) => {
      try { setDepth(JSON.parse(e.data)); } catch { /* ignore */ }
    });
    return () => es.close();
  }, [role, selected?.id]);

  const sideBySide = layout === 'side';
  const tickData = ticks.length > 1 ? ticks : [selected?.price, selected?.price];

  return (
    <div>
      <Card size="small" style={{ marginBottom: 12 }}>
        <Segmented
          value={layout}
          onChange={setLayout}
          options={[
            { value: 'side', label: '左右排布', icon: <AppstoreOutlined /> },
            { value: 'stacked', label: '上下排布', icon: <OrderedListOutlined /> },
          ]}
        />
        <Text type="secondary" style={{ marginLeft: 12, fontSize: 12 }}>
          <LayoutOutlined /> 可切换控件排布方式；窄屏自动上下排布
          {role === 'admin' && ' · 管理员最高级行情（L2 深度实时推送）'}
        </Text>
      </Card>
      <Row gutter={[12, 12]}>
        <Col xs={24} lg={sideBySide ? 14 : 24}>
          <QuoteTable onRowClick={setSelected} selectedId={selected?.id} />
        </Col>
        <Col xs={24} lg={sideBySide ? 10 : 24}>
          {selected ? (
            <Card
              size="small"
              title={(
                <span>
                  <Text strong className="mono">{selected.code}</Text>
                  <Text code style={{ marginLeft: 8 }}>{selected.ticker}</Text>
                  <span style={{ marginLeft: 8 }}>{selected.name}</span>
                </span>
              )}
              extra={onTrade && role === 'trader' ? (
                <Button type="primary" size="small" onClick={() => onTrade(selected)}>下单</Button>
              ) : undefined}
            >
              <div style={{ textAlign: 'center', marginBottom: 12 }}>
                <span className={`mono quote-cell ${priceClass(selected.change)}`} style={{ fontSize: 26 }}>
                  {fmtPrice(selected.price)}
                </span>
                <span className={`mono ${priceClass(selected.change)}`} style={{ marginLeft: 12 }}>
                  {selected.change > 0 ? '+' : ''}{fmtPrice(selected.change)}（{selected.changePct > 0 ? '+' : ''}{selected.changePct}%）
                </span>
              </div>
              <Sparkline data={tickData} width={520} height={80} stroke={2} />
              <Descriptions size="small" column={1} style={{ marginTop: 12 }}>
                <Descriptions.Item label="计量指标">{selected.metricLabel}</Descriptions.Item>
                <Descriptions.Item label="所属模型">{selected.model}</Descriptions.Item>
                {selected.providerName && (
                  <Descriptions.Item label="提供方">{selected.providerName}</Descriptions.Item>
                )}
                <Descriptions.Item label="交易状态">
                  {selected.halted
                    ? <Tooltip title={selected.haltReason}><Tag color="red">已熔断</Tag></Tooltip>
                    : <Tag color="green">交易中</Tag>}
                </Descriptions.Item>
                <Descriptions.Item label="月费 / 额度">
                  ¥{Number(selected.monthlyFee ?? 0).toFixed(2)} / {Number(selected.monthlyQuotaTokens ?? 0).toLocaleString()} tokens
                </Descriptions.Item>
                <Descriptions.Item label="超额单价">
                  ¥{Number(selected.overagePricePer1k ?? 0).toFixed(2)} / 1K
                </Descriptions.Item>
                <Descriptions.Item label="简介">
                  <Paragraph style={{ marginBottom: 0 }}>{selected.description || '-'}</Paragraph>
                </Descriptions.Item>
              </Descriptions>

              {role === 'admin' && (
                <div style={{ marginTop: 12 }}>
                  <Text strong>L2 深度（五档）</Text>
                  {depth ? <DepthTable depth={depth} /> : (
                    <Paragraph type="secondary" style={{ marginTop: 8 }}>深度数据推送中…</Paragraph>
                  )}
                </div>
              )}
            </Card>
          ) : (
            <Card size="small">
              <Empty description="点击左侧行情中的合约查看详情" />
            </Card>
          )}
        </Col>
      </Row>
    </div>
  );
}

function DepthTable({ depth }) {
  const rows = [
    ...[...depth.asks].reverse().map((a) => ({ ...a, side: 'ask' })),
    { level: 0, price: depth.price, volume: null, side: 'mid' },
    ...depth.bids.map((b) => ({ ...b, side: 'bid' })),
  ];
  return (
    <div style={{ marginTop: 8, fontFamily: 'JetBrains Mono, Consolas, monospace' }}>
      {rows.map((r, i) => (
        <div key={i} className={`depth-row ${r.side === 'ask' ? 'price-down' : r.side === 'bid' ? 'price-up' : ''}`}
          style={r.side === 'mid' ? { borderTop: '1px solid #d9d9d9', borderBottom: '1px solid #d9d9d9', fontWeight: 700, margin: '2px 0' } : undefined}>
          <span>{r.side === 'ask' ? `卖${r.level}` : r.side === 'bid' ? `买${r.level}` : '最新'}</span>
          <span>{fmtPrice(r.price)}</span>
          <span>{r.volume != null ? r.volume : '—'}</span>
        </div>
      ))}
    </div>
  );
}
