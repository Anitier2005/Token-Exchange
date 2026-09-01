import React, { useEffect, useState } from 'react';
import { Layout, Menu, Button, message, Drawer, Grid } from 'antd';
import {
  DashboardOutlined, LineChartOutlined, LogoutOutlined, BankOutlined,
  RobotOutlined, ApiOutlined, SettingOutlined, MenuOutlined, SafetyOutlined,
} from '@ant-design/icons';
import Login from '../pages/Login.jsx';
import TraderView from '../pages/TraderView.jsx';
import ProviderView from '../pages/ProviderView.jsx';
import ReceiverView from '../pages/ReceiverView.jsx';
import AdminView from '../pages/AdminView.jsx';
import { cachedUser, clearAuth, getToken } from '../api.js';

const { Header, Content } = Layout;
const { useBreakpoint } = Grid;

const ROLE_LABEL = {
  admin: '管理员', trader: '期货交易商', provider: '期货提供方', receiver: '期货接收方',
};

// 所有角色共享同一套行情页；管理员额外拥有最高级（L2）行情
const ROLE_MENUS = {
  trader: [
    { key: 'market', icon: <LineChartOutlined />, label: '行情' },
    { key: 'trade', icon: <RobotOutlined />, label: '交易' },
    { key: 'account', icon: <BankOutlined />, label: '我的账户' },
  ],
  provider: [
    { key: 'market', icon: <LineChartOutlined />, label: '行情' },
    { key: 'futures', icon: <RobotOutlined />, label: '我的期货与定价' },
    { key: 'usage', icon: <DashboardOutlined />, label: '调用量与结转' },
  ],
  receiver: [
    { key: 'market', icon: <LineChartOutlined />, label: '行情' },
    { key: 'subscribe', icon: <ApiOutlined />, label: '订阅与密钥' },
    { key: 'usage', icon: <DashboardOutlined />, label: '用量与账单' },
  ],
  admin: [
    { key: 'market', icon: <LineChartOutlined />, label: '行情（L2）' },
    { key: 'overview', icon: <DashboardOutlined />, label: '交易所概览' },
    { key: 'config', icon: <SettingOutlined />, label: '交易与风控配置' },
    { key: 'users', icon: <BankOutlined />, label: '账户管理' },
    { key: 'futures', icon: <RobotOutlined />, label: '期货管理' },
    { key: 'settlements', icon: <ApiOutlined />, label: '结转管理' },
    { key: 'ops', icon: <SafetyOutlined />, label: '运营监控' },
  ],
};

export default function App() {
  const [user, setUser] = useState(null);
  const [tab, setTab] = useState('market');
  const [menuOpen, setMenuOpen] = useState(false);
  const screens = useBreakpoint();
  const isMobile = !screens.md;

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

  const menuItems = ROLE_MENUS[user.role] || [];
  const nav = (
    <Menu
      theme="dark"
      mode={isMobile ? 'vertical' : 'horizontal'}
      selectedKeys={[tab]}
      onClick={(e) => { setTab(e.key); setMenuOpen(false); }}
      items={menuItems}
      style={{ background: 'transparent', flex: 1, minWidth: 0, borderBottom: 'none' }}
    />
  );

  return (
    <Layout style={{ minHeight: '100vh', minWidth: 0 }}>
      <Header className="app-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flex: 1, minWidth: 0 }}>
          {isMobile && (
            <Button type="text" icon={<MenuOutlined />} onClick={() => setMenuOpen(true)}
              style={{ color: '#fff' }} />
          )}
          <span className="app-title">⬡ 词元交易所</span>
          {!isMobile && nav}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#fff', whiteSpace: 'nowrap', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13 }}>
            {ROLE_LABEL[user.role]} · {user.displayName || user.email}
          </span>
          <Button size="small" icon={<LogoutOutlined />} onClick={logout} ghost>退出</Button>
        </div>
      </Header>
      <Drawer title="导航" placement="left" open={menuOpen} onClose={() => setMenuOpen(false)} width={240} styles={{ body: { padding: 0 } }}>
        {nav}
      </Drawer>
      <Content style={{ minWidth: 0 }}>
        {user.role === 'trader' && <TraderView user={user} tab={tab} />}
        {user.role === 'provider' && <ProviderView user={user} tab={tab} />}
        {user.role === 'receiver' && <ReceiverView user={user} tab={tab} />}
        {user.role === 'admin' && <AdminView user={user} tab={tab} />}
      </Content>
    </Layout>
  );
}
