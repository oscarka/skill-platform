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
  const [showLog, setShowLog] = useState(false);
  const [overrideModel, setOverrideModel] = useState('');
  // Inputs editing state
  const [editingInputs, setEditingInputs] = useState(false);
  const [editedTextValues, setEditedTextValues] = useState<Record<string, string>>({});
  const [replacementFiles, setReplacementFiles] = useState<Record<string, File>>({});
  const [savingInputs, setSavingInputs] = useState(false);
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
      await api.results.process(id!, overrideModel || undefined);
      flash('success', `AI 处理已启动${overrideModel ? `（模型：${overrideModel}）` : ''}，请稍候…`);
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

  const startEditInputs = () => {
    // Pre-fill text values from current inputs
    const vals: Record<string, string> = {};
    for (const inp of (data?.inputs || [])) {
      if (inp.field_type === 'text') vals[inp.field_key] = inp.value || '';
    }
    setEditedTextValues(vals);
    setReplacementFiles({});
    setEditingInputs(true);
  };

  const handleSaveInputs = async () => {
    setSavingInputs(true);
    try {
      const fd = new FormData();
      fd.append('fields', JSON.stringify(editedTextValues));
      for (const [inputId, file] of Object.entries(replacementFiles)) {
        fd.append(`file_${inputId}`, file);
      }
      const res = await api.tickets.updateInputs(id!, fd);
      // Update local data with fresh inputs
      setData((prev: any) => ({ ...prev, inputs: res.inputs }));
      setEditingInputs(false);
      setReplacementFiles({});
      flash('success', '客户输入已更新，可重新 AI 处理');
    } catch (e: any) { flash('error', e.message); }
    finally { setSavingInputs(false); }
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
          <span>有效期：{formatDate(ticket.expires_at)}</span>
          {ticket.return_count > 0 && <span>已打回 {ticket.return_count} 次</span>}
          {ticket.h5_submitted_at && <span>客户提交：{formatDate(ticket.h5_submitted_at)}</span>}
        </div>
      </div>

      {/* ── Action Bar ────────────────────────────────────────────── */}
      <div className="card mb-4">
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {canProcess && (
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <select
                className="form-input"
                style={{ fontSize: '.8rem', padding: '4px 8px', width: 'auto', minWidth: 160 }}
                value={overrideModel}
                onChange={e => setOverrideModel(e.target.value)}
                disabled={processing}
                title="选择执行模型（留空=使用系统默认）"
              >
                <option value="">🤖 默认模型</option>
                <option value="doubao-seed-1-8-251228">豆包 Seed 1.8</option>
                <option value="deepseek-v4-flash">DeepSeek V4 Flash</option>
                <option value="deepseek-chat">DeepSeek V3</option>
                <option value="gemini-3.6-flash">Gemini 3.6 Flash</option>
                <option value="gemini-2.5-flash">Gemini 2.5 Flash</option>
              </select>
              <button className="btn btn-primary" onClick={handleProcess} disabled={processing}>
                {processing ? '⏳ AI 处理中…' : '🤖 重新 AI 处理'}
              </button>
            </div>
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
              {/* AI 执行日志（Agent 每一步的操作记录，和沙箱测试日志格式一致） */}
              {result.ai_log && (() => {
                // 解析 transcript JSON（runner.py 存的是 JSON array）
                let transcript: any[] = [];
                try { transcript = JSON.parse(result.ai_log); } catch { transcript = []; }
                const stepCount = transcript.filter((t: any) => t.type !== 'event' || t.event !== 'header').length;
                // 下载完整日志
                const downloadLog = () => {
                  const blob = new Blob([result.ai_log], { type: 'application/json' });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url; a.download = `ticket-ai-log-${id || 'unknown'}.json`;
                  a.click(); URL.revokeObjectURL(url);
                };
                return (
                  <div style={{ marginTop: 12 }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => setShowLog(v => !v)}
                        style={{ fontSize: '.78rem' }}
                      >
                        {showLog ? '▲ 收起执行日志' : `▼ 查看 Agent 执行日志（${stepCount} 步）`}
                      </button>
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={downloadLog}
                        style={{ fontSize: '.75rem', color: 'var(--primary)' }}
                        title="下载完整执行日志（JSON 格式）"
                      >
                        📥 下载完整日志
                      </button>
                    </div>
                    {showLog && (
                      <div style={{
                        marginTop: 8,
                        borderLeft: '3px solid var(--gray-200)',
                        paddingLeft: 12,
                        maxHeight: 600,
                        overflowY: 'auto',
                      }}>
                        {transcript.length === 0 ? (
                          <div style={{ color: 'var(--gray-400)', fontSize: '.8rem' }}>暂无日志记录</div>
                        ) : transcript.map((t: any, i: number) => (
                          <div key={i} style={{ marginBottom: 12 }}>
                            {/* 条目标题行 */}
                            <div style={{
                              fontSize: '.78rem', fontWeight: 600, marginBottom: 4,
                              color: t.role === 'assistant' ? 'var(--primary)'
                                : t.role === 'tool' ? 'var(--success)'
                                : t.type === 'event' ? '#e67700'
                                : 'var(--gray-500)'
                            }}>
                              {t.type === 'event'
                                ? `⚡ ${t.event === 'start' ? '开始' : t.event === 'executor_done' ? '执行完成' : t.event || '事件'}`
                                : t.role === 'system'
                                  ? `📋 系统指令（${t.label || 'executor'}）`
                                  : t.role === 'assistant'
                                    ? `🤖 AI 思考与回复${t.turn != null ? `（第 ${t.turn} 轮）` : ''}`
                                    : t.role === 'tool'
                                      ? `🔧 工具调用：${t.tool || '未知工具'}`
                                      : `第 ${t.round || t.turn || i} 步`}
                              {t.ts && (
                                <span style={{ fontWeight: 400, color: 'var(--gray-400)', marginLeft: 8 }}>
                                  {t.ts.slice(11, 19)}
                                </span>
                              )}
                              {t.is_truncated && (
                                <span style={{ marginLeft: 8, fontSize: '.7rem', color: '#e67700', background: '#fff3e0', padding: '1px 6px', borderRadius: 3 }}>
                                  ✂️ 已截断{t.original_length ? ` (原 ${(t.original_length / 1024).toFixed(1)}KB)` : ''}
                                </span>
                              )}
                            </div>
                            {/* 事件详情 */}
                            {t.type === 'event' && t.detail && (
                              <div style={{ fontSize: '.8rem', color: 'var(--gray-600)' }}>{t.detail}</div>
                            )}
                            {/* 系统指令（只显示前 200 字） */}
                            {t.role === 'system' && t.content && (
                              <pre style={{ background: '#f8f9fa', borderRadius: 4, padding: '6px 10px', fontSize: '.75rem', whiteSpace: 'pre-wrap', maxHeight: 120, overflow: 'auto', margin: 0, color: 'var(--gray-600)' }}>
                                {t.content.slice(0, 300)}{t.content.length > 300 ? `\n...[共 ${t.content.length} 字]` : ''}
                              </pre>
                            )}
                            {/* AI 回复内容 */}
                            {t.role === 'assistant' && t.content && (
                              <pre style={{ background: '#f0f4ff', borderRadius: 4, padding: '8px 10px', fontSize: '.8rem', whiteSpace: 'pre-wrap', maxHeight: 400, overflow: 'auto', margin: 0 }}>
                                {t.content}
                              </pre>
                            )}
                            {/* 调用了哪些工具 */}
                            {t.role === 'assistant' && t.tool_calls?.length > 0 && (
                              <div style={{ marginTop: 4, fontSize: '.75rem', color: 'var(--gray-500)' }}>
                                🔧 调用工具：{t.tool_calls.map((tc: any) => tc.name || tc.function?.name).join('、')}
                              </div>
                            )}
                            {/* 工具输入 */}
                            {t.role === 'tool' && t.input && (
                              <div style={{ marginBottom: 4 }}>
                                <div style={{ fontSize: '.75rem', color: 'var(--gray-500)', marginBottom: 2 }}>📥 输入参数：</div>
                                <pre style={{ background: '#f0fff4', borderRadius: 4, padding: '6px 8px', fontSize: '.78rem', whiteSpace: 'pre-wrap', maxHeight: 120, overflow: 'auto', margin: 0 }}>
                                  {typeof t.input === 'string' ? t.input : JSON.stringify(t.input, null, 2)}
                                </pre>
                              </div>
                            )}
                            {/* 工具输出 */}
                            {t.role === 'tool' && t.output && (
                              <div>
                                <div style={{ fontSize: '.75rem', color: 'var(--gray-500)', marginBottom: 2 }}>
                                  📤 输出结果{t.is_truncated ? '（已截断，下载完整日志查看原文）' : ''}：
                                </div>
                                <pre style={{ background: '#fff8f0', borderRadius: 4, padding: '6px 8px', fontSize: '.78rem', whiteSpace: 'pre-wrap', maxHeight: 300, overflow: 'auto', margin: 0 }}>
                                  {t.output}
                                </pre>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })()}
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
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
            <div className="card-title" style={{ margin: 0 }}>📋 客户提交内容</div>
            {!editingInputs && (
              <button className="btn btn-ghost btn-sm ml-auto" onClick={startEditInputs}>✏️ 编辑</button>
            )}
          </div>

          {/* ── Read-only view ── */}
          {!editingInputs && (
            <>
              {textInputs.map((inp: any) => {
                const fieldCfg = skill?.h5_config?.fields?.find((f: any) => f.key === inp.field_key);
                return (
                  <div key={inp.id} style={{ marginBottom: 12 }}>
                    <div style={{ fontSize: '.78rem', fontWeight: 600, color: 'var(--gray-500)', marginBottom: 4 }}>
                      {fieldCfg?.label || inp.field_key}
                    </div>
                    <div style={{ fontSize: '.875rem', background: 'var(--gray-50)', padding: '8px 12px', borderRadius: 6, whiteSpace: 'pre-wrap' }}>
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
            </>
          )}

          {/* ── Edit mode ── */}
          {editingInputs && (
            <div>
              {/* Text fields */}
              {textInputs.map((inp: any) => {
                const fieldCfg = skill?.h5_config?.fields?.find((f: any) => f.key === inp.field_key);
                return (
                  <div key={inp.id} className="form-group">
                    <label className="form-label">{fieldCfg?.label || inp.field_key}</label>
                    <textarea
                      className="form-textarea"
                      rows={3}
                      style={{ fontSize: '.875rem', fontFamily: 'inherit', resize: 'vertical' }}
                      value={editedTextValues[inp.field_key] ?? inp.value ?? ''}
                      onChange={e => setEditedTextValues(prev => ({ ...prev, [inp.field_key]: e.target.value }))}
                    />
                  </div>
                );
              })}
              {/* File fields */}
              {fileInputs.length > 0 && (
                <div className="form-group">
                  <label className="form-label" style={{ fontSize: '.78rem', fontWeight: 600, color: 'var(--gray-500)' }}>上传的文件</label>
                  {fileInputs.map((f: any) => (
                    <div key={f.id} style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '8px 10px', background: 'var(--gray-50)', borderRadius: 6, marginBottom: 8, border: replacementFiles[f.id] ? '1.5px solid var(--primary)' : '1px solid var(--gray-200)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span>{f.mime_type?.includes('pdf') ? '📄' : '🖼️'}</span>
                        <span style={{ flex: 1, fontSize: '.875rem', color: replacementFiles[f.id] ? 'var(--gray-400)' : 'inherit', textDecoration: replacementFiles[f.id] ? 'line-through' : 'none' }}>
                          {f.file_name}
                        </span>
                        <label className="btn btn-ghost btn-sm" style={{ cursor: 'pointer', fontSize: '.78rem' }}>
                          📁 替换文件
                          <input type="file" style={{ display: 'none' }}
                            onChange={e => {
                              const file = e.target.files?.[0];
                              if (file) setReplacementFiles(prev => ({ ...prev, [f.id]: file }));
                            }}
                          />
                        </label>
                      </div>
                      {replacementFiles[f.id] && (
                        <div style={{ fontSize: '.78rem', color: 'var(--primary)', paddingLeft: 28, display: 'flex', alignItems: 'center', gap: 6 }}>
                          ✅ 将替换为：{replacementFiles[f.id].name}
                          <button className="btn btn-ghost btn-sm" style={{ fontSize: '.72rem', padding: '0 4px' }}
                            onClick={() => setReplacementFiles(prev => { const n = { ...prev }; delete n[f.id]; return n; })}>
                            ✕ 取消
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {/* Actions */}
              <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                <button className="btn btn-primary" onClick={handleSaveInputs} disabled={savingInputs}>
                  {savingInputs ? '保存中…' : '💾 保存修改'}
                </button>
                <button className="btn btn-ghost" onClick={() => { setEditingInputs(false); setReplacementFiles({}); }}>
                  取消
                </button>
              </div>
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
          <div><span style={{ color: 'var(--gray-400)' }}>创建时间：</span>{fmtDate(ticket.created_at)}</div>
          <div><span style={{ color: 'var(--gray-400)' }}>更新时间：</span>{fmtDate(ticket.updated_at)}</div>
        </div>
      </div>
    </div>
  );
}
