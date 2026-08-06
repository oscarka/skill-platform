import { useState, useEffect, useRef, useCallback } from 'react';
import { api } from '../lib/api';

// ─── 状态颜色配置 ──────────────────────────────────────────────────────────────
const STATUS_CONFIG: Record<string, { label: string; cls: string; dot: string }> = {
  created:       { label: '待发送',   cls: 'badge-pending',    dot: '#94a3b8' },
  waiting_input: { label: '等待提交', cls: 'badge-reviewing',  dot: '#f59e0b' },
  submitted:     { label: '已提交',   cls: 'badge-internal',   dot: '#6366f1' },
  processing:    { label: 'AI处理中', cls: 'badge-reviewing',  dot: '#3b82f6' },
  done:          { label: '已完成',   cls: 'badge-published',  dot: '#10b981' },
  returned:      { label: '已打回',   cls: 'badge-pending',    dot: '#f59e0b' },
  expired:       { label: '已过期',   cls: 'badge-disabled',   dot: '#94a3b8' },
  error:         { label: '出错',     cls: 'badge-rejected',   dot: '#ef4444' },
};

// ─── Transcript 每种 role/type 的颜色主题 ─────────────────────────────────────
const ENTRY_THEME: Record<string, {
  dotChar: string; dotBg: string; dotBorder: string;
  cardBg: string; cardBorder: string;
  badgeBg: string; badgeColor: string; label: string;
}> = {
  header: {
    dotChar: '🚀', dotBg: '#fef3c7', dotBorder: '#f59e0b',
    cardBg: '#fffbeb', cardBorder: '#fde68a',
    badgeBg: '#fef3c7', badgeColor: '#92400e', label: 'START',
  },
  event: {
    dotChar: '⚡', dotBg: '#fef3c7', dotBorder: '#f59e0b',
    cardBg: '#fffbeb', cardBorder: '#fde68a',
    badgeBg: '#fef3c7', badgeColor: '#92400e', label: 'EVENT',
  },
  system: {
    dotChar: '📋', dotBg: '#f1f5f9', dotBorder: '#64748b',
    cardBg: '#f8fafc', cardBorder: '#e2e8f0',
    badgeBg: '#e2e8f0', badgeColor: '#334155', label: 'SYSTEM PROMPT',
  },
  assistant: {
    dotChar: '🧠', dotBg: '#f3e8ff', dotBorder: '#9333ea',
    cardBg: '#faf5ff', cardBorder: '#e9d5ff',
    badgeBg: '#f3e8ff', badgeColor: '#6b21a8', label: 'AI THINKING',
  },
  tool: {
    dotChar: '🔧', dotBg: '#d1fae5', dotBorder: '#10b981',
    cardBg: '#ecfdf5', cardBorder: '#a7f3d0',
    badgeBg: '#d1fae5', badgeColor: '#065f46', label: 'TOOL RESPONSE',
  },
};

const getEntryTheme = (t: any) => {
  if (t.type === 'header') return ENTRY_THEME.header;
  if (t.type === 'event') return ENTRY_THEME.event;
  if (t.role === 'system') return ENTRY_THEME.system;
  if (t.role === 'assistant') return ENTRY_THEME.assistant;
  if (t.role === 'tool') return ENTRY_THEME.tool;
  return ENTRY_THEME.event;
};

// ─── 工具函数 ────────────────────────────────────────────────────────────────
const formatDate = (val: any) => {
  if (!val) return '-';
  let num = Number(val);
  if (!isNaN(num) && num > 1000000000) {
    if (num < 10000000000) num *= 1000;
    return new Date(num).toLocaleString('zh-CN');
  }
  const d = new Date(val);
  return isNaN(d.getTime()) ? String(val) : d.toLocaleString('zh-CN');
};

const formatTimeOnly = (val: any) => {
  if (!val) return '';
  if (typeof val === 'string' && val.includes('T')) return val.slice(11, 19);
  let num = Number(val);
  if (!isNaN(num) && num > 1000000000) {
    if (num < 10000000000) num *= 1000;
    return new Date(num).toLocaleTimeString('zh-CN');
  }
  return String(val);
};

// ─── 内联样式常量 ─────────────────────────────────────────────────────────────
const S = {
  darkBar: {
    margin: '6px 0 8px',
    padding: '6px 10px',
    background: '#0f172a',
    color: '#94a3b8',
    borderRadius: '8px',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: '11px',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    flexWrap: 'wrap' as const,
    gap: '6px',
  },
  pre: {
    background: '#0f172a',
    color: '#34d399',
    padding: '10px 12px',
    borderRadius: '8px',
    fontSize: '11px',
    whiteSpace: 'pre-wrap' as const,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    margin: 0,
    overflow: 'auto' as const,
    maxHeight: 420,
  },
  preBlue: {
    background: '#0f172a',
    color: '#38bdf8',
    padding: '10px 12px',
    borderRadius: '8px',
    fontSize: '11px',
    whiteSpace: 'pre-wrap' as const,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    margin: 0,
    overflow: 'auto' as const,
    maxHeight: 420,
  },
  detailsSummary: {
    fontSize: '11px',
    fontWeight: 600,
    color: '#4f46e5',
    cursor: 'pointer',
    userSelect: 'none' as const,
    fontFamily: 'sans-serif',
  },
} as const;

// ─── Agent Tasks Panel (渠道消息统一日志) ─────────────────────────────────────

const CHANNEL_STATUS: Record<string, { label: string; dot: string }> = {
  pending:   { label: '待路由',   dot: '#94a3b8' },
  routing:   { label: '路由中',   dot: '#f59e0b' },
  executing: { label: '执行中',   dot: '#3b82f6' },
  done:      { label: '已完成',   dot: '#10b981' },
  failed:    { label: '失败',     dot: '#ef4444' },
};

const EVENT_ICONS: Record<string, string> = {
  message_received: '📨',
  wiki_fetched:     '📚',
  route_decided:    '🔀',
  skill_selected:   '🎯',
  skill_started:    '⚙️',
  reassurance_sent: '💬',
  skill_done:       '✅',
  reply_sent:       '📤',
  task_failed:      '❌',
};

function AgentTasksPanel() {
  const [tasks, setTasks] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<any>(null);
  const [events, setEvents] = useState<any[]>([]);
  const [filter, setFilter] = useState({ channel: '', status: '' });
  const [detailTab, setDetailTab] = useState<'events' | 'transcript' | 'context'>('events');

  const loadTasks = async () => {
    try {
      const params = new URLSearchParams({ limit: '50' });
      if (filter.channel) params.set('channel', filter.channel);
      if (filter.status) params.set('status', filter.status);
      const res = await fetch(`/api/v1/agent/tasks?${params}`);
      const data = await res.json();
      setTasks(data.tasks || []);
      setTotal(data.total || 0);
    } catch (e) {
      console.error('load tasks:', e);
    } finally {
      setLoading(false);
    }
  };

  const loadTaskDetail = async (id: string) => {
    const res = await fetch(`/api/v1/agent/tasks/${id}`);
    const data = await res.json();
    setSelected(data);
    setEvents(data.events || []);
    setDetailTab('events'); // reset tab on task change
  };

  useEffect(() => { loadTasks(); }, [filter]);
  useEffect(() => {
    const t = setInterval(loadTasks, 8000);
    return () => clearInterval(t);
  }, [filter]);

  const fmtTime = (ts: any) => ts ? new Date(Number(ts)).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '-';
  const fmtDur  = (ms: number) => ms ? (ms < 1000 ? `${ms}ms` : `${(ms/1000).toFixed(1)}s`) : '-';

  return (
    <div style={{ display: 'flex', gap: 12, flex: 1, minHeight: 0, overflow: 'hidden', height: '100%' }}>
      {/* Left list */}
      <div className="card" style={{ width: 340, display: 'flex', flexDirection: 'column', padding: 12, overflow: 'hidden' }}>
        <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexShrink: 0 }}>
          <select className="form-control" value={filter.channel} onChange={e => setFilter(f => ({ ...f, channel: e.target.value }))} style={{ flex: 1, fontSize: '.8rem', padding: '4px 8px' }}>
            <option value="">全部渠道</option>
            <option value="wecom">企业微信</option>
            <option value="api">API</option>
          </select>
          <select className="form-control" value={filter.status} onChange={e => setFilter(f => ({ ...f, status: e.target.value }))} style={{ flex: 1, fontSize: '.8rem', padding: '4px 8px' }}>
            <option value="">全部状态</option>
            <option value="done">已完成</option>
            <option value="failed">失败</option>
            <option value="executing">执行中</option>
          </select>
          <button className="btn btn-sm btn-ghost" onClick={loadTasks} title="刷新">↻</button>
        </div>
        <div style={{ fontSize: '.75rem', color: '#64748b', marginBottom: 8, flexShrink: 0 }}>共 {total} 条记录</div>
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {loading && <div style={{ textAlign: 'center', padding: 20, color: '#64748b' }}>加载中...</div>}
          {!loading && tasks.length === 0 && <div style={{ textAlign: 'center', padding: 20, color: '#64748b' }}>暂无数据<br/><span style={{ fontSize: '.75rem' }}>渠道消息到来后会自动记录</span></div>}
          {tasks.map(t => {
            const sc = CHANNEL_STATUS[t.status] || { label: t.status, dot: '#94a3b8' };
            const isActive = selected?.id === t.id;
            return (
              <div key={t.id} onClick={() => loadTaskDetail(t.id)} style={{
                padding: '10px 12px', marginBottom: 6, borderRadius: 8, cursor: 'pointer',
                background: isActive ? '#eff6ff' : '#f8fafc',
                border: `1px solid ${isActive ? '#3b82f6' : '#e2e8f0'}`,
                transition: 'all .15s',
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                  <span style={{ fontSize: '.8rem', fontWeight: 600, color: '#1e293b' }}>{t.user_id || '-'}</span>
                  <span style={{ fontSize: '.7rem', display: 'flex', alignItems: 'center', gap: 4 }}>
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: sc.dot, display: 'inline-block' }} />
                    {sc.label}
                  </span>
                </div>
                <div style={{ fontSize: '.75rem', color: '#475569', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginBottom: 3 }}>
                  {t.input_content?.slice(0, 50) || '-'}
                </div>
                <div style={{ fontSize: '.7rem', color: '#94a3b8', display: 'flex', gap: 8 }}>
                  <span>{t.source_channel || '-'}</span>
                  <span>{t.route_type || '-'}</span>
                  <span>{fmtTime(t.started_at)}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>


      {/* Right detail */}
      <div className="card" style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: 16, overflow: 'hidden' }}>
        {!selected && <div style={{ margin: 'auto', textAlign: 'center', color: '#94a3b8' }}><div style={{ fontSize: 48, marginBottom: 12 }}>📋</div>点击左侧任务查看事件流</div>}
        {selected && <>
          {/* Task header — rich info bar */}
          <div style={{ borderBottom: '1px solid #e2e8f0', paddingBottom: 14, marginBottom: 14, flexShrink: 0 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5, flexWrap: 'wrap' }}>
                  <span style={{ fontWeight: 700, fontSize: '1rem', color: '#1e293b' }}>{selected.user_id}</span>
                  <span style={{ fontSize: '.75rem', padding: '1px 7px', borderRadius: 4, background: '#dbeafe', color: '#1d4ed8', fontWeight: 600 }}>{selected.source_channel}</span>
                  {selected.status === 'done' && <span style={{ fontSize: '.75rem', padding: '1px 7px', borderRadius: 4, background: '#dcfce7', color: '#15803d', fontWeight: 600 }}>✓ 已完成</span>}
                  {selected.status === 'failed' && <span style={{ fontSize: '.75rem', padding: '1px 7px', borderRadius: 4, background: '#fee2e2', color: '#dc2626', fontWeight: 600 }}>✗ 失败</span>}
                  {(selected.status === 'executing' || selected.status === 'routing') && <span style={{ fontSize: '.75rem', padding: '1px 7px', borderRadius: 4, background: '#fef3c7', color: '#d97706', fontWeight: 600 }}>⟳ {selected.status === 'routing' ? '路由中' : '执行中'}</span>}
                  {selected.duration_ms && <span style={{ fontSize: '.72rem', color: '#64748b' }}>⏱ {fmtDur(selected.duration_ms)}</span>}
                </div>
                <div style={{ fontSize: '.88rem', color: '#374151', fontWeight: 500, marginBottom: 5 }}>{selected.input_content}</div>
                <div style={{ display: 'flex', gap: 12, fontSize: '.72rem', color: '#64748b', flexWrap: 'wrap' }}>
                  <span>ID: <code style={{ fontSize: '.7rem' }}>{selected.id}</code></span>
                  {selected.route_type && <span>路由: <strong style={{ color: '#374151' }}>{selected.route_type}</strong></span>}
                  {selected.skill_id && <span>Skill: <code style={{ fontSize: '.7rem' }}>{selected.skill_id.slice(0,8)}</code></span>}
                </div>
              </div>
            </div>
            {/* Failure error banner */}
            {selected.status === 'failed' && selected.error_message && (
              <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '10px 14px', marginTop: 8 }}>
                <div style={{ fontSize: '.78rem', fontWeight: 700, color: '#dc2626', marginBottom: 4 }}>❌ 失败原因</div>
                <div style={{ fontSize: '.8rem', color: '#7f1d1d', fontFamily: 'monospace', whiteSpace: 'pre-wrap' }}>{selected.error_message}</div>
              </div>
            )}
          </div>


          {/* ── Detail Tab Bar ─────────────────────────────────────────────── */}
          <div style={{ display: 'flex', gap: 0, borderBottom: '2px solid #e2e8f0', marginBottom: 0, flexShrink: 0 }}>
            {[
              { key: 'events', label: '📋 事件流', count: events.length },
              { key: 'transcript', label: '🎬 执行详情', count: selected.job_transcript ? selected.job_transcript.length : 0 },
              { key: 'context', label: '📜 上下文', count: 0 },
            ].map(({ key, label, count }) => (
              <button key={key} onClick={() => setDetailTab(key as any)} style={{
                background: 'none', border: 'none', cursor: 'pointer',
                padding: '8px 14px', fontSize: '.78rem', fontWeight: detailTab === key ? 700 : 500,
                color: detailTab === key ? '#2563eb' : '#64748b',
                borderBottom: `2px solid ${detailTab === key ? '#2563eb' : 'transparent'}`,
                marginBottom: -2, transition: 'all .15s',
              }}>
                {label}{count > 0 && <span style={{ marginLeft: 4, background: '#e2e8f0', color: '#475569', borderRadius: 8, padding: '0 5px', fontSize: '.68rem' }}>{count}</span>}
              </button>
            ))}
          </div>

          {/* ── Tab Content ────────────────────────────────────────────── */}

          {/* Events Tab */}
          {detailTab === 'events' && <div style={{ flex: 1, overflowY: 'auto', minHeight: 0, paddingTop: 12 }}>
            <div style={{ fontSize: '.75rem', fontWeight: 700, color: '#64748b', marginBottom: 12, textTransform: 'uppercase', letterSpacing: '.06em' }}>事件流 ({events.length})</div>
            {events.length === 0 && <div style={{ color: '#94a3b8', fontSize: '.82rem' }}>暂无事件记录</div>}
            {events.map((ev: any, i: number) => {
              const prevTs = i > 0 ? Number(events[i - 1].ts) : Number(ev.ts);
              const stepMs = Number(ev.ts) - prevTs;
              const p: any = ev.payload || {};
              const evType: string = ev.event_type;
              type CardCfg = { bg: string; border: string; label: string; icon: string; lc: string };
              const cfgMap: Record<string, CardCfg> = {
                message_received: { bg: '#eff6ff', border: '#bfdbfe', label: '收到消息', icon: '📩', lc: '#1d4ed8' },
                wiki_fetched:     { bg: '#f0fdf4', border: '#bbf7d0', label: 'Wiki 上下文', icon: '📚', lc: '#15803d' },
                route_decided:    { bg: '#faf5ff', border: '#e9d5ff', label: '路由决策', icon: '🔀', lc: '#7c3aed' },
                skill_selected:   { bg: '#fff7ed', border: '#fed7aa', label: 'Skill 选择', icon: '🎯', lc: '#c2410c' },
                skill_input:      { bg: '#f8fafc', border: '#cbd5e1', label: '发给 Skill 的上下文', icon: '📤', lc: '#374151' },
                skill_started:    { bg: '#fefce8', border: '#fef08a', label: 'Skill 启动', icon: '🚀', lc: '#854d0e' },
                reassurance_sent: { bg: '#ecfdf5', border: '#a7f3d0', label: '安抚消息', icon: '💬', lc: '#065f46' },
                skill_done:       { bg: '#f0fdf4', border: '#86efac', label: 'Skill 完成', icon: '✅', lc: '#15803d' },
                reply_sent:       { bg: '#eff6ff', border: '#93c5fd', label: '回复发送', icon: '✉️', lc: '#1e40af' },
                task_failed:      { bg: '#fef2f2', border: '#fca5a5', label: '任务失败', icon: '❌', lc: '#dc2626' },
              };
              const cfg: CardCfg = cfgMap[evType] || { bg: '#f8fafc', border: '#e2e8f0', label: evType, icon: '•', lc: '#374151' };
              return (
                <div key={ev.id || i} style={{ display: 'flex', gap: 10, marginBottom: 10 }}>
                  <div style={{ flexShrink: 0, width: 30, height: 30, borderRadius: '50%', background: cfg.bg, border: `2px solid ${cfg.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '.9rem', marginTop: 2 }}>
                    {cfg.icon}
                  </div>
                  <div style={{ flex: 1, background: cfg.bg, border: `1px solid ${cfg.border}`, borderRadius: 10, padding: '10px 13px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontSize: '.75rem', fontWeight: 700, color: cfg.lc, textTransform: 'uppercase', letterSpacing: '.04em' }}>{cfg.label}</span>
                        {i > 0 && stepMs > 0 && <span style={{ fontSize: '.68rem', padding: '1px 5px', borderRadius: 4, background: 'rgba(0,0,0,.06)', color: '#64748b' }}>+{stepMs < 1000 ? `${stepMs}ms` : `${(stepMs/1000).toFixed(1)}s`}</span>}
                      </div>
                      <span style={{ fontSize: '.7rem', color: '#94a3b8', fontFamily: 'monospace' }}>{fmtTime(ev.ts)}</span>
                    </div>

                    {evType === 'message_received' && (
                      <div style={{ fontSize: '.82rem', color: '#1e3a5f' }}>
                        {p.from_name && <div style={{ marginBottom: 5 }}><strong>「{p.from_name}」</strong> → {p.source}</div>}
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          {(p.history_count > 0) && <span style={{ background: '#dbeafe', color: '#1d4ed8', padding: '1px 7px', borderRadius: 4, fontSize: '.72rem' }}>📜 历史 {p.history_count} 条</span>}
                          {p.has_notes && <span style={{ background: '#e0e7ff', color: '#4338ca', padding: '1px 7px', borderRadius: 4, fontSize: '.72rem' }}>📝 含备注</span>}
                        </div>
                      </div>
                    )}
                    {evType === 'wiki_fetched' && (
                      <div>
                        <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', marginBottom: (p.profile_preview || p.wiki_preview) ? 8 : 0 }}>
                          {p.profile_chars > 0 ? <span style={{ background: '#dcfce7', color: '#166534', padding: '1px 7px', borderRadius: 4, fontSize: '.72rem' }}>👤 用户画像 {p.profile_chars} 字</span> : <span style={{ color: '#94a3b8', fontSize: '.75rem' }}>暂无用户画像</span>}
                          {p.wiki_chars > 0 && <span style={{ background: '#d1fae5', color: '#065f46', padding: '1px 7px', borderRadius: 4, fontSize: '.72rem' }}>📖 健康档案 {p.wiki_chars} 字</span>}
                        </div>
                        {p.profile_preview && <details style={{ marginTop: 4 }}><summary style={{ fontSize: '.72rem', color: '#64748b', cursor: 'pointer' }}>展开用户画像</summary><pre style={{ fontSize: '.72rem', color: '#374151', whiteSpace: 'pre-wrap', marginTop: 4, maxHeight: 150, overflow: 'auto', background: 'rgba(255,255,255,.7)', padding: 8, borderRadius: 6 }}>{p.profile_preview}</pre></details>}
                        {p.wiki_preview && <details style={{ marginTop: 4 }}><summary style={{ fontSize: '.72rem', color: '#64748b', cursor: 'pointer' }}>展开健康档案</summary><pre style={{ fontSize: '.72rem', color: '#374151', whiteSpace: 'pre-wrap', marginTop: 4, maxHeight: 150, overflow: 'auto', background: 'rgba(255,255,255,.7)', padding: 8, borderRadius: 6 }}>{p.wiki_preview}</pre></details>}
                      </div>
                    )}
                    {evType === 'route_decided' && (
                      <div style={{ fontSize: '.82rem', color: '#5b21b6' }}>路由类型: <strong>{p.routeType}</strong></div>
                    )}
                    {evType === 'skill_selected' && (
                      <div>
                        <div style={{ fontSize: '.82rem', marginBottom: 5 }}>
                          <strong style={{ color: '#c2410c' }}>{p.skillName}</strong>
                          <code style={{ marginLeft: 7, fontSize: '.7rem', color: '#64748b' }}>{(p.skillId || '').slice(0, 8)}</code>
                        </div>
                        {p.reason && <div style={{ fontSize: '.78rem', color: '#78350f', background: 'rgba(255,255,255,.6)', padding: '6px 9px', borderRadius: 6, borderLeft: '3px solid #fb923c', lineHeight: 1.5 }}>{p.reason}</div>}
                      </div>
                    )}
                    {evType === 'skill_input' && (
                      <div>
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
                          <span style={{ fontSize: '.72rem', padding: '1px 6px', borderRadius: 4, background: p.has_wiki ? '#d1fae5' : '#f1f5f9', color: p.has_wiki ? '#065f46' : '#94a3b8' }}>📖 {p.has_wiki ? `健康档案 ${p.wiki_chars}字` : '无健康档案'}</span>
                          <span style={{ fontSize: '.72rem', padding: '1px 6px', borderRadius: 4, background: p.has_profile ? '#dcfce7' : '#f1f5f9', color: p.has_profile ? '#166534' : '#94a3b8' }}>👤 {p.has_profile ? `用户画像 ${p.profile_chars}字` : '无用户画像'}</span>
                          {p.history_count > 0 && <span style={{ fontSize: '.72rem', padding: '1px 6px', borderRadius: 4, background: '#dbeafe', color: '#1d4ed8' }}>📜 历史 {p.history_count} 条</span>}
                          <span style={{ fontSize: '.72rem', padding: '1px 6px', borderRadius: 4, background: '#f3f4f6', color: '#6b7280' }}>总长 {p.message_chars} 字</span>
                        </div>
                        {p.message_preview && <details><summary style={{ fontSize: '.72rem', color: '#64748b', cursor: 'pointer' }}>展开发给 Skill 的完整上下文</summary><pre style={{ fontSize: '.72rem', color: '#374151', whiteSpace: 'pre-wrap', marginTop: 6, maxHeight: 220, overflow: 'auto', background: '#fff', padding: 10, borderRadius: 7, border: '1px solid #e5e7eb' }}>{p.message_preview}</pre></details>}
                      </div>
                    )}
                    {evType === 'reassurance_sent' && p.reply && (
                      <div style={{ fontSize: '.83rem', color: '#065f46', background: 'rgba(255,255,255,.7)', padding: '8px 11px', borderRadius: 7, borderLeft: '3px solid #34d399', whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>{p.reply}</div>
                    )}
                    {evType === 'skill_done' && (
                      <div style={{ fontSize: '.78rem', color: '#15803d' }}>输出长度: {p.outputLen || 0} 字符</div>
                    )}
                    {evType === 'task_failed' && (
                      <div>
                        <div style={{ fontSize: '.82rem', color: '#dc2626', fontFamily: 'monospace', marginBottom: p.stack ? 6 : 0 }}>{p.error}</div>
                        {p.stack && <details><summary style={{ fontSize: '.72rem', color: '#94a3b8', cursor: 'pointer' }}>展开 Stack Trace</summary><pre style={{ fontSize: '.68rem', color: '#7f1d1d', whiteSpace: 'pre-wrap', marginTop: 4, maxHeight: 150, overflow: 'auto' }}>{p.stack}</pre></details>}
                      </div>
                    )}
                    {!['message_received','wiki_fetched','route_decided','skill_selected','skill_input','skill_started','reassurance_sent','skill_done','reply_sent','task_failed'].includes(evType) && ev.payload && (
                      <pre style={{ margin: 0, fontSize: '.72rem', color: '#475569', background: 'rgba(255,255,255,.6)', padding: '6px 8px', borderRadius: 6, whiteSpace: 'pre-wrap', maxHeight: 120, overflow: 'auto' }}>{JSON.stringify(ev.payload, null, 2)}</pre>
                    )}
                  </div>
                </div>
              );
            })}

            {/* Final reply */}
            {selected.reply_content && (
              <div style={{ marginTop: 12, padding: '12px 16px', background: 'linear-gradient(135deg, #f0fdf4 0%, #dcfce7 100%)', borderRadius: 10, border: '1px solid #86efac' }}>
                <div style={{ fontSize: '.75rem', fontWeight: 700, color: '#166534', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '.05em' }}>💬 最终回复</div>
                <div style={{ fontSize: '.85rem', color: '#14532d', whiteSpace: 'pre-wrap', lineHeight: 1.7 }}>{selected.reply_content}</div>
              </div>
            )}
          </div>}

          {/* Transcript Tab — CUA Timeline (same renderer as ticket logs) */}
          {detailTab === 'transcript' && (
            <div style={{ flex: 1, overflowY: 'auto', minHeight: 0, paddingTop: 12 }}>
              {!selected.job_transcript && (
                <div style={{ textAlign: 'center', padding: 40, color: '#94a3b8' }}>
                  <div style={{ fontSize: 32, marginBottom: 8 }}>🎬</div>
                  <div style={{ fontSize: '.85rem' }}>执行详情尚未到达</div>
                  <div style={{ fontSize: '.78rem', marginTop: 4 }}>Skill 运行中会实时推送，完成后可在此查看完整 AI 调用链</div>
                </div>
              )}
              {selected.job_transcript && selected.job_transcript.map((t: any, i: number) => {
                const timeStr = t.ts ? new Date(t.ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
                const usage = t.usage || {};
                const reqMeta = t.request_meta || {};
                const isSystem = t.role === 'system';
                const isAssistant = t.role === 'assistant';
                const isTool = t.role === 'tool';
                const isEvent = t.type === 'event' || t.type === 'header';
                const themeMap: Record<string, any> = {
                  header:    { dotBg: '#7c3aed', dotBorder: '#c4b5fd', dotChar: '⚡', label: 'START',    badgeBg: '#ede9fe', badgeColor: '#5b21b6', cardBg: '#faf5ff', cardBorder: '#e9d5ff' },
                  event:     { dotBg: '#d97706', dotBorder: '#fcd34d', dotChar: '◆', label: 'EVENT',    badgeBg: '#fef3c7', badgeColor: '#92400e', cardBg: '#fffbeb', cardBorder: '#fde68a' },
                  system:    { dotBg: '#0f172a', dotBorder: '#334155', dotChar: '⌨', label: 'PROMPT',   badgeBg: '#1e293b', badgeColor: '#94a3b8', cardBg: '#0f172a', cardBorder: '#334155' },
                  assistant: { dotBg: '#059669', dotBorder: '#6ee7b7', dotChar: '🤖', label: 'AI',      badgeBg: '#d1fae5', badgeColor: '#065f46', cardBg: '#f0fdf4', cardBorder: '#a7f3d0' },
                  tool:      { dotBg: '#ea580c', dotBorder: '#fdba74', dotChar: '🔧', label: 'TOOL',    badgeBg: '#fff7ed', badgeColor: '#c2410c', cardBg: '#fff7ed', cardBorder: '#fed7aa' },
                };
                const roleKey = isEvent ? (t.type || 'event') : (t.role || 'event');
                const theme = themeMap[roleKey] || themeMap['event'];
                return (
                  <div key={i} style={{ position: 'relative', paddingLeft: 36, marginBottom: 10 }}>
                    <div style={{ position: 'absolute', left: 0, top: 4, width: 24, height: 24, borderRadius: '50%', background: theme.dotBg, border: `2px solid ${theme.dotBorder}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '11px' }}>
                      {theme.dotChar}
                    </div>
                    <div style={{ borderRadius: 10, border: `1px solid ${theme.cardBorder}`, background: theme.cardBg, padding: '9px 13px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                          <span style={{ display: 'inline-block', padding: '2px 7px', borderRadius: 5, fontSize: '10px', fontWeight: 700, textTransform: 'uppercase' as const, background: theme.badgeBg, color: theme.badgeColor }}>
                            {isEvent ? (t.event || t.type || theme.label) : isSystem ? 'SYSTEM PROMPT' : isAssistant ? `AI · TURN ${t.turn ?? i}` : isTool ? `TOOL · ${t.tool || 'MCP'}` : theme.label}
                          </span>
                          {t.label && <span style={{ fontSize: '.7rem', color: '#64748b' }}>[{t.label}]</span>}
                        </div>
                        <span style={{ fontSize: '.7rem', color: '#94a3b8', fontFamily: 'monospace' }}>{timeStr}</span>
                      </div>
                      {(isSystem || isAssistant || isTool) && (
                        <div style={{ margin: '5px 0 7px', padding: '5px 9px', background: '#0f172a', borderRadius: 7, fontFamily: 'monospace', fontSize: '11px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap' as const, gap: 6 }}>
                          <div><span style={{ color: '#38bdf8', fontWeight: 'bold' }}>{reqMeta.method || (isTool ? 'EXEC' : 'POST')}</span> <span style={{ color: '#f1f5f9' }}>{reqMeta.endpoint || (isTool ? `tool://${t.tool || 'mcp'}` : '/chat/completions')}</span></div>
                          <div style={{ display: 'flex', gap: 10, fontSize: '10px', flexWrap: 'wrap' as const }}>
                            {t.model && <span style={{ color: '#c084fc' }}>model: {t.model}</span>}
                            {usage.prompt_tokens != null && <span style={{ color: '#34d399' }}>in: {usage.prompt_tokens} / out: {usage.completion_tokens ?? 0}</span>}
                            {t.finish_reason && <span style={{ color: '#f59e0b' }}>finish: {t.finish_reason}</span>}
                          </div>
                        </div>
                      )}
                      {isEvent && <div style={{ fontSize: '.82rem', color: '#92400e' }}>{t.detail || t.message || t.event || JSON.stringify(t)}</div>}
                      {isSystem && t.content && (
                        <details open={false}>
                          <summary style={{ fontSize: '.72rem', color: '#94a3b8', cursor: 'pointer' }}>▶ 展开 System Prompt ({(t.content || '').length} 字符)</summary>
                          <pre style={{ fontSize: '11px', color: '#e2e8f0', background: '#0f172a', padding: '8px 10px', borderRadius: 6, whiteSpace: 'pre-wrap', marginTop: 6, maxHeight: 400, overflow: 'auto' }}>{t.content}</pre>
                        </details>
                      )}
                      {isAssistant && t.content && (
                        <details open={false}>
                          <summary style={{ fontSize: '.72rem', color: '#64748b', cursor: 'pointer' }}>▶ AI 输出 ({(t.content || '').length} 字符)</summary>
                          <pre style={{ fontSize: '11px', color: '#1e293b', whiteSpace: 'pre-wrap', marginTop: 6, maxHeight: 300, overflow: 'auto' }}>{t.content}</pre>
                        </details>
                      )}
                      {isTool && t.content && (
                        <details open={false}>
                          <summary style={{ fontSize: '.72rem', color: '#64748b', cursor: 'pointer' }}>▶ Tool 输出</summary>
                          <pre style={{ fontSize: '11px', color: '#78350f', whiteSpace: 'pre-wrap', marginTop: 6, maxHeight: 200, overflow: 'auto' }}>{typeof t.content === 'string' ? t.content : JSON.stringify(t.content, null, 2)}</pre>
                        </details>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Context Tab — full history, notes, system prompt */}
          {detailTab === 'context' && (
            <div style={{ flex: 1, overflowY: 'auto', minHeight: 0, paddingTop: 12 }}>
              {!selected.context_snapshot && <div style={{ color: '#94a3b8', fontSize: '.82rem' }}>暂无上下文快照</div>}
              {selected.context_snapshot && (() => {
                const ctx = selected.context_snapshot;
                return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    {/* Basic info */}
                    <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, padding: '10px 14px' }}>
                      <div style={{ fontSize: '.75rem', fontWeight: 700, color: '#374151', marginBottom: 6 }}>📋 基本信息</div>
                      <div style={{ fontSize: '.78rem', color: '#475569', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
                        <span>用户: <strong>{ctx.from_name || '-'}</strong></span>
                        <span>会话: <code style={{ fontSize: '.72rem' }}>{(ctx.session_id || '').slice(0, 12)}</code></span>
                        <span>历史条数: <strong style={{ color: '#2563eb' }}>{ctx.history_count ?? 0} 条</strong></span>
                        <span>是否含备注: <strong>{ctx.notes ? '是' : '否'}</strong></span>
                      </div>
                    </div>
                    {/* Notes */}
                    {ctx.notes && (
                      <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, padding: '10px 14px' }}>
                        <div style={{ fontSize: '.75rem', fontWeight: 700, color: '#92400e', marginBottom: 6 }}>📝 客户备注</div>
                        <pre style={{ fontSize: '.78rem', color: '#78350f', whiteSpace: 'pre-wrap', margin: 0 }}>{ctx.notes}</pre>
                      </div>
                    )}
                    {/* Full history */}
                    {ctx.history && ctx.history.length > 0 && (
                      <div style={{ background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: 8, padding: '10px 14px' }}>
                        <div style={{ fontSize: '.75rem', fontWeight: 700, color: '#0369a1', marginBottom: 10 }}>📜 对话历史 ({ctx.history.length} 条)</div>
                        {ctx.history.map((h: any, idx: number) => (
                          <div key={idx} style={{ marginBottom: 8, display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                            <span style={{ flexShrink: 0, fontSize: '.7rem', padding: '2px 6px', borderRadius: 4, background: h.role === 'user' ? '#dbeafe' : '#d1fae5', color: h.role === 'user' ? '#1d4ed8' : '#065f46', fontWeight: 600, marginTop: 1 }}>{h.role === 'user' ? '用户' : 'AI'}</span>
                            <div style={{ fontSize: '.78rem', color: '#374151', lineHeight: 1.5 }}>{(h.content || '').slice(0, 300)}{(h.content || '').length > 300 ? '…' : ''}</div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>
          )}
        </>}
      </div>

    </div>
  );
}

// ─── Component State ─────────────────────────────────────────────────────────
export default function AgentLogs() {
  const [mainTab, setMainTab] = useState<'tickets' | 'channel'>('tickets');
  const [tickets, setTickets] = useState<any[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailData, setDetailData] = useState<any>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [activeTab, setActiveTab] = useState<'transcript' | 'output' | 'json'>('transcript');

  const [filterStatus, setFilterStatus] = useState('');
  const [q, setQ] = useState('');
  const [reprocessing, setReprocessing] = useState(false);
  const [overrideModel, setOverrideModel] = useState('');
  const [expandAll, setExpandAll] = useState(false);

  // ─── Refs ────────────────────────────────────────────────────────────────────
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const detailPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const prevTranscriptLen = useRef<number>(0);

  // ─── 数据加载 ─────────────────────────────────────────────────────────────────
  const loadList = useCallback(async (autoSelect = false) => {
    try {
      const res = await api.tickets.list({ status: filterStatus || undefined, q: q || undefined });
      const list = res.tickets || [];
      setTickets(list);
      setLoadingList(false);

      if (autoSelect && list.length > 0 && !selectedId) {
        setSelectedId(list[0].id);
      }

      const hasActive = list.some((t: any) => ['submitted', 'processing'].includes(t.status));
      if (hasActive && !pollRef.current) {
        pollRef.current = setInterval(() => loadList(false), 4000);
      } else if (!hasActive && pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    } catch {
      setLoadingList(false);
    }
  }, [filterStatus, q, selectedId]);

  const loadDetail = async (id: string) => {
    prevTranscriptLen.current = 0;
    setLoadingDetail(true);
    try {
      const res = await api.tickets.get(id);
      setDetailData(res);
    } catch {
      setDetailData(null);
    } finally {
      setLoadingDetail(false);
    }
  };

  const refreshDetailSilent = async (id: string) => {
    try {
      const res = await api.tickets.get(id);
      setDetailData(res);
    } catch {}
  };

  useEffect(() => {
    loadList(true);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [filterStatus]);

  useEffect(() => {
    if (selectedId) {
      loadDetail(selectedId);
    } else {
      setDetailData(null);
    }
  }, [selectedId]);

  // 详情实时轮询 (1.2s) — 处理中时自动刷新
  useEffect(() => {
    const status = detailData?.ticket?.status;
    const isActive = status === 'processing' || status === 'submitted';
    if (selectedId && isActive) {
      if (!detailPollRef.current) {
        detailPollRef.current = setInterval(() => refreshDetailSilent(selectedId), 1200);
      }
    } else {
      if (detailPollRef.current) {
        clearInterval(detailPollRef.current);
        detailPollRef.current = null;
      }
    }
    return () => {
      if (detailPollRef.current) {
        clearInterval(detailPollRef.current);
        detailPollRef.current = null;
      }
    };
  }, [selectedId, detailData?.ticket?.status]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    loadList(true);
  };

  const handleReprocess = async () => {
    if (!selectedId) return;
    setReprocessing(true);
    try {
      await api.results.process(selectedId, overrideModel || undefined);
      await loadList(false);
      await loadDetail(selectedId);
    } catch (err: any) {
      alert(`处理失败: ${err.message}`);
    } finally {
      setReprocessing(false);
    }
  };

  // ─── 计算 Transcript 统计 ─────────────────────────────────────────────────────
  const rawAiLog = detailData?.result?.ai_log || '';
  let transcript: any[] = [];
  try {
    if (rawAiLog) transcript = JSON.parse(rawAiLog);
  } catch {
    transcript = [];
  }

  // 统计各类事件数
  const statsThinking = transcript.filter((t: any) => t.role === 'assistant').length;
  const statsTool = transcript.filter((t: any) => t.role === 'tool').length;
  const statsTokens = transcript.reduce((acc: number, t: any) => acc + (t.usage?.total_tokens || 0), 0);

  const headerObj = transcript.find((t: any) => t.type === 'header');
  const detectedModel = headerObj?.model || detailData?.ticket?.override_model || '系统默认';

  // 新增条目数 (用于实时指示器)
  const newCount = Math.max(0, transcript.length - prevTranscriptLen.current);
  if (transcript.length > 0 && transcript.length !== prevTranscriptLen.current) {
    prevTranscriptLen.current = transcript.length;
  }

  const downloadLog = () => {
    if (!rawAiLog) return;
    const blob = new Blob([rawAiLog], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `agent-transcript-${selectedId || 'unknown'}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 48px)' }}>
      <div className="page-header" style={{ flexShrink: 0 }}>
        <div>
          <h1>📜 Agent 全链条控制台</h1>
          <p>工单日志 · 渠道消息追踪 · HTTP Payload · Token 消耗 · 全链路事件流</p>
        </div>
        {/* 主标签页切换 */}
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button
            className={`btn btn-sm ${mainTab === 'tickets' ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => setMainTab('tickets')}
          >📋 工单日志</button>
          <button
            className={`btn btn-sm ${mainTab === 'channel' ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => setMainTab('channel')}
          >📡 渠道消息</button>
        </div>
      </div>

      {/* ── 渠道消息面板 ─────────────────────────────────────── */}
      {mainTab === 'channel' && (
        <div style={{ flex: 1, overflow: 'hidden', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <AgentTasksPanel />
        </div>
      )}

      {/* ── 工单日志面板（原有内容）─────────────────────────── */}
      {mainTab === 'tickets' && <div style={{ flex: 1, display: 'grid', gridTemplateColumns: '340px 1fr', gridTemplateRows: '1fr', alignItems: 'stretch', gap: 16, overflow: 'hidden', minHeight: 0 }}>

        {/* ── 左侧：工单列表 ────────────────────────────────────────────── */}
        <div className="card" style={{ display: 'flex', flexDirection: 'column', padding: 12, overflow: 'hidden', minHeight: 0 }}>
          {/* 搜索 */}
          <form onSubmit={handleSearch} style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
            <input
              className="form-input"
              style={{ fontSize: '.8rem', padding: '5px 8px' }}
              placeholder="搜索工单标题/编号..."
              value={q}
              onChange={e => setQ(e.target.value)}
            />
            <button className="btn btn-secondary btn-sm" type="submit">搜索</button>
          </form>

          {/* 状态过滤 */}
          <select
            className="form-input"
            style={{ fontSize: '.8rem', padding: '4px 8px', marginBottom: 10 }}
            value={filterStatus}
            onChange={e => setFilterStatus(e.target.value)}
          >
            <option value="">全部状态</option>
            <option value="done">✅ 已完成</option>
            <option value="processing">⏳ AI 处理中</option>
            <option value="submitted">📤 已提交</option>
            <option value="error">❌ 出错</option>
          </select>

          {/* 列表 */}
          <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
            {loadingList ? (
              <div style={{ textAlign: 'center', padding: 24, color: '#94a3b8', fontSize: '.82rem' }}>加载工单列表…</div>
            ) : tickets.length === 0 ? (
              <div style={{ textAlign: 'center', padding: 24, color: '#94a3b8', fontSize: '.82rem' }}>无符合条件的工单</div>
            ) : tickets.map(t => {
              const isSelected = t.id === selectedId;
              const sc = STATUS_CONFIG[t.status] || { label: t.status, cls: 'badge-disabled', dot: '#94a3b8' };
              return (
                <div
                  key={t.id}
                  onClick={() => setSelectedId(t.id)}
                  style={{
                    padding: '10px 12px',
                    borderRadius: 10,
                    cursor: 'pointer',
                    border: isSelected ? '2px solid #4f46e5' : '1px solid #e2e8f0',
                    background: isSelected ? '#f5f3ff' : '#fff',
                    boxShadow: isSelected ? '0 2px 10px rgba(79,70,229,0.14)' : 'none',
                    transition: 'all 0.14s ease',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      {/* 状态圆点 */}
                      <span style={{
                        width: 8, height: 8, borderRadius: '50%',
                        background: sc.dot, display: 'inline-block', flexShrink: 0,
                      }} />
                      <span className={`badge ${sc.cls}`} style={{ fontSize: '.66rem' }}>{sc.label}</span>
                    </div>
                    <span style={{ fontSize: '.7rem', color: '#94a3b8', fontFamily: 'monospace' }}>
                      {formatDate(t.created_at)}
                    </span>
                  </div>
                  <div style={{ fontWeight: 600, fontSize: '.83rem', color: '#0f172a', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {t.title}
                  </div>
                  <div style={{ fontSize: '.73rem', color: '#64748b', marginTop: 3, display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: '#4f46e5' }}>{t.skill_name || t.skill_id}</span>
                    {t.patient_name && <span>{t.patient_name}</span>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* ── 右侧：日志详情面板 ───────────────────────────────────────────── */}
        <div className="card" style={{ display: 'flex', flexDirection: 'column', padding: 0, overflow: 'hidden', background: '#fff', minHeight: 0 }}>
          {!selectedId ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#94a3b8', padding: 40 }}>
              <div style={{ fontSize: '3.5rem', marginBottom: 14 }}>💻</div>
              <div style={{ fontWeight: 700, fontSize: '1rem', color: '#334155', marginBottom: 6 }}>请在左侧选择工单查看 Agent 全链条日志</div>
              <div style={{ fontSize: '.8rem', color: '#94a3b8' }}>包含完整的 HTTP Payload、System Prompt、工具调用参数与响应上下文</div>
            </div>
          ) : loadingDetail ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#94a3b8', gap: 10, padding: 40 }}>
              <span style={{ fontSize: '1.4rem' }}>⏳</span>
              <span style={{ fontSize: '.88rem' }}>正在加载日志数据…</span>
            </div>
          ) : !detailData ? (
            <div style={{ textAlign: 'center', padding: 40, color: '#94a3b8' }}>未能找到该工单数据</div>
          ) : (
            <>
              {/* ── Header 信息条 ───────────────────────────── */}
              <div style={{ background: '#f8fafc', borderBottom: '1px solid #e2e8f0', padding: '12px 16px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 10 }}>
                  <div>
                    <h2 style={{ fontSize: '1rem', fontWeight: 700, margin: '0 0 6px 0', color: '#0f172a', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      {detailData.ticket?.title}
                      <span className={`badge ${STATUS_CONFIG[detailData.ticket?.status]?.cls || 'badge-disabled'}`} style={{ fontSize: '.68rem' }}>
                        {STATUS_CONFIG[detailData.ticket?.status]?.label || detailData.ticket?.status}
                      </span>
                    </h2>
                    <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: '.76rem', fontFamily: 'monospace', color: '#64748b' }}>
                      <span>Skill: <strong style={{ color: '#4f46e5' }}>{detailData.skill?.name || detailData.ticket?.skill_id}</strong></span>
                      <span>模型: <strong style={{ color: '#0284c7' }}>{detectedModel}</strong></span>
                      <span>提交: {formatDate(detailData.ticket?.created_at)}</span>
                      {detailData.ticket?.patient_name && <span>客户: <strong>{detailData.ticket.patient_name}</strong></span>}
                    </div>
                  </div>
                  {/* 模型选择 + 重跑 */}
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <select
                      className="form-input"
                      style={{ fontSize: '.76rem', padding: '4px 8px', width: 'auto' }}
                      value={overrideModel}
                      onChange={e => setOverrideModel(e.target.value)}
                      disabled={reprocessing}
                    >
                      <option value="">🤖 默认模型</option>
                      <option value="doubao-seed-1-8-251228">豆包 Seed 1.8</option>
                      <option value="deepseek-v4-flash">DeepSeek V4 Flash</option>
                      <option value="deepseek-chat">DeepSeek V3</option>
                      <option value="gemini-3.6-flash">Gemini 3.6 Flash</option>
                      <option value="gemini-2.5-flash">Gemini 2.5 Flash</option>
                    </select>
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={handleReprocess}
                      disabled={reprocessing}
                      style={{ boxShadow: '0 2px 6px rgba(79,70,229,0.22)', whiteSpace: 'nowrap' }}
                    >
                      {reprocessing ? '⏳ 启动中…' : '🚀 重新运行'}
                    </button>
                  </div>
                </div>

                {/* Stats 统计条 */}
                {transcript.length > 0 && (
                  <div style={{ display: 'flex', gap: 16, marginTop: 10, flexWrap: 'wrap' }}>
                    {[
                      { icon: '📋', label: '总事件', val: transcript.length, color: '#64748b' },
                      { icon: '🧠', label: 'AI 思考轮', val: statsThinking, color: '#7e22ce' },
                      { icon: '🔧', label: '工具调用', val: statsTool, color: '#059669' },
                      { icon: '🔢', label: '累计 Tokens', val: statsTokens > 0 ? statsTokens.toLocaleString() : '—', color: '#0284c7' },
                    ].map(s => (
                      <div key={s.label} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: '.74rem', color: s.color, fontWeight: 600 }}>
                        <span>{s.icon}</span>
                        <span>{s.label}:</span>
                        <span style={{ fontFamily: 'monospace', fontWeight: 700 }}>{s.val}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* ── User Inputs 参数展示 — 可折叠 ────────────── */}
              {detailData.inputs && detailData.inputs.length > 0 && (() => {
                const filled = detailData.inputs.filter((i: any) => i.value || i.file_path);
                const files  = detailData.inputs.filter((i: any) => i.file_path).length;
                return (
                  <details style={{ background: '#f0f9ff', borderBottom: '1px solid #bae6fd', flexShrink: 0 }}>
                    <summary style={{
                      padding: '8px 16px', fontSize: '.76rem', fontWeight: 700,
                      color: '#0369a1', cursor: 'pointer', userSelect: 'none',
                      display: 'flex', alignItems: 'center', gap: 8, listStyle: 'none',
                    }}>
                      <span>📥 客户提交参数</span>
                      <span style={{ fontWeight: 400, color: '#0284c7' }}>
                        {filled.length}/{detailData.inputs.length} 个有值
                        {files > 0 && ` · ${files} 个文件`}
                      </span>
                      <span style={{ marginLeft: 'auto', fontSize: '10px', color: '#94a3b8' }}>▶ 点击展开</span>
                    </summary>
                    <div style={{ padding: '6px 16px 10px', display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 200, overflowY: 'auto' }}>
                      {detailData.inputs.map((inp: any, idx: number) => {
                          const rawVal = inp.file_path
                            ? `📁 ${inp.file_name || inp.file_path}`
                            : (inp.value || '');
                          // Try to pretty-print JSON values (e.g. script-submitted objects)
                          let displayVal = rawVal;
                          if (!inp.file_path && inp.value) {
                            try {
                              const parsed = JSON.parse(inp.value);
                              if (typeof parsed === 'object') displayVal = JSON.stringify(parsed, null, 2);
                            } catch { /* not JSON, show as-is */ }
                          }
                          const isEmpty = !inp.value && !inp.file_path;
                          return (
                            <div key={idx} style={{ fontSize: '.75rem', background: '#fff', padding: '4px 10px', borderRadius: 6, border: '1px solid #e0f2fe', display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                              <span style={{ fontWeight: 700, color: '#0284c7', flexShrink: 0, minWidth: 60 }}>
                                {inp.field_key || `Input ${idx + 1}`}:
                              </span>
                              <span style={{ whiteSpace: 'pre-wrap', fontFamily: 'monospace', color: '#0c4a6e', wordBreak: 'break-all', opacity: isEmpty ? 0.4 : 1 }}>
                                {isEmpty ? '(empty)' : displayVal}
                              </span>
                            </div>
                          );
                        })}
                    </div>
                  </details>
                );
              })()}

              {/* ── Tabs ────────────────────────────────────── */}
              <div style={{ display: 'flex', gap: 4, padding: '8px 16px', borderBottom: '1px solid #e2e8f0', alignItems: 'center', background: '#fafafa' }}>
                {[
                  { key: 'transcript', label: `⚡ CUA Timeline (${transcript.length})` },
                  { key: 'output',     label: '📄 最终输出' },
                  { key: 'json',       label: '🔍 原始 JSON' },
                ].map(tab => (
                  <button
                    key={tab.key}
                    className={`btn btn-sm ${activeTab === tab.key ? 'btn-primary' : 'btn-ghost'}`}
                    onClick={() => setActiveTab(tab.key as any)}
                  >
                    {tab.label}
                  </button>
                ))}
                {activeTab === 'transcript' && (
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => setExpandAll(v => !v)}
                    style={{ marginLeft: 'auto', fontSize: '.73rem', color: '#64748b' }}
                  >
                    {expandAll ? '📂 全部折叠' : '📖 全部展开'}
                  </button>
                )}
                {rawAiLog && (
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={downloadLog}
                    style={{ marginLeft: activeTab === 'transcript' ? 4 : 'auto', fontSize: '.73rem', color: '#4f46e5' }}
                  >
                    📥 下载 JSON
                  </button>
                )}
              </div>

              {/* ── Tab Content ─────────────────────────────── */}
              <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px' }}>

                {/* TAB 1: CUA Timeline */}
                {activeTab === 'transcript' && (
                  <div>
                    {/* 实时处理中横幅 */}
                    {(detailData.ticket?.status === 'processing' || detailData.ticket?.status === 'submitted') && (
                      <div style={{
                        display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16,
                        background: 'linear-gradient(135deg, #1e1b4b, #312e81)', color: '#a5b4fc',
                        borderRadius: 10, padding: '10px 14px', fontSize: '.8rem',
                      }}>
                        <span style={{ fontSize: '1.1rem', animation: 'spin 1.2s linear infinite', display: 'inline-block' }}>⚡</span>
                        <span>
                          Agent 正在实时执行中 — 已捕获 <strong style={{ color: '#fff' }}>{transcript.length}</strong> 条步骤
                          {newCount > 0 && <span style={{ marginLeft: 8, color: '#34d399', fontWeight: 700 }}>+{newCount} 新</span>}
                          ，每 1.2s 自动刷新
                        </span>
                      </div>
                    )}

                    {transcript.length === 0 ? (
                      <div style={{ textAlign: 'center', padding: '48px 20px', background: '#fafafa', borderRadius: 12, border: '1px dashed #cbd5e1' }}>
                        {['created', 'submitted', 'waiting_input', 'returned'].includes(detailData.ticket?.status) ? (
                          <>
                            <div style={{ fontSize: '2rem', marginBottom: 10 }}>📋</div>
                            <div style={{ fontWeight: 700, color: '#0f172a', marginBottom: 6 }}>
                              工单处于「{STATUS_CONFIG[detailData.ticket?.status]?.label}」状态
                            </div>
                            <div style={{ fontSize: '.82rem', color: '#64748b', marginBottom: 14 }}>
                              尚未触发 AI 引擎，点击下方立即启动全链条分析
                            </div>
                            <button className="btn btn-primary btn-sm" onClick={handleReprocess} disabled={reprocessing}
                              style={{ boxShadow: '0 2px 8px rgba(79,70,229,0.25)' }}>
                              {reprocessing ? '⏳ 启动中…' : '🚀 立即启动 Agent'}
                            </button>
                          </>
                        ) : (
                          <div style={{ color: '#94a3b8', fontSize: '.85rem' }}>暂无 Transcript 日志（可能是旧版工单或未录入）</div>
                        )}
                      </div>
                    ) : (
                      /* ── CUA Timeline 竖线 + Dot 布局 ── */
                      <div style={{ position: 'relative', paddingLeft: 28, display: 'flex', flexDirection: 'column', gap: 14 }}>

                        {/* 竖向连接线 */}
                        <div style={{ position: 'absolute', left: 11, top: 14, bottom: 14, width: 2, background: '#e2e8f0', zIndex: 0 }} />

                        {transcript.map((t: any, i: number) => {
                          const theme = getEntryTheme(t);
                          const timeStr = formatTimeOnly(t.ts);
                          const reqMeta = t.request_meta || {};
                          const usage = t.usage || {};
                          const isSystem = t.role === 'system';
                          const isAssistant = t.role === 'assistant';
                          const isTool = t.role === 'tool';
                          const isEvent = t.type === 'event' || t.type === 'header';

                          return (
                            <div key={i} style={{ position: 'relative', zIndex: 1, animation: 'fadeInUp 0.22s ease-out' }}>
                              {/* Timeline Dot */}
                              <div style={{
                                position: 'absolute', left: -28, top: 8,
                                width: 24, height: 24, borderRadius: '50%',
                                background: theme.dotBg, border: `2px solid ${theme.dotBorder}`,
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                fontSize: '11px', boxShadow: '0 2px 6px rgba(0,0,0,0.08)',
                              }}>
                                {theme.dotChar}
                              </div>

                              {/* Log Card */}
                              <div style={{
                                borderRadius: 12, border: `1px solid ${theme.cardBorder}`,
                                background: theme.cardBg, padding: '11px 14px',
                                boxShadow: '0 1px 4px rgba(0,0,0,0.03)',
                              }}>
                                {/* Card Header Row */}
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                                    <span style={{
                                      display: 'inline-block', padding: '2px 8px', borderRadius: 6,
                                      fontSize: '10px', fontWeight: 700, textTransform: 'uppercase',
                                      background: theme.badgeBg, color: theme.badgeColor,
                                    }}>
                                      {isEvent
                                        ? (t.event || theme.label)
                                        : isSystem ? 'SYSTEM PROMPT'
                                        : isAssistant ? `AI THINKING · TURN ${t.turn ?? i}`
                                        : isTool ? `TOOL · ${t.tool || 'MCP'}`
                                        : theme.label}
                                    </span>
                                    {t.label && (
                                      <span style={{ fontSize: '.7rem', color: '#64748b', fontWeight: 600 }}>[{t.label}]</span>
                                    )}
                                  </div>
                                  <span style={{ fontSize: '.7rem', color: '#94a3b8', fontFamily: 'monospace', flexShrink: 0 }}>{timeStr}</span>
                                </div>

                                {/* Dark HTTP Bar (for system / assistant / tool) */}
                                {(isSystem || isAssistant || isTool) && (
                                  <div style={S.darkBar}>
                                    <div>
                                      <span style={{ color: '#38bdf8', fontWeight: 'bold' }}>
                                        {reqMeta.method || (isTool ? 'EXEC' : 'POST')}
                                      </span>
                                      {' '}
                                      <span style={{ color: '#f1f5f9' }}>
                                        {reqMeta.endpoint || (isTool ? `tool://${t.tool || 'mcp'}` : '/chat/completions')}
                                      </span>
                                    </div>
                                    <div style={{ display: 'flex', gap: 10, fontSize: '10px', flexWrap: 'wrap' }}>
                                      {t.model && <span style={{ color: '#c084fc' }}>model: {t.model}</span>}
                                      {usage.prompt_tokens != null && (
                                        <span style={{ color: '#34d399' }}>
                                          in: {usage.prompt_tokens} / out: {usage.completion_tokens ?? 0}
                                        </span>
                                      )}
                                      {t.finish_reason && <span style={{ color: '#f59e0b' }}>finish: {t.finish_reason}</span>}
                                      {reqMeta.status_code && <span style={{ color: reqMeta.status_code < 300 ? '#34d399' : '#f87171' }}>HTTP {reqMeta.status_code}</span>}
                                    </div>
                                  </div>
                                )}

                                {/* EVENT content */}
                                {isEvent && (
                                  <div style={{ fontSize: '.82rem', color: '#92400e', fontWeight: 500, lineHeight: 1.6 }}>
                                    {t.detail || t.message || t.event || JSON.stringify(t)}
                                  </div>
                                )}

                                {/* SYSTEM PROMPT — collapsible */}
                                {isSystem && t.content && (
                                  <details open={expandAll} style={{ marginTop: 4 }}>
                                    <summary style={S.detailsSummary}>
                                      ▶ 展开查看 System Prompt 完整指令 ({t.content.length.toLocaleString()} 字符)
                                    </summary>
                                    <pre style={{ ...S.pre, color: '#e2e8f0', marginTop: 8, maxHeight: 500 }}>
                                      {t.content}
                                    </pre>
                                  </details>
                                )}

                                {/* ASSISTANT thinking + tool calls */}
                                {isAssistant && (
                                  <div>
                                    {t.content && (
                                      <div style={{
                                        fontSize: '.84rem', color: '#3b0764', lineHeight: 1.7,
                                        whiteSpace: 'pre-wrap', background: 'rgba(255,255,255,0.75)',
                                        padding: '9px 12px', borderRadius: 8, border: '1px solid #f3e8ff',
                                      }}>
                                        {t.content}
                                      </div>
                                    )}
                                    {t.tool_calls && t.tool_calls.length > 0 && (
                                      <div style={{ marginTop: 8 }}>
                                        <div style={{ fontSize: '.74rem', fontWeight: 700, color: '#7e22ce', marginBottom: 5 }}>
                                          🛠️ 发起工具调用 × {t.tool_calls.length}
                                        </div>
                                        {t.tool_calls.map((tc: any, idx: number) => {
                                          const tcName = tc.name || tc.function?.name || 'tool';
                                          const rawArgs = tc.arguments ?? tc.function?.arguments;
                                          const tcArgs = typeof rawArgs === 'string'
                                            ? rawArgs
                                            : JSON.stringify(rawArgs, null, 2);
                                          return (
                                            <div key={idx} style={{ background: '#0f172a', borderRadius: 8, padding: '8px 12px', marginTop: 5 }}>
                                              <div style={{ color: '#38bdf8', fontSize: '11px', fontWeight: 'bold', fontFamily: 'monospace', marginBottom: 4 }}>
                                                🔧 {tcName}
                                                {tc.id && <span style={{ color: '#64748b', fontWeight: 400, marginLeft: 8 }}>id: {tc.id}</span>}
                                              </div>
                                              <details open={expandAll}>
                                                <summary style={{ fontSize: '10px', color: '#94a3b8', cursor: 'pointer', fontFamily: 'monospace', userSelect: 'none' }}>
                                                  ▶ 展开查看 Arguments & Payload
                                                </summary>
                                                <pre style={{ ...S.pre, background: 'transparent', color: '#34d399', marginTop: 6, padding: 0 }}>
                                                  {tcArgs}
                                                </pre>
                                              </details>
                                            </div>
                                          );
                                        })}
                                      </div>
                                    )}
                                  </div>
                                )}

                                {/* TOOL response — collapsible input/output */}
                                {isTool && (
                                  <div>
                                    <div style={{ fontSize: '.8rem', fontWeight: 600, color: '#065f46', marginBottom: 5 }}>
                                      ✅ 工具 <code style={{ fontSize: '10px', background: '#a7f3d0', color: '#065f46', padding: '1px 5px', borderRadius: 4 }}>{t.tool || 'MCP'}</code> 执行完成
                                      {t.call_id && <span style={{ marginLeft: 8, fontSize: '10px', color: '#94a3b8', fontFamily: 'monospace' }}>call_id: {t.call_id}</span>}
                                    </div>
                                    <details open={expandAll} style={{ marginTop: 4 }}>
                                      <summary style={S.detailsSummary}>
                                        ▶ 展开查看请求参数 (Request) & 响应上下文 (Response)
                                      </summary>
                                      <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
                                        {t.input && (
                                          <div>
                                            <div style={{ fontSize: '10px', color: '#64748b', fontWeight: 700, marginBottom: 3 }}>[INPUT ARGUMENTS & PAYLOAD]</div>
                                            <pre style={S.preBlue}>
                                              {typeof t.input === 'string' ? t.input : JSON.stringify(t.input, null, 2)}
                                            </pre>
                                          </div>
                                        )}
                                        {t.output && (
                                          <div>
                                            <div style={{ fontSize: '10px', color: '#64748b', fontWeight: 700, marginBottom: 3 }}>[RESPONSE RESULT CONTEXT]</div>
                                            <pre style={S.pre}>
                                              {typeof t.output === 'string' ? t.output : JSON.stringify(t.output, null, 2)}
                                            </pre>
                                          </div>
                                        )}
                                        {!t.input && !t.output && t.content && (
                                          <pre style={S.pre}>{typeof t.content === 'string' ? t.content : JSON.stringify(t.content, null, 2)}</pre>
                                        )}
                                      </div>
                                    </details>
                                  </div>
                                )}
                                {/* ── Fallback: 其他未匹配类型的 entry ── */}
                                {!isSystem && !isAssistant && !isTool && !isEvent && (
                                  <details open={expandAll} style={{ marginTop: 4 }}>
                                    <summary style={S.detailsSummary}>▶ 展开查看原始数据</summary>
                                    <pre style={{ ...S.pre, marginTop: 8 }}>
                                      {JSON.stringify(t, null, 2)}
                                    </pre>
                                  </details>
                                )}

                              </div>
                            </div>
                          );
                        })}

                      </div>
                    )}
                  </div>
                )}

                {/* TAB 2: OUTPUT */}
                {activeTab === 'output' && (
                  <div>
                    {!detailData.result ? (
                      <div style={{ textAlign: 'center', padding: 40, color: '#94a3b8' }}>尚未生成输出结果</div>
                    ) : (
                      <div
                        style={{
                          background: '#f8fafc',
                          border: '1px solid #e2e8f0',
                          borderRadius: '12px',
                          padding: '16px 20px',
                          fontSize: '.88rem',
                          lineHeight: 1.85,
                          whiteSpace: 'pre-wrap',
                          fontFamily: 'inherit',
                          color: '#0f172a',
                        }}
                      >
                        {detailData.result.revised_result || detailData.result.raw_result || '（无输出文本）'}
                      </div>
                    )}
                  </div>
                )}

                {/* TAB 3: JSON */}
                {activeTab === 'json' && (
                  <div>
                    <pre
                      style={{
                        background: '#0f172a',
                        color: '#38bdf8',
                        padding: 16,
                        borderRadius: '12px',
                        fontSize: '.78rem',
                        whiteSpace: 'pre-wrap',
                        overflowX: 'auto',
                        maxHeight: '70vh',
                        fontFamily: 'monospace',
                      }}
                    >
                      {rawAiLog ? rawAiLog : '// 暂无原始 JSON 日志'}
                    </pre>
                  </div>
                )}

              </div>
            </>
          )}
        </div>

      </div>}

    </div>
  );
}
