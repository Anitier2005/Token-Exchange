import React, { useEffect, useState, useCallback } from 'react';
import { Card, Col, Row, Statistic, Table, Modal, Form, InputNumber, Button, Radio, message, Tag, Space, Typography } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import QuoteTable, { Sparkline } from '../components/QuoteTable.jsx';
import { api, fmtMoney, fmtPrice, priceClass } from '../api.js';

const { Text } = Typography;

export default function TraderView({ tab }) {
  const [account, setAccount] = useState(null);
  const [positions, setPositions] = useState([]);
  const [orders, setOrders] = useState([]);
  const [selected, setSelected] = useState(null);
  const [orderOpen, setOrderOpen] = useState(false);
  const [rechargeOpen, setRechargeOpen] = useState(false);
  const [form] = Form.useForm();

  const refresh = useCallback(async () => {
    try {
      const [acc, pos, ords] = await Promise.all([
        api('/api/trader/account'),
        api('/api/trader/positions'),
        api('/api/trader/orders'),
      ]);
      setAccount(acc);
      setPositions(pos);
      setOrders(ords);
    } catch (e) {
      message.error(e.message);
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [refresh]);

  const openOrder = (f) => {
    if (f.halted) { message.warning(`该期货已熔断：${f.haltReason}`); return; }
    setSelected(f);
    form.resetFields();
    form.setFieldsValue({ volume: f.minVolume || 1 });
    setOrderOpen(true);
  };

  const submitOrder = async (values) => {
    try {
      const res = await api('/api/trader/orders', {
        method: 'POST',
        body: { futureId: selected.id, side: values.side, volume: values.volume },
      });
      message.success(res.message);
      setOrderOpen(false);
      refresh();
    } catch (e) {
      message.error(e.message);
    }
  };

  const doRecharge = async (v) => {
    try {
      const res = await api('/api/trader/recharge', { method: 'POST', body: { amount: v.amount } });
      message.success(`充值成功，余额 ${fmtMoney(res.balance)}`);
      setRechargeOpen(false);
      refresh();
    } catch (e) { message.error(e.message); }
  };

  const floatTotal = positions.reduce((s, p) => s + p.floatPnl, 0);

  return (
    <div className="page">
      {tab === 'market' && (
        <>
          <Row gutter={16} style={{ marginBottom: 16 }}>
            <Col span={6}><Card size="small"><Statistic title="账户余额" value={account?.balance ?? 0} precision={2} prefix="¥" /></Card></Col>
            <Col span={6}><Card size="small"><Statistic title="占用保证金" value={account?.usedMargin ?? 0} precision={2} prefix="¥" /></Card></Col>
            <Col span={6}><Card size="small"><Statistic title="可用资金" value={account?.available ?? 0} precision={2} prefix="¥" /></Card></Col>
            <Col span={6}>
              <Card size="small">
                <Statistic
                  title="浮动盈亏"
                  value={floatTotal}
                  precision={2}
                  prefix={floatTotal >= 0 ? '¥+' : '¥'}
                  valueStyle={{ color: floatTotal >= 0 ? '#e03131' : '#0ca678' }}
                />
              </Card>
            </Col>
          </Row>
          <QuoteTable onRowClick={openOrder} selectedId={selected?.id} />
          <Row gutter={16} style={{ marginTop: 16 }}>
            <Col span={12}>
              <Card title="当前持仓" size="small" extra={<Button size="small" icon={<ReloadOutlined />} onClick={refresh} />}>
                <Table rowKey="id" size="small" pagination={false} dataSource={positions}
                  locale={{ emptyText: '暂无持仓，点击上方行情开仓' }}
                  columns={[
                    { title: '期货', render: (_, r) => `${r.code} ${r.name}` },
                    { title: '方向', dataIndex: 'side', width: 70, render: (v) => <Tag color={v === 'long' ? 'red' : 'green'}>{v === 'long' ? '多' : '空'}</Tag> },
                    { title: '手数', dataIndex: 'volume', width: 70, align: 'right' },
                    { title: '开仓均价', dataIndex: 'avg_price', width: 100, align: 'right', render: fmtPrice },
                    { title: '最新价', dataIndex: 'lastPrice', width: 100, align: 'right', render: (v) => <span className="mono">{fmtPrice(v)}</span> },
                    { title: '浮动盈亏', dataIndex: 'floatPnl', width: 110, align: 'right', render: (v, r) => <span className={`mono ${priceClass(v)}`}>{v > 0 ? '+' : ''}{fmtMoney(v)}</span> },
                  ]} />
              </Card>
            </Col>
            <Col span={12}>
              <Card title="最近成交" size="small">
                <Table rowKey="id" size="small" pagination={{ pageSize: 8 }} dataSource={orders}
                  locale={{ emptyText: '暂无成交记录' }}
                  columns={[
                    { title: '时间', dataIndex: 'created_at', width: 90, render: (v) => new Date(v).toLocaleTimeString('zh-CN', { hour12: false }) },
                    { title: '期货', dataIndex: 'code', width: 90 },
                    { title: '方向', dataIndex: 'side', width: 60, render: (v) => <Tag color={v === 'long' ? 'red' : 'green'}>{v === 'long' ? '多' : '空'}</Tag> },
                    { title: '价格', dataIndex: 'price', width: 90, align: 'right', render: fmtPrice },
                    { title: '手数', dataIndex: 'volume', width: 60, align: 'right' },
                    { title: '已实现盈亏', dataIndex: 'realized_pnl', width: 100, align: 'right', render: (v) => <span className={`mono ${priceClass(Number(v))}`}>{Number(v) > 0 ? '+' : ''}{fmtMoney(v)}</span> },
                    { title: '手续费', dataIndex: 'fee', width: 80, align: 'right', render: (v) => fmtMoney(v) },
                    { title: '税费', dataIndex: 'tax', width: 70, align: 'right', render: (v) => fmtMoney(v) },
                  ]} />
              </Card>
            </Col>
          </Row>
        </>
      )}

      {tab === 'account' && (
        <Row gutter={16}>
          <Col span={8}>
            <Card title="保证金账户" size="small">
              <Statistic title="余额" value={account?.balance ?? 0} precision={2} prefix="¥" />
              <Statistic title="占用保证金" value={account?.usedMargin ?? 0} precision={2} prefix="¥" style={{ marginTop: 8 }} />
              <Statistic title="可用资金" value={account?.available ?? 0} precision={2} prefix="¥" style={{ marginTop: 8 }} />
              <Button type="primary" block style={{ marginTop: 16 }} onClick={() => setRechargeOpen(true)}>虚拟充值</Button>
            </Card>
          </Col>
          <Col span={16}>
            <Card title="全部持仓" size="small">
              <Table rowKey="id" size="small" pagination={false} dataSource={positions}
                locale={{ emptyText: '暂无持仓' }}
                columns={[
                  { title: '期货', render: (_, r) => `${r.code} ${r.name}` },
                  { title: '方向', dataIndex: 'side', render: (v) => <Tag color={v === 'long' ? 'red' : 'green'}>{v === 'long' ? '多' : '空'}</Tag> },
                  { title: '手数', dataIndex: 'volume', align: 'right' },
                  { title: '均价', dataIndex: 'avg_price', align: 'right', render: fmtPrice },
                  { title: '最新价', dataIndex: 'lastPrice', align: 'right', render: fmtPrice },
                  { title: '浮动盈亏', dataIndex: 'floatPnl', align: 'right', render: (v) => <span className={`mono ${priceClass(v)}`}>{fmtMoney(v)}</span> },
                ]} />
            </Card>
          </Col>
        </Row>
      )}

      <Modal
        title={`下单 · ${selected?.code || ''} ${selected?.name || ''}`}
        open={orderOpen}
        onCancel={() => setOrderOpen(false)}
        onOk={() => form.submit()}
        okText="确认下单"
        destroyOnClose
      >
        {selected && (
          <div style={{ marginBottom: 16 }}>
            <Space size="large">
              <span>最新价：<span className={`mono quote-cell ${priceClass(selected.change)}`}>{fmtPrice(selected.price)}</span></span>
              <span>基准价：<span className="mono">{fmtPrice(selected.basePrice || selected.prevClose)}</span></span>
            </Space>
          </div>
        )}
        <Form form={form} layout="vertical" onFinish={submitOrder}>
          <Form.Item name="side" label="方向" rules={[{ required: true }]} initialValue="long">
            <Radio.Group buttonStyle="solid">
              <Radio.Button value="long" style={{ color: '#e03131' }}>做多（看涨）</Radio.Button>
              <Radio.Button value="short" style={{ color: '#0ca678' }}>做空（看跌）</Radio.Button>
            </Radio.Group>
          </Form.Item>
          <Form.Item
            name="volume"
            label={`手数（最小 ${selected?.minVolume || 1} 手，反向持仓将自动平仓）`}
            rules={[{ required: true, message: '请输入手数' }]}
          >
            <InputNumber min={selected?.minVolume || 1} precision={0} style={{ width: '100%' }} />
          </Form.Item>
          <Text type="secondary">市价单，按最新价成交；手续费按成交金额计，盈利平仓自动扣税。</Text>
        </Form>
      </Modal>

      <Modal title="虚拟充值（充多少有多少）" open={rechargeOpen} onCancel={() => setRechargeOpen(false)} footer={null} destroyOnClose>
        <Form layout="vertical" onFinish={doRecharge}>
          <Form.Item name="amount" label="充值金额" rules={[{ required: true, message: '请输入金额' }]}>
            <InputNumber min={1} precision={2} style={{ width: '100%' }} placeholder="例如 100000" />
          </Form.Item>
          <Button type="primary" htmlType="submit" block>充值</Button>
        </Form>
      </Modal>
    </div>
  );
}
