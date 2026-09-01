import React, { useEffect, useRef, useState } from 'react';
import { Card, Table, Tag, Typography, Tooltip } from 'antd';
import { api, fmtPrice, getToken, priceClass } from '../api.js';

const { Text } = Typography;

// 实时行情表格：SSE 推送，红涨绿跌
export default function QuoteTable({ onRowClick, selectedId, streamLevel = 'L1' }) {
  const [quotes, setQuotes] = useState([]);
  const [ticksMap, setTicksMap] = useState({});
  const esRef = useRef(null);

  const loadOnce = async () => {
    try {
      const data = await api('/api/market/futures');
      setQuotes(data);
    } catch { /* ignore */ }
  };

  useEffect(() => {
    loadOnce();
    // SSE 实时推送（频率由服务端管理员配置决定）
    const es = new EventSource(`/api/market/stream?level=L1&token=${getToken()}`);
    esRef.current = es;
    es.addEventListener('quote', (e) => {
      try {
        const snapshot = JSON.parse(e.data);
        setQuotes((prev) => {
          // 合并静态字段（月费等）
          const map = new Map(prev.map((p) => [p.id, p]));
          return snapshot.map((s) => ({ ...(map.get(s.id) || {}), ...s }));
        });
        setTicksMap((prev) => {
          const next = { ...prev };
          for (const s of snapshot) {
            const arr = next[s.id] || [];
            if (!arr.length || arr[arr.length - 1].price !== s.price) {
              next[s.id] = [...arr, { price: s.price, ts: Date.now() }].slice(-120);
            }
          }
          return next;
        });
      } catch { /* ignore */ }
    });
    return () => es.close();
  }, []);

  const columns = [
    { title: '代码', dataIndex: 'code', width: 110, render: (v) => <Text strong>{v}</Text> },
    { title: '名称', dataIndex: 'name', ellipsis: true },
    {
      title: '最新价', dataIndex: 'price', width: 120, align: 'right',
      render: (v, r) => <span className={`mono quote-cell ${priceClass(r.change)}`}>{fmtPrice(v)}</span>,
    },
    {
      title: '涨跌额', dataIndex: 'change', width: 100, align: 'right',
      render: (v) => <span className={`mono ${priceClass(v)}`}>{v > 0 ? '+' : ''}{fmtPrice(v)}</span>,
    },
    {
      title: '涨跌幅', dataIndex: 'changePct', width: 100, align: 'right',
      render: (v) => <span className={`mono ${priceClass(v)}`}>{v > 0 ? '+' : ''}{v.toFixed(2)}%</span>,
    },
    {
      title: '走势', width: 140, key: 'spark',
      render: (_, r) => <Sparkline data={(ticksMap[r.id] || []).map((t) => t.price)} />,
    },
    {
      title: '状态', dataIndex: 'halted', width: 100, align: 'center',
      render: (halted, r) => halted
        ? <Tooltip title={r.haltReason}><Tag color="red">已熔断</Tag></Tooltip>
        : <Tag color="green">交易中</Tag>,
    },
  ];

  return (
    <Card title="期货行情（实时推送 · 红涨绿跌）" size="small">
      <Table
        rowKey="id"
        size="middle"
        pagination={false}
        dataSource={quotes}
        columns={columns}
        onRow={(r) => ({
          onClick: () => onRowClick && onRowClick(r),
          style: { cursor: onRowClick ? 'pointer' : 'default', background: selectedId === r.id ? '#e6f4ff' : undefined },
        })}
      />
    </Card>
  );
}

// 迷你走势图（SVG）
export function Sparkline({ data, width = 130, height = 32 }) {
  if (!data || data.length < 2) return <span style={{ color: '#999' }}>--</span>;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const pts = data.map((v, i) =>
    `${(i / (data.length - 1)) * width},${height - ((v - min) / range) * (height - 4) - 2}`
  ).join(' ');
  const up = data[data.length - 1] >= data[0];
  const color = up ? '#e03131' : '#0ca678';
  return (
    <svg width={width} height={height}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" />
    </svg>
  );
}
