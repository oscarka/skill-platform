import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';

const STATUS_BADGE: Record<string, { label: string; cls: string }> = {
  created:       { label: '待发送',   cls: 'badge-pending' },
  waiting_input: { label: '等待提交', cls: 'badge-reviewing' },
  submitted:     { label: '已提交',   cls: 'badge-internal' },
  processing:    { label: 'AI处理中', cls: 'badge-reviewing' },
  done:          { label: '已完成',   cls: 'badge-published' },
  returned:      { label: '已打回',   cls: 'badge-pending' },
  expired:       { label: '已过期',   cls: 'badge-disabled' },
  error:         { label: '出错',     cls: 'badge-rejected' },
};

export default function TicketDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [data, setData] = useState<any>(null);
  const [result, setResult] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState(false);
  const [returnReason, setReturnReason] = useState('');
  const [showReturn, setShowReturn] = useState(false);
  const [copied, setCopied] = useState(false);
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  // Revision state
  const [editingResult, setEditingResult] = useState(false);
  const [revisedText, setRevisedText] = useState('');
  const [revisionNotes, setRevisionNotes] = useState('');
  const [revisedBy, setRevisedBy] = useState('');
  const [savingRevision, setSavingRevision] = useState(false);
  // Poll ref
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const flash = (type: 'success' | 'error', text: string) => {
    setMsg({ type, text }); setTimeout(() => setMsg(null), 4000);
  };

  const loadResult = async () => {
    try {
      const r = await api.results.get(id!);
      setResult(r.result);
    } catch { setResult(null); }
  };

  const load = async () => {
    setLoading(true);
    const d = await api.tickets.get(id!).catch(() => null);
    setData(d);
    if (d) await loadResult();
    setLoading(false);
  };

  useEffect(() => { load(); }, [id]);

  // Poll while submitted or processing
  useEffect(() => {
    const status = data?.ticket?.status;
    if (status === 'processing' || status === 'submitted') {
      setProcessing(true);
      pollRef.current = setInterval(async () => {
        const s = await api.tickets.status(id!).catch(() => null);
        if (s && s.status !== 'processing' && s.status !== 'submitted') {
          clearInterval(pollRef.current!);
          setProcessing(false);
          await load();
        }
      }, 2500);
    } else {
      setProcessing(false);
      if (pollRef.current) clearInterval(pollRef.current);
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [data?.ticket?.status]);

  const handleProcess = async () => {
    try {
      await api.results.process(id!);
      flash('success', 'AI 处理已启动，请稍候…');
      setTimeout(load, 1000);
    } catch (e: any) { flash('error', e.message); }
  };

  const handleReturn = async () => {
    if (!returnReason.trim()) return;
    try {
      await api.tickets.return(id!, returnReason);
      flash('success', '已打回，客户可重新提交');
      setShowReturn(false); setReturnReason(''); load();
    } catch (e: any) { flash('error', e.message); }
  };

  const copyLink = () => {
    navigator.clipboard.writeText(data.ticket.h5_url);
    setCopied(true); setTimeout(() => setCopied(false), 2000);
  };

  const startEdit = () => {
    setRevisedText(result?.revised_result || result?.raw_result || '');
    setRevisionNotes(result?.revision_notes || '');
    setRevisedBy(result?.revised_by || '');
    setEditingResult(true);
  };

  const handleSaveRevision = async () => {
    setSavingRevision(true);
    try {
      await api.results.update(id!, { revised_result: revisedText, revision_notes: revisionNotes, revised_by: revisedBy });
      flash('success', '修订已保存');
      setEditingResult(false);
      await loadResult();
    } catch (e: any) { flash('error', e.message); }
    finally { setSavingRevision(false); }
  };

  if (loading) return <div className="loading">加载中…</div>;
  if (!data) return <div className="alert alert-error">工单不存在</div>;

  const { ticket, skill, inputs } = data;
  const badge = STATUS_BADGE[ticket.status] || { label: ticket.status, cls: '' };
  const isExpired = Date.now() > ticket.expires_at;
  const textInputs = (inputs || []).filter((i: any) => i.field_type === 'text');
  const fileInputs = (inputs || []).filter((i: any) => i.field_type === 'file');
  const displayContent = result?.revised_result || result?.raw_result || '';
  const canProcess = ['submitted', 'done', 'error'].includes(ticket.status);
  const canReturn = ['submitted', 'done'].includes(ticket.status);

  // ── placeholder JSX — filled in next chunk
  return (
    <div>
      {/* ── Page Header ───────────────────────────────────────────── */}
      <div className="page-header">
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <h1>{ticket.title}</h1>
            <span className={`badge ${badge.cls}`}>{badge.label}</span>
            {processing && <span className="badge badge-reviewing" style={{ animation: 'none' }}>⏳ 处理中…</span>}
            {isExpired && ticket.status !== 'done' && <span className="badge badge-rejected">已过期</span>}
          </div>
          <p>{skill?.name || '—'} · {ticket.patient_name || '未填患者'} · 创建人：{ticket.created_by || '—'}</p>
        </div>
        <button className="btn btn-ghost" onClick={() => navigate('/tickets')}>← 返回</button>
      </div>

      {msg && <div className={`alert alert-${msg.type}`}>{msg.text}</div>}

      {/* ── H5 Link ───────────────────────────────────────────────── */}
      <div className="card mb-4">
        <div className="card-title">🔗 客户 H5 链接</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <input className="form-input" readOnly value={ticket.h5_url}
            style={{ flex: 1, fontFamily: 'monospace', fontSize: '.82rem', background: 'var(--gray-50)' }} />
          <button className="btn btn-primary" onClick={copyLink}>{copied ? '✅ 已复制' : '📋 复制'}</button>
          <a className="btn btn-ghost" href={ticket.h5_url} target="_blank" rel="noreferrer">🔗 预览</a>
        </div>
        <div style={{ marginTop: 6, fontSize: '.75rem', color: 'var(--gray-400)', display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          <span>有效期：{new Date(ticket.expires_at).toLocaleString('zh-CN')}</span>
          {ticket.return_count > 0 && <span>已打回 {ticket.return_count} 次</span>}
          {ticket.h5_submitted_at && <span>客户提交：{new Date(ticket.h5_submitted_at).toLocaleString('zh-CN')}</span>}
        </div>
      </div>

      {/* ── Action Bar ────────────────────────────────────────────── */}
      <div className="card mb-4">
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {canProcess && (
            <button className="btn btn-primary" onClick={handleProcess} disabled={processing}>
              {processing ? '⏳ AI 处理中…' : '🤖 重新 AI 处理'}
            </button>
          )}
          {canReturn && (
            <button className="btn btn-secondary" onClick={() => setShowReturn(v => !v)}>↩️ 打回补充</button>
          )}
          {result && (
            <>
              <a className="btn btn-ghost" href={api.results.reportUrl(id!, 'html')} target="_blank" rel="noreferrer"
                title="在新窗口打开 → Ctrl+P 打印为 PDF">📄 预览报告 / 打印 PDF</a>
            </>
          )}
        </div>
        {processing && (
          <div style={{ marginTop: 10, padding: '8px 12px', background: 'var(--primary-light)', borderRadius: 'var(--radius-sm)', fontSize: '.83rem', color: 'var(--primary)', display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ display: 'inline-block', animation: 'spin 1s linear infinite' }}>⏳</span>
            AI 正在处理，页面将自动更新…
          </div>
        )}
        {showReturn && (
          <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
            <input className="form-input" style={{ flex: 1 }} placeholder="告知客户需要补充的内容…"
              value={returnReason} onChange={e => setReturnReason(e.target.value)} />
            <button className="btn btn-danger btn-sm" onClick={handleReturn}>确认打回</button>
            <button className="btn btn-ghost btn-sm" onClick={() => setShowReturn(false)}>取消</button>
          </div>
        )}
      </div>

      {/* ── AI Result ─────────────────────────────────────────────── */}
      {(result || ticket.status === 'processing' || ticket.status === 'submitted') && (
        <div className="card mb-4">
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
            <div className="card-title" style={{ margin: 0 }}>🤖 AI 处理结果</div>
            {result?.revised_result && <span className="badge badge-published" style={{ marginLeft: 8 }}>已修订</span>}
            {result && !editingResult && (
              <button className="btn btn-ghost btn-sm ml-auto" onClick={startEdit}>✏️ 编辑调整</button>
            )}
          </div>

          {/* Processing spinner */}
          {(ticket.status === 'processing' || ticket.status === 'submitted') && !result && (
            <div style={{ textAlign: 'center', padding: '32px 0', color: 'var(--gray-400)' }}>
              <div style={{ fontSize: '2rem', marginBottom: 8 }}>🤖</div>
              <div style={{ fontWeight: 600, color: 'var(--primary)', marginBottom: 4 }}>AI 正在分析处理中…</div>
              <div style={{ fontSize: '.8rem' }}>通常需要 20-60 秒，完成后自动刷新</div>
            </div>
          )}

          {/* Result display */}
          {result && !editingResult && (
            <>
              <div style={{
                background: 'var(--gray-50)', border: '1px solid var(--gray-200)',
                borderRadius: 'var(--radius-sm)', padding: '16px 18px',
                fontSize: '.875rem', lineHeight: 1.85,
                whiteSpace: 'pre-wrap', fontFamily: 'inherit',
                maxHeight: 600, overflowY: 'auto',
                color: 'var(--gray-800)',
              }}>
                {displayContent || '（暂无结果）'}
              </div>
              {result.revised_by && (
                <div style={{ marginTop: 8, fontSize: '.75rem', color: 'var(--gray-400)', display: 'flex', gap: 16 }}>
                  <span>修订人：{result.revised_by}</span>
                  {result.revision_notes && <span>备注：{result.revision_notes}</span>}
                  {result.revised_at && <span>{new Date(result.revised_at).toLocaleString('zh-CN')}</span>}
                </div>
              )}
            </>
          )}

          {/* Edit mode */}
          {result && editingResult && (
            <div>
              <div className="form-group">
                <label className="form-label">修订内容（支持 Markdown）</label>
                <textarea className="form-textarea" rows={16}
                  style={{ fontSize: '.875rem', lineHeight: 1.7, fontFamily: 'inherit' }}
                  value={revisedText} onChange={e => setRevisedText(e.target.value)} />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div className="form-group">
                  <label className="form-label">修订人</label>
                  <input className="form-input" value={revisedBy} onChange={e => setRevisedBy(e.target.value)} placeholder="姓名" />
                </div>
                <div className="form-group">
                  <label className="form-label">修订备注</label>
                  <input className="form-input" value={revisionNotes} onChange={e => setRevisionNotes(e.target.value)} placeholder="修改原因（可选）" />
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-primary" onClick={handleSaveRevision} disabled={savingRevision}>
                  {savingRevision ? '保存中…' : '💾 保存修订'}
                </button>
                <button className="btn btn-ghost" onClick={() => setEditingResult(false)}>取消</button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Client Inputs ─────────────────────────────────────────── */}
      {(textInputs.length > 0 || fileInputs.length > 0) && (
        <div className="card mb-4">
          <div className="card-title">📋 客户提交内容</div>
          {textInputs.map((inp: any) => {
            const fieldCfg = skill?.h5_config?.fields?.find((f: any) => f.key === inp.field_key);
            return (
              <div key={inp.id} style={{ marginBottom: 12 }}>
                <div style={{ fontSize: '.78rem', fontWeight: 600, color: 'var(--gray-500)', marginBottom: 4 }}>
                  {fieldCfg?.label || inp.field_key}
                </div>
                <div style={{ fontSize: '.875rem', background: 'var(--gray-50)', padding: '8px 12px', borderRadius: 6 }}>
                  {inp.value || '（未填写）'}
                </div>
              </div>
            );
          })}
          {fileInputs.length > 0 && (
            <div style={{ marginTop: textInputs.length ? 12 : 0 }}>
              <div style={{ fontSize: '.78rem', fontWeight: 600, color: 'var(--gray-500)', marginBottom: 8 }}>上传的文件</div>
              {fileInputs.map((f: any) => (
                <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', background: 'var(--gray-50)', borderRadius: 6, marginBottom: 6 }}>
                  <span>{f.mime_type?.includes('pdf') ? '📄' : '🖼️'}</span>
                  <span style={{ flex: 1, fontSize: '.875rem' }}>{f.file_name}</span>
                  <a className="btn btn-ghost btn-sm" href={'/api/upload/' + f.file_path?.split('/').pop()} target="_blank" rel="noreferrer">查看</a>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Ticket Info ───────────────────────────────────────────── */}
      <div className="card">
        <div className="card-title">ℹ️ 工单信息</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, fontSize: '.85rem', color: 'var(--gray-600)' }}>
          <div><span style={{ color: 'var(--gray-400)' }}>Token：</span><span className="font-mono" style={{ fontSize: '.75rem' }}>{ticket.token?.slice(0, 16)}…</span></div>
          <div><span style={{ color: 'var(--gray-400)' }}>备注：</span>{ticket.notes || '—'}</div>
          <div><span style={{ color: 'var(--gray-400)' }}>创建时间：</span>{new Date(ticket.created_at).toLocaleString('zh-CN')}</div>
          <div><span style={{ color: 'var(--gray-400)' }}>更新时间：</span>{new Date(ticket.updated_at).toLocaleString('zh-CN')}</div>
        </div>
      </div>
    </div>
  );
}
