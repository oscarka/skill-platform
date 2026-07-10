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

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Layout />}>
          <Route index element={<Navigate to="/skills" replace />} />
          <Route path="skills" element={<SkillList />} />
          <Route path="skills/new" element={<SkillNew />} />
          <Route path="skills/:id" element={<SkillDetail />} />
          <Route path="tickets" element={<TicketList />} />
          <Route path="tickets/new" element={<TicketCreate />} />
          <Route path="tickets/:id" element={<TicketDetail />} />
          <Route path="test" element={<SkillTest />} />
          <Route path="mcp-configs" element={<McpConfigs />} />
          <Route path="oauth" element={<OAuthManager />} />
          <Route path="settings" element={<Settings />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
