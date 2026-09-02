import React, { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import {
  Drawer, Card, Row, Col, Statistic, Form, InputNumber, Button, Table, Tag, Typography,
  Space, Grid, Segmented, Empty, Tabs, Divider, Alert, message,
} from 'antd';
import {
  RiseOutlined, FallOutlined, MinusOutlined, ExperimentOutlined,
} from '@ant-design/icons';
import QuoteTable, { Sparkline } from '../components/QuoteTable.jsx';
import { api, fmtMoney, fmtPrice, priceClass, getToken } from '../api.js';

const { useBreakpoint } = Grid;
const { Text, Title } = Typography;

const SIDE_COLOR = { long: '#e03131', short: '#0ca678' };
const SIDE_LABEL = { long: '做多（买入）', short: '做空（卖出）' };

export default function TraderView({ tab }) {
  const screens = useBreakpoint();
  const isMobile = !screens.md;
  const [account, setAccount] = useState(null);
  const [quotes, setQuotes] = useState([]);
  const [positions, setPositions] = useState([]);
  const [orders, setOrders] = useState([]);
  const [selected, setSelected] = useState(null); // quote in drawer
  const [depth, setDepth] = useState(null);  // L2 盘口
  const [ticks, setTicks] = useState([]);    // 分时 tick
  const [side, setSide] = useState('long');
  const [volume, setVolume] = useState(1);
  const [placing, setPlacing] = useState(false);
  const esRef = useRef(null);

  const refreshAccount = useCallback(async () => {
    try {
      const [acc, pos, ords] = await Promise.all([
        api('/api/trader/account'),
        api('/api/trader/positions'),
        api('/api/trader/orders'),
      ]);
      setAccount(acc);
      setPositions(pos);
      setOrders(ords);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    refreshAccount();
    const t = setInterval(refreshAccount, 3000);
    return () => clearInterval(t);
  }, [refreshAccount]);

  // SSE L1 推送（行情表）
  useEffect(() => {
    let closed = false;
    const connect = () => {
      if (closed) return;
      const es = new EventSource(`/api/market/stream?level=L1&token=${getToken()}`);
      esRef.current = es;
      es.addEventListener('quote', (e) => {
        try {
          const snapshot = JSON.parse(e.data);
          setQuotes((prev) => {
            const map = new Map(prev.map((p) => [p.id, p]));
            return snapshot.map((s) => ({ ...(map.get(s.id) || {}), ...s }));
          });
        } catch { /* ignore */ }
      });
      es.addEventListener('error', () => {
        es.close();
        setTimeout(connect, 2000);
      });
    };
    api('/api/market/futures').then((data) => !closed && setQuotes(data)).catch(() => {});
    connect();
    return () => { closed = true; esRef.current && esRef.current.close(); };
  }, []);

  // 选中期货：加载深度盘口、tick 分时，订阅 L2
  useEffect(() => {
    if (!selected) {
      setDepth(null);
      setTicks([]);
      return;
    }
    let cancelled = false;
    let es = null;
    const load = async () => {
      const [d, t] = await Promise.all([
        api(`/api/market/futures/${selected.id}/depth`),
        api(`/api/market/futures/${selected.id}/ticks?limit=300`),
      ]);
      if (cancelled) return;
      setDepth(d);
      setTicks(t);
    };
    load();
    // L2 SSE
    try {
      es = new EventSource(`/api/market/stream?level=L2&futureId=${selected.id}&token=${getToken()}`);
      es.addEventListener('depth', (e) => {
        try { !cancelled && setDepth(JSON.parse(e.data)); } catch {}
      });
      es.addEventListener('error', () => es.close());
    } catch {}
    // 同步 L1 更新选中对象（价格变化影响盘口和头部展示）
    setQuotes((prev) => {
      const latest = prev.find((q) => q.id === selected.id);
      if (latest && latest.price !== selected.price) {
        setSelected(latest);
      }
      return prev;
    });
    return () => {
      cancelled = true;
      if (es) es.close();
    };
  }, [selected?.id]);

  // 每 2 秒刷新一次盘口（作为 SSE 兜底）与分时 tick
  useEffect(() => {
    if (!selected) return;
    const t = setInterval(async () => {
      try {
        const [d, t] = await Promise.all([
          api(`/api/market/futures/${selected.id}/depth`),
          api(`/api/market/futures/${selected.id}/ticks?limit=300`),
        ]);
        setDepth(d);
        setTicks(t);
        const q = await api('/api/market/futures');
        const latest = q.find((x) => x.id === selected.id);
        if (latest) setSelected(latest);
      } catch {}
    }, 2000);
    return () => clearInterval(t);
  }, [selected?.id]);

  const myPositions = positions.filter((p) => p.future_id === selected?.id);
  const myOrders = orders.filter((o) => o.future_id === selected?.id).slice(0, 30);
  const position = myPositions[0];

  const placeOrder = async () => {
    if (!selected) return;
    setPlacing(true);
    try {
      const res = await api('/api/trader/orders', {
        method: 'POST',
        body: { futureId: selected.id, side, volume },
      });
      message.success(res.message);
      refreshAccount();
    } catch (e) {
      message.error(e.message);
    } finally {
      setPlacing(false);
    }
  };

  const openDrawer = (quote) => {
    setSelected(quote);
    setSide('long');
    setVolume(quote.minVolume || 1);
  };

  // 侧栏交易预览值
  const feeRate = 0.001; // 可在 account 页展示，这里做计算预览用默认值，实际以服务器为准
  const marginRatio = 0.10;
  const priceNow = selected ? selected.price : 0;
  const value = priceNow * volume;
  const marginPreview = +(value * marginRatio).toFixed(2);
  const feePreview = +(value * feeRate).toFixed(2);

  return (
    <div className="page" style={{ maxWidth: '100%', overflowX: 'hidden' }}>
      {tab === 'market' && (
        <>
          {/* Row gutter 外层必须 overflow:hidden，避免 AntD Row 的负 margin 产生横向溢出 */}
          <div style={{ overflow: 'hidden' }}>
            <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
              <Col xs={24} sm={12} md={6}><Card size="small"><Statistic title="账户余额" value={account?.balance ?? 0} precision={2} prefix="¥" /></Card></Col>
              <Col xs={24} sm={12} md={6}><Card size="small"><Statistic title="占用保证金" value={account?.usedMargin ?? 0} precision={2} prefix="¥" /></Card></Col>
              <Col xs={24} sm={12} md={6}><Card size="small"><Statistic title="可用资金" value={account?.available ?? 0} precision={2} prefix="¥" /></Card></Col>
              <Col xs={24} sm={12} md={6}>
                <Card size="small">
                  <Statistic
                    title="浮动盈亏"
                    value={positions.reduce((s, p) => s + p.floatPnl, 0)}
                    precision={2}
                    valueStyle={{ color: positions.reduce((s, p) => s + p.floatPnl, 0) >= 0 ? '#e03131' : '#0ca678' }}
                    prefix="¥"
                  />
                </Card>
              </Col>
            </Row>
          </div>
          <QuoteTable onRowClick={openDrawer} selectedId={selected?.id} />
        </>
      )}

      {tab === 'account' && (
        <AccountView account={account} positions={positions} orders={orders} />
      )}

      {/* ============ Drawer 交易侧栏 ============ */}
      <Drawer
        title={null}
        open={!!selected}
        onClose={() => setSelected(null)}
        width={isMobile ? '100%' : 560}
        placement="right"
        destroyOnClose
        mask={isMobile}          // 桌面端允许点击行情，只压缩；移动端覆盖整页
        maskClosable={true}
        closable={true}
        styles={{
          header: { padding: 0, minHeight: 0, borderBottom: 'none', display: 'none' },
          // Drawer body 自身使用 100% 高度，不允许溢出。根 div 继承这个高度。
          body: {
            padding: 0, height: '100%', boxSizing: 'border-box', overflow: 'hidden',
            maxWidth: '100vw',
          },
          content: {
            boxShadow: isMobile ? 'none' : '-4px 0 24px rgba(0,0,0,.08)',
            display: 'flex', flexDirection: 'column',
            maxWidth: '100vw', overflow: 'hidden',
          },
          // content-wrapper 本身要高度=视口、宽度=抽屉宽度；否则 min-height 100vh 会溢出
          wrapper: { maxWidth: '100vw' },
        }}
        classNames={{
          body: 'trader-drawer-body',
        }}
      >
        {selected && (
          // 根容器使用 height:100%，而不是 min-height:100vh！
          // Drawer 在桌面端 height=视口高、移动端 height=100%，两者都能正确填满且不溢出。
          <div style={{
            height: '100%', width: '100%',
            display: 'flex', flexDirection: 'column',
            overflow: 'hidden', boxSizing: 'border-box',
          }}>
            {/* ------- 头部：精细行情 ------- */}
            <div style={{
              padding: 16, borderBottom: '1px solid #f0f0f0', flexShrink: 0,
              background: `linear-gradient(135deg, ${selected.change >= 0 ? '#fff5f5' : '#f0faf5'} 0%, #fff 100%)`,
              maxWidth: '100%', overflow: 'hidden',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 8 }}>
                <div style={{ minWidth: 0 }}>
                  <Title level={4} style={{ margin: 0, fontSize: 20, lineHeight: 1.2 }}>
                    <span style={{ whiteSpace: 'nowrap' }}>{selected.code}</span>
                    <Text type="secondary" style={{ fontSize: 13, fontWeight: 400, marginLeft: 6 }}>{selected.ticker}</Text>
                  </Title>
                  <Text type="secondary" style={{ display: 'block', marginTop: 2, wordBreak: 'break-all' }}>{selected.name}</Text>
                </div>
                <div style={{ flexShrink: 0 }}>
                  <Tag color={selected.halted ? 'red' : 'green'} style={{ margin: 0 }}>{selected.halted ? (selected.haltReason || '已熔断').slice(0, 14) : '交易中'}</Tag>
                </div>
              </div>
              <div style={{ marginTop: 12, display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
                <span className={`mono quote-cell ${priceClass(selected.change)}`} style={{ fontSize: 26, lineHeight: 1.1, wordBreak: 'break-all' }}>
                  {selected.change > 0 ? '▲' : selected.change < 0 ? '▼' : '—'} {fmtPrice(priceNow)}
                </span>
                <span className={`mono ${priceClass(selected.change)}`}>
                  {selected.change >= 0 ? '+' : ''}{fmtPrice(selected.change)}
                </span>
                <span className={`mono ${priceClass(selected.change)}`}>
                  {selected.changePct >= 0 ? '+' : ''}{selected.changePct.toFixed(2)}%
                </span>
              </div>
              <div style={{ marginTop: 10, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(96px,1fr))', gap: '4px 14px', fontSize: 12, color: '#666' }}>
                <div style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>今开：<span className="mono" style={{ color: '#222' }}>{fmtPrice(selected.dayOpen)}</span></div>
                <div style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>昨收：<span className="mono" style={{ color: '#222' }}>{fmtPrice(selected.prevClose)}</span></div>
                <div style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>最高：<span className="mono price-up">{fmtPrice(selected.dayHigh ?? priceNow)}</span></div>
                <div style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>最低：<span className="mono price-down">{fmtPrice(selected.dayLow ?? priceNow)}</span></div>
                <div style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>最小跳动：<span className="mono" style={{ color: '#222' }}>{Number(selected.tickSize ?? 0.0001).toFixed(6)}</span></div>
                <div style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>每档手数：<span className="mono" style={{ color: '#222' }}>{selected.handsPerTick ?? 10}</span></div>
                <div style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>交易门槛：<span className="mono" style={{ color: '#222' }}>{selected.minVolume} 手</span></div>
              </div>
            </div>

            {/* ------- 分时走势 ------- */}
            <div style={{
              padding: '10px 16px', borderBottom: '1px solid #f0f0f0',
              flexShrink: 0, maxWidth: '100%', overflow: 'hidden',
            }}>
              <Text type="secondary" style={{ fontSize: 12 }}>分时走势（成交事件驱动）</Text>
              <div style={{ marginTop: 4, width: '100%', background: '#fafafa', borderRadius: 4, padding: 8, boxSizing: 'border-box', overflow: 'hidden' }}>
                <BigSparkline data={ticks.map((t) => t.price)} />
                {ticks.length < 2 && (
                  <div style={{ textAlign: 'center', color: '#bbb', fontSize: 12, padding: '14px 0' }}>
                    <ExperimentOutlined /> 暂无成交，价格静止中
                  </div>
                )}
              </div>
            </div>

            {/* ------- 五档盘口 ------- */}
            <div style={{
              padding: '10px 16px', borderBottom: '1px solid #f0f0f0',
              flexShrink: 0, maxWidth: '100%', overflow: 'hidden',
            }}>
              <Text strong style={{ fontSize: 13 }}>五档盘口（L2）</Text>
              <div style={{ marginTop: 6, minWidth: 0 }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr minmax(70px, auto) 1fr', gap: 6, fontSize: 12 }}>
                  <div style={{ textAlign: 'right', color: '#999' }}>档位</div>
                  <div style={{ textAlign: 'center', color: '#999' }}>价格</div>
                  <div style={{ color: '#999' }}>量</div>
                </div>
                {depth && (
                  <>
                    {[...depth.asks].reverse().map((a, i) => {
                      const maxV = Math.max(...depth.asks.map((x) => x.volume), ...depth.bids.map((x) => x.volume)) || 1;
                      const ratio = a.volume / maxV;
                      return (
                        <div key={`a${i}`} style={{
                          display: 'grid', gridTemplateColumns: '1fr minmax(70px, auto) 1fr', gap: 6, alignItems: 'center',
                          position: 'relative', fontSize: 12,
                        }}>
                          <div style={{ position: 'absolute', inset: 0, background: '#fff1f0', opacity: 0.6, transformOrigin: 'right', transform: `scaleX(${ratio})`, zIndex: 0 }} />
                          <div style={{ textAlign: 'right', position: 'relative', zIndex: 1, color: '#666' }}>卖{a.level}</div>
                          <div style={{ textAlign: 'center', position: 'relative', zIndex: 1 }} className="mono price-up">{fmtPrice(a.price)}</div>
                          <div style={{ position: 'relative', zIndex: 1, color: '#333', overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.volume}</div>
                        </div>
                      );
                    })}
                    <div style={{
                      textAlign: 'center', padding: '6px 0', margin: '4px 0',
                      background: selected.change >= 0 ? '#fff5f5' : '#f0faf5',
                      fontWeight: 600, fontSize: 14,
                    }} className={`mono ${priceClass(selected.change)}`}>
                      {selected.change > 0 ? '▲' : selected.change < 0 ? '▼' : '—'} {fmtPrice(priceNow)}
                    </div>
                    {depth.bids.map((b, i) => {
                      const maxV = Math.max(...depth.asks.map((x) => x.volume), ...depth.bids.map((x) => x.volume)) || 1;
                      const ratio = b.volume / maxV;
                      return (
                        <div key={`b${i}`} style={{
                          display: 'grid', gridTemplateColumns: '1fr minmax(70px, auto) 1fr', gap: 6, alignItems: 'center',
                          position: 'relative', fontSize: 12,
                        }}>
                          <div style={{ position: 'absolute', inset: 0, background: '#e6f8f0', opacity: 0.6, transformOrigin: 'left', transform: `scaleX(${ratio})`, zIndex: 0 }} />
                          <div style={{ textAlign: 'right', position: 'relative', zIndex: 1, color: '#666' }}>买{b.level}</div>
                          <div style={{ textAlign: 'center', position: 'relative', zIndex: 1 }} className="mono price-down">{fmtPrice(b.price)}</div>
                          <div style={{ position: 'relative', zIndex: 1, color: '#333', overflow: 'hidden', textOverflow: 'ellipsis' }}>{b.volume}</div>
                        </div>
                      );
                    })}
                  </>
                )}
              </div>
            </div>

            {/* ------- 交易面板 ------- */}
            <div style={{
              padding: 14, borderBottom: '1px solid #f0f0f0', flexShrink: 0,
              maxWidth: '100%', overflow: 'hidden',
            }}>
              <div style={{ marginBottom: 10 }}>
                <Segmented
                  block
                  size="large"
                  value={side}
                  onChange={setSide}
                  options={[
                    { label: <span><RiseOutlined /> 做多（买入）</span>, value: 'long' },
                    { label: <span><FallOutlined /> 做空（卖出）</span>, value: 'short' },
                  ]}
                />
              </div>
              {selected.halted && (
                <Alert type="error" showIcon style={{ marginBottom: 10 }}
                  message={`该期货已熔断：${(selected.haltReason || '暂停交易').slice(0, 32)}`} />
              )}
              <div style={{
                padding: 12, borderRadius: 8, marginBottom: 10,
                border: `1px solid ${side === 'long' ? '#ffd1cf' : '#c4efd4'}`,
                background: side === 'long' ? '#fff8f8' : '#f4fbf5',
                overflow: 'hidden', boxSizing: 'border-box',
              }}>
                <div style={{ fontSize: 12, color: '#666', marginBottom: 6 }}>交易数量（手）</div>
                <InputNumber
                  min={selected.minVolume || 1}
                  max={9999999}
                  precision={0}
                  value={volume}
                  onChange={(v) => setVolume(Math.max(selected.minVolume || 1, Number(v) || 0))}
                  size="large"
                  style={{ width: '100%', maxWidth: '100%' }}
                  suffix={
                    <span style={{ fontSize: 12, color: '#999' }}>≥{selected.minVolume}手</span>
                  }
                />
                <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                  {[1, 5, 10, 25, 50, 100].map((n) => Math.max(selected.minVolume || 1, n) && (
                    <Button key={n} size="small" type={volume === n ? 'primary' : 'default'} onClick={() => setVolume(n)}>
                      {n}手
                    </Button>
                  ))}
                </div>
                <div style={{ overflow: 'hidden', marginTop: 12 }}>
                  <Row gutter={[12, 8]}>
                    <Col xs={24} sm={12}><Statistic title="合约价值" value={value} precision={2} prefix="¥" /></Col>
                    <Col xs={24} sm={12}><Statistic title="保证金（约）" value={marginPreview} precision={2} prefix="¥" /></Col>
                    <Col xs={24} sm={12}><Statistic title="手续费（约）" value={feePreview} precision={2} prefix="¥" /></Col>
                    <Col xs={24} sm={12}><Statistic title="可用资金" value={account?.available ?? 0} precision={2} prefix="¥" /></Col>
                  </Row>
                </div>
              </div>
              <Button
                block
                size="large"
                type="primary"
                danger={side === 'long'}
                style={{
                  height: 52, fontSize: 15, fontWeight: 600,
                  background: side === 'long' ? '#e03131' : '#0ca678',
                  border: 'none',
                  maxWidth: '100%', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis',
                }}
                onClick={placeOrder}
                loading={placing}
                disabled={selected.halted}
              >
                {side === 'long' ? '买入开多（按卖一价成交）' : '卖出开空（按买一价成交）'}
              </Button>
              {position && (
                <div style={{ marginTop: 12, padding: 12, borderRadius: 8, background: '#fafafa', overflow: 'hidden' }}>
                  <div style={{ fontSize: 12, color: '#666', marginBottom: 6 }}>当前持有</div>
                  <div style={{ overflow: 'hidden' }}>
                    <Row gutter={[8, 6]} wrap={true}>
                      <Col xs={24} sm={8}>
                        <Tag color={position.side === 'long' ? 'red' : 'green'}>
                          {position.side === 'long' ? '多' : '空'} {position.volume} 手
                        </Tag>
                      </Col>
                      <Col xs={24} sm={8}>均价：<span className="mono">{fmtPrice(position.avg_price)}</span></Col>
                      <Col xs={24} sm={8}>
                        盈亏：<span className={`mono ${priceClass(position.floatPnl)}`}>{position.floatPnl >= 0 ? '+' : ''}{fmtMoney(position.floatPnl)}</span>
                      </Col>
                    </Row>
                  </div>
                </div>
              )}
            </div>

            {/* ------- Tabs：成交 / 持仓 ------- */}
            {/* 剩余空间用 flex:1；minHeight:0 允许在父 flex 下正确收缩并触发内部滚动 */}
            <div style={{
              flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column',
              maxWidth: '100%', overflow: 'hidden',
            }}>
              <Tabs
                size="small"
                tabPosition="top"
                style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, margin: 0 }}
                items={[
                  {
                    key: 'orders',
                    label: `该合约成交 (${myOrders.length})`,
                    children: (
                      <div style={{
                        flex: 1, minHeight: 0, overflow: 'auto', padding: '0 16px 16px',
                        maxWidth: '100%', boxSizing: 'border-box',
                      }}>
                        <Table
                          rowKey="id" size="small" pagination={{ pageSize: 10 }} dataSource={myOrders}
                          locale={{ emptyText: <Empty description="暂无该合约成交" /> }}
                          scroll={{ x: 'max-content' }}
                          columns={[
                            { title: '时间', dataIndex: 'created_at', width: 90, render: (v) => new Date(v).toLocaleTimeString('zh-CN', { hour12: false }) },
                            { title: '方向', dataIndex: 'side', width: 60, render: (v) => <Tag color={v === 'long' ? 'red' : 'green'}>{v === 'long' ? '多' : '空'}</Tag> },
                            { title: '价', dataIndex: 'price', width: 80, align: 'right', render: (v) => <span className="mono">{fmtPrice(v)}</span> },
                            { title: '量', dataIndex: 'volume', width: 50, align: 'right' },
                            { title: '已实现盈亏', dataIndex: 'realized_pnl', width: 95, align: 'right', render: (v) => <span className={`mono ${priceClass(Number(v))}`}>{Number(v) >= 0 ? '+' : ''}{fmtMoney(v)}</span> },
                            { title: '费/税', width: 85, align: 'right', render: (_, r) => `${fmtMoney(r.fee)}/${fmtMoney(r.tax)}` },
                          ]}
                        />
                      </div>
                    ),
                  },
                  {
                    key: 'positions',
                    label: '全部持仓',
                    children: (
                      <div style={{
                        flex: 1, minHeight: 0, overflow: 'auto', padding: '0 16px 16px',
                        maxWidth: '100%', boxSizing: 'border-box',
                      }}>
                        <Table
                          rowKey="id" size="small" pagination={false} dataSource={positions}
                          locale={{ emptyText: <Empty description="暂无持仓" /> }}
                          scroll={{ x: 'max-content' }}
                          columns={[
                            { title: '期货', render: (_, r) => `${r.code} ${r.name}`, width: 220, ellipsis: true },
                            { title: '方向', dataIndex: 'side', width: 60, render: (v) => <Tag color={v === 'long' ? 'red' : 'green'}>{v === 'long' ? '多' : '空'}</Tag> },
                            { title: '手数', dataIndex: 'volume', width: 60, align: 'right' },
                            { title: '开仓均价', dataIndex: 'avg_price', width: 90, align: 'right', render: (v) => <span className="mono">{fmtPrice(v)}</span> },
                            { title: '最新价', dataIndex: 'lastPrice', width: 90, align: 'right', render: (v) => <span className="mono">{fmtPrice(v)}</span> },
                            { title: '浮动盈亏', dataIndex: 'floatPnl', width: 110, align: 'right', render: (v) => <span className={`mono ${priceClass(v)}`}>{v >= 0 ? '+' : ''}{fmtMoney(v)}</span> },
                          ]}
                        />
                      </div>
                    ),
                  },
                ]}
              />
            </div>
          </div>
        )}
      </Drawer>
    </div>
  );
}

// 更宽的分时走势图（侧栏内用）
function BigSparkline({ data, width = 600, height = 100 }) {
  if (!data || data.length < 2) {
    return <Sparkline data={[]} width={width} height={height} />;
  }
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const len = data.length;
  const pts = data.map((v, i) =>
    `${(i / (len - 1)) * width},${height - ((v - min) / range) * (height - 8) - 4}`
  ).join(' ');
  const up = data[data.length - 1] >= data[0];
  const color = up ? '#e03131' : '#0ca678';
  const fillId = 'sf' + (Math.random().toString(36).slice(2, 8));
  return (
    <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} preserveAspectRatio="none"
      style={{ display: 'block', overflow: 'hidden', maxWidth: '100%' }}>
      <defs>
        <linearGradient id={fillId} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.25" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={`0,${height} ${pts} ${width},${height}`} fill={`url(#${fillId})`} />
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" />
    </svg>
  );
}

function AccountView({ account, positions, orders }) {
  return (
    <div style={{ overflow: 'hidden' }}>
      <Row gutter={[16, 16]}>
        <Col xs={24} md={8}>
          <Card title="保证金账户" size="small">
            <Statistic title="余额" value={account?.balance ?? 0} precision={2} prefix="¥" />
            <Statistic title="占用保证金" value={account?.usedMargin ?? 0} precision={2} prefix="¥" style={{ marginTop: 8 }} />
            <Statistic title="可用资金" value={account?.available ?? 0} precision={2} prefix="¥" style={{ marginTop: 8 }} />
            <Statistic title="冻结保证金" value={account?.reservedMargin ?? 0} precision={2} prefix="¥" style={{ marginTop: 8 }} />
            <Alert type="info" showIcon style={{ marginTop: 16 }}
              message="虚拟充值" description="交易商的充值与提供方/接收方不同：请在交易所后台或联系管理员充值（演示环境待充值可使用 trader1 / trader1@tex.io）。" />
          </Card>
        </Col>
        <Col xs={24} md={16}>
          <Card title="全部持仓" size="small" style={{ marginBottom: 16 }}>
            <Table rowKey="id" size="small" pagination={false} dataSource={positions}
              locale={{ emptyText: <Empty description="暂无持仓" /> }}
              scroll={{ x: 'max-content' }}
              columns={[
                { title: '期货', render: (_, r) => `${r.code} ${r.name}`, ellipsis: true },
                { title: '方向', dataIndex: 'side', width: 70, render: (v) => <Tag color={v === 'long' ? 'red' : 'green'}>{v === 'long' ? '多' : '空'}</Tag> },
                { title: '手数', dataIndex: 'volume', align: 'right', width: 70 },
                { title: '均价', dataIndex: 'avg_price', align: 'right', width: 100, render: (v) => <span className="mono">{fmtPrice(v)}</span> },
                { title: '最新价', dataIndex: 'lastPrice', align: 'right', width: 100, render: (v) => <span className="mono">{fmtPrice(v)}</span> },
                { title: '浮动盈亏', dataIndex: 'floatPnl', align: 'right', width: 120, render: (v) => <span className={`mono ${priceClass(v)}`}>{fmtMoney(v)}</span> },
              ]} />
          </Card>
          <Card title="全部成交" size="small">
            <Table rowKey="id" size="small" pagination={{ pageSize: 10 }} dataSource={orders}
              locale={{ emptyText: <Empty description="暂无成交" /> }}
              scroll={{ x: 'max-content' }}
              columns={[
                { title: '时间', dataIndex: 'created_at', width: 150, render: (v) => new Date(v).toLocaleString('zh-CN', { hour12: false }) },
                { title: '期货', dataIndex: 'code', width: 110, ellipsis: true },
                { title: '方向', dataIndex: 'side', width: 60, render: (v) => <Tag color={v === 'long' ? 'red' : 'green'}>{v === 'long' ? '多' : '空'}</Tag> },
                { title: '价格', dataIndex: 'price', width: 100, align: 'right', render: (v) => <span className="mono">{fmtPrice(v)}</span> },
                { title: '手数', dataIndex: 'volume', width: 60, align: 'right' },
                { title: '已实现盈亏', dataIndex: 'realized_pnl', width: 120, align: 'right', render: (v) => <span className={`mono ${priceClass(Number(v))}`}>{Number(v) >= 0 ? '+' : ''}{fmtMoney(v)}</span> },
                { title: '手续费', dataIndex: 'fee', width: 80, align: 'right', render: (v) => fmtMoney(v) },
                { title: '税费', dataIndex: 'tax', width: 70, align: 'right', render: (v) => fmtMoney(v) },
              ]} />
          </Card>
        </Col>
      </Row>
    </div>
  );
}
