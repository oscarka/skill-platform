import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';

const STATUS_CONFIG: Record<string, { label: string; cls: string; dot: string }> = {
  created:       { label: '待发送',    cls: 'badge-pending',    dot: 'status-dot-yellow' },
  waiting_input: { label: '等待提交',  cls: 'badge-reviewing',  dot: 'status-dot-blue' },
  submitted:     { label: '已提交',    cls: 'badge-internal',   dot: 'status-dot-blue' },
  processing:    { label: 'AI处理中',  cls: 'badge-reviewing',  dot: 'status-dot-blue' },
  done:          { label: '已完成',    cls: 'badge-published',  dot: 'status-dot-green' },
  returned:      { label: '已打回',    cls: 'badge-pending',    dot: 'status-dot-yellow' },
  expired:       { label: '已过期',    cls: 'badge-disabled',   dot: 'status-dot-gray' },
  error:         { label: '出错',      cls: 'badge-rejected',   dot: 'status-dot-red' },
};

export default function TicketList() {
  const navigate = useNavigate();
  const [tickets, setTickets] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterStatus, setFilterStatus] = useState('');
  const [q, setQ] = useState('');
  const [copied, setCopied] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = () => {
    api.tickets.list({ status: filterStatus || undefined, q: q || undefined })
      .then(d => {
        setTickets(d.tickets);
        setLoading(false);
        // Auto-poll if any ticket is still processing
        const hasActive = d.tickets?.some((t: any) => ['submitted','processing'].includes(t.status));
        if (hasActive && !pollRef.current) {
          pollRef.current = setInterval(() => load(), 8000);
        } else if (!hasActive && pollRef.current) {
          clearInterval(pollRef.current); pollRef.current = null;
        }
      })
      .catch(() => setLoading(false));
  };

  useEffect(() => {
    setLoading(true);
    load();
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [filterStatus]);

  const handleSearch = (e: React.FormEvent) => { e.preventDefault(); load(); };

  const copyLink = (url: string, id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(url).then(() => {
      setCopied(id); setTimeout(() => setCopied(null), 2000);
    });
  };

  const handleProcess = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await api.results.process(id);
      load();
    } catch (err: any) { alert(err.message); }
  };

  // Stats
  const stats = {
    total: tickets.length,
    submitted: tickets.filter(t => t.status === 'submitted').length,
    done: tickets.filter(t => t.status === 'done').length,
    processing: tickets.filter(t => t.status === 'processing').length,
  };

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>工单列表</h1>
          <p>管理所有客户工单，共 {stats.total} 条</p>
        </div>
        <button className="btn btn-primary" onClick={() => navigate('/tickets/new')}>＋ 创建工单</button>
      </div>

      {/* Stats */}
      {tickets.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, marginBottom: 20 }}>
          <div className="stat-card" style={{ borderLeft: '4px solid var(--gray-300)' }}>
            <div className="stat-card-label">📋 全部工单</div>
            <div className="stat-card-value">{stats.total}</div>
          </div>
          <div className="stat-card" style={{ borderLeft: '4px solid #f59e0b' }}>
            <div className="stat-card-label">⏳ 待处理</div>
            <div className="stat-card-value" style={{ color: '#b45309' }}>{stats.submitted}</div>
          </div>
          <div className="stat-card" style={{ borderLeft: '4px solid #10b981' }}>
            <div className="stat-card-label">✅ 已完成</div>
            <div className="stat-card-value" style={{ color: '#065f46' }}>{stats.done}</div>
          </div>
          <div className="stat-card" style={{ borderLeft: '4px solid #3b82f6' }}>
            <div className="stat-card-label">🤖 处理中</div>
            <div className="stat-card-value" style={{ color: '#1d4ed8' }}>{stats.processing}</div>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="card mb-4" style={{ padding: '14px 18px' }}>
        <form onSubmit={handleSearch} style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <input className="form-input" style={{ flex: 1, minWidth: 200 }}
            placeholder="🔍  搜索标题 / 患者 / Token…" value={q} onChange={e => setQ(e.target.value)} />
          <select className="form-select" style={{ width: 150 }} value={filterStatus} onChange={e => setFilterStatus(e.target.value)}>
            <option value="">全部状态</option>
            {Object.entries(STATUS_CONFIG).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
          <button className="btn btn-primary" type="submit">搜索</button>
          {(filterStatus || q) && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setFilterStatus(''); setQ(''); setTimeout(load, 50); }}>清除</button>
          )}
        </form>
      </div>

      {loading ? (
        <div className="loading">加载中…</div>
      ) : tickets.length === 0 ? (
        <div className="empty-state card">
          <div className="empty-state-icon">📭</div>
          <p>暂无工单</p>
          <p style={{ marginTop: 12 }}>
            <button className="btn btn-primary btn-sm" onClick={() => navigate('/tickets/new')}>创建第一张工单</button>
          </p>
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>工单标题</th>
                <th>Skill</th>
                <th>患者</th>
                <th>状态</th>
                <th>有效期</th>
                <th>创建时间</th>
                <th style={{ minWidth: 140 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {tickets.map(t => {
                const sc = STATUS_CONFIG[t.status] || { label: t.status, cls: '', dot: 'status-dot-gray' };
                const isExpired = Date.now() > t.expires_at && t.status !== 'done';
                return (
                  <tr key={t.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/tickets/${t.id}`)}>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span className={`status-dot ${sc.dot}`} />
                        <span style={{ fontWeight: 600, color: 'var(--gray-800)' }}>{t.title}</span>
                      </div>
                      {t.return_count > 0 && (
                        <span style={{ fontSize: '.7rem', color: 'var(--warning)', marginLeft: 16 }}>↩ 已打回 {t.return_count} 次</span>
                      )}
                    </td>
                    <td><span className="text-sm text-muted">{t.skill_name}</span></td>
                    <td><span className="text-sm">{t.patient_name || <span className="text-muted">—</span>}</span></td>
                    <td><span className={`badge ${sc.cls}`}>{sc.label}</span></td>
                    <td>
                      <span style={{ fontSize: '.8rem', color: isExpired ? 'var(--danger)' : 'var(--gray-500)' }}>
                        {isExpired ? '⚠ 已过期' : new Date(t.expires_at).toLocaleDateString('zh-CN')}
                      </span>
                    </td>
                    <td><span className="text-xs text-muted">{new Date(t.created_at).toLocaleDateString('zh-CN')}</span></td>
                    <td onClick={e => e.stopPropagation()}>
                      <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                        <button className="btn btn-ghost btn-sm" onClick={e => copyLink(t.h5_url, t.id, e)}>
                          {copied === t.id ? '✅' : '📋'} 链接
                        </button>
                        {t.status === 'done' && (
                          <a className="btn btn-ghost btn-sm" href={`/api/results/${t.id}/report`} target="_blank" rel="noreferrer">📄 报告</a>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
