import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout';
import SkillList from './pages/SkillList';
import SkillNew from './pages/SkillNew';
import SkillDetail from './pages/SkillDetail';
import Settings from './pages/Settings';
import TicketList from './pages/TicketList';
import TicketCreate from './pages/TicketCreate';
import TicketDetail from './pages/TicketDetail';
import SkillTest from './pages/SkillTest';
import McpConfigs from './pages/McpConfigs';
import OAuthManager from './pages/OAuthManager';
import AgentProfile from './pages/AgentProfile';
import AgentInstances from './pages/AgentInstances';
import AgentLogs from './pages/AgentLogs';
import SkillResult from './pages/SkillResult';
import AgentFactory from './pages/AgentFactory';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* 公开结果查看页（无需登录，用户从微信点链接进来）*/}
        <Route path="/skill-result/:requestId" element={<SkillResult />} />
        <Route path="/" element={<Layout />}>
          <Route index element={<Navigate to="/skills" replace />} />
          <Route path="skills" element={<SkillList />} />
          <Route path="skills/new" element={<SkillNew />} />
          <Route path="skills/:id" element={<SkillDetail />} />
          <Route path="tickets" element={<TicketList />} />
          <Route path="tickets/new" element={<TicketCreate />} />
          <Route path="tickets/:id" element={<TicketDetail />} />
          <Route path="agent-logs" element={<AgentLogs />} />
          <Route path="agent-factory" element={<AgentFactory />} />
          <Route path="test" element={<SkillTest />} />
          <Route path="mcp-configs" element={<McpConfigs />} />
          <Route path="oauth" element={<OAuthManager />} />
          <Route path="agent-profile" element={<AgentProfile />} />
          <Route path="agent-instances" element={<AgentInstances />} />
          <Route path="settings" element={<Settings />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
