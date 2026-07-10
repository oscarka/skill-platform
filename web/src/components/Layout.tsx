import { Outlet, NavLink, useLocation } from 'react-router-dom';

const NAV = [
  {
    section: 'Skill 管理',
    items: [
      { to: '/skills', label: 'Skill 列表', icon: '📦' },
      { to: '/skills/new', label: '上传 Skill', icon: '➕' },
    ],
  },
  {
    section: '工单',
    items: [
      { to: '/tickets', label: '工单列表', icon: '📋' },
      { to: '/tickets/new', label: '创建工单', icon: '🔗' },
    ],
  },
  {
    section: '测试',
    items: [
      { to: '/test', label: 'Skill 测试台', icon: '🧪' },
    ],
  },
  {
    section: '系统',
    items: [
      { to: '/settings', label: '平台设置', icon: '⚙️' },
    ],
  },
];

export default function Layout() {
  const location = useLocation();
  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="sidebar-logo">
          <div className="sidebar-logo-icon">⚡</div>
          <span>Skill 平台</span>
        </div>
        <nav className="sidebar-nav">
          {NAV.map(group => (
            <div key={group.section} style={{ marginBottom: 6 }}>
              <div className="nav-section-title">{group.section}</div>
              {group.items.map(item =>
                (item as any).soon ? (
                  <div key={item.to} className="nav-item" style={{ opacity: .4, cursor: 'default' }}>
                    <span className="nav-icon">{item.icon}</span>
                    {item.label}
                    <span style={{ marginLeft: 'auto', fontSize: '.68rem', background: 'rgba(255,255,255,.1)', borderRadius: 4, padding: '2px 6px' }}>即将</span>
                  </div>
                ) : (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    className={({ isActive }) =>
                      `nav-item${isActive || (item.to !== '/' && location.pathname.startsWith(item.to)) ? ' active' : ''}`
                    }
                    end={item.to === '/'}
                  >
                    <span className="nav-icon">{item.icon}</span>
                    {item.label}
                  </NavLink>
                )
              )}
            </div>
          ))}
        </nav>
        <div className="sidebar-footer">Skill Platform v1.0</div>
      </aside>
      <div className="main-area">
        <div className="page-content">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
