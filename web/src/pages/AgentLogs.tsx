import { useState, useEffect, useRef } from 'react';
import { api } from '../lib/api';

const STATUS_CONFIG: Record<string, { label: string; cls: string }> = {
  created:       { label: '待发送',    cls: 'badge-pending' },
  waiting_input: { label: '等待提交',  cls: 'badge-reviewing' },
  submitted:     { label: '已提交',    cls: 'badge-internal' },
  processing:    { label: 'AI处理中',  cls: 'badge-reviewing' },
  done:          { label: '已完成',    cls: 'badge-published' },
  returned:      { label: '已打回',    cls: 'badge-pending' },
  expired:       { label: '已过期',    cls: 'badge-disabled' },
  error:         { label: '出错',      cls: 'badge-rejected' },
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

const formatTimeOnly = (val: any) => {
  if (!val) return '';
  if (typeof val === 'string' && val.includes('T')) {
    return val.slice(11, 19);
  }
  let num = Number(val);
  if (!isNaN(num) && num > 1000000000) {
    if (num < 10000000000) num *= 1000;
    return new Date(num).toLocaleTimeString('zh-CN');
  }
  return String(val);
};

export default function AgentLogs() {
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

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const detailPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadList = async (autoSelect = false) => {
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
        pollRef.current = setInterval(() => loadList(false), 5000);
      } else if (!hasActive && pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    } catch {
      setLoadingList(false);
    }
  };

  const loadDetail = async (id: string) => {
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
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [filterStatus]);

  useEffect(() => {
    if (selectedId) {
      loadDetail(selectedId);
    } else {
      setDetailData(null);
    }
  }, [selectedId]);

  // Real-time detail polling (1.5s interval) while ticket is processing or submitted
  useEffect(() => {
    const status = detailData?.ticket?.status;
    if (selectedId && (status === 'processing' || status === 'submitted')) {
      if (!detailPollRef.current) {
        detailPollRef.current = setInterval(() => {
          refreshDetailSilent(selectedId);
        }, 1500);
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

  const rawAiLog = detailData?.result?.ai_log || '';
  let transcript: any[] = [];
  try {
    if (rawAiLog) transcript = JSON.parse(rawAiLog);
  } catch {
    transcript = [];
  }

  const headerObj = transcript.find((t: any) => t.type === 'header');
  const detectedModel = headerObj?.model || detailData?.ticket?.override_model || '系统默认';

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
    <div>
      <div className="page-header">
        <div>
          <h1>📜 Agent 全链条控制台 (CUA Live Console)</h1>
          <p>全量链条追踪、HTTP 接口 Payload、Tokens 消耗、System Prompt 深度上下文与工具拆解</p>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '340px 1fr', gap: 16, minHeight: 'calc(100vh - 170px)' }}>
        
        {/* Left Side: Ticket List */}
        <div className="card" style={{ display: 'flex', flexDirection: 'column', padding: 12, height: '100%', overflow: 'hidden' }}>
          <form onSubmit={handleSearch} style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
            <input
              className="form-input"
              style={{ fontSize: '.8rem', padding: '5px 8px' }}
              placeholder="搜索工单标题/编号..."
              value={q}
              onChange={e => setQ(e.target.value)}
            />
            <button className="btn btn-secondary btn-sm" type="submit">搜索</button>
          </form>

          <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
            <select
              className="form-input"
              style={{ fontSize: '.8rem', padding: '4px 8px' }}
              value={filterStatus}
              onChange={e => setFilterStatus(e.target.value)}
            >
              <option value="">全部状态</option>
              <option value="done">已完成</option>
              <option value="processing">AI 处理中</option>
              <option value="submitted">已提交</option>
              <option value="error">出错</option>
            </select>
          </div>

          <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
            {loadingList ? (
              <div style={{ textAlign: 'center', padding: 20, color: 'var(--gray-400)', fontSize: '.85rem' }}>加载工单列表...</div>
            ) : tickets.length === 0 ? (
              <div style={{ textAlign: 'center', padding: 20, color: 'var(--gray-400)', fontSize: '.85rem' }}>无符合条件的工单</div>
            ) : (
              tickets.map(t => {
                const isSelected = t.id === selectedId;
                const statusCfg = STATUS_CONFIG[t.status] || { label: t.status, cls: 'badge-disabled' };
                return (
                  <div
                    key={t.id}
                    onClick={() => setSelectedId(t.id)}
                    style={{
                      padding: '10px 12px',
                      borderRadius: '10px',
                      cursor: 'pointer',
                      border: isSelected ? '2px solid #4f46e5' : '1px solid #e2e8f0',
                      background: isSelected ? '#f5f3ff' : '#fff',
                      boxShadow: isSelected ? '0 2px 8px rgba(79,70,229,0.12)' : 'none',
                      transition: 'all 0.15s ease',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                      <span className={`badge ${statusCfg.cls}`} style={{ fontSize: '.68rem' }}>{statusCfg.label}</span>
                      <span style={{ fontSize: '.72rem', color: '#94a3b8', fontFamily: 'monospace' }}>
                        {formatDate(t.created_at)}
                      </span>
                    </div>
                    <div style={{ fontWeight: 600, fontSize: '.84rem', color: '#0f172a', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {t.title}
                    </div>
                    <div style={{ fontSize: '.75rem', color: '#64748b', marginTop: 2, display: 'flex', justifyContent: 'space-between' }}>
                      <span>Skill: {t.skill_name || t.skill_id}</span>
                      {t.patient_name && <span>{t.patient_name}</span>}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Right Side: Log Detail */}
        <div className="card" style={{ display: 'flex', flexDirection: 'column', padding: 16, overflow: 'hidden', background: '#ffffff' }}>
          {!selectedId ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#94a3b8' }}>
              <div style={{ fontSize: '3rem', marginBottom: 12 }}>💻</div>
              <div style={{ fontWeight: 600, color: '#334155' }}>请在左侧列表选择一条工单查看完整 Agent 上下文与执行日志</div>
              <div style={{ fontSize: '.8rem', color: '#94a3b8', marginTop: 4 }}>CUA Log UI — HTTP Payload、Tokens 统计、System Prompt 与 Tool 响应全展开</div>
            </div>
          ) : loadingDetail ? (
            <div style={{ textAlign: 'center', padding: 40, color: '#94a3b8' }}>加载工单日志数据...</div>
          ) : !detailData ? (
            <div style={{ textAlign: 'center', padding: 40, color: '#94a3b8' }}>未能找到该工单数据</div>
          ) : (
            <>
              {/* Header Info Banner */}
              <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '12px', padding: '12px 16px', marginBottom: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 10 }}>
                  <div>
                    <h2 style={{ fontSize: '1.05rem', fontWeight: 700, margin: '0 0 6px 0', color: '#0f172a', display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span>{detailData.ticket?.title}</span>
                      <span className={`badge ${STATUS_CONFIG[detailData.ticket?.status]?.cls || 'badge-disabled'}`} style={{ fontSize: '.7rem' }}>
                        {STATUS_CONFIG[detailData.ticket?.status]?.label || detailData.ticket?.status}
                      </span>
                    </h2>
                    <div style={{ fontSize: '.78rem', color: '#64748b', display: 'flex', gap: 14, flexWrap: 'wrap', fontFamily: 'monospace' }}>
                      <span>Skill: <strong style={{ color: '#4f46e5' }}>{detailData.skill?.name || detailData.ticket?.skill_id}</strong></span>
                      <span>识别模型: <strong style={{ color: '#0284c7' }}>{detectedModel}</strong></span>
                      <span>提交时间: <strong>{formatDate(detailData.ticket?.created_at)}</strong></span>
                      {detailData.ticket?.patient_name && <span>客户: <strong>{detailData.ticket.patient_name}</strong></span>}
                    </div>
                  </div>

                  {/* Model Selector & Reprocess Button */}
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <select
                      className="form-input"
                      style={{ fontSize: '.78rem', padding: '4px 8px', width: 'auto', background: '#fff' }}
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
                    <button className="btn btn-primary btn-sm" onClick={handleReprocess} disabled={reprocessing} style={{ boxShadow: '0 2px 6px rgba(79,70,229,0.2)' }}>
                      {reprocessing ? '⏳ 启动中...' : '🚀 指定模型重新运行'}
                    </button>
                  </div>
                </div>
              </div>

              {/* USER INPUTS BANNER (CUA Style Input Payload Context) */}
              {detailData.inputs && detailData.inputs.length > 0 && (
                <div style={{ background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: '10px', padding: '10px 14px', marginBottom: 12 }}>
                  <div style={{ fontSize: '.78rem', fontWeight: 700, color: '#0369a1', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span>📥 客户提交参数与上下文 (User Input Payload)</span>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {detailData.inputs.map((inp: any, idx: number) => (
                      <div key={idx} style={{ fontSize: '.78rem', color: '#0c4a6e', background: '#fff', padding: '6px 10px', borderRadius: 6, border: '1px solid #e0f2fe' }}>
                        <span style={{ fontWeight: 600, color: '#0284c7' }}>{inp.field_name || `Input ${idx + 1}`}: </span>
                        <span style={{ whiteSpace: 'pre-wrap', fontFamily: 'monospace' }}>{inp.field_value || (inp.file_path ? `📁 ${inp.file_path}` : '(empty)')}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Tabs */}
              <div style={{ display: 'flex', gap: 8, borderBottom: '1px solid #e2e8f0', paddingBottom: 8, marginBottom: 12, alignItems: 'center' }}>
                <button
                  className={`btn btn-sm ${activeTab === 'transcript' ? 'btn-primary' : 'btn-ghost'}`}
                  onClick={() => setActiveTab('transcript')}
                >
                  ⚡ CUA Timeline 全链条追踪 ({transcript.length} 事件)
                </button>
                <button
                  className={`btn btn-sm ${activeTab === 'output' ? 'btn-primary' : 'btn-ghost'}`}
                  onClick={() => setActiveTab('output')}
                >
                  📄 最终输出报告
                </button>
                <button
                  className={`btn btn-sm ${activeTab === 'json' ? 'btn-primary' : 'btn-ghost'}`}
                  onClick={() => setActiveTab('json')}
                >
                  🔍 原始 JSON 数据
                </button>

                {activeTab === 'transcript' && (
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => setExpandAll(v => !v)}
                    style={{ marginLeft: 'auto', fontSize: '.75rem', color: '#64748b' }}
                  >
                    {expandAll ? '📂 全部折叠' : '📖 全部展开'}
                  </button>
                )}

                {rawAiLog && (
                  <button className="btn btn-ghost btn-sm" onClick={downloadLog} style={{ marginLeft: activeTab === 'transcript' ? 4 : 'auto', fontSize: '.75rem', color: '#4f46e5' }}>
                    📥 下载完整 JSON
                  </button>
                )}
              </div>

              {/* Tab Content */}
              <div style={{ flex: 1, overflowY: 'auto', paddingRight: 4 }}>
                
                {/* TAB 1: TRANSCRIPT (CUA Live Timeline Log Style) */}
                {activeTab === 'transcript' && (
                  <div>
                    {transcript.length === 0 ? (
                      <div style={{ textAlign: 'center', padding: '40px 20px', background: '#fafafa', borderRadius: '12px', border: '1px dashed #cbd5e1' }}>
                        {detailData.ticket?.status === 'processing' ? (
                          <div>
                            <div style={{ fontSize: '2rem', marginBottom: 8 }}>⏳</div>
                            <div style={{ fontWeight: 700, color: '#4f46e5', fontSize: '1rem', marginBottom: 4 }}>
                              Agent 正在实时思考与调用工具中…
                            </div>
                            <div style={{ fontSize: '.82rem', color: '#64748b' }}>
                              已开启 1.5s 实时捕获，最新产生步骤与工具 Response 将流式刷新在下方
                            </div>
                          </div>
                        ) : ['created', 'submitted', 'waiting_input', 'returned'].includes(detailData.ticket?.status) ? (
                          <div>
                            <div style={{ fontSize: '2rem', marginBottom: 8 }}>📋</div>
                            <div style={{ fontWeight: 700, color: '#0f172a', fontSize: '1rem', marginBottom: 4 }}>
                              该工单处于「{STATUS_CONFIG[detailData.ticket?.status]?.label || detailData.ticket?.status}」状态
                            </div>
                            <div style={{ fontSize: '.82rem', color: '#64748b', marginBottom: 14 }}>
                              尚在队列中，未触发 AI 引擎运行。您可以点击下方按钮立即触发全链条分析
                            </div>
                            <button
                              className="btn btn-primary btn-sm"
                              onClick={handleReprocess}
                              disabled={reprocessing}
                              style={{ boxShadow: '0 2px 8px rgba(79,70,229,0.25)' }}
                            >
                              {reprocessing ? '⏳ 启动中...' : '🚀 立即启动 Agent 分析与预测'}
                            </button>
                          </div>
                        ) : (
                          <div style={{ color: '#94a3b8', fontSize: '.85rem' }}>
                            暂无详细思考与工具调用日志（可能是传统 prompt 模式或未录入）
                          </div>
                        )}
                      </div>
                    ) : (
                      <div style={{ position: 'relative', paddingLeft: 24, display: 'flex', flexDirection: 'column', gap: 14 }}>
                        
                        {/* Live Processing Indicator Header if still running */}
                        {(detailData.ticket?.status === 'processing' || detailData.ticket?.status === 'submitted') && (
                          <div style={{ background: '#f5f3ff', border: '1px solid #c7d2fe', borderRadius: '10px', padding: '8px 12px', fontSize: '.8rem', color: '#4338ca', display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span style={{ animation: 'spin 1s linear infinite', display: 'inline-block' }}>⚡</span>
                            <span>Agent 正在实时执行中 (已捕获 <strong>{transcript.length}</strong> 条实时步骤，自动刷新中…)</span>
                          </div>
                        )}

                        {/* Timeline Vertical Guide Line */}
                        <div
                          style={{
                            position: 'absolute',
                            left: 9,
                            top: 12,
                            bottom: 12,
                            width: 2,
                            background: '#cbd5e1',
                            zIndex: 0,
                          }}
                        />

                        {transcript.map((t: any, i: number) => {
                          const isEvent = t.type === 'event' || t.type === 'header';
                          const isSystem = t.role === 'system';
                          const isAssistant = t.role === 'assistant';
                          const isTool = t.role === 'tool';

                          let dotChar = '•';
                          let dotBg = '#fff';
                          let dotBorder = '#94a3b8';
                          let cardBg = '#ffffff';
                          let cardBorder = '#e2e8f0';

                          if (isEvent) {
                            dotChar = '⚡'; dotBg = '#fef3c7'; dotBorder = '#f59e0b';
                            cardBg = '#fffbeb'; cardBorder = '#fde68a';
                          } else if (isSystem) {
                            dotChar = '📋'; dotBg = '#f1f5f9'; dotBorder = '#64748b';
                            cardBg = '#f8fafc'; cardBorder = '#e2e8f0';
                          } else if (isAssistant) {
                            dotChar = '🧠'; dotBg = '#f3e8ff'; dotBorder = '#9333ea';
                            cardBg = '#faf5ff'; cardBorder = '#e9d5ff';
                          } else if (isTool) {
                            dotChar = '🔧'; dotBg = '#d1fae5'; dotBorder = '#10b981';
                            cardBg = '#ecfdf5'; cardBorder = '#a7f3d0';
                          }

                          const timeStr = formatTimeOnly(t.ts);
                          const reqMeta = t.request_meta || {};
                          const usage = t.usage || {};

                          return (
                            <div key={i} style={{ position: 'relative', zIndex: 1 }}>
                              {/* Dot */}
                              <div
                                style={{
                                  position: 'absolute',
                                  left: -24,
                                  top: 10,
                                  width: 20,
                                  height: 20,
                                  borderRadius: '50%',
                                  background: dotBg,
                                  border: `2px solid ${dotBorder}`,
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  fontSize: '10px',
                                  boxShadow: '0 2px 4px rgba(0,0,0,0.05)',
                                }}
                              >
                                {dotChar}
                              </div>

                              {/* Card */}
                              <div
                                style={{
                                  borderRadius: '12px',
                                  border: `1px solid ${cardBorder}`,
                                  background: cardBg,
                                  padding: '12px 14px',
                                  boxShadow: '0 1px 3px rgba(0,0,0,0.02)',
                                }}
                              >
                                {/* Card Title Line */}
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                    <span
                                      style={{
                                        display: 'inline-block',
                                        padding: '2px 8px',
                                        borderRadius: '6px',
                                        fontSize: '10px',
                                        fontWeight: 700,
                                        background: dotBg,
                                        color: dotBorder,
                                        textTransform: 'uppercase',
                                      }}
                                    >
                                      {isEvent ? (t.event || 'EVENT') : isSystem ? 'SYSTEM PROMPT' : isAssistant ? `AI THINKING (TURN ${t.turn != null ? t.turn : i})` : `TOOL RESPONSE (${t.tool || 'MCP'})`}
                                    </span>
                                    {t.label && <span style={{ fontSize: '.72rem', color: '#64748b', fontWeight: 600 }}>[{t.label}]</span>}
                                  </div>
                                  <span style={{ fontSize: '.72rem', color: '#94a3b8', fontFamily: 'monospace' }}>{timeStr}</span>
                                </div>

                                {/* HTTP API REQUEST BANNER (CUA Log Style Endpoint Bar) */}
                                {(isAssistant || isSystem || isTool) && (
                                  <div style={{ marginTop: 4, marginBottom: 8, padding: '6px 10px', background: '#0f172a', color: '#94a3b8', borderRadius: '8px', fontFamily: 'monospace', fontSize: '11px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
                                    <div>
                                      <span style={{ color: '#38bdf8', fontWeight: 'bold' }}>{reqMeta.method || (isTool ? 'EXEC' : 'POST')}</span>{' '}
                                      <span style={{ color: '#f1f5f9' }}>{reqMeta.endpoint || (isTool ? `tool://${t.tool || 'mcp'}` : `/chat/completions`)}</span>
                                    </div>
                                    <div style={{ display: 'flex', gap: 10, fontSize: '10px' }}>
                                      {t.model && <span style={{ color: '#c084fc' }}>model: {t.model}</span>}
                                      {usage.prompt_tokens != null && (
                                        <span style={{ color: '#34d399' }}>
                                          tokens: in={usage.prompt_tokens} / out={usage.completion_tokens || 0}
                                        </span>
                                      )}
                                      {t.finish_reason && <span style={{ color: '#f59e0b' }}>finish: {t.finish_reason}</span>}
                                    </div>
                                  </div>
                                )}

                                {/* EVENT CONTENT */}
                                {isEvent && (
                                  <div style={{ fontSize: '.82rem', color: '#92400e', fontWeight: 500 }}>
                                    {t.detail || t.event || JSON.stringify(t)}
                                  </div>
                                )}

                                {/* SYSTEM PROMPT (Accordion Collapsible) */}
                                {isSystem && t.content && (
                                  <details open={expandAll} style={{ marginTop: 4 }}>
                                    <summary style={{ fontSize: '11px', fontWeight: 600, color: '#4f46e5', cursor: 'pointer', userSelect: 'none' }}>
                                      ▶ 展开查看 System Prompt 完整指令 (共 {t.content.length} 字)
                                    </summary>
                                    <pre style={{ background: '#0f172a', color: '#e2e8f0', padding: 12, borderRadius: 8, fontSize: '11px', marginTop: 8, maxHeight: 450, overflow: 'auto', whiteSpace: 'pre-wrap', fontFamily: 'monospace' }}>
                                      {t.content}
                                    </pre>
                                  </details>
                                )}

                                {/* ASSISTANT RESPONSE & TOOL CALLS */}
                                {isAssistant && (
                                  <div>
                                    {t.content && (
                                      <div style={{ fontSize: '.85rem', color: '#3b0764', lineHeight: 1.6, whiteSpace: 'pre-wrap', background: 'rgba(255,255,255,0.8)', padding: 10, borderRadius: 8, border: '1px solid #f3e8ff' }}>
                                        {t.content}
                                      </div>
                                    )}
                                    {t.tool_calls && t.tool_calls.length > 0 && (
                                      <div style={{ marginTop: 8 }}>
                                        <div style={{ fontSize: '.75rem', fontWeight: 700, color: '#7e22ce', marginBottom: 4 }}>🛠️ 发起工具调用 ({t.tool_calls.length} 个):</div>
                                        {t.tool_calls.map((tc: any, idx: number) => {
                                          const tcName = tc.name || tc.function?.name || 'tool';
                                          const tcArgs = typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments, null, 2);
                                          return (
                                            <div key={idx} style={{ background: '#0f172a', borderRadius: 8, padding: '8px 12px', marginTop: 6 }}>
                                              <div style={{ color: '#38bdf8', fontSize: '11px', fontWeight: 'bold', fontFamily: 'monospace' }}>
                                                🔧 {tcName}
                                              </div>
                                              <details open={expandAll} style={{ marginTop: 4 }}>
                                                <summary style={{ fontSize: '10px', color: '#94a3b8', cursor: 'pointer', fontFamily: 'monospace' }}>
                                                  ▶ 展开查看 Tool Arguments & Request Payload
                                                </summary>
                                                <pre style={{ background: 'transparent', color: '#34d399', padding: 0, margin: '6px 0 0 0', fontSize: '11px', whiteSpace: 'pre-wrap', fontFamily: 'monospace' }}>
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

                                {/* TOOL RESPONSE (Accordion Collapsible Payload & Response) */}
                                {isTool && (
                                  <div>
                                    <div style={{ fontSize: '.82rem', fontWeight: 600, color: '#065f46', marginBottom: 4 }}>
                                      ✅ 工具 [{t.tool || 'MCP'}] 执行完成
                                    </div>
                                    <details open={expandAll} style={{ marginTop: 6 }}>
                                      <summary style={{ fontSize: '11px', fontWeight: 600, color: '#059669', cursor: 'pointer', userSelect: 'none' }}>
                                        ▶ 展开查看详细请求参数 (Request Payload) & 响应上下文 (Response)
                                      </summary>
                                      <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                                        {t.input && (
                                          <div>
                                            <div style={{ fontSize: '10px', color: '#64748b', fontWeight: 'bold', marginBottom: 2 }}>[Input Arguments & Payload]</div>
                                            <pre style={{ background: '#0f172a', color: '#38bdf8', padding: 10, borderRadius: 6, fontSize: '11px', margin: 0, whiteSpace: 'pre-wrap' }}>
                                              {typeof t.input === 'string' ? t.input : JSON.stringify(t.input, null, 2)}
                                            </pre>
                                          </div>
                                        )}
                                        {t.output && (
                                          <div>
                                            <div style={{ fontSize: '10px', color: '#64748b', fontWeight: 'bold', marginBottom: 2 }}>[Response Result Context]</div>
                                            <pre style={{ background: '#0f172a', color: '#34d399', padding: 10, borderRadius: 6, fontSize: '11px', margin: 0, maxHeight: 450, overflow: 'auto', whiteSpace: 'pre-wrap' }}>
                                              {t.output}
                                            </pre>
                                          </div>
                                        )}
                                      </div>
                                    </details>
                                  </div>
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

      </div>
    </div>
  );
}
