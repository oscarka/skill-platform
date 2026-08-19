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
      { to: '/agent-logs', label: 'Agent 执行日志', icon: '📜' },
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
      { to: '/agent-instances', label: 'Agent 实例管理', icon: '🤖' },
      { to: '/agent-profile',   label: '服务配置（默认）', icon: '⚙️' },
      { to: '/mcp-configs',     label: 'MCP 配置', icon: '🔌' },
      { to: '/oauth',           label: '授权管理', icon: '🔑' },
      { to: '/settings',        label: '平台设置', icon: '🛠️' },
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
                    className={() => {
                      const path = location.pathname;
                      // 精确匹配当前路径
                      if (path === item.to) return 'nav-item active';
                      // "新建/上传" 类页面：只精确匹配，不匹配子路径
                      if (item.to.endsWith('/new')) return 'nav-item';
                      // 列表页：也匹配其详情子页（如 /tickets/:id），但不匹配同级 /new
                      if (item.to !== '/' && path.startsWith(item.to + '/') && !path.startsWith(item.to + '/new')) {
                        return 'nav-item active';
                      }
                      return 'nav-item';
                    }}
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
