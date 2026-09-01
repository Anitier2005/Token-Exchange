import React, { useEffect, useState, useCallback } from 'react';
import {
  Card, Col, Row, Statistic, Table, Tag, Typography, Form, InputNumber, Switch, Input,
  Button, Modal, message, Space, TimePicker, Select, Popconfirm, Descriptions, Alert,
} from 'antd';
import { api, fmtMoney, fmtPrice, priceClass } from '../api.js';
import { Sparkline } from '../components/QuoteTable.jsx';

const { Text, Paragraph } = Typography;

export default function AdminView({ tab }) {
  const [config, setConfig] = useState(null);
  const [users, setUsers] = useState([]);
  const [futures, setFutures] = useState([]);
  const [overview, setOverview] = useState(null);
  const [settlements, setSettlements] = useState([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState(null);
  const [userCreateOpen, setUserCreateOpen] = useState(false);
  const [form] = Form.useForm();
  const [editForm] = Form.useForm();
  const [configForm] = Form.useForm();
  const [userForm] = Form.useForm();

  const refresh = useCallback(async () => {
    try {
      const [cfg, us, futs, ov, st] = await Promise.all([
        api('/api/admin/config'),
        api('/api/admin/users'),
        api('/api/market/futures'),
        api('/api/admin/overview'),
        api('/api/admin/settlements'),
      ]);
      setConfig(cfg);
      setUsers(us);
      setFutures(futs);
      setOverview(ov);
      setSettlements(st);
    } catch (e) { message.error(e.message); }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    if (config && tab === 'config') {
      configForm.setFieldsValue({
        ...config,
        trading_start: config.trading_start,
        trading_end: config.trading_end,
      });
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
      await api('/api/admin/futures', { method: 'POST', body: v });
      message.success('期货已创建');
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

  const toggleUserStatus = async (u) => {
    const status = u.status === 'active' ? 'disabled' : 'active';
    await api(`/api/admin/users/${u.id}/status`, { method: 'PUT', body: { status } });
    refresh();
  };

  const createUser = async (v) => {
    try {
      await api('/api/admin/users', { method: 'POST', body: v });
      message.success('账户已创建');
      setUserCreateOpen(false);
      userForm.resetFields();
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

  const providers = users.filter((u) => u.role === 'provider');

  return (
    <div className="page">
      {tab === 'overview' && overview && (
        <>
          <Row gutter={16} style={{ marginBottom: 16 }}>
            <Col span={4}><Card size="small"><Statistic title="交易商" value={overview.usersByRole.trader || 0} /></Card></Col>
            <Col span={4}><Card size="small"><Statistic title="提供方" value={overview.usersByRole.provider || 0} /></Card></Col>
            <Col span={4}><Card size="small"><Statistic title="接收方" value={overview.usersByRole.receiver || 0} /></Card></Col>
            <Col span={4}><Card size="small"><Statistic title="在市期货" value={overview.futuresCount} /></Card></Col>
            <Col span={4}><Card size="small"><Statistic title="累计成交笔数" value={overview.ordersCount} /></Card></Col>
            <Col span={4}><Card size="small"><Statistic title="累计成交手数" value={overview.totalVolume} /></Card></Col>
          </Row>
          {config?.manual_halted && (
            <Alert type="error" showIcon style={{ marginBottom: 16 }}
              message={`全交易所熔断中：${config.halt_reason || '手动熔断'}`} />
          )}
          <Card title="实时行情" size="small">
            <Table rowKey="id" size="middle" pagination={false} dataSource={overview.quotes}
              columns={[
                { title: '代码', dataIndex: 'code', width: 110, render: (v) => <Text strong>{v}</Text> },
                { title: '名称', dataIndex: 'name' },
                { title: '最新价', dataIndex: 'price', width: 110, align: 'right', render: (v, r) => <span className={`mono ${priceClass(r.change)}`}>{fmtPrice(v)}</span> },
                { title: '涨跌幅', dataIndex: 'changePct', width: 100, align: 'right', render: (v) => <span className={`mono ${priceClass(v)}`}>{v > 0 ? '+' : ''}{v.toFixed(2)}%</span> },
                { title: '状态', dataIndex: 'halted', width: 100, render: (h, r) => h ? <Tag color="red" title={r.haltReason}>已熔断</Tag> : <Tag color="green">交易中</Tag> },
              ]} />
          </Card>
        </>
      )}

      {tab === 'config' && config && (
        <>
          <Card title="交易与风控配置（保存后即时生效）" size="small" style={{ marginBottom: 16 }}>
            <Form form={configForm} layout="vertical" onFinish={saveConfig}>
              <Row gutter={24}>
                <Col span={6}>
                  <Form.Item name="trading_start" label="交易开始时间 (HH:MM)" rules={[{ required: true }]}>
                    <Input placeholder="09:00" />
                  </Form.Item>
                </Col>
                <Col span={6}>
                  <Form.Item name="trading_end" label="交易结束时间 (HH:MM)" rules={[{ required: true }]}>
                    <Input placeholder="17:00" />
                  </Form.Item>
                </Col>
                <Col span={6}>
                  <Form.Item name="trade_interval_sec" label="交易频率限制（秒/笔）">
                    <InputNumber min={0} precision={0} style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
                <Col span={6}>
                  <Form.Item name="margin_ratio" label="保证金比例（0-1）">
                    <InputNumber min={0.01} max={1} step={0.05} style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
                <Col span={6}>
                  <Form.Item name="fee_rate" label="交易手续费率（按成交金额）">
                    <InputNumber min={0} step={0.0005} style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
                <Col span={6}>
                  <Form.Item name="tax_rate" label="税费率（按已实现盈利）">
                    <InputNumber min={0} max={1} step={0.01} style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
                <Col span={6}>
                  <Form.Item name="circuit_breaker_enabled" label="启用自动熔断" valuePropName="checked">
                    <Switch />
                  </Form.Item>
                </Col>
                <Col span={6}>
                  <Form.Item name="circuit_breaker_pct" label="熔断阈值（日内涨跌幅，0-1）">
                    <InputNumber min={0.001} max={1} step={0.01} style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
                <Col span={6}>
                  <Form.Item name="l1_interval_ms" label="L1 行情推送间隔（毫秒）">
                    <InputNumber min={200} precision={0} step={500} style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
                <Col span={6}>
                  <Form.Item name="l2_interval_ms" label="L2 行情推送间隔（毫秒）">
                    <InputNumber min={200} precision={0} step={500} style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
                <Col span={6}>
                  <Form.Item name="provider_price_set_days" label="提供方定价频率（天/次）">
                    <InputNumber min={1} precision={0} style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
                <Col span={6}>
                  <Form.Item name="tick_volatility" label="行情波动率（tick 随机幅度）">
                    <InputNumber min={0.0001} step={0.001} style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
              </Row>
              <Button type="primary" htmlType="submit">保存配置</Button>
            </Form>
          </Card>
          <Card title="手动熔断" size="small">
            <Space>
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

      {tab === 'users' && (
        <Card title="交易所账户管理" size="small"
          extra={<Button type="primary" size="small" onClick={() => setUserCreateOpen(true)}>创建账户</Button>}>
          <Table rowKey="id" size="middle" pagination={{ pageSize: 12 }} dataSource={users}
            columns={[
              { title: 'ID', dataIndex: 'id', width: 50 },
              { title: '用户名', dataIndex: 'username', width: 120 },
              { title: '显示名', dataIndex: 'display_name', width: 140 },
              {
                title: '角色', dataIndex: 'role', width: 110,
                render: (v) => ({ admin: <Tag color="geekblue">管理员</Tag>, trader: <Tag color="volcano">交易商</Tag>, provider: <Tag color="purple">提供方</Tag>, receiver: <Tag color="cyan">接收方</Tag> }[v]),
              },
              { title: '余额', dataIndex: 'balance', width: 120, align: 'right', render: (v) => `¥${fmtMoney(v)}` },
              { title: '状态', dataIndex: 'status', width: 80, render: (v) => <Tag color={v === 'active' ? 'green' : 'red'}>{v === 'active' ? '正常' : '禁用'}</Tag> },
              { title: '创建时间', dataIndex: 'created_at', width: 160, render: (v) => new Date(v).toLocaleString('zh-CN', { hour12: false }) },
              {
                title: '操作', width: 100,
                render: (_, u) => (
                  <Popconfirm title={u.status === 'active' ? '禁用该账户？' : '恢复该账户？'} onConfirm={() => toggleUserStatus(u)}>
                    <Button size="small" danger={u.status === 'active'}>{u.status === 'active' ? '禁用' : '恢复'}</Button>
                  </Popconfirm>
                ),
              },
            ]} />
        </Card>
      )}

      {tab === 'futures' && (
        <Card title="期货管理" size="small"
          extra={<Button type="primary" size="small" onClick={() => setCreateOpen(true)}>创建期货</Button>}>
          <Table rowKey="id" size="middle" pagination={false} dataSource={futures}
            columns={[
              { title: '代码', dataIndex: 'code', width: 100, render: (v) => <Text strong>{v}</Text> },
              { title: '名称', dataIndex: 'name', width: 170 },
              { title: '提供方', dataIndex: 'providerName', width: 120 },
              { title: '最新价', dataIndex: 'price', width: 100, align: 'right', render: (v, r) => <span className={`mono ${priceClass(r.change)}`}>{fmtPrice(v)}</span> },
              { title: '门槛(手)', dataIndex: 'minVolume', width: 80, align: 'right' },
              { title: '月费', dataIndex: 'monthlyFee', width: 90, align: 'right', render: (v) => `¥${fmtMoney(v)}` },
              { title: '状态', dataIndex: 'status', width: 80, render: (v, r) => (v !== 'active' ? <Tag>{v}</Tag> : r.halted ? <Tag color="red" title={r.haltReason}>熔断</Tag> : <Tag color="green">交易中</Tag>) },
              {
                title: '操作', width: 180,
                render: (_, f) => (
                  <Space>
                    <Button size="small" onClick={() => { setEditTarget(f); editForm.setFieldsValue({ name: f.name, description: f.description, minVolume: f.minVolume, monthlyFee: f.monthlyFee, monthlyQuotaTokens: f.monthlyQuotaTokens, overagePricePer1k: f.basePrice, status: f.status }); }}>编辑</Button>
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
          <Card size="small" style={{ marginBottom: 16 }}
            title="手动触发月度结转（提供方按调用量结转收入，接收方按月费+超额扣款）">
            <Space>
              <Button type="primary" onClick={() => runSettle()}>结转上个自然月</Button>
            </Space>
          </Card>
          <Card title="结转记录" size="small">
            <Table rowKey="id" size="small" pagination={{ pageSize: 12 }} dataSource={settlements}
              locale={{ emptyText: '暂无结转记录' }}
              columns={[
                { title: '周期', dataIndex: 'period', width: 80 },
                { title: '类型', dataIndex: 'type', width: 80, render: (v) => <Tag color={v === 'provider' ? 'purple' : 'cyan'}>{v === 'provider' ? '提供方' : '接收方'}</Tag> },
                { title: '用户', dataIndex: 'username', width: 110 },
                { title: '期货', dataIndex: 'code', width: 100 },
                { title: '金额', dataIndex: 'amount', width: 110, align: 'right', render: (v, r) => <span style={{ color: r.type === 'provider' ? '#e03131' : '#0ca678' }}>{r.type === 'provider' ? '+' : '-'}¥{fmtMoney(v)}</span> },
                { title: '明细', render: (_, r) => JSON.stringify(r.detail) },
              ]} />
          </Card>
        </>
      )}

      <Modal title="创建期货" open={createOpen} onCancel={() => setCreateOpen(false)} onOk={() => form.submit()} okText="创建" destroyOnClose>
        <Form form={form} layout="vertical" onFinish={createFuture}
          initialValues={{ minVolume: 1, monthlyFee: 99, monthlyQuotaTokens: 500000, overagePricePer1k: 0.3, initPrice: 1 }}>
          <Row gutter={12}>
            <Col span={12}><Form.Item name="code" label="代码" rules={[{ required: true }]}><Input placeholder="GPT-5T" /></Form.Item></Col>
            <Col span={12}><Form.Item name="name" label="名称" rules={[{ required: true }]}><Input placeholder="GPT-5 Token 期货" /></Form.Item></Col>
            <Col span={12}>
              <Form.Item name="providerId" label="提供方（可选）">
                <Select allowClear placeholder="选择提供方" options={providers.map((p) => ({ value: p.id, label: p.display_name || p.username }))} />
              </Form.Item>
            </Col>
            <Col span={12}><Form.Item name="initPrice" label="初始价格"><InputNumber min={0.0001} precision={4} style={{ width: '100%' }} /></Form.Item></Col>
            <Col span={12}><Form.Item name="minVolume" label="交易门槛（最小手数）"><InputNumber min={1} precision={0} style={{ width: '100%' }} /></Form.Item></Col>
            <Col span={12}><Form.Item name="monthlyFee" label="接收方月费（元/月）"><InputNumber min={0} style={{ width: '100%' }} /></Form.Item></Col>
            <Col span={12}><Form.Item name="monthlyQuotaTokens" label="月度 token 额度"><InputNumber min={1} precision={0} style={{ width: '100%' }} /></Form.Item></Col>
            <Col span={12}><Form.Item name="overagePricePer1k" label="超额单价（元/1K）"><InputNumber min={0} precision={2} style={{ width: '100%' }} /></Form.Item></Col>
            <Col span={24}><Form.Item name="description" label="描述"><Input.TextArea rows={2} /></Form.Item></Col>
          </Row>
        </Form>
      </Modal>

      <Modal title={`编辑期货 · ${editTarget?.code || ''}`} open={!!editTarget} onCancel={() => setEditTarget(null)} onOk={() => editForm.submit()} okText="保存" destroyOnClose>
        <Form form={editForm} layout="vertical" onFinish={saveEdit}>
          <Form.Item name="name" label="名称"><Input /></Form.Item>
          <Form.Item name="description" label="描述"><Input.TextArea rows={2} /></Form.Item>
          <Row gutter={12}>
            <Col span={12}><Form.Item name="minVolume" label="交易门槛（最小手数）"><InputNumber min={1} precision={0} style={{ width: '100%' }} /></Form.Item></Col>
            <Col span={12}><Form.Item name="monthlyFee" label="月费（元/月）"><InputNumber min={0} style={{ width: '100%' }} /></Form.Item></Col>
            <Col span={12}><Form.Item name="monthlyQuotaTokens" label="月度 token 额度"><InputNumber min={1} precision={0} style={{ width: '100%' }} /></Form.Item></Col>
            <Col span={12}><Form.Item name="overagePricePer1k" label="超额单价（元/1K）"><InputNumber min={0} precision={2} style={{ width: '100%' }} /></Form.Item></Col>
            <Col span={12}>
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

      <Modal title="创建账户" open={userCreateOpen} onCancel={() => setUserCreateOpen(false)} onOk={() => userForm.submit()} okText="创建" destroyOnClose>
        <Form form={userForm} layout="vertical" onFinish={createUser} initialValues={{ role: 'trader' }}>
          <Form.Item name="username" label="用户名" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="password" label="密码" rules={[{ required: true }]}><Input.Password /></Form.Item>
          <Form.Item name="displayName" label="显示名称"><Input /></Form.Item>
          <Form.Item name="role" label="角色">
            <Select options={[
              { value: 'admin', label: '管理员' },
              { value: 'trader', label: '期货交易商' },
              { value: 'provider', label: '期货提供方' },
              { value: 'receiver', label: '期货接收方' },
            ]} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
