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
  const [polling, setPolling] = useState<ReturnType<typeof setInterval> | null>(null);

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
  };

  // Auto-refresh selected task when executing
  useEffect(() => {
    if (!selected) return;
    if (selected.status === 'executing' || selected.status === 'routing') {
      const t = setInterval(() => loadTaskDetail(selected.id), 3000);
      setPolling(t);
      return () => clearInterval(t);
    } else {
      if (polling) { clearInterval(polling); setPolling(null); }
    }
  }, [selected?.status, selected?.id]);

  useEffect(() => { loadTasks(); }, [filter]);
  useEffect(() => {
    const t = setInterval(loadTasks, 8000);
    return () => clearInterval(t);
  }, [filter]);

  const fmtTime = (ts: any) => ts ? new Date(Number(ts)).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '-';
  const fmtTimeShort = (ts: any) => ts ? new Date(Number(ts)).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
  const fmtDur = (ms: number) => ms ? (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`) : '-';

  // ── Build unified timeline: merge agent events + transcript steps sorted by ts ──
  const buildTimeline = (): any[] => {
    if (!selected) return [];
    const timeline: any[] = [];

    // Add context snapshot as first synthetic item
    if (selected.context_snapshot) {
      const ctx = selected.context_snapshot;
      timeline.push({ _kind: 'context', ts: selected.started_at, ctx });
    }

    // Agent-level events
    for (const ev of (events || [])) {
      timeline.push({ _kind: 'agent_event', ts: Number(ev.ts), ev });
    }

    // Transcript steps (from Cloud Run Job)
    if (selected.job_transcript && Array.isArray(selected.job_transcript)) {
      for (const t of selected.job_transcript) {
        const ts = t.ts ? new Date(t.ts).getTime() : 0;
        timeline.push({ _kind: 'transcript', ts, t });
      }
    }

    // CUA execution events (from Mac mini callback)
    if (selected.cua_events?.events && Array.isArray(selected.cua_events.events)) {
      const baseTs = selected.cua_events.delivered_at || Date.now();
      for (let i = 0; i < selected.cua_events.events.length; i++) {
        const ce = selected.cua_events.events[i];
        const ts = ce._ts || (baseTs - (selected.cua_events.events.length - i) * 200);
        timeline.push({ _kind: 'cua_event', ts, ce, cuaMeta: selected.cua_events });
      }
    }

    // Sort by ts
    timeline.sort((a, b) => a.ts - b.ts);
    return timeline;
  };

  const timeline = buildTimeline();

  // ── Status config ────────────────────────────────────────────────────────────
  const statusCfg: Record<string, { label: string; dot: string; bg: string; text: string }> = {
    done:      { label: '完成', dot: '#22c55e', bg: '#dcfce7', text: '#15803d' },
    failed:    { label: '失败', dot: '#ef4444', bg: '#fee2e2', text: '#dc2626' },
    executing: { label: '执行中', dot: '#f59e0b', bg: '#fef3c7', text: '#d97706' },
    routing:   { label: '路由中', dot: '#8b5cf6', bg: '#ede9fe', text: '#6d28d9' },
  };

  return (
    <div style={{ display: 'flex', gap: 0, flex: 1, minHeight: 0, overflow: 'hidden', height: '100%' }}>

      {/* ── LEFT PANEL (CUA log style) ──────────────────────────────────────── */}
      <div style={{ width: 320, display: 'flex', flexDirection: 'column', borderRight: '1px solid #e2e8f0', overflow: 'hidden', background: '#fafafa' }}>
        {/* Filter bar */}
        <div style={{ padding: '10px 12px', borderBottom: '1px solid #e2e8f0', display: 'flex', gap: 6, flexShrink: 0 }}>
          <select value={filter.channel} onChange={e => setFilter(f => ({ ...f, channel: e.target.value }))}
            style={{ flex: 1, fontSize: '.78rem', padding: '4px 7px', border: '1px solid #d1d5db', borderRadius: 6, background: '#fff' }}>
            <option value="">全部渠道</option>
            <option value="wecom">企业微信</option>
            <option value="api">API</option>
          </select>
          <select value={filter.status} onChange={e => setFilter(f => ({ ...f, status: e.target.value }))}
            style={{ flex: 1, fontSize: '.78rem', padding: '4px 7px', border: '1px solid #d1d5db', borderRadius: 6, background: '#fff' }}>
            <option value="">全部状态</option>
            <option value="done">已完成</option>
            <option value="failed">失败</option>
            <option value="executing">执行中</option>
          </select>
          <button onClick={loadTasks} style={{ border: '1px solid #d1d5db', background: '#fff', borderRadius: 6, padding: '4px 8px', cursor: 'pointer', fontSize: '.9rem' }}>↻</button>
        </div>
        <div style={{ padding: '4px 12px 6px', fontSize: '.72rem', color: '#9ca3af', flexShrink: 0 }}>共 {total} 条</div>

        {/* Task list */}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {loading && <div style={{ textAlign: 'center', padding: 24, color: '#94a3b8' }}>加载中...</div>}
          {!loading && tasks.length === 0 && <div style={{ textAlign: 'center', padding: 24, color: '#94a3b8', fontSize: '.82rem' }}>暂无数据</div>}
          {tasks.map((t: any) => {
            const sc = statusCfg[t.status] || { label: t.status, dot: '#94a3b8', bg: '#f1f5f9', text: '#475569' };
            const isActive = selected?.id === t.id;
            const initial = (t.user_id || '?')[0].toUpperCase();
            return (
              <div key={t.id} onClick={() => loadTaskDetail(t.id)} style={{
                padding: '11px 14px', borderBottom: '1px solid #f0f0f0', cursor: 'pointer',
                background: isActive ? '#eff6ff' : '#fafafa',
                borderLeft: `3px solid ${isActive ? '#3b82f6' : 'transparent'}`,
                transition: 'all .12s',
              }}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                  {/* Avatar */}
                  <div style={{
                    flexShrink: 0, width: 36, height: 36, borderRadius: '50%',
                    background: isActive ? '#3b82f6' : '#e2e8f0',
                    color: isActive ? '#fff' : '#475569',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontWeight: 700, fontSize: '.9rem',
                  }}>{initial}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 3 }}>
                      <span style={{ fontSize: '.85rem', fontWeight: 600, color: '#1e293b' }}>{t.user_id || '-'}</span>
                      <span style={{ fontSize: '.68rem', padding: '2px 6px', borderRadius: 10, background: sc.bg, color: sc.text, fontWeight: 600 }}>
                        <span style={{ display: 'inline-block', width: 5, height: 5, borderRadius: '50%', background: sc.dot, marginRight: 3, verticalAlign: 'middle' }} />
                        {sc.label}
                      </span>
                    </div>
                    <div style={{ fontSize: '.78rem', color: '#475569', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginBottom: 3 }}>
                      {t.input_content?.slice(0, 45) || '-'}
                    </div>
                    <div style={{ display: 'flex', gap: 8, fontSize: '.7rem', color: '#9ca3af' }}>
                      <span style={{ background: '#f1f5f9', color: '#64748b', padding: '0 5px', borderRadius: 3, fontSize: '.67rem' }}>{t.source_channel || '-'}</span>
                      {t.route_type && <span style={{ background: '#f1f5f9', color: '#64748b', padding: '0 5px', borderRadius: 3, fontSize: '.67rem' }}>{t.route_type}</span>}
                      <span style={{ marginLeft: 'auto' }}>{fmtTime(t.started_at)}</span>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── RIGHT PANEL: unified timeline ───────────────────────────────────── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: '#fff' }}>
        {!selected && (
          <div style={{ margin: 'auto', textAlign: 'center', color: '#94a3b8' }}>
            <div style={{ fontSize: 44, marginBottom: 12 }}>💬</div>
            <div style={{ fontSize: '.9rem' }}>选择左侧会话查看完整链路日志</div>
          </div>
        )}
        {selected && <>
          {/* ── Session header bar ──────────────────────────────────────────── */}
          <div style={{ padding: '14px 20px', borderBottom: '1px solid #e2e8f0', background: '#fafafa', flexShrink: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
              {/* Avatar */}
              <div style={{ width: 40, height: 40, borderRadius: '50%', background: '#3b82f6', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: '1rem', flexShrink: 0 }}>
                {(selected.user_id || '?')[0].toUpperCase()}
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
                  <span style={{ fontWeight: 700, fontSize: '.95rem', color: '#111827' }}>{selected.user_id}</span>
                  <span style={{ fontSize: '.72rem', padding: '1px 7px', borderRadius: 4, background: '#dbeafe', color: '#1d4ed8', fontWeight: 600 }}>{selected.source_channel}</span>
                  {(() => {
                    const sc = statusCfg[selected.status] || { label: selected.status, bg: '#f1f5f9', text: '#64748b' };
                    return <span style={{ fontSize: '.72rem', padding: '1px 7px', borderRadius: 4, background: sc.bg, color: sc.text, fontWeight: 600 }}>{sc.label}</span>;
                  })()}
                  {selected.duration_ms && <span style={{ fontSize: '.72rem', color: '#6b7280' }}>⏱ {fmtDur(selected.duration_ms)}</span>}
                </div>
                <div style={{ fontSize: '.85rem', color: '#374151' }}>{selected.input_content}</div>
              </div>
              <div style={{ textAlign: 'right', fontSize: '.7rem', color: '#9ca3af', flexShrink: 0 }}>
                <div><code>{selected.id?.slice(0, 14)}</code></div>
                {selected.route_type && <div>{selected.route_type}</div>}
              </div>
            </div>
            {/* Failure banner */}
            {selected.status === 'failed' && selected.error_message && (
              <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 7, padding: '8px 12px', marginTop: 6 }}>
                <span style={{ fontSize: '.75rem', fontWeight: 700, color: '#dc2626' }}>❌ 失败原因: </span>
                <span style={{ fontSize: '.78rem', color: '#7f1d1d', fontFamily: 'monospace' }}>{selected.error_message}</span>
              </div>
            )}
            {/* Stats row */}
            <div style={{ display: 'flex', gap: 12, marginTop: 8, fontSize: '.72rem', color: '#6b7280' }}>
              <span>📋 事件 {events.length}</span>
              {selected.job_transcript && <span>🎬 AI步骤 {(selected.job_transcript || []).length}</span>}
              {selected.context_snapshot?.history_count > 0 && <span>📜 历史 {selected.context_snapshot.history_count} 条</span>}
              {selected.cua_events?.events && <span style={{ color: selected.cua_events.success !== false ? '#15803d' : '#dc2626' }}>{selected.cua_events.success !== false ? '🤖 CUA 已送达' : '⚠️ CUA 送达异常'} ({selected.cua_events.events.length} 步)</span>}
            </div>
          </div>

          {/* ── Unified timeline scroll area ────────────────────────────────── */}
          <div style={{ flex: 1, overflowY: 'auto', minHeight: 0, padding: '16px 20px' }}>
            {timeline.length === 0 && <div style={{ color: '#94a3b8', textAlign: 'center', padding: 32 }}>暂无日志数据</div>}

            {timeline.map((item: any, idx: number) => {
              /* ── Context / History item ──────────────────────────────────── */
              if (item._kind === 'context') {
                const ctx = item.ctx;
                return (
                  <div key={`ctx-${idx}`} style={{ display: 'flex', gap: 12, marginBottom: 14 }}>
                    <div style={{ flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                      <div style={{ width: 32, height: 32, borderRadius: '50%', background: '#1e293b', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '14px' }}>📜</div>
                      <div style={{ width: 1, flex: 1, background: '#e2e8f0', marginTop: 4 }} />
                    </div>
                    <div style={{ flex: 1, paddingBottom: 14 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                        <span style={{ fontSize: '.72rem', fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.06em', color: '#374151', background: '#f1f5f9', padding: '2px 8px', borderRadius: 5 }}>消息接入</span>
                        <span style={{ fontSize: '.7rem', color: '#9ca3af', fontFamily: 'monospace' }}>{fmtTimeShort(item.ts)}</span>
                      </div>
                      {/* Dark bar */}
                      <div style={{ background: '#0f172a', borderRadius: 8, padding: '8px 12px', marginBottom: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '11px', fontFamily: 'monospace', flexWrap: 'wrap' as const, gap: 6 }}>
                        <span style={{ color: '#38bdf8', fontWeight: 'bold' }}>📥 接收消息</span>
                        <span style={{ color: '#f1f5f9' }}>/api/orch/ingest</span>
                        <div style={{ display: 'flex', gap: 10 }}>
                          {ctx.history_count > 0 && <span style={{ color: '#c084fc' }}>history: {ctx.history_count}</span>}
                          {ctx.from_name && <span style={{ color: '#34d399' }}>from: {ctx.from_name}</span>}
                          {ctx.notes && <span style={{ color: '#f59e0b' }}>notes: yes</span>}
                        </div>
                      </div>
                      {/* History preview */}
                      {ctx.history && ctx.history.length > 0 && (
                        <details>
                          <summary style={{ fontSize: '.75rem', color: '#64748b', cursor: 'pointer', padding: '4px 0' }}>
                            ▶ 展开对话历史 ({ctx.history.length} 条)
                          </summary>
                          <div style={{ marginTop: 8, background: '#f8fafc', borderRadius: 8, padding: '10px 12px', border: '1px solid #e2e8f0', maxHeight: 300, overflow: 'auto' }}>
                            {ctx.history.map((h: any, hi: number) => (
                              <div key={hi} style={{ marginBottom: 8, display: 'flex', gap: 8 }}>
                                <span style={{ flexShrink: 0, fontSize: '.68rem', padding: '2px 6px', borderRadius: 4, fontWeight: 600, background: h.role === 'user' ? '#dbeafe' : '#d1fae5', color: h.role === 'user' ? '#1d4ed8' : '#065f46' }}>
                                  {h.role === 'user' ? '用户' : 'AI'}
                                </span>
                                <div style={{ fontSize: '.78rem', color: '#374151', lineHeight: 1.5 }}>{(h.content || '').slice(0, 200)}{(h.content || '').length > 200 ? '…' : ''}</div>
                              </div>
                            ))}
                          </div>
                        </details>
                      )}
                      {ctx.notes && (
                        <div style={{ marginTop: 6, background: '#fffbeb', borderRadius: 7, padding: '7px 10px', border: '1px solid #fde68a', fontSize: '.78rem', color: '#78350f' }}>
                          📝 备注: {ctx.notes}
                        </div>
                      )}
                    </div>
                  </div>
                );
              }

              /* ── Agent event item ────────────────────────────────────────── */
              if (item._kind === 'agent_event') {
                const ev = item.ev;
                const p: any = ev.payload || {};
                const prevTs = idx > 0 ? timeline[idx - 1].ts : item.ts;
                const stepMs = item.ts - prevTs;
                const evType: string = ev.event_type;
                const evCfg: Record<string, { icon: string; label: string; dotBg: string; cardBg: string; cardBorder: string; textColor: string }> = {
                  message_received: { icon: '📩', label: '收到消息', dotBg: '#2563eb', cardBg: '#eff6ff', cardBorder: '#bfdbfe', textColor: '#1e40af' },
                  wiki_fetched:     { icon: '📚', label: 'Wiki 上下文', dotBg: '#059669', cardBg: '#f0fdf4', cardBorder: '#bbf7d0', textColor: '#065f46' },
                  route_decided:    { icon: '🔀', label: '路由决策', dotBg: '#7c3aed', cardBg: '#faf5ff', cardBorder: '#e9d5ff', textColor: '#5b21b6' },
                  skill_selected:   { icon: '🎯', label: 'Skill 选择', dotBg: '#ea580c', cardBg: '#fff7ed', cardBorder: '#fed7aa', textColor: '#c2410c' },
                  skill_input:      { icon: '📤', label: '发送上下文', dotBg: '#475569', cardBg: '#f8fafc', cardBorder: '#cbd5e1', textColor: '#334155' },
                  skill_started:    { icon: '🚀', label: 'Skill 启动', dotBg: '#ca8a04', cardBg: '#fefce8', cardBorder: '#fef08a', textColor: '#854d0e' },
                  reassurance_sent: { icon: '💬', label: '安抚消息', dotBg: '#059669', cardBg: '#ecfdf5', cardBorder: '#a7f3d0', textColor: '#065f46' },
                  skill_done:       { icon: '✅', label: 'Skill 完成', dotBg: '#16a34a', cardBg: '#f0fdf4', cardBorder: '#86efac', textColor: '#15803d' },
                  reply_sent:       { icon: '✉️', label: '发送给用户', dotBg: '#2563eb', cardBg: '#eff6ff', cardBorder: '#93c5fd', textColor: '#1e40af' },
                  task_failed:      { icon: '❌', label: '任务失败', dotBg: '#dc2626', cardBg: '#fef2f2', cardBorder: '#fca5a5', textColor: '#dc2626' },
                };
                const cfg = evCfg[evType] || { icon: '•', label: evType, dotBg: '#64748b', cardBg: '#f8fafc', cardBorder: '#e2e8f0', textColor: '#374151' };

                return (
                  <div key={`ev-${idx}`} style={{ display: 'flex', gap: 12, marginBottom: 14 }}>
                    <div style={{ flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                      <div style={{ width: 32, height: 32, borderRadius: '50%', background: cfg.dotBg, border: '2px solid rgba(255,255,255,.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '14px', boxShadow: '0 1px 4px rgba(0,0,0,.12)' }}>{cfg.icon}</div>
                      {idx < timeline.length - 1 && <div style={{ width: 1, flex: 1, background: '#e2e8f0', marginTop: 4 }} />}
                    </div>
                    <div style={{ flex: 1, paddingBottom: 14 }}>
                      {/* Header */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                        <span style={{ fontSize: '.72rem', fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.06em', color: cfg.textColor, background: cfg.cardBg, border: `1px solid ${cfg.cardBorder}`, padding: '2px 8px', borderRadius: 5 }}>{cfg.label}</span>
                        {idx > 0 && stepMs > 0 && <span style={{ fontSize: '.68rem', background: '#f1f5f9', color: '#64748b', padding: '1px 5px', borderRadius: 4 }}>+{stepMs < 1000 ? `${stepMs}ms` : `${(stepMs / 1000).toFixed(1)}s`}</span>}
                        <span style={{ fontSize: '.7rem', color: '#9ca3af', fontFamily: 'monospace', marginLeft: 'auto' }}>{fmtTimeShort(item.ts)}</span>
                      </div>
                      {/* Card body */}
                      <div style={{ background: cfg.cardBg, border: `1px solid ${cfg.cardBorder}`, borderRadius: 10, padding: '10px 14px' }}>
                        {evType === 'message_received' && (
                          <div>
                            <div style={{ fontSize: '.85rem', fontWeight: 500, color: '#1e293b', marginBottom: 6 }}>「{p.content || selected.input_content}」</div>
                            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' as const }}>
                              <span style={{ fontSize: '.7rem', padding: '1px 6px', borderRadius: 4, background: '#dbeafe', color: '#1d4ed8' }}>来源: {p.source || selected.source_channel}</span>
                              {p.history_count > 0 && <span style={{ fontSize: '.7rem', padding: '1px 6px', borderRadius: 4, background: '#e0e7ff', color: '#4338ca' }}>📜 历史 {p.history_count} 条</span>}
                              {p.has_notes && <span style={{ fontSize: '.7rem', padding: '1px 6px', borderRadius: 4, background: '#fef3c7', color: '#92400e' }}>📝 含备注</span>}
                            </div>
                          </div>
                        )}
                        {evType === 'wiki_fetched' && (
                          <div>
                            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' as const, marginBottom: (p.profile_preview || p.wiki_preview) ? 8 : 0 }}>
                              <span style={{ fontSize: '.72rem', padding: '2px 8px', borderRadius: 4, background: p.profile_chars > 0 ? '#dcfce7' : '#f1f5f9', color: p.profile_chars > 0 ? '#166534' : '#94a3b8' }}>👤 用户画像 {p.profile_chars > 0 ? `${p.profile_chars}字` : '暂无'}</span>
                              <span style={{ fontSize: '.72rem', padding: '2px 8px', borderRadius: 4, background: p.wiki_chars > 0 ? '#d1fae5' : '#f1f5f9', color: p.wiki_chars > 0 ? '#065f46' : '#94a3b8' }}>📖 健康档案 {p.wiki_chars > 0 ? `${p.wiki_chars}字` : '暂无'}</span>
                            </div>
                            {p.profile_preview && <details style={{ marginTop: 6 }}><summary style={{ fontSize: '.72rem', color: '#64748b', cursor: 'pointer' }}>展开用户画像</summary><pre style={{ fontSize: '.72rem', whiteSpace: 'pre-wrap', marginTop: 6, maxHeight: 200, overflow: 'auto', background: 'rgba(255,255,255,.7)', padding: 8, borderRadius: 6 }}>{p.profile_preview}</pre></details>}
                            {p.wiki_preview && <details style={{ marginTop: 4 }}><summary style={{ fontSize: '.72rem', color: '#64748b', cursor: 'pointer' }}>展开健康档案</summary><pre style={{ fontSize: '.72rem', whiteSpace: 'pre-wrap', marginTop: 6, maxHeight: 200, overflow: 'auto', background: 'rgba(255,255,255,.7)', padding: 8, borderRadius: 6 }}>{p.wiki_preview}</pre></details>}
                          </div>
                        )}
                        {evType === 'route_decided' && (
                          <div>
                            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' as const }}>
                              <span style={{ fontSize: '.88rem', fontWeight: 700, color: '#5b21b6' }}>{p.routeType === 'health' ? '🏥 健康咨询' : '💬 普通对话'}</span>
                              {p.durationMs && <span style={{ fontSize: '.72rem', background: '#ede9fe', color: '#6d28d9', padding: '1px 6px', borderRadius: 4 }}>⏱ {p.durationMs}ms</span>}
                              {p.model && <span style={{ fontSize: '.72rem', background: '#f1f5f9', color: '#475569', padding: '1px 6px', borderRadius: 4 }}>model: {p.model}</span>}
                            </div>
                            {/* Route AI call - dark HTTP bar */}
                            <div style={{ background: '#0f172a', borderRadius: 7, padding: '7px 11px', marginBottom: 8, fontFamily: 'monospace', fontSize: '11px', display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap' as const, gap: 6 }}>
                              <div><span style={{ color: '#38bdf8', fontWeight: 'bold' }}>POST</span> <span style={{ color: '#f1f5f9' }}>/chat/completions</span></div>
                              <span style={{ color: '#c084fc' }}>分诊路由 AI</span>
                            </div>
                            {/* AI 判定结论 */}
                            {p.rawResult && (
                              <div style={{ marginBottom: 8, background: p.routeType === 'health' ? '#faf5ff' : '#f0fdf4', border: `1px solid ${p.routeType === 'health' ? '#e9d5ff' : '#bbf7d0'}`, borderRadius: 6, padding: '6px 10px', fontSize: '.8rem', fontFamily: 'monospace', color: p.routeType === 'health' ? '#6d28d9' : '#065f46' }}>
                                AI 判定结论：{p.rawResult}
                              </div>
                            )}
                            {p.systemPrompt && <details style={{ marginBottom: 6 }}><summary style={{ fontSize: '.72rem', color: '#64748b', cursor: 'pointer' }}>▶ 展开 System Prompt ({p.systemPrompt.length} 字符)</summary><pre style={{ fontSize: '11px', color: '#374151', whiteSpace: 'pre-wrap', marginTop: 6, maxHeight: 200, overflow: 'auto', background: 'rgba(255,255,255,.7)', padding: 8, borderRadius: 6, border: '1px solid #e5e7eb' }}>{p.systemPrompt}</pre></details>}
                            {p.userMsg && <details><summary style={{ fontSize: '.72rem', color: '#64748b', cursor: 'pointer' }}>▶ 展开用户消息 (含近期历史)</summary><pre style={{ fontSize: '11px', color: '#374151', whiteSpace: 'pre-wrap', marginTop: 6, maxHeight: 200, overflow: 'auto', background: 'rgba(255,255,255,.7)', padding: 8, borderRadius: 6, border: '1px solid #e5e7eb' }}>{p.userMsg}</pre></details>}
                          </div>
                        )}
                        {evType === 'skill_selected' && (
                          <div>
                            {/* Available skills */}
                            {p.available_skills && p.available_skills.length > 0 && (
                              <div style={{ marginBottom: 8 }}>
                                <div style={{ fontSize: '.72rem', color: '#64748b', marginBottom: 5 }}>可用 Skill：</div>
                                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' as const }}>
                                  {(p.available_skills as any[]).map((s: any) => (
                                    <span key={s.id} title={s.description || ''} style={{ fontSize: '.75rem', padding: '2px 8px', borderRadius: 12, background: s.id === p.skillId ? '#fff7ed' : '#f1f5f9', color: s.id === p.skillId ? '#c2410c' : '#475569', border: `1px solid ${s.id === p.skillId ? '#fed7aa' : '#e2e8f0'}`, fontWeight: s.id === p.skillId ? 700 : 400, cursor: s.description ? 'help' : 'default' }}>
                                      {s.name}{s.id === p.skillId ? ' ✓' : ''}
                                    </span>
                                  ))}
                                </div>
                              </div>
                            )}
                            <div style={{ fontSize: '.88rem', fontWeight: 600, color: '#c2410c', marginBottom: 6 }}>
                              选中：{p.skillName} <code style={{ fontSize: '.7rem', color: '#78716c', fontWeight: 400 }}>{(p.skillId || '').slice(0, 8)}</code>
                            </div>
                            {p.reason && <div style={{ fontSize: '.8rem', color: '#78350f', background: 'rgba(255,255,255,.6)', padding: '7px 10px', borderRadius: 6, borderLeft: '3px solid #fb923c', lineHeight: 1.6 }}>理由：{p.reason}</div>}
                          </div>
                        )}
                        {evType === 'skill_input' && (
                          <div>
                            <div style={{ background: '#0f172a', borderRadius: 7, padding: '7px 11px', marginBottom: 8, display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap' as const, gap: 6, fontSize: '11px', fontFamily: 'monospace' }}>
                              <div><span style={{ color: '#38bdf8', fontWeight: 'bold' }}>POST</span> <span style={{ color: '#f1f5f9' }}>/skill/execute</span></div>
                              <div style={{ display: 'flex', gap: 10 }}>
                                <span style={{ color: '#c084fc' }}>wiki: {p.wiki_chars || 0}字</span>
                                <span style={{ color: '#34d399' }}>profile: {p.profile_chars || 0}字</span>
                                <span style={{ color: '#f59e0b' }}>history: {p.history_count || 0}</span>
                                <span style={{ color: '#94a3b8' }}>total: {p.message_chars || 0}字</span>
                              </div>
                            </div>
                            {p.message_preview && <details><summary style={{ fontSize: '.72rem', color: '#64748b', cursor: 'pointer' }}>▶ 展开发送给 Skill 的完整上下文（拼装后的 user message，含 wiki/profile/历史）{p.message_chars > (p.message_preview?.length || 0) ? ` — 仅显示前${p.message_preview.length}字，完整${p.message_chars}字` : ''}</summary><pre style={{ fontSize: '11px', color: '#1e293b', whiteSpace: 'pre-wrap', marginTop: 6, maxHeight: 500, overflow: 'auto', background: '#fff', padding: 10, borderRadius: 7, border: '1px solid #e5e7eb' }}>{p.message_preview}</pre></details>}
                          </div>
                        )}
                        {evType === 'reassurance_sent' && p.reply && (
                          <div style={{ fontSize: '.85rem', color: '#065f46', borderLeft: '3px solid #34d399', paddingLeft: 10, lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>{p.reply}</div>
                        )}
                        {evType === 'skill_started' && (
                          <div>
                            <div style={{ fontSize: '.85rem', fontWeight: 600, color: '#854d0e', marginBottom: 6 }}>🚀 {p.skillName || 'Skill'} 正在启动执行</div>
                            {p.context_summary && <div style={{ fontSize: '.78rem', color: '#78350f', background: 'rgba(255,255,255,.6)', padding: '5px 10px', borderRadius: 6, marginBottom: 6 }}>注入上下文：{p.context_summary}</div>}
                            {p.description && <div style={{ fontSize: '.75rem', color: '#92400e', lineHeight: 1.5, borderLeft: '3px solid #fbbf24', paddingLeft: 8 }}>{p.description}</div>}
                          </div>
                        )}
                        {evType === 'skill_done' && (
                          <div>
                            <div style={{ fontSize: '.82rem', color: '#15803d', marginBottom: p.output_preview ? 6 : 0 }}>输出 {p.outputLen || 0} 字符 · 执行完成</div>
                            {p.output_preview && <details><summary style={{ fontSize: '.72rem', color: '#64748b', cursor: 'pointer' }}>▶ 展开回复内容</summary><pre style={{ fontSize: '.82rem', color: '#14532d', whiteSpace: 'pre-wrap', marginTop: 6, maxHeight: 280, overflow: 'auto', background: 'rgba(255,255,255,.7)', padding: 10, borderRadius: 7, lineHeight: 1.6 }}>{p.output_preview}</pre></details>}
                          </div>
                        )}
                        {evType === 'reply_sent' && (
                          <div>
                            {/* CUA delivery dark bar */}
                            <div style={{ background: '#0f172a', borderRadius: 7, padding: '7px 11px', marginBottom: 8, fontFamily: 'monospace', fontSize: '11px', display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap' as const, gap: 6 }}>
                              <div><span style={{ color: '#38bdf8', fontWeight: 'bold' }}>SEND</span> <span style={{ color: '#f1f5f9' }}>{p.channel || '企业微信'}</span></div>
                              <div style={{ display: 'flex', gap: 10 }}>
                                {p.recipient && <span style={{ color: '#34d399' }}>→ {p.recipient}</span>}
                                {p.delivery_action && <span style={{ color: '#c084fc' }}>{p.delivery_action}</span>}
                                {p.replyLen && <span style={{ color: '#94a3b8' }}>{p.replyLen} 字符</span>}
                              </div>
                            </div>
                            {p.reply && <div style={{ fontSize: '.85rem', color: '#1e3a5f', borderLeft: '3px solid #3b82f6', paddingLeft: 10, lineHeight: 1.7, whiteSpace: 'pre-wrap', background: 'rgba(255,255,255,.7)', padding: '8px 8px 8px 12px', borderRadius: '0 7px 7px 0' }}>{p.reply}</div>}
                          </div>
                        )}
                        {evType === 'task_failed' && (
                          <div>
                            <div style={{ fontSize: '.85rem', color: '#dc2626', fontFamily: 'monospace', marginBottom: 6 }}>{p.error}</div>
                            {p.stack && <details><summary style={{ fontSize: '.72rem', color: '#9ca3af', cursor: 'pointer' }}>Stack Trace</summary><pre style={{ fontSize: '10px', color: '#7f1d1d', whiteSpace: 'pre-wrap', maxHeight: 160, overflow: 'auto', marginTop: 4 }}>{p.stack}</pre></details>}
                          </div>
                        )}
                        {evType === 'cua_delivered' && (
                          <div>
                            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
                              <span style={{ fontSize: '.88rem', fontWeight: 700, color: p.success !== false ? '#059669' : '#dc2626' }}>
                                {p.success !== false ? '✅ CUA 已成功送达' : '⚠️ CUA 送达异常'}
                              </span>
                              {p.step_count && <span style={{ fontSize: '.72rem', background: '#d1fae5', color: '#065f46', padding: '1px 6px', borderRadius: 4 }}>{p.step_count} 步</span>}
                            </div>
                            <div style={{ fontSize: '.78rem', color: '#475569' }}>
                              {p.app && <span>📱 {p.app}</span>}
                              {p.recipient && <span style={{ marginLeft: 8 }}>→ {p.recipient}</span>}
                            </div>
                            {p.events_preview && p.events_preview.length > 0 && (
                              <details style={{ marginTop: 6 }}>
                                <summary style={{ fontSize: '.72rem', color: '#64748b', cursor: 'pointer' }}>▶ 展开 CUA 执行步骤摘要</summary>
                                <div style={{ marginTop: 6, fontSize: '.75rem' }}>
                                  {(p.events_preview as any[]).map((ep: any, i: number) => (
                                    <div key={i} style={{ display: 'flex', gap: 8, padding: '3px 0', borderBottom: '1px solid #f1f5f9' }}>
                                      <span style={{ color: '#6b7280', minWidth: 60 }}>{ep.type || '-'}</span>
                                      <span style={{ color: '#374151' }}>{ep.text || '-'}</span>
                                    </div>
                                  ))}
                                </div>
                              </details>
                            )}
                          </div>
                        )}
                        {!['message_received','wiki_fetched','route_decided','skill_selected','skill_input','skill_started','reassurance_sent','skill_done','reply_sent','task_failed','cua_delivered'].includes(evType) && (
                          <pre style={{ margin: 0, fontSize: '.72rem', color: '#475569', whiteSpace: 'pre-wrap', maxHeight: 120, overflow: 'auto' }}>{JSON.stringify(ev.payload, null, 2)}</pre>
                        )}
                      </div>
                    </div>
                  </div>
                );
              }

              /* ── Transcript step (CUA Timeline style) ───────────────────── */
              if (item._kind === 'transcript') {
                const t = item.t;
                const usage = t.usage || {};
                const reqMeta = t.request_meta || {};
                const isSystem = t.role === 'system';
                const isAssistant = t.role === 'assistant';
                const isTool = t.role === 'tool';
                const isEvent = t.type === 'event' || t.type === 'header';
                const themeMap: Record<string, any> = {
                  header:    { dot: '#7c3aed', icon: '⚡', badge: '沙箱启动',    badgeBg: '#ede9fe', badgeFg: '#5b21b6', cardBg: '#faf5ff', border: '#e9d5ff' },
                  event:     { dot: '#d97706', icon: '◆', badge: '执行事件',    badgeBg: '#fef3c7', badgeFg: '#92400e', cardBg: '#fffbeb', border: '#fde68a' },
                  system:    { dot: '#1e293b', icon: '⌨', badge: '系统提示词', badgeBg: '#1e293b', badgeFg: '#94a3b8', cardBg: '#0f172a', border: '#334155' },
                  assistant: { dot: '#059669', icon: '🤖', badge: 'AI 推理', badgeBg: '#d1fae5', badgeFg: '#065f46', cardBg: '#f0fdf4', border: '#a7f3d0' },
                  tool:      { dot: '#ea580c', icon: '🔧', badge: '工具调用',    badgeBg: '#fff7ed', badgeFg: '#c2410c', cardBg: '#fff7ed', border: '#fed7aa' },
                };
                const roleKey = isEvent ? (t.type || 'event') : (t.role || 'event');
                const th = themeMap[roleKey] || themeMap['event'];
                const turnLabel = isAssistant ? `AI 推理 · 第${t.turn ?? (idx + 1)}轮` : th.badge;
                const cardLabel = isEvent ? (t.event === 'start' ? '沙箱开始执行' : t.event === 'skill_loaded' ? 'Skill 内容加载' : t.event || th.badge) : isSystem ? '系统提示词 [executor]' : isTool ? `工具 · ${t.tool || 'MCP'}` : turnLabel;

                return (
                  <div key={`tr-${idx}`} style={{ display: 'flex', gap: 12, marginBottom: 14 }}>
                    <div style={{ flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                      <div style={{ width: 32, height: 32, borderRadius: '50%', background: th.dot, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '13px', boxShadow: '0 1px 4px rgba(0,0,0,.12)' }}>{th.icon}</div>
                      {idx < timeline.length - 1 && <div style={{ width: 1, flex: 1, background: '#e2e8f0', marginTop: 4 }} />}
                    </div>
                    <div style={{ flex: 1, paddingBottom: 14 }}>
                      {/* Header */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                        <span style={{ fontSize: '.72rem', fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.06em', background: th.badgeBg, color: th.badgeFg, padding: '2px 8px', borderRadius: 5 }}>{cardLabel}</span>
                        {t.label && <span style={{ fontSize: '.7rem', color: '#64748b' }}>[{t.label}]</span>}
                        <span style={{ fontSize: '.7rem', color: '#9ca3af', fontFamily: 'monospace', marginLeft: 'auto' }}>{fmtTimeShort(item.ts)}</span>
                      </div>
                      {/* Card */}
                      <div style={{ borderRadius: 10, border: `1px solid ${th.border}`, background: th.cardBg, padding: '10px 14px' }}>
                        {/* Dark HTTP bar for AI / system / tool */}
                        {(isSystem || isAssistant || isTool) && (
                          <div style={{ background: '#0f172a', borderRadius: 7, padding: '7px 11px', marginBottom: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '11px', fontFamily: 'monospace', flexWrap: 'wrap' as const, gap: 6 }}>
                            <div>
                              <span style={{ color: '#38bdf8', fontWeight: 'bold' }}>{reqMeta.method || (isTool ? 'EXEC' : 'POST')}</span>
                              {' '}
                              <span style={{ color: '#f1f5f9' }}>{reqMeta.endpoint || (isTool ? `tool://${t.tool || 'mcp'}` : '/chat/completions')}</span>
                            </div>
                            <div style={{ display: 'flex', gap: 10 }}>
                              {t.model && <span style={{ color: '#c084fc' }}>model: {t.model}</span>}
                              {usage.prompt_tokens != null && <span style={{ color: '#34d399' }}>in: {usage.prompt_tokens} / out: {usage.completion_tokens ?? 0}</span>}
                              {t.finish_reason && <span style={{ color: '#f59e0b' }}>finish: {t.finish_reason}</span>}
                              {reqMeta.status_code && <span style={{ color: reqMeta.status_code < 300 ? '#34d399' : '#f87171' }}>HTTP {reqMeta.status_code}</span>}
                            </div>
                          </div>
                        )}
                        {/* Event content — show full with expand button if truncated */}
                        {isEvent && (() => {
                          const raw = t.detail || t.message || t.event || JSON.stringify(t);
                          const truncMatch = typeof raw === 'string' && raw.match(/\[(\d+)\s*chars?\s*total\]/);
                          const fullText = t.full_content || (typeof raw === 'string' ? raw : '');
                          return (
                            <div style={{ fontSize: '.82rem', color: '#92400e' }}>
                              <div style={{ whiteSpace: 'pre-wrap' }}>{raw}</div>
                              {truncMatch && (
                                <details style={{ marginTop: 6 }}>
                                  <summary style={{ fontSize: '.72rem', color: '#b45309', cursor: 'pointer', background: '#fef3c7', display: 'inline-block', padding: '2px 8px', borderRadius: 4 }}>📖 查看完整内容（{truncMatch[1]} 字符）</summary>
                                  <pre style={{ fontSize: '11px', color: '#78350f', whiteSpace: 'pre-wrap', marginTop: 6, maxHeight: 600, overflow: 'auto', background: '#fffbeb', padding: 10, borderRadius: 7, border: '1px solid #fde68a' }}>{fullText}</pre>
                                </details>
                              )}
                            </div>
                          );
                        })()}
                        {/* System prompt — also support expand for truncated */}
                        {isSystem && t.content && (() => {
                          const truncMatch = typeof t.content === 'string' && t.content.match(/\[(\d+)\s*chars?\s*total\]/);
                          const fullText = t.full_content || t.content;
                          return (
                            <details>
                              <summary style={{ fontSize: '.72rem', color: '#94a3b8', cursor: 'pointer' }}>▶ 展开系统提示词 ({fullText.length} 字符){t.is_truncated ? ' — 点击查看完整内容' : ''}</summary>
                              <pre style={{ fontSize: '11px', color: '#e2e8f0', background: '#0f172a', padding: '10px 12px', borderRadius: 7, whiteSpace: 'pre-wrap', marginTop: 6, maxHeight: 600, overflow: 'auto' }}>{fullText}</pre>
                            </details>
                          );
                        })()}
                        {/* AI thinking */}
                        {isAssistant && t.content && (
                          <details>
                            <summary style={{ fontSize: '.72rem', color: '#64748b', cursor: 'pointer' }}>▶ AI 输出 ({(t.content || '').length} 字符)</summary>
                            <pre style={{ fontSize: '11px', color: '#1e293b', whiteSpace: 'pre-wrap', marginTop: 6, maxHeight: 320, overflow: 'auto' }}>{t.content}</pre>
                          </details>
                        )}
                        {/* Tool output */}
                        {isTool && t.content && (
                          <details>
                            <summary style={{ fontSize: '.72rem', color: '#64748b', cursor: 'pointer' }}>▶ Tool 返回</summary>
                            <pre style={{ fontSize: '11px', color: '#78350f', whiteSpace: 'pre-wrap', marginTop: 6, maxHeight: 240, overflow: 'auto' }}>{typeof t.content === 'string' ? t.content : JSON.stringify(t.content, null, 2)}</pre>
                          </details>
                        )}
                      </div>
                    </div>
                  </div>
                );
              }

              /* ── CUA execution event ──────────────────────────────────── */
              if (item._kind === 'cua_event') {
                const ce = item.ce;
                const cuaMeta = item.cuaMeta;
                const prevTs = idx > 0 ? timeline[idx - 1].ts : item.ts;
                const stepMs = item.ts - prevTs;
                const evType: string = ce.type || 'cua';
                const cuaCfg: Record<string, { icon: string; label: string; dot: string; bg: string; border: string; textColor: string }> = {
                  task_start:        { icon: '🎬', label: 'CUA 开始',    dot: '#7c3aed', bg: '#faf5ff', border: '#e9d5ff', textColor: '#5b21b6' },
                  phase:             { icon: '⚙️', label: 'CUA 阶段',    dot: '#64748b', bg: '#f8fafc', border: '#e2e8f0', textColor: '#475569' },
                  cua_instruction:   { icon: '🤖', label: 'CUA 指令',    dot: '#2563eb', bg: '#eff6ff', border: '#bfdbfe', textColor: '#1d4ed8' },
                  agent_reply_ready: { icon: '💡', label: 'Agent 回复就绪', dot: '#059669', bg: '#f0fdf4', border: '#bbf7d0', textColor: '#065f46' },
                  tool_call:         { icon: '🔧', label: 'Tool 调用',    dot: '#ea580c', bg: '#fff7ed', border: '#fed7aa', textColor: '#c2410c' },
                  tool_result:       { icon: '📤', label: 'Tool 结果',    dot: '#d97706', bg: '#fefce8', border: '#fef08a', textColor: '#92400e' },
                  text:              { icon: '💬', label: 'AI 输出',      dot: '#0891b2', bg: '#ecfeff', border: '#a5f3fc', textColor: '#0e7490' },
                  task_done:         { icon: '✅', label: 'CUA 完成',    dot: '#16a34a', bg: '#f0fdf4', border: '#86efac', textColor: '#15803d' },
                  task_failed:       { icon: '❌', label: 'CUA 失败',    dot: '#dc2626', bg: '#fef2f2', border: '#fca5a5', textColor: '#dc2626' },
                };
                const cfg = cuaCfg[evType] || { icon: '•', label: evType, dot: '#94a3b8', bg: '#f8fafc', border: '#e2e8f0', textColor: '#475569' };

                return (
                  <div key={`cua-${idx}`} style={{ display: 'flex', gap: 12, marginBottom: 14 }}>
                    <div style={{ flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                      <div style={{ width: 32, height: 32, borderRadius: '50%', background: cfg.dot, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '13px', boxShadow: '0 1px 4px rgba(0,0,0,.12)' }}>{cfg.icon}</div>
                      {idx < timeline.length - 1 && <div style={{ width: 1, flex: 1, background: '#e2e8f0', marginTop: 4 }} />}
                    </div>
                    <div style={{ flex: 1, paddingBottom: 14 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                        <span style={{ fontSize: '.7rem', fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.05em', background: cfg.bg, color: cfg.textColor, border: `1px solid ${cfg.border}`, padding: '2px 8px', borderRadius: 5 }}>CUA · {cfg.label}</span>
                        {idx > 0 && stepMs > 10 && <span style={{ fontSize: '.68rem', background: '#f1f5f9', color: '#64748b', padding: '1px 5px', borderRadius: 4 }}>+{stepMs < 1000 ? `${stepMs}ms` : `${(stepMs / 1000).toFixed(1)}s`}</span>}
                        <span style={{ fontSize: '.7rem', color: '#9ca3af', fontFamily: 'monospace', marginLeft: 'auto' }}>{fmtTimeShort(item.ts)}</span>
                      </div>
                      <div style={{ background: cfg.bg, border: `1px solid ${cfg.border}`, borderRadius: 10, padding: '10px 14px' }}>
                        {evType === 'cua_instruction' && (
                          <div>
                            <div style={{ background: '#0f172a', borderRadius: 7, padding: '7px 11px', marginBottom: 8, fontFamily: 'monospace', fontSize: '11px', display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap' as const, gap: 6 }}>
                              <div><span style={{ color: '#38bdf8', fontWeight: 'bold' }}>SEND</span> <span style={{ color: '#f1f5f9' }}>{ce.app || '企业微信'}</span></div>
                              <div style={{ display: 'flex', gap: 10 }}>
                                {ce.recipient && <span style={{ color: '#34d399' }}>→ {ce.recipient}</span>}
                                {ce.action && <span style={{ color: '#c084fc' }}>{ce.action}</span>}
                              </div>
                            </div>
                            {ce.content_preview && <div style={{ fontSize: '.83rem', color: '#1e3a5f', borderLeft: '3px solid #3b82f6', paddingLeft: 10, lineHeight: 1.7, whiteSpace: 'pre-wrap', background: 'rgba(255,255,255,.7)', padding: '8px 8px 8px 12px', borderRadius: '0 7px 7px 0' }}>{ce.content_preview?.slice(0, 400)}</div>}
                          </div>
                        )}
                        {evType === 'tool_call' && (
                          <div style={{ fontSize: '.82rem', color: '#c2410c' }}>
                            <span style={{ background: '#fff7ed', padding: '2px 7px', borderRadius: 4, border: '1px solid #fed7aa', fontFamily: 'monospace' }}>{ce.tool || ce.name || 'tool'}</span>
                            {ce.input && <details style={{ marginTop: 6 }}><summary style={{ fontSize: '.72rem', color: '#64748b', cursor: 'pointer' }}>▶ 输入参数</summary><pre style={{ fontSize: '10px', whiteSpace: 'pre-wrap', marginTop: 4, maxHeight: 150, overflow: 'auto' }}>{JSON.stringify(ce.input, null, 2)}</pre></details>}
                          </div>
                        )}
                        {evType === 'text' && ce.text && (
                          <details>
                            <summary style={{ fontSize: '.72rem', color: '#64748b', cursor: 'pointer' }}>▶ AI 输出 ({(ce.text || '').length} 字符)</summary>
                            <pre style={{ fontSize: '.8rem', whiteSpace: 'pre-wrap', marginTop: 6, maxHeight: 250, overflow: 'auto' }}>{ce.text}</pre>
                          </details>
                        )}
                        {evType === 'phase' && <div style={{ fontSize: '.82rem', color: '#475569' }}>阶段: <strong>{ce.phase}</strong></div>}
                        {evType === 'task_done' && <div style={{ fontSize: '.82rem', color: '#15803d' }}>✓ CUA 执行完成，消息已发送给 <strong>{cuaMeta.recipient}</strong></div>}
                        {evType === 'task_failed' && <div style={{ fontSize: '.82rem', color: '#dc2626' }}>{ce.error || ce.detail || '执行失败'}</div>}
                        {!['cua_instruction','tool_call','tool_result','text','phase','task_start','task_done','task_failed','agent_reply_ready'].includes(evType) && (
                          <pre style={{ margin: 0, fontSize: '.72rem', color: '#475569', whiteSpace: 'pre-wrap', maxHeight: 100, overflow: 'auto' }}>{JSON.stringify(ce, null, 2)}</pre>
                        )}
                      </div>
                    </div>
                  </div>
                );
              }

              return null;
            })}

            {/* Final reply */}
            {selected.reply_content && (
              <div style={{ display: 'flex', gap: 12, marginBottom: 14 }}>
                <div style={{ flexShrink: 0, width: 32, height: 32, borderRadius: '50%', background: '#16a34a', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '14px' }}>💬</div>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                    <span style={{ fontSize: '.72rem', fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.06em', background: '#dcfce7', color: '#15803d', padding: '2px 8px', borderRadius: 5 }}>FINAL REPLY</span>
                  </div>
                  <div style={{ background: 'linear-gradient(135deg, #f0fdf4 0%, #dcfce7 100%)', border: '1px solid #86efac', borderRadius: 10, padding: '12px 16px', fontSize: '.88rem', color: '#14532d', lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>
                    {selected.reply_content}
                  </div>
                </div>
              </div>
            )}
          </div>
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
