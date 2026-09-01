import React, { useEffect, useState, useCallback } from 'react';
import { Card, Col, Row, Statistic, Table, Tag, Typography, Modal, Form, InputNumber, Input, Button, message, DatePicker } from 'antd';
import { api, fmtMoney } from '../api.js';

const { Text, Paragraph } = Typography;

export default function ProviderView({ tab }) {
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
      {tab === 'futures' && (
        <>
          <Row gutter={16} style={{ marginBottom: 16 }}>
            <Col span={8}><Card size="small"><Statistic title="结算账户余额" value={account?.balance ?? 0} precision={2} prefix="¥" /></Card></Col>
            <Col span={8}><Card size="small"><Statistic title="在市期货" value={futures.length} /></Card></Col>
            <Col span={8}><Card size="small"><Statistic title="累计结转收入" value={totalIncome} precision={2} prefix="¥" /></Card></Col>
          </Row>
          <Card title="我的期货（按周期设定基准价格，行情围绕基准价波动）" size="small" style={{ marginBottom: 16 }}>
            <Table rowKey="id" size="middle" pagination={false} dataSource={futures}
              locale={{ emptyText: '暂无期货，请联系管理员创建并挂接' }}
              columns={[
                { title: '代码', dataIndex: 'code', width: 100, render: (v) => <Text strong>{v}</Text> },
                { title: '名称', dataIndex: 'name' },
                {
                  title: '当前基准价', dataIndex: 'current_price', width: 120, align: 'right',
                  render: (v) => v ? <span className="mono">¥{Number(v).toFixed(4)}</span> : <Tag>未设定</Tag>,
                },
                {
                  title: '上次设定', dataIndex: 'last_set_at', width: 170,
                  render: (v) => v ? new Date(v).toLocaleString('zh-CN', { hour12: false }) : '-',
                },
                { title: '状态', dataIndex: 'status', width: 90, render: (v) => <Tag color={v === 'active' ? 'green' : 'orange'}>{v === 'active' ? '交易中' : v}</Tag> },
                {
                  title: '操作', width: 120,
                  render: (_, r) => <Button size="small" type="primary" onClick={() => openPrice(r)}>设定价格</Button>,
                },
              ]} />
          </Card>
          <Card title="提交大模型接口（交易所统一接口将透传调用）" size="small">
            <Form form={epForm} layout="inline" onFinish={submitEndpoint}
              initialValues={endpoint ? { endpoint: endpoint.endpoint, apiKey: endpoint.api_key, note: endpoint.note } : {}}>
              <Form.Item name="endpoint" rules={[{ required: true, message: '接口地址必填' }]} style={{ minWidth: 320 }}>
                <Input placeholder="https://api.your-model.com/v1/chat/completions" />
              </Form.Item>
              <Form.Item name="apiKey">
                <Input placeholder="API Key（可选）" />
              </Form.Item>
              <Form.Item>
                <Button type="primary" htmlType="submit">提交 / 更新</Button>
              </Form.Item>
            </Form>
            {endpoint && (
              <Paragraph type="secondary" style={{ marginTop: 12 }}>
                当前登记：{endpoint.endpoint}（{new Date(endpoint.created_at).toLocaleString('zh-CN', { hour12: false })}）
              </Paragraph>
            )}
          </Card>
        </>
      )}

      {tab === 'usage' && (
        <Row gutter={16}>
          <Col span={14}>
            <Card title="月度调用量（结转依据）" size="small">
              <Table rowKey={(r) => r.month + r.future_id} size="small" pagination={false} dataSource={usage}
                locale={{ emptyText: '暂无调用记录' }}
                columns={[
                  { title: '月份', dataIndex: 'month', width: 90 },
                  { title: '期货', render: (_, r) => `${r.code} ${r.name}` },
                  { title: '调用量（tokens）', dataIndex: 'tokens', align: 'right', render: (v) => Number(v).toLocaleString() },
                  { title: '调用次数', dataIndex: 'calls', align: 'right' },
                ]} />
            </Card>
          </Col>
          <Col span={10}>
            <Card title="月度结转记录" size="small">
              <Table rowKey="id" size="small" pagination={{ pageSize: 10 }} dataSource={settlements}
                locale={{ emptyText: '暂无结转记录' }}
                columns={[
                  { title: '周期', dataIndex: 'period', width: 80 },
                  { title: '期货', dataIndex: 'code', width: 90 },
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
