import React, { useEffect, useState, useCallback } from 'react';
import {
  Card, Col, Row, Statistic, Table, Tag, Typography, Button, Modal, message, Progress, Space, Input, Alert, InputNumber,
} from 'antd';
import { CopyOutlined, SyncOutlined } from '@ant-design/icons';
import MarketPage from '../components/MarketPage.jsx';
import { api, fmtMoney } from '../api.js';

const { Text, Paragraph } = Typography;

export default function ReceiverView({ user, tab }) {
  const [account, setAccount] = useState(null);
  const [models, setModels] = useState([]);
  const [subs, setSubs] = useState([]);
  const [usage, setUsage] = useState([]);
  const [settlements, setSettlements] = useState([]);
  const [rechargeOpen, setRechargeOpen] = useState(false);
  const [keyModal, setKeyModal] = useState(null); // { title, apiKey }
  const [chatTest, setChatTest] = useState(null); // subscription for testing
  const [chatInput, setChatInput] = useState('你好，介绍一下你自己');
  const [chatLog, setChatLog] = useState([]);
  const [chatting, setChatting] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [acc, ms, ss, us, st] = await Promise.all([
        api('/api/receiver/account'),
        api('/api/receiver/models'),
        api('/api/receiver/subscriptions'),
        api('/api/receiver/usage'),
        api('/api/receiver/settlements'),
      ]);
      setAccount(acc);
      setModels(ms);
      setSubs(ss);
      setUsage(us);
      setSettlements(st);
    } catch (e) { message.error(e.message); }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const subscribe = async (m) => {
    try {
      const res = await api('/api/receiver/subscriptions', { method: 'POST', body: { model: m.model } });
      setKeyModal({ title: `订阅成功 · ${m.model}`, apiKey: res.apiKey });
      refresh();
    } catch (e) { message.error(e.message); }
  };

  const regenKey = async (s) => {
    try {
      const res = await api(`/api/receiver/subscriptions/${s.id}/regenerate-key`, { method: 'POST' });
      setKeyModal({ title: `密钥已重置 · ${s.model}`, apiKey: res.apiKey });
      refresh();
    } catch (e) { message.error(e.message); }
  };

  const cancelSub = async (s) => {
    Modal.confirm({
      title: `取消订阅模型 ${s.model}？`,
      content: '取消后统一接口密钥立即失效。',
      onOk: async () => {
        await api(`/api/receiver/subscriptions/${s.id}/cancel`, { method: 'POST' });
        message.success('已取消订阅');
        refresh();
      },
    });
  };

  const sendChat = async () => {
    if (!chatTest || !chatInput.trim()) return;
    setChatting(true);
    const userMsg = chatInput;
    setChatInput('');
    setChatLog((l) => [...l, { role: 'user', content: userMsg }]);
    try {
      const res = await fetch('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${chatTest.api_key}` },
        body: JSON.stringify({ model: chatTest.model, messages: [{ role: 'user', content: userMsg }] }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error?.message || '调用失败');
      setChatLog((l) => [...l, { role: 'assistant', content: data.choices[0].message.content, usage: data.usage }]);
    } catch (e) {
      setChatLog((l) => [...l, { role: 'assistant', content: `[错误] ${e.message}` }]);
    } finally {
      setChatting(false);
    }
  };

  const copyKey = (k) => {
    navigator.clipboard?.writeText(k);
    message.success('已复制到剪贴板');
  };

  const totalBills = settlements.reduce((s, x) => s + Number(x.amount), 0);

  return (
    <div className="page">
      {tab === 'market' && <MarketPage role="receiver" />}

      {tab === 'subscribe' && (
        <>
          <Row gutter={[12, 12]} style={{ marginBottom: 12 }}>
            <Col xs={12} md={8}><Card size="small"><Statistic title="账户余额" value={account?.balance ?? 0} precision={2} prefix="¥" /></Card></Col>
            <Col xs={12} md={8}><Card size="small"><Statistic title="有效订阅" value={subs.filter((s) => s.status === 'active').length} /></Card></Col>
            <Col xs={24} md={8}>
              <Card size="small" actions={[<Button type="link" onClick={() => setRechargeOpen(true)}>虚拟充值</Button>]}>
                <Statistic title="累计账单" value={totalBills} precision={2} prefix="¥" />
              </Card>
            </Col>
          </Row>
          <Card title="可订阅的模型（按模型订阅，覆盖该模型全部 4 类指标合约）" size="small" style={{ marginBottom: 12 }}>
            <Row gutter={[12, 12]}>
              {models.length === 0 && <Col span={24}><Text type="secondary">暂无可订阅模型</Text></Col>}
              {models.map((m) => (
                <Col xs={24} md={12} xl={8} key={m.model}>
                  <Card size="small" title={<span><Text strong>{m.model}</Text>{m.providerName && <Text type="secondary"> · {m.providerName}</Text>}</span>}
                    extra={m.subscribed ? <Tag color="green">已订阅</Tag> : <Button size="small" type="primary" onClick={() => subscribe(m)}>订阅</Button>}>
                    <Paragraph ellipsis={{ rows: 2 }} type="secondary" style={{ minHeight: 40 }}>{m.description}</Paragraph>
                    <Space direction="vertical" size={2}>
                      <Text style={{ fontSize: 12 }}>月费：¥{fmtMoney(m.monthlyFee)} / 月</Text>
                      <Text style={{ fontSize: 12 }}>额度：{Number(m.monthlyQuotaTokens).toLocaleString()} tokens</Text>
                      <Text style={{ fontSize: 12 }}>超额：¥{Number(m.overagePricePer1k).toFixed(2)} / 1K</Text>
                    </Space>
                    <div style={{ marginTop: 8 }}>
                      {m.contracts.map((c) => (
                        <Tag key={c.id} style={{ marginBottom: 4 }}>{c.ticker} · {c.metricLabel}</Tag>
                      ))}
                    </div>
                  </Card>
                </Col>
              ))}
            </Row>
          </Card>
          <Card title="我的订阅与统一接口密钥" size="small">
            <Table rowKey="id" size="middle" pagination={false} dataSource={subs}
              scroll={{ x: 720 }}
              locale={{ emptyText: '暂无订阅' }}
              columns={[
                { title: '模型', dataIndex: 'model', width: 110, render: (v) => <Text strong>{v}</Text> },
                {
                  title: 'API Key', dataIndex: 'api_key', render: (v) => (
                    <Space>
                      <Text code style={{ fontSize: 12 }}>{v.slice(0, 20)}…</Text>
                      <Button size="small" icon={<CopyOutlined />} onClick={() => copyKey(v)}>复制</Button>
                    </Space>
                  ),
                },
                { title: '状态', dataIndex: 'status', width: 80, render: (v) => <Tag color={v === 'active' ? 'green' : 'default'}>{v === 'active' ? '生效' : '已取消'}</Tag> },
                {
                  title: '操作', width: 240,
                  render: (_, r) => r.status === 'active' && (
                    <Space wrap>
                      <Button size="small" onClick={() => { setChatTest(r); setChatLog([]); }}>在线测试</Button>
                      <Button size="small" icon={<SyncOutlined />} onClick={() => regenKey(r)}>重置密钥</Button>
                      <Button size="small" danger onClick={() => cancelSub(r)}>取消订阅</Button>
                    </Space>
                  ),
                },
              ]} />
            <Alert
              style={{ marginTop: 12 }}
              type="info"
              showIcon
              message="统一接口调用方式"
              description={
                <Paragraph style={{ marginBottom: 0 }} copyable={{ text: `curl -X POST ${location.origin}/v1/chat/completions -H "Authorization: Bearer <你的API Key>" -H "Content-Type: application/json" -d '{"model":"<模型代码>","messages":[{"role":"user","content":"你好"}]}'` }}>
                  <Text code>POST /v1/chat/completions</Text>，兼容 OpenAI Chat Completions 格式；月费按月结转，超出额度按超额单价计费。
                </Paragraph>
              }
            />
          </Card>
        </>
      )}

      {tab === 'usage' && (
        <Row gutter={[12, 12]}>
          <Col xs={24} lg={12}>
            <Card title="本月用量（按模型）" size="small">
              {usage.length === 0 && <Text type="secondary">暂无订阅</Text>}
              {usage.map((u) => (
                <div key={u.subscription_id} style={{ marginBottom: 16 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4, flexWrap: 'wrap', gap: 4 }}>
                    <Text strong>{u.model}</Text>
                    <Text className="mono">{Number(u.month_tokens).toLocaleString()} / {Number(u.monthly_quota_tokens).toLocaleString()} tokens · {Number(u.month_calls).toLocaleString()} 次</Text>
                  </div>
                  <Progress
                    percent={Math.min(100, Math.round(u.month_tokens / u.monthly_quota_tokens * 100))}
                    status={u.month_tokens > u.monthly_quota_tokens ? 'exception' : 'active'}
                  />
                </div>
              ))}
            </Card>
          </Col>
          <Col xs={24} lg={12}>
            <Card title="月度结转账单" size="small">
              <Table rowKey="id" size="small" pagination={{ pageSize: 10 }} dataSource={settlements}
                scroll={{ x: 480 }}
                locale={{ emptyText: '暂无账单' }}
                columns={[
                  { title: '周期', dataIndex: 'period', width: 80 },
                  { title: '模型', dataIndex: 'model', width: 90 },
                  { title: '月费', render: (_, r) => `¥${fmtMoney(r.detail?.monthlyFee ?? 0)}` },
                  { title: '超额 tokens', render: (_, r) => Number(r.detail?.overage ?? 0).toLocaleString() },
                  { title: '金额', dataIndex: 'amount', align: 'right', render: (v) => `¥${fmtMoney(v)}` },
                ]} />
            </Card>
          </Col>
        </Row>
      )}

      <Modal
        title={keyModal?.title}
        open={!!keyModal}
        onCancel={() => setKeyModal(null)}
        onOk={() => setKeyModal(null)}
        okText="我已保存"
        cancelButtonProps={{ style: { display: 'none' } }}
      >
        <Paragraph type="warning">请立即保存密钥，重置后旧密钥将失效。</Paragraph>
        <Input.Search
          value={keyModal?.apiKey}
          readOnly
          enterButton={<CopyOutlined />}
          onSearch={() => copyKey(keyModal.apiKey)}
        />
      </Modal>

      <Modal
        title={`在线测试统一接口 · ${chatTest?.model || ''}`}
        open={!!chatTest}
        onCancel={() => setChatTest(null)}
        footer={null}
        width={560}
        destroyOnClose
      >
        <div style={{ maxHeight: 320, overflow: 'auto', background: '#fafafa', padding: 12, borderRadius: 8, marginBottom: 12 }}>
          {chatLog.length === 0 && <Text type="secondary">发送一条消息测试 token 调用（用量将按 4 类指标分别计入结转）</Text>}
          {chatLog.map((m, i) => (
            <div key={i} style={{ marginBottom: 8, textAlign: m.role === 'user' ? 'right' : 'left' }}>
              <div style={{
                display: 'inline-block', maxWidth: '85%', padding: '6px 10px', borderRadius: 8,
                background: m.role === 'user' ? '#1a3a6b' : '#fff', color: m.role === 'user' ? '#fff' : '#333',
                border: m.role === 'user' ? 'none' : '1px solid #e5e5e5',
                whiteSpace: 'pre-wrap', fontSize: 13,
              }}>{m.content}</div>
              {m.usage && <div style={{ fontSize: 11, color: '#999', marginTop: 2 }}>tokens: {m.usage.total_tokens}（缓存命中 {m.usage.cached_tokens}）</div>}
            </div>
          ))}
        </div>
        <Space.Compact style={{ width: '100%' }}>
          <Input value={chatInput} onChange={(e) => setChatInput(e.target.value)}
            onPressEnter={sendChat} placeholder="输入消息…" disabled={chatting} />
          <Button type="primary" onClick={sendChat} loading={chatting}>发送</Button>
        </Space.Compact>
      </Modal>

      <Modal title="虚拟充值" open={rechargeOpen} onCancel={() => setRechargeOpen(false)} footer={null} destroyOnClose>
        <RechargeForm onDone={() => { setRechargeOpen(false); refresh(); }} role="receiver" />
      </Modal>
    </div>
  );
}

function RechargeForm({ onDone, role }) {
  const [amount, setAmount] = React.useState(10000);
  const submit = async () => {
    try {
      await api(`/api/${role}/recharge`, { method: 'POST', body: { amount } });
      message.success('充值成功');
      onDone();
    } catch (e) { message.error(e.message); }
  };
  return (
    <div>
      <InputNumber value={amount} min={1} onChange={setAmount} precision={2} style={{ width: '100%', marginBottom: 12 }} />
      <Button type="primary" block onClick={submit}>充值</Button>
    </div>
  );
}
