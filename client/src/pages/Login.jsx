import React, { useState } from 'react';
import { Card, Tabs, Form, Input, Button, Select, message, Typography } from 'antd';
import { MailOutlined, LockOutlined } from '@ant-design/icons';
import { api, setAuth } from '../api.js';

const { Title, Paragraph } = Typography;

// 邮箱登录 / 注册（暂不验证邮箱真实性）
export default function Login({ onLogin }) {
  const [mode, setMode] = useState('login');
  const [loading, setLoading] = useState(false);

  const submit = async (values) => {
    setLoading(true);
    try {
      const path = mode === 'login' ? '/api/auth/login' : '/api/auth/register';
      const res = await api(path, { method: 'POST', body: values });
      setAuth(res.token, res.user);
      message.success(`${mode === 'login' ? '登录' : '注册'}成功，欢迎 ${res.user.displayName || res.user.email}`);
      onLogin(res.user);
    } catch (e) {
      message.error(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'linear-gradient(135deg, #12294d 0%, #1c3d6e 60%, #2b5a9e 100%)',
      padding: 16,
    }}>
      <Card style={{ width: '100%', maxWidth: 420, boxShadow: '0 8px 32px rgba(0,0,0,.3)' }}>
        <div style={{ textAlign: 'center', marginBottom: 8 }}>
          <Title level={3} style={{ marginBottom: 4 }}>⬡ 词元交易所</Title>
          <Paragraph type="secondary" style={{ marginBottom: 16 }}>
            Token Futures Exchange · 大模型词元期货交易平台
          </Paragraph>
        </div>
        <Tabs
          activeKey={mode}
          onChange={setMode}
          centered
          items={[
            { key: 'login', label: '登录' },
            { key: 'register', label: '注册' },
          ]}
        />
        <Form onFinish={submit} layout="vertical" initialValues={{ role: 'trader' }}>
          <Form.Item
            name="email"
            rules={[
              { required: true, message: '请输入邮箱' },
              { type: 'email', message: '邮箱格式不正确' },
            ]}
          >
            <Input prefix={<MailOutlined />} placeholder="邮箱（暂不验证真实性）" size="large" autoComplete="email" />
          </Form.Item>
          <Form.Item name="password" rules={[{ required: true, message: '请输入密码' }]}>
            <Input.Password prefix={<LockOutlined />} placeholder="密码" size="large" autoComplete="current-password" />
          </Form.Item>
          {mode === 'register' && (
            <>
              <Form.Item name="displayName">
                <Input placeholder="显示名称（可选，默认取邮箱前缀）" size="large" />
              </Form.Item>
              <Form.Item name="role" rules={[{ required: true }]}>
                <Select
                  size="large"
                  options={[
                    { value: 'trader', label: '期货交易商 —— 保证金账户，多空交易' },
                    { value: 'provider', label: '期货提供方 —— 提交大模型接口与定价' },
                    { value: 'receiver', label: '期货接收方 —— 订阅月费使用 token' },
                  ]}
                />
              </Form.Item>
            </>
          )}
          <Button type="primary" htmlType="submit" block size="large" loading={loading}>
            {mode === 'login' ? '登 录' : '注 册'}
          </Button>
        </Form>
        <Paragraph type="secondary" style={{ marginTop: 16, fontSize: 12, marginBottom: 0 }}>
          演示账户：admin@tex.io / admin123 · trader1@tex.io / trader123 · provider1@tex.io / provider123 · receiver1@tex.io / receiver123
        </Paragraph>
      </Card>
    </div>
  );
}
