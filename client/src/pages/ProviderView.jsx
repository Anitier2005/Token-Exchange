import React, { useEffect, useState, useCallback } from 'react';
import {
  Card, Col, Row, Statistic, Table, Tag, Typography, Modal, Form, InputNumber, Input, Button, message,
} from 'antd';
import MarketPage from '../components/MarketPage.jsx';
import { api, fmtMoney } from '../api.js';

const { Text, Paragraph } = Typography;

export default function ProviderView({ user, tab }) {
  const [account, setAccount] = useState(null);
  const [futures, setFutures] = useState([]);
  const [usage, setUsage] = useState([]);
  const [settlements, setSettlements] = useState([]);
  const [endpoint, setEndpoint] = useState(null);
  const [priceTarget, setPriceTarget] = useState(null);
  const [priceHistory, setPriceHistory] = useState([]);
  const [priceForm] = Form.useForm();
  const [epForm] = Form.useForm();

  const refresh = useCallback(async () => {
    try {
      const [acc, futs, use, st, ep] = await Promise.all([
        api('/api/provider/account'),
        api('/api/provider/futures'),
        api('/api/provider/usage'),
        api('/api/provider/settlements'),
        api('/api/provider/endpoint'),
      ]);
      setAccount(acc);
      setFutures(futs);
      setUsage(use);
      setSettlements(st);
      setEndpoint(ep);
    } catch (e) { message.error(e.message); }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const openPrice = async (f) => {
    setPriceTarget(f);
    const hist = await api(`/api/provider/futures/${f.id}/prices`);
    setPriceHistory(hist);
    priceForm.setFieldsValue({ price: f.current_price ? Number(f.current_price) : undefined });
  };

  const submitPrice = async (v) => {
    try {
      const res = await api(`/api/provider/futures/${priceTarget.id}/price`, { method: 'POST', body: { price: v.price } });
      message.success(`价格已更新为 ¥${res.price}`);
      setPriceTarget(null);
      refresh();
    } catch (e) { message.error(e.message); }
  };

  const submitEndpoint = async (v) => {
    try {
      await api('/api/provider/endpoint', { method: 'POST', body: v });
      message.success('接口已登记，将同步到名下所有期货');
      refresh();
    } catch (e) { message.error(e.message); }
  };

  const totalIncome = settlements.reduce((s, x) => s + Number(x.amount), 0);

  return (
    <div className="page">
      {tab === 'market' && <MarketPage role="provider" />}

      {tab === 'futures' && (
        <>
          <Row gutter={[12, 12]} style={{ marginBottom: 12 }}>
            <Col xs={24} md={8}><Card size="small"><Statistic title="结算账户余额" value={account?.balance ?? 0} precision={2} prefix="¥" /></Card></Col>
            <Col xs={12} md={8}><Card size="small"><Statistic title="在市合约" value={futures.length} /></Card></Col>
            <Col xs={12} md={8}><Card size="small"><Statistic title="累计结转收入" value={totalIncome} precision={2} prefix="¥" /></Card></Col>
          </Row>
          <Card title="我的合约（按周期设定基准价格，行情围绕基准价波动）" size="small" style={{ marginBottom: 12 }}>
            <Table rowKey="id" size="middle" pagination={false} dataSource={futures}
              scroll={{ x: 820 }}
              locale={{ emptyText: '暂无期货，请联系管理员创建并挂接' }}
              columns={[
                { title: '代码', dataIndex: 'code', width: 110, render: (v) => <Text strong className="mono">{v}</Text> },
                { title: '缩写', dataIndex: 'ticker', width: 90, render: (v) => <Text code>{v}</Text> },
                { title: '名称', dataIndex: 'name', ellipsis: true },
                { title: '指标', dataIndex: 'metric_label', width: 130, ellipsis: true },
                {
                  title: '当前基准价', dataIndex: 'current_price', width: 110, align: 'right',
                  render: (v) => v ? <span className="mono">¥{Number(v).toFixed(4)}</span> : <Tag>未设定</Tag>,
                },
                {
                  title: '上次设定', dataIndex: 'last_set_at', width: 160,
                  render: (v) => v ? new Date(v).toLocaleString('zh-CN', { hour12: false }) : '-',
                },
                { title: '状态', dataIndex: 'status', width: 90, render: (v) => <Tag color={v === 'active' ? 'green' : 'orange'}>{v === 'active' ? '交易中' : v}</Tag> },
                {
                  title: '操作', width: 110,
                  render: (_, r) => <Button size="small" type="primary" onClick={() => openPrice(r)}>设定价格</Button>,
                },
              ]} />
          </Card>
          <Card title="提交大模型接口（交易所统一接口将透传调用）" size="small">
            <Form form={epForm} layout="vertical" onFinish={submitEndpoint}
              initialValues={endpoint ? { endpoint: endpoint.endpoint, apiKey: endpoint.api_key, note: endpoint.note } : {}}>
              <Row gutter={12}>
                <Col xs={24} md={10}>
                  <Form.Item name="endpoint" rules={[{ required: true, message: '接口地址必填' }]} style={{ marginBottom: 8 }}>
                    <Input placeholder="https://api.your-model.com/v1/chat/completions" />
                  </Form.Item>
                </Col>
                <Col xs={24} md={8}>
                  <Form.Item name="apiKey" style={{ marginBottom: 8 }}>
                    <Input placeholder="API Key（可选）" />
                  </Form.Item>
                </Col>
                <Col xs={24} md={6}>
                  <Button type="primary" htmlType="submit" block>提交 / 更新</Button>
                </Col>
              </Row>
            </Form>
            {endpoint && (
              <Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0, wordBreak: 'break-all' }}>
                当前登记：{endpoint.endpoint}（{new Date(endpoint.created_at).toLocaleString('zh-CN', { hour12: false })}）
              </Paragraph>
            )}
          </Card>
        </>
      )}

      {tab === 'usage' && (
        <Row gutter={[12, 12]}>
          <Col xs={24} lg={14}>
            <Card title="月度调用量（结转依据）" size="small">
              <Table rowKey={(r) => r.month + r.future_id} size="small" pagination={false} dataSource={usage}
                scroll={{ x: 640 }}
                locale={{ emptyText: '暂无调用记录' }}
                columns={[
                  { title: '月份', dataIndex: 'month', width: 90 },
                  { title: '合约', render: (_, r) => `${r.code} ${r.name}`, ellipsis: true },
                  { title: '指标', dataIndex: 'metric', width: 120 },
                  { title: '计量值', dataIndex: 'tokens', align: 'right', render: (v) => Number(v).toLocaleString() },
                  { title: '调用笔数', dataIndex: 'calls', align: 'right' },
                ]} />
            </Card>
          </Col>
          <Col xs={24} lg={10}>
            <Card title="月度结转记录" size="small">
              <Table rowKey="id" size="small" pagination={{ pageSize: 10 }} dataSource={settlements}
                scroll={{ x: 360 }}
                locale={{ emptyText: '暂无结转记录' }}
                columns={[
                  { title: '周期', dataIndex: 'period', width: 80 },
                  { title: '合约', dataIndex: 'code', width: 90 },
                  { title: '金额', dataIndex: 'amount', align: 'right', render: (v) => `¥${fmtMoney(v)}` },
                ]} />
            </Card>
          </Col>
        </Row>
      )}

      <Modal
        title={`设定基准价 · ${priceTarget?.code || ''}`}
        open={!!priceTarget}
        onCancel={() => setPriceTarget(null)}
        onOk={() => priceForm.submit()}
        okText="提交价格"
        destroyOnClose
      >
        <Paragraph type="secondary">
          单价按「每 1K tokens」计；设定频率由管理员配置，超频将被拒绝。
        </Paragraph>
        <Form form={priceForm} layout="vertical" onFinish={submitPrice}>
          <Form.Item name="price" label="基准价（元 / 1K tokens）" rules={[{ required: true, message: '请输入价格' }]}>
            <InputNumber min={0.0001} precision={4} style={{ width: '100%' }} />
          </Form.Item>
        </Form>
        {priceHistory.length > 0 && (
          <Table rowKey="id" size="small" pagination={false} dataSource={priceHistory.slice(0, 8)}
            title={() => '历史设定'}
            columns={[
              { title: '价格', dataIndex: 'price', render: (v) => `¥${Number(v).toFixed(4)}` },
              { title: '时间', dataIndex: 'created_at', render: (v) => new Date(v).toLocaleString('zh-CN', { hour12: false }) },
            ]} />
        )}
      </Modal>
    </div>
  );
}
