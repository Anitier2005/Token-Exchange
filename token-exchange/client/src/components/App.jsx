import React, { useEffect, useState } from 'react';
import { Layout, Menu, Button, message, Modal, ConfigProvider } from 'antd';
import {
  DashboardOutlined, LineChartOutlined, LogoutOutlined, BankOutlined,
  RobotOutlined, ApiOutlined, SettingOutlined,
} from '@ant-design/icons';
import Login from '../pages/Login.jsx';
import TraderView from '../pages/TraderView.jsx';
import ProviderView from '../pages/ProviderView.jsx';
import ReceiverView from '../pages/ReceiverView.jsx';
import AdminView from '../pages/AdminView.jsx';
import { cachedUser, clearAuth, getToken } from '../api.js';

const { Header, Content } = Layout;

const ROLE_LABEL = {
  admin: '管理员', trader: '期货交易商', provider: '期货提供方', receiver: '期货接收方',
};

const ROLE_MENUS = {
  trader: [
    { key: 'market', icon: <LineChartOutlined />, label: '行情交易' },
    { key: 'account', icon: <BankOutlined />, label: '我的账户' },
  ],
  provider: [
    { key: 'futures', icon: <RobotOutlined />, label: '我的期货与定价' },
    { key: 'usage', icon: <DashboardOutlined />, label: '调用量与结转' },
  ],
  receiver: [
    { key: 'subscribe', icon: <ApiOutlined />, label: '订阅与密钥' },
    { key: 'usage', icon: <DashboardOutlined />, label: '用量与账单' },
  ],
  admin: [
    { key: 'overview', icon: <DashboardOutlined />, label: '交易所概览' },
    { key: 'config', icon: <SettingOutlined />, label: '交易与风控配置' },
    { key: 'users', icon: <BankOutlined />, label: '账户管理' },
    { key: 'futures', icon: <LineChartOutlined />, label: '期货管理' },
    { key: 'settlements', icon: <RobotOutlined />, label: '结转管理' },
  ],
};

export default function App() {
  const [user, setUser] = useState(null);
  const [tab, setTab] = useState('market');

  useEffect(() => {
    if (getToken() && cachedUser()) {
      setUser(cachedUser());
      setTab(ROLE_MENUS[cachedUser().role]?.[0]?.key || 'market');
    }
  }, []);

  const logout = () => {
    clearAuth();
    setUser(null);
    message.success('已退出登录');
  };

  if (!user) {
    return <Login onLogin={(u) => { setUser(u); setTab(ROLE_MENUS[u.role]?.[0]?.key || 'market'); }} />;
  }

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: '#12294d' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flex: 1 }}>
          <span style={{ color: '#fff', fontSize: 18, fontWeight: 700, whiteSpace: 'nowrap' }}>⬡ 词元交易所</span>
          <Menu
            theme="dark"
            mode="horizontal"
            selectedKeys={[tab]}
            onClick={(e) => setTab(e.key)}
            items={ROLE_MENUS[user.role] || []}
            style={{ background: 'transparent', flex: 1, minWidth: 0 }}
          />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, color: '#fff', whiteSpace: 'nowrap' }}>
          <span>{ROLE_LABEL[user.role]} · {user.displayName || user.username}</span>
          <Button size="small" icon={<LogoutOutlined />} onClick={logout} ghost>退出</Button>
        </div>
      </Header>
      <Content>
        {user.role === 'trader' && <TraderView user={user} tab={tab} />}
        {user.role === 'provider' && <ProviderView user={user} tab={tab} />}
        {user.role === 'receiver' && <ReceiverView user={user} tab={tab} />}
        {user.role === 'admin' && <AdminView user={user} tab={tab} />}
      </Content>
    </Layout>
  );
}
