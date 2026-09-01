import React, { useEffect, useState, useCallback } from 'react';
import {
  Card, Tabs, Table, Tag, Typography, Form, Input, Select, Button, message, Drawer, Descriptions,
  Segmented, Row, Col, List, Modal, Spin, Empty, Space, InputNumber, Popconfirm, Alert,
} from 'antd';
import { AppstoreOutlined, BarsOutlined, UserAddOutlined, SearchOutlined, ReloadOutlined } from '@ant-design/icons';
import { api, fmtMoney } from '../api.js';

const { Text, Paragraph } = Typography;

export const STATUS_META = {
  active: { label: '正常', color: 'green' },
  frozen: { label: '冻结', color: 'blue' },
  risk_control: { label: '风控', color: 'orange' },
  cancelled: { label: '注销', color: 'default' },
};

const ROLE_META = {
  admin: { label: '管理员', color: 'geekblue' },
  trader: { label: '期货交易商', color: 'volcano' },
  provider: { label: '期货提供方', color: 'purple' },
  receiver: { label: '期货接收方', color: 'cyan' },
};

const STATUS_DESC = {
  frozen: '冻结：已挂出的单不受影响，但无法再挂新单，无法登录和查看。',
  risk_control: '风控：可以登录和查看，禁止挂单，已挂出的单立即撤回。',
  cancelled: '注销：无法登录和查看，无法进行任何操作；数据全部保留，未提取的保证金转入交易所账户。',
};

// 账户管理：
// - 默认分页为「搜索与操作」，不显示任何账户，必须筛选后才显示（且只显示 名称/状态/ID）
// - 其他分页按角色显示账户，支持卡片 / 条目两种视图
// - 点击账户在右侧弹出侧边栏，信息与操作使用不同分页
export default function AccountManage() {
  const [tab, setTab] = useState('search');
  const [drawerId, setDrawerId] = useState(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [version, setVersion] = useState(0); // 状态变更后刷新列表

  return (
    <Card size="small" title="交易所账户管理">
      <Tabs
        activeKey={tab}
        onChange={setTab}
        items={[
          {
            key: 'search',
            label: '搜索与操作',
            children: <SearchPanel onOpen={setDrawerId} version={version} onCreate={() => setCreateOpen(true)} />,
          },
          { key: 'trader', label: '期货交易商', children: <RolePanel role="trader" onOpen={setDrawerId} version={version} /> },
          { key: 'provider', label: '期货提供方', children: <RolePanel role="provider" onOpen={setDrawerId} version={version} /> },
          { key: 'receiver', label: '期货接收方', children: <RolePanel role="receiver" onOpen={setDrawerId} version={version} /> },
          { key: 'admin', label: '管理员', children: <RolePanel role="admin" onOpen={setDrawerId} version={version} /> },
        ]}
      />
      <AccountDrawer id={drawerId} onClose={() => setDrawerId(null)} onChanged={() => setVersion((v) => v + 1)} />
      <CreateUserModal open={createOpen} onClose={() => setCreateOpen(false)} onCreated={() => setVersion((v) => v + 1)} />
    </Card>
  );
}

// ---------- 搜索与操作（默认分页：无筛选不显示任何账户） ----------
function SearchPanel({ onOpen, version, onCreate }) {
  const [form] = Form.useForm();
  const [searched, setSearched] = useState(false);
  const [loading, setLoading] = useState(false);
  const [users, setUsers] = useState([]);

  const doSearch = async (values) => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (values.role) params.set('role', values.role);
      if (values.status) params.set('status', values.status);
      if (values.q) params.set('q', values.q);
      const data = await api(`/api/admin/users?${params.toString()}`);
      setUsers(data);
      setSearched(true);
    } catch (e) { message.error(e.message); }
    finally { setLoading(false); }
  };

  useEffect(() => {
    if (searched) form.submit();
  }, [version]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div>
      <Alert
        type="info" showIcon style={{ marginBottom: 12 }}
        message="为保护账户隐私，本页默认不显示任何账户信息；请先通过条件筛选。"
      />
      <Form form={form} layout="inline" onFinish={doSearch}
        style={{ marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
        <Form.Item name="role">
          <Select allowClear placeholder="角色" style={{ width: 140 }}
            options={Object.entries(ROLE_META).map(([v, m]) => ({ value: v, label: m.label }))} />
        </Form.Item>
        <Form.Item name="status">
          <Select allowClear placeholder="状态" style={{ width: 120 }}
            options={Object.entries(STATUS_META).map(([v, m]) => ({ value: v, label: m.label }))} />
        </Form.Item>
        <Form.Item name="q">
          <Input allowClear placeholder="邮箱 / 名称 / ID 关键词" style={{ width: 220 }} prefix={<SearchOutlined />} />
        </Form.Item>
        <Form.Item>
          <Space>
            <Button type="primary" htmlType="submit" loading={loading}>筛选</Button>
            <Button icon={<UserAddOutlined />} onClick={onCreate}>创建账户</Button>
          </Space>
        </Form.Item>
      </Form>

      {searched ? (
        <Table rowKey="id" size="middle" loading={loading} dataSource={users}
          pagination={{ pageSize: 12, showTotal: (n) => `共 ${n} 个账户` }}
          locale={{ emptyText: '没有符合条件的账户' }}
          onRow={(r) => ({ onClick: () => onOpen(r.id), style: { cursor: 'pointer' } })}
          columns={[
            {
              title: '名称', dataIndex: 'display_name',
              render: (v, r) => <Text strong>{v || r.email?.split('@')[0]}</Text>,
            },
            {
              title: '状态', dataIndex: 'status', width: 100,
              render: (v) => <Tag color={STATUS_META[v]?.color}>{STATUS_META[v]?.label || v}</Tag>,
            },
            { title: 'ID', dataIndex: 'id', width: 180, render: (v) => <span className="mono" style={{ color: '#888' }}>{v}</span> },
            {
              title: '', width: 80,
              render: () => <Button size="small" type="link">详情</Button>,
            },
          ]} />
      ) : (
        <Empty description="尚未筛选：请设置角色 / 状态 / 关键词后点击「筛选」" style={{ padding: '32px 0' }} />
      )}
    </div>
  );
}

// ---------- 角色分页（卡片 / 条目两种视图，仅显示 名称 / 状态 / ID） ----------
function RolePanel({ role, onOpen, version }) {
  const [view, setView] = useState('card');
  const [users, setUsers] = useState(null);

  const load = useCallback(async () => {
    try {
      setUsers(await api(`/api/admin/users?role=${role}`));
    } catch (e) { message.error(e.message); }
  }, [role]);

  useEffect(() => { load(); }, [load, version]);

  const nameOf = (u) => u.display_name || u.email?.split('@')[0] || '-';

  return (
    <Spin spinning={users == null}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
        <Text type="secondary">
          {ROLE_META[role].label}账户 · 共 {users?.length ?? 0} 个；点击查看详情与操作
        </Text>
        <Space>
          <Button size="small" icon={<ReloadOutlined />} onClick={load} />
          <Segmented value={view} onChange={setView}
            options={[
              { value: 'card', label: '卡片', icon: <AppstoreOutlined /> },
              { value: 'list', label: '条目', icon: <BarsOutlined /> },
            ]} />
        </Space>
      </div>

      {view === 'card' ? (
        <Row gutter={[12, 12]}>
          {(users || []).map((u) => (
            <Col xs={24} sm={12} md={8} xl={6} key={u.id}>
              <Card size="small" className="acct-card" onClick={() => onOpen(u.id)}>
                <Card.Meta
                  title={<span>{nameOf(u)} <Tag color={STATUS_META[u.status]?.color} style={{ marginLeft: 8 }}>{STATUS_META[u.status]?.label}</Tag></span>}
                  description={<span className="mono acct-id">ID {u.id}</span>}
                />
              </Card>
            </Col>
          ))}
        </Row>
      ) : (
        <List
          dataSource={users || []}
          locale={{ emptyText: '暂无账户' }}
          renderItem={(u) => (
            <List.Item style={{ cursor: 'pointer', padding: '10px 8px' }} onClick={() => onOpen(u.id)}>
              <List.Item.Meta
                avatar={<Tag color={ROLE_META[u.role]?.color}>{ROLE_META[u.role]?.label}</Tag>}
                title={<Text strong>{nameOf(u)}</Text>}
                description={<span className="mono acct-id">ID {u.id}</span>}
              />
              <Tag color={STATUS_META[u.status]?.color}>{STATUS_META[u.status]?.label}</Tag>
            </List.Item>
          )}
        />
      )}
    </Spin>
  );
}

// ---------- 右侧侧边栏：信息与操作分页 ----------
function AccountDrawer({ id, onClose, onChanged }) {
  const [detail, setDetail] = useState(null);
  const [reason, setReason] = useState('');

  useEffect(() => {
    if (id == null) { setDetail(null); setReason(''); return; }
    (async () => {
      try { setDetail(await api(`/api/admin/users/${id}`)); }
      catch (e) { message.error(e.message); }
    })();
  }, [id]);

  const changeStatus = async (status) => {
    try {
      const res = await api(`/api/admin/users/${id}/status`, { method: 'PUT', body: { status, reason } });
      message.success(res.note);
      setReason('');
      setDetail(await api(`/api/admin/users/${id}`));
      onChanged();
    } catch (e) { message.error(e.message); }
  };

  const u = detail;
  const status = u?.status;

  return (
    <Drawer
      title={u ? (
        <span>
          {u.display_name || u.email?.split('@')[0]}
          <Tag color={STATUS_META[status]?.color} style={{ marginLeft: 12 }}>{STATUS_META[status]?.label}</Tag>
        </span>
      ) : '账户详情'}
      placement="right"
      open={id != null}
      onClose={onClose}
      width={Math.min(480, typeof window !== 'undefined' ? window.innerWidth - 24 : 480)}
    >
      {!u ? <Spin style={{ display: 'block', margin: '48px auto' }} /> : (
        <Tabs
          items={[
            {
              key: 'info',
              label: '信息',
              children: (
                <Descriptions column={1} size="small" bordered>
                  <Descriptions.Item label="ID"><span className="mono">{u.id}</span></Descriptions.Item>
                  <Descriptions.Item label="邮箱">{u.email}</Descriptions.Item>
                  <Descriptions.Item label="显示名称">{u.display_name || '-'}</Descriptions.Item>
                  <Descriptions.Item label="角色">
                    <Tag color={ROLE_META[u.role]?.color}>{ROLE_META[u.role]?.label}</Tag>
                  </Descriptions.Item>
                  <Descriptions.Item label="状态">
                    <Tag color={STATUS_META[u.status]?.color}>{STATUS_META[u.status]?.label}</Tag>
                  </Descriptions.Item>
                  <Descriptions.Item label="账户余额">¥{fmtMoney(u.balance)}</Descriptions.Item>
                  <Descriptions.Item label="注册时间">
                    {new Date(u.created_at).toLocaleString('zh-CN', { hour12: false })}
                  </Descriptions.Item>
                  <Descriptions.Item label="累计委托">{u.stats?.orders ?? 0} 笔（{u.stats?.orderVolume ?? 0} 手）</Descriptions.Item>
                  <Descriptions.Item label="当前持仓">{u.stats?.positions ?? 0} 个（{u.stats?.positionVolume ?? 0} 手）</Descriptions.Item>
                  <Descriptions.Item label="有效订阅">{u.stats?.subscriptions ?? 0} 个</Descriptions.Item>
                </Descriptions>
              ),
            },
            {
              key: 'ops',
              label: '操作',
              children: (
                <div>
                  {status === 'cancelled' && (
                    <Alert type="warning" showIcon style={{ marginBottom: 16 }}
                      message="该账户已注销：数据全部保留，无法变更状态。" />
                  )}
                  <Paragraph type="secondary" style={{ fontSize: 12 }}>操作原因（可选）：</Paragraph>
                  <Input.TextArea
                    rows={2} value={reason} onChange={(e) => setReason(e.target.value)}
                    placeholder="例如：异常交易行为 / 客户申请注销" style={{ marginBottom: 16 }} />

                  {status !== 'cancelled' && (
                    <Space direction="vertical" style={{ width: '100%' }} size={12}>
                      {status !== 'frozen' && (
                        <Popconfirm title="确认冻结该账户？" description={STATUS_DESC.frozen}
                          onConfirm={() => changeStatus('frozen')} okText="冻结" cancelText="取消">
                          <Button block>冻结</Button>
                        </Popconfirm>
                      )}
                      {status !== 'risk_control' && (
                        <Popconfirm title="确认对该账户执行风控？" description={STATUS_DESC.risk_control}
                          onConfirm={() => changeStatus('risk_control')} okText="执行风控" cancelText="取消">
                          <Button block>触发风控</Button>
                        </Popconfirm>
                      )}
                      {status !== 'active' && (
                        <Popconfirm title="确认恢复该账户为正常状态？"
                          onConfirm={() => changeStatus('active')} okText="恢复" cancelText="取消">
                          <Button block type="primary">恢复正常</Button>
                        </Popconfirm>
                      )}
                      <Popconfirm title="确认注销该账户？" description={STATUS_DESC.cancelled}
                        onConfirm={() => changeStatus('cancelled')} okText="确认注销" cancelText="取消" okButtonProps={{ danger: true }}>
                        <Button block danger>注销账户</Button>
                      </Popconfirm>
                    </Space>
                  )}

                  <Alert type="info" style={{ marginTop: 24 }} showIcon message="状态说明"
                    description={(
                      <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12 }}>
                        <li>{STATUS_DESC.frozen}</li>
                        <li>{STATUS_DESC.risk_control}</li>
                        <li>{STATUS_DESC.cancelled}</li>
                      </ul>
                    )} />
                </div>
              ),
            },
          ]}
        />
      )}
    </Drawer>
  );
}

// ---------- 创建账户（邮箱登录，ID 由系统生成长串纯数字） ----------
function CreateUserModal({ open, onClose, onCreated }) {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);

  const submit = async (v) => {
    setLoading(true);
    try {
      const res = await api('/api/admin/users', { method: 'POST', body: v });
      message.success(`账户已创建，ID：${res.id}`);
      form.resetFields();
      onClose();
      onCreated();
    } catch (e) { message.error(e.message); }
    finally { setLoading(false); }
  };

  return (
    <Modal title="创建账户" open={open} onCancel={onClose} onOk={() => form.submit()} okText="创建" destroyOnClose>
      <Form form={form} layout="vertical" onFinish={submit} initialValues={{ role: 'trader' }}>
        <Form.Item name="email" label="邮箱（登录凭证，暂不验证）"
          rules={[{ required: true, message: '请输入邮箱' }, { type: 'email', message: '邮箱格式不正确' }]}>
          <Input placeholder="user@example.com" />
        </Form.Item>
        <Form.Item name="password" label="密码" rules={[{ required: true, message: '请输入密码' }]}>
          <Input.Password />
        </Form.Item>
        <Form.Item name="displayName" label="显示名称">
          <Input placeholder="可选" />
        </Form.Item>
        <Form.Item name="role" label="角色">
          <Select options={Object.entries(ROLE_META).map(([v, m]) => ({ value: v, label: m.label }))} />
        </Form.Item>
        <Paragraph type="secondary" style={{ marginBottom: 0, fontSize: 12 }}>
          账户 ID 将由系统自动生成 15 位纯数字随机数。
        </Paragraph>
      </Form>
    </Modal>
  );
}
