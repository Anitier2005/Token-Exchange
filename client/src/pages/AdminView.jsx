import React, { useEffect, useState, useCallback } from 'react';
import {
  Card, Col, Row, Statistic, Table, Tag, Typography, Form, InputNumber, Switch, Input,
  Button, Modal, message, Space, Select, Popconfirm, Alert,
} from 'antd';
import MarketPage from '../components/MarketPage.jsx';
import AccountManage from '../components/AccountManage.jsx';
import OpsView from '../pages/OpsView.jsx';
import { api, fmtMoney, fmtPrice, priceClass } from '../api.js';

const { Text } = Typography;

export default function AdminView({ user, tab }) {
  const [config, setConfig] = useState(null);
  const [futures, setFutures] = useState([]);
  const [overview, setOverview] = useState(null);
  const [settlements, setSettlements] = useState([]);
  const [providers, setProviders] = useState([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState(null);
  const [form] = Form.useForm();
  const [editForm] = Form.useForm();
  const [configForm] = Form.useForm();

  const refresh = useCallback(async () => {
    try {
      const [cfg, futs, ov, st, provs] = await Promise.all([
        api('/api/admin/config'),
        api('/api/market/futures'),
        api('/api/admin/overview'),
        api('/api/admin/settlements'),
        api('/api/admin/users?role=provider'),
      ]);
      setConfig(cfg);
      setFutures(futs);
      setOverview(ov);
      setSettlements(st);
      setProviders(provs);
    } catch (e) { message.error(e.message); }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    if (config && tab === 'config') {
      configForm.setFieldsValue({ ...config });
    }
  }, [config, tab]);

  const saveConfig = async (v) => {
    try {
      await api('/api/admin/config', { method: 'PUT', body: v });
      message.success('配置已保存并即时生效');
      refresh();
    } catch (e) { message.error(e.message); }
  };

  const toggleHalt = async () => {
    const halted = !config.manual_halted;
    await api('/api/admin/halt', {
      method: 'POST',
      body: { halted, reason: halted ? '管理员手动熔断' : null },
    });
    message.success(halted ? '已触发手动熔断' : '已恢复交易');
    refresh();
  };

  const toggleFutureHalt = async (f) => {
    await api(`/api/admin/futures/${f.id}/halt`, {
      method: 'POST',
      body: { halted: !f.halted, reason: '管理员手动熔断' },
    });
    message.success(!f.halted ? `${f.code} 已熔断` : `${f.code} 已恢复`);
    refresh();
  };

  const createFuture = async (v) => {
    try {
      const res = await api('/api/admin/futures', { method: 'POST', body: v });
      message.success(`模型 ${res.model} 已创建，共 ${res.contracts.length} 份指标合约`);
      setCreateOpen(false);
      form.resetFields();
      refresh();
    } catch (e) { message.error(e.message); }
  };

  const saveEdit = async (v) => {
    try {
      await api(`/api/admin/futures/${editTarget.id}`, { method: 'PUT', body: v });
      message.success('已保存');
      setEditTarget(null);
      refresh();
    } catch (e) { message.error(e.message); }
  };

  const runSettle = async (period) => {
    try {
      const res = await api('/api/admin/settle', { method: 'POST', body: { period } });
      message.success(`${res.period} 结转完成，共 ${res.bills.length} 张账单`);
      refresh();
    } catch (e) { message.error(e.message); }
  };

  return (
    <div className="page">
      {tab === 'market' && <MarketPage role="admin" />}

      {tab === 'overview' && overview && (
        <>
          <Row gutter={[12, 12]} style={{ marginBottom: 12 }}>
            <Col xs={12} md={8} xl={4}><Card size="small"><Statistic title="交易商" value={overview.usersByRole.trader || 0} /></Card></Col>
            <Col xs={12} md={8} xl={4}><Card size="small"><Statistic title="提供方" value={overview.usersByRole.provider || 0} /></Card></Col>
            <Col xs={12} md={8} xl={4}><Card size="small"><Statistic title="接收方" value={overview.usersByRole.receiver || 0} /></Card></Col>
            <Col xs={12} md={8} xl={4}><Card size="small"><Statistic title="在市合约" value={overview.futuresCount} suffix={`/ ${overview.modelsCount} 模型`} /></Card></Col>
            <Col xs={12} md={8} xl={4}><Card size="small"><Statistic title="累计成交笔数" value={overview.ordersCount} /></Card></Col>
            <Col xs={12} md={8} xl={4}><Card size="small"><Statistic title="挂单中" value={overview.pendingOrders} /></Card></Col>
          </Row>
          {config?.manual_halted && (
            <Alert type="error" showIcon style={{ marginBottom: 12 }}
              message={`全交易所熔断中：${config.halt_reason || '手动熔断'}`} />
          )}
          <Card title="实时行情" size="small">
            <Table rowKey="id" size="middle" pagination={false} dataSource={overview.quotes}
              scroll={{ x: 720 }}
              columns={[
                { title: '代码', dataIndex: 'code', width: 110, render: (v) => <Text strong className="mono">{v}</Text> },
                { title: '缩写', dataIndex: 'ticker', width: 90, render: (v) => <Text code>{v}</Text> },
                { title: '名称', dataIndex: 'name', ellipsis: true },
                { title: '最新价', dataIndex: 'price', width: 110, align: 'right', render: (v, r) => <span className={`mono ${priceClass(r.change)}`}>{fmtPrice(v)}</span> },
                { title: '涨跌幅', dataIndex: 'changePct', width: 100, align: 'right', render: (v, r) => <span className={`mono ${priceClass(r.change)}`}>{v > 0 ? '+' : ''}{v.toFixed(2)}%</span> },
                { title: '状态', dataIndex: 'halted', width: 100, render: (h, r) => h ? <Tag color="red" title={r.haltReason}>已熔断</Tag> : <Tag color="green">交易中</Tag> },
              ]} />
          </Card>
        </>
      )}

      {tab === 'config' && config && (
        <>
          <Card title="交易与风控配置（保存后即时生效）" size="small" style={{ marginBottom: 12 }}>
            <Form form={configForm} layout="vertical" onFinish={saveConfig}>
              <Row gutter={24}>
                {[
                  { name: 'trading_start', label: '交易开始时间 (HH:MM)', el: <Input placeholder="09:00" /> },
                  { name: 'trading_end', label: '交易结束时间 (HH:MM)', el: <Input placeholder="17:00" /> },
                  { name: 'trade_interval_sec', label: '交易频率限制（秒/笔）', el: <InputNumber min={0} precision={0} style={{ width: '100%' }} /> },
                  { name: 'margin_ratio', label: '保证金比例（0-1）', el: <InputNumber min={0.01} max={1} step={0.05} style={{ width: '100%' }} /> },
                  { name: 'fee_rate', label: '交易手续费率（按成交金额）', el: <InputNumber min={0} step={0.0005} style={{ width: '100%' }} /> },
                  { name: 'tax_rate', label: '税费率（按已实现盈利）', el: <InputNumber min={0} max={1} step={0.01} style={{ width: '100%' }} /> },
                  { name: 'circuit_breaker_pct', label: '熔断阈值（日内涨跌幅，0-1）', el: <InputNumber min={0.001} max={1} step={0.01} style={{ width: '100%' }} /> },
                  { name: 'l1_interval_ms', label: 'L1 行情推送间隔（毫秒）', el: <InputNumber min={200} precision={0} step={500} style={{ width: '100%' }} /> },
                  { name: 'l2_interval_ms', label: 'L2 行情推送间隔（毫秒）', el: <InputNumber min={200} precision={0} step={500} style={{ width: '100%' }} /> },
                  { name: 'provider_price_set_days', label: '提供方定价频率（天/次）', el: <InputNumber min={1} precision={0} style={{ width: '100%' }} /> },
                  { name: 'tick_volatility', label: '行情波动率（tick 随机幅度）', el: <InputNumber min={0.0001} step={0.001} style={{ width: '100%' }} /> },
                ].map((f) => (
                  <Col xs={24} sm={12} md={8} xl={6} key={f.name}>
                    <Form.Item name={f.name} label={f.label} rules={[{ required: true }]}>
                      {f.el}
                    </Form.Item>
                  </Col>
                ))}
                <Col xs={24} sm={12} md={8} xl={6}>
                  <Form.Item name="circuit_breaker_enabled" label="启用自动熔断" valuePropName="checked">
                    <Switch />
                  </Form.Item>
                </Col>
              </Row>
              <Button type="primary" htmlType="submit">保存配置</Button>
            </Form>
          </Card>
          <Card title="手动熔断" size="small">
            <Space wrap>
              <Text>当前状态：{config.manual_halted ? <Tag color="red">熔断中 - {config.halt_reason}</Tag> : <Tag color="green">正常交易</Tag>}</Text>
              <Popconfirm
                title={config.manual_halted ? '恢复全交易所交易？' : '确认手动熔断全交易所？'}
                onConfirm={toggleHalt}
              >
                <Button danger={!config.manual_halted} type={config.manual_halted ? 'primary' : 'default'}>
                  {config.manual_halted ? '恢复交易' : '手动熔断全交易所'}
                </Button>
              </Popconfirm>
            </Space>
          </Card>
        </>
      )}

      {tab === 'users' && <AccountManage />}

      {tab === 'futures' && (
        <Card title="期货管理（创建模型时自动生成 4 份指标合约）" size="small"
          extra={<Button type="primary" size="small" onClick={() => setCreateOpen(true)}>创建模型</Button>}>
          <Table rowKey="id" size="middle" pagination={false} dataSource={futures}
            scroll={{ x: 900 }}
            columns={[
              { title: '代码', dataIndex: 'code', width: 110, render: (v) => <Text strong className="mono">{v}</Text> },
              { title: '缩写', dataIndex: 'ticker', width: 90, render: (v) => <Text code>{v}</Text> },
              { title: '中文名称', dataIndex: 'name', width: 180, ellipsis: true },
              { title: '模型', dataIndex: 'model', width: 80 },
              { title: '指标', dataIndex: 'metricLabel', width: 130, ellipsis: true },
              { title: '提供方', dataIndex: 'providerName', width: 110, ellipsis: true },
              { title: '最新价', dataIndex: 'price', width: 100, align: 'right', render: (v, r) => <span className={`mono ${priceClass(r.change)}`}>{fmtPrice(v)}</span> },
              { title: '门槛(手)', dataIndex: 'minVolume', width: 80, align: 'right' },
              { title: '月费', dataIndex: 'monthlyFee', width: 90, align: 'right', render: (v) => `¥${fmtMoney(v)}` },
              { title: '状态', dataIndex: 'status', width: 80, render: (v, r) => (v !== 'active' ? <Tag>{v}</Tag> : r.halted ? <Tag color="red" title={r.haltReason}>熔断</Tag> : <Tag color="green">交易中</Tag>) },
              {
                title: '操作', width: 180,
                render: (_, f) => (
                  <Space>
                    <Button size="small" onClick={() => { setEditTarget(f); editForm.setFieldsValue({ name: f.name, description: f.description, minVolume: f.minVolume, monthlyFee: f.monthlyFee, monthlyQuotaTokens: f.monthlyQuotaTokens, overagePricePer1k: f.overagePricePer1k, status: f.status }); }}>编辑</Button>
                    {f.status === 'active' && (
                      <Popconfirm title={f.halted ? `恢复 ${f.code}？` : `手动熔断 ${f.code}？`} onConfirm={() => toggleFutureHalt(f)}>
                        <Button size="small" danger={!f.halted}>{f.halted ? '恢复' : '熔断'}</Button>
                      </Popconfirm>
                    )}
                  </Space>
                ),
              },
            ]} />
        </Card>
      )}

      {tab === 'settlements' && (
        <>
          <Card size="small" style={{ marginBottom: 12 }}
            title="手动触发月度结转（提供方按调用量结转收入，接收方按月费+超额扣款）">
            <Button type="primary" onClick={() => runSettle()}>结转上个自然月</Button>
          </Card>
          <Card title="结转记录" size="small">
            <Table rowKey="id" size="small" pagination={{ pageSize: 12 }} dataSource={settlements}
              scroll={{ x: 760 }}
              locale={{ emptyText: '暂无结转记录' }}
              columns={[
                { title: '周期', dataIndex: 'period', width: 80 },
                { title: '类型', dataIndex: 'type', width: 80, render: (v) => <Tag color={v === 'provider' ? 'purple' : 'cyan'}>{v === 'provider' ? '提供方' : '接收方'}</Tag> },
                { title: '账户', render: (_, r) => r.display_name || r.email, width: 140, ellipsis: true },
                { title: '模型 / 合约', dataIndex: 'model', width: 100 },
                { title: '金额', dataIndex: 'amount', width: 110, align: 'right', render: (v, r) => <span style={{ color: r.type === 'provider' ? '#e03131' : '#0ca678' }}>{r.type === 'provider' ? '+' : '-'}¥{fmtMoney(v)}</span> },
                { title: '明细', render: (_, r) => <Text type="secondary" style={{ fontSize: 12 }}>{JSON.stringify(r.detail)}</Text> },
              ]} />
          </Card>
        </>
      )}

      {tab === 'ops' && <OpsView />}

      <Modal title="创建模型（自动生成 4 份指标合约）" open={createOpen} onCancel={() => setCreateOpen(false)} onOk={() => form.submit()} okText="创建" destroyOnClose width={640}>
        <Form form={form} layout="vertical" onFinish={createFuture}
          initialValues={{ minVolume: 1, monthlyFee: 99, monthlyQuotaTokens: 500000, overagePricePer1k: 0.3, initPrice: 1 }}>
          <Row gutter={12}>
            <Col xs={24} sm={12}>
              <Form.Item name="model" label="模型代码（唯一，如 GPT5）" rules={[{ required: true }]}>
                <Input placeholder="GPT5" />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12}>
              <Form.Item name="ticker" label="英文缩略名（2-8 位字母数字）" rules={[{ required: true }]}>
                <Input placeholder="GPT" />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12}>
              <Form.Item name="name" label="中文名称" rules={[{ required: true }]}>
                <Input placeholder="GPT-5 词元期货" />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12}>
              <Form.Item name="providerId" label="提供方（可选）">
                <Select allowClear placeholder="选择提供方"
                  options={providers.map((p) => ({ value: p.id, label: p.display_name || p.email }))} />
              </Form.Item>
            </Col>
            <Col xs={12} sm={6}><Form.Item name="initPrice" label="初始价格"><InputNumber min={0.0001} precision={4} style={{ width: '100%' }} /></Form.Item></Col>
            <Col xs={12} sm={6}><Form.Item name="minVolume" label="交易门槛（手）"><InputNumber min={1} precision={0} style={{ width: '100%' }} /></Form.Item></Col>
            <Col xs={12} sm={6}><Form.Item name="monthlyFee" label="接收方月费（元/月）"><InputNumber min={0} style={{ width: '100%' }} /></Form.Item></Col>
            <Col xs={12} sm={6}><Form.Item name="monthlyQuotaTokens" label="月度 token 额度"><InputNumber min={1} precision={0} style={{ width: '100%' }} /></Form.Item></Col>
            <Col xs={12} sm={6}><Form.Item name="overagePricePer1k" label="超额单价（元/1K）"><InputNumber min={0} precision={2} style={{ width: '100%' }} /></Form.Item></Col>
            <Col span={24}><Form.Item name="description" label="简介"><Input.TextArea rows={2} placeholder="合约简介，将展示在行情页" /></Form.Item></Col>
          </Row>
          <Text type="secondary" style={{ fontSize: 12 }}>
            将按「缓存未命中输入 / 缓存命中输入 / 输出 / 调用次数」4 类计量指标分别生成合约，
            缩写后缀 CM / CH / O / C，交易代码为「缩写+后缀+4 位随机数字」（数字与字母混合，参考 A股/港股风格）。
          </Text>
        </Form>
      </Modal>

      <Modal title={`编辑合约 · ${editTarget?.code || ''}`} open={!!editTarget} onCancel={() => setEditTarget(null)} onOk={() => editForm.submit()} okText="保存" destroyOnClose>
        <Form form={editForm} layout="vertical" onFinish={saveEdit}>
          <Form.Item name="name" label="中文名称"><Input /></Form.Item>
          <Form.Item name="description" label="简介"><Input.TextArea rows={2} /></Form.Item>
          <Row gutter={12}>
            <Col xs={12} sm={6}><Form.Item name="minVolume" label="交易门槛（手）"><InputNumber min={1} precision={0} style={{ width: '100%' }} /></Form.Item></Col>
            <Col xs={12} sm={6}><Form.Item name="monthlyFee" label="月费（元/月）"><InputNumber min={0} style={{ width: '100%' }} /></Form.Item></Col>
            <Col xs={12} sm={6}><Form.Item name="monthlyQuotaTokens" label="月度 token 额度"><InputNumber min={1} precision={0} style={{ width: '100%' }} /></Form.Item></Col>
            <Col xs={12} sm={6}><Form.Item name="overagePricePer1k" label="超额单价（元/1K）"><InputNumber min={0} precision={2} style={{ width: '100%' }} /></Form.Item></Col>
            <Col span={24}>
              <Form.Item name="status" label="状态">
                <Select options={[
                  { value: 'active', label: '交易中' },
                  { value: 'suspended', label: '暂停' },
                  { value: 'delisted', label: '下市' },
                ]} />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Modal>
    </div>
  );
}
