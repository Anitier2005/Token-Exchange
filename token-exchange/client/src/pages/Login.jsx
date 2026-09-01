import React, { useState } from 'react';
import { Card, Tabs, Form, Input, Button, Select, message, Typography } from 'antd';
import { UserOutlined, LockOutlined } from '@ant-design/icons';
import { api, setAuth } from '../api.js';

const { Title, Paragraph } = Typography;

export default function Login({ onLogin }) {
  const [mode, setMode] = useState('login');
  const [loading, setLoading] = useState(false);

  const submit = async (values) => {
    setLoading(true);
    try {
      const path = mode === 'login' ? '/api/auth/login' : '/api/auth/register';
      const body = mode === 'login'
        ? { username: values.username, password: values.password }
        : values;
      const res = await api(path, { method: 'POST', body });
      setAuth(res.token, res.user);
      message.success(`${mode === 'login' ? '登录' : '注册'}成功，欢迎 ${res.user.displayName || res.user.username}`);
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
    }}>
      <Card style={{ width: 420, boxShadow: '0 8px 32px rgba(0,0,0,.3)' }}>
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
          <Form.Item name="username" rules={[{ required: true, message: '请输入用户名' }]}>
            <Input prefix={<UserOutlined />} placeholder="用户名（演示：admin / admin123）" size="large" />
          </Form.Item>
          <Form.Item name="password" rules={[{ required: true, message: '请输入密码' }]}>
            <Input.Password prefix={<LockOutlined />} placeholder="密码" size="large" />
          </Form.Item>
          {mode === 'register' && (
            <>
              <Form.Item name="displayName">
                <Input placeholder="显示名称（可选）" size="large" />
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
          演示账户：admin/admin123 · trader1/trader123 · provider1/provider123 · receiver1/receiver123
        </Paragraph>
      </Card>
    </div>
  );
}
