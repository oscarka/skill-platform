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

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadList = async (autoSelect = false) => {
    try {
      const res = await api.tickets.list({ status: filterStatus || undefined, q: q || undefined });
      const list = res.tickets || [];
      setTickets(list);
      setLoadingList(false);

      if (autoSelect && list.length > 0 && !selectedId) {
        setSelectedId(list[0].id);
      }

      // Check if polling is needed
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

  // Helper to extract transcript
  const rawAiLog = detailData?.result?.ai_log || '';
  let transcript: any[] = [];
  try {
    if (rawAiLog) transcript = JSON.parse(rawAiLog);
  } catch {
    transcript = [];
  }

  // Extract model name from transcript header if present
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
          <h1>📜 Agent 执行日志</h1>
          <p>全量查看每条工单的思考流程、工具调用、运行耗时与完整 AI 上下文</p>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '360px 1fr', gap: 16, minHeight: 'calc(100vh - 180px)' }}>
        
        {/* Left Side: Ticket List */}
        <div className="card" style={{ display: 'flex', flexDirection: 'column', padding: 12, height: '100%', overflow: 'hidden' }}>
          <form onSubmit={handleSearch} style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
            <input
              className="form-input"
              style={{ fontSize: '.8rem', padding: '4px 8px' }}
              placeholder="搜索工单标题/编号..."
              value={q}
              onChange={e => setQ(e.target.value)}
            />
            <button className="btn btn-secondary btn-sm" type="submit">搜索</button>
          </form>

          <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
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
              <div style={{ textAlign: 'center', padding: 20, color: 'var(--gray-400)', fontSize: '.85rem' }}>加载列表中...</div>
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
                      borderRadius: 'var(--radius-sm)',
                      cursor: 'pointer',
                      border: isSelected ? '2px solid var(--primary)' : '1px solid var(--gray-200)',
                      background: isSelected ? 'var(--primary-light)' : '#fff',
                      transition: 'all 0.15s ease',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                      <span className={`badge ${statusCfg.cls}`} style={{ fontSize: '.7rem' }}>{statusCfg.label}</span>
                      <span style={{ fontSize: '.72rem', color: 'var(--gray-400)' }}>
                        {new Date(t.created_at).toLocaleDateString('zh-CN')}
                      </span>
                    </div>
                    <div style={{ fontWeight: 600, fontSize: '.85rem', color: 'var(--gray-800)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {t.title}
                    </div>
                    <div style={{ fontSize: '.75rem', color: 'var(--gray-500)', marginTop: 2 }}>
                      Skill: {t.skill_name || t.skill_id}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Right Side: Log Detail */}
        <div className="card" style={{ display: 'flex', flexDirection: 'column', padding: 16, overflow: 'hidden' }}>
          {!selectedId ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--gray-400)' }}>
              <div style={{ fontSize: '3rem', marginBottom: 12 }}>📜</div>
              <div>请在左侧列表选择一条工单查看完整 Agent 上下文与执行日志</div>
            </div>
          ) : loadingDetail ? (
            <div style={{ textAlign: 'center', padding: 40, color: 'var(--gray-400)' }}>加载工单日志数据...</div>
          ) : !detailData ? (
            <div style={{ textAlign: 'center', padding: 40, color: 'var(--gray-400)' }}>未能找到该工单数据</div>
          ) : (
            <>
              {/* Header Info */}
              <div style={{ borderBottom: '1px solid var(--gray-200)', paddingBottom: 12, marginBottom: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 10 }}>
                  <div>
                    <h2 style={{ fontSize: '1.1rem', margin: '0 0 4px 0', color: 'var(--gray-900)' }}>
                      {detailData.ticket?.title}
                    </h2>
                    <div style={{ fontSize: '.8rem', color: 'var(--gray-500)', display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                      <span>Skill: <strong>{detailData.skill?.name || detailData.ticket?.skill_id}</strong></span>
                      <span>识别模型: <strong>{detectedModel}</strong></span>
                      <span>提交时间: {new Date(detailData.ticket?.created_at).toLocaleString('zh-CN')}</span>
                    </div>
                  </div>

                  {/* Model Selector & Reprocess Button */}
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <select
                      className="form-input"
                      style={{ fontSize: '.8rem', padding: '4px 8px', width: 'auto' }}
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
                    <button className="btn btn-primary btn-sm" onClick={handleReprocess} disabled={reprocessing}>
                      {reprocessing ? '⏳ 处理中...' : '🤖 指定模型重新运行'}
                    </button>
                  </div>
                </div>
              </div>

              {/* Tabs */}
              <div style={{ display: 'flex', gap: 8, borderBottom: '1px solid var(--gray-200)', marginBottom: 12 }}>
                <button
                  className={`btn btn-sm ${activeTab === 'transcript' ? 'btn-primary' : 'btn-ghost'}`}
                  onClick={() => setActiveTab('transcript')}
                >
                  ⚡ 执行上下文 & Step 追踪 ({transcript.length} 条记录)
                </button>
                <button
                  className={`btn btn-sm ${activeTab === 'output' ? 'btn-primary' : 'btn-ghost'}`}
                  onClick={() => setActiveTab('output')}
                >
                  📄 最终输出结果
                </button>
                <button
                  className={`btn btn-sm ${activeTab === 'json' ? 'btn-primary' : 'btn-ghost'}`}
                  onClick={() => setActiveTab('json')}
                >
                  🔍 原始 JSON 日志
                </button>
                {rawAiLog && (
                  <button className="btn btn-ghost btn-sm" onClick={downloadLog} style={{ marginLeft: 'auto', fontSize: '.78rem', color: 'var(--primary)' }}>
                    📥 下载完整 JSON
                  </button>
                )}
              </div>

              {/* Tab Content */}
              <div style={{ flex: 1, overflowY: 'auto', paddingRight: 4 }}>
                
                {/* TAB 1: TRANSCRIPT */}
                {activeTab === 'transcript' && (
                  <div>
                    {transcript.length === 0 ? (
                      <div style={{ textAlign: 'center', padding: 40, color: 'var(--gray-400)', fontSize: '.85rem' }}>
                        {detailData.result ? '暂无详细思考与工具调用日志（可能是纯文本类型或传统运行模式）' : '工单尚未执行完成'}
                      </div>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                        {transcript.map((t: any, i: number) => {
                          const isEvent = t.type === 'event';
                          const isSystem = t.role === 'system';
                          const isAssistant = t.role === 'assistant';
                          const isTool = t.role === 'tool';

                          return (
                            <div
                              key={i}
                              style={{
                                border: '1px solid var(--gray-200)',
                                borderRadius: 'var(--radius-sm)',
                                background: isEvent ? '#fffbf0' : isSystem ? '#fafafa' : isAssistant ? '#f4f7ff' : '#f0fff4',
                                padding: '12px 14px',
                              }}
                            >
                              {/* Entry Header */}
                              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                                <div style={{ fontWeight: 600, fontSize: '.83rem', color: isAssistant ? 'var(--primary)' : isTool ? '#047857' : isEvent ? '#b45309' : 'var(--gray-700)' }}>
                                  {isEvent ? `⚡ 事件: ${t.event || 'System Event'}`
                                    : isSystem ? `📋 System Prompt (${t.label || 'executor'})`
                                    : isAssistant ? `🤖 AI Turn ${t.turn != null ? t.turn : i}`
                                    : isTool ? `🔧 工具响应: ${t.tool || 'MCP/Internal Tool'}`
                                    : `Step ${i + 1}`}
                                </div>
                                {t.ts && <span style={{ fontSize: '.72rem', color: 'var(--gray-400)' }}>{t.ts.slice(11, 19)}</span>}
                              </div>

                              {/* Details per role */}
                              {isEvent && t.detail && (
                                <div style={{ fontSize: '.83rem', color: '#92400e', whiteSpace: 'pre-wrap' }}>{t.detail}</div>
                              )}

                              {isSystem && t.content && (
                                <pre style={{ background: '#fff', border: '1px solid var(--gray-200)', borderRadius: 4, padding: 10, fontSize: '.78rem', whiteSpace: 'pre-wrap', maxHeight: 400, overflow: 'auto', margin: 0, color: 'var(--gray-700)' }}>
                                  {t.content}
                                </pre>
                              )}

                              {isAssistant && (
                                <div>
                                  {t.content && (
                                    <pre style={{ background: '#fff', border: '1px solid #dbeafe', borderRadius: 4, padding: 10, fontSize: '.83rem', whiteSpace: 'pre-wrap', maxHeight: 600, overflow: 'auto', margin: '0 0 8px 0', lineHeight: 1.6 }}>
                                      {t.content}
                                    </pre>
                                  )}
                                  {t.tool_calls && t.tool_calls.length > 0 && (
                                    <div style={{ marginTop: 6 }}>
                                      <div style={{ fontSize: '.78rem', fontWeight: 600, color: 'var(--primary)', marginBottom: 4 }}>🛠️ 发起工具调用 ({t.tool_calls.length} 个):</div>
                                      {t.tool_calls.map((tc: any, idx: number) => (
                                        <div key={idx} style={{ background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 4, padding: '6px 10px', fontSize: '.78rem', marginBottom: 4 }}>
                                          <strong>{tc.name || tc.function?.name}</strong>
                                          <pre style={{ margin: '4px 0 0 0', whiteSpace: 'pre-wrap', fontSize: '.75rem', color: 'var(--gray-700)' }}>
                                            {typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments, null, 2)}
                                          </pre>
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              )}

                              {isTool && (
                                <div>
                                  {t.input && (
                                    <div style={{ marginBottom: 6 }}>
                                      <div style={{ fontSize: '.75rem', color: 'var(--gray-500)' }}>输入参数:</div>
                                      <pre style={{ background: '#fff', border: '1px solid var(--gray-200)', borderRadius: 4, padding: 6, fontSize: '.75rem', margin: 0 }}>
                                        {typeof t.input === 'string' ? t.input : JSON.stringify(t.input, null, 2)}
                                      </pre>
                                    </div>
                                  )}
                                  {t.output && (
                                    <div>
                                      <div style={{ fontSize: '.75rem', color: 'var(--gray-500)' }}>输出结果:</div>
                                      <pre style={{ background: '#fff', border: '1px solid #a7f3d0', borderRadius: 4, padding: 8, fontSize: '.78rem', whiteSpace: 'pre-wrap', maxHeight: 400, overflow: 'auto', margin: 0 }}>
                                        {t.output}
                                      </pre>
                                    </div>
                                  )}
                                </div>
                              )}
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
                      <div style={{ textAlign: 'center', padding: 40, color: 'var(--gray-400)' }}>尚未生成输出结果</div>
                    ) : (
                      <div
                        style={{
                          background: 'var(--gray-50)',
                          border: '1px solid var(--gray-200)',
                          borderRadius: 'var(--radius-sm)',
                          padding: '16px 18px',
                          fontSize: '.88rem',
                          lineHeight: 1.85,
                          whiteSpace: 'pre-wrap',
                          fontFamily: 'inherit',
                          color: 'var(--gray-800)',
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
                        background: '#1e293b',
                        color: '#f8fafc',
                        padding: 14,
                        borderRadius: 'var(--radius-sm)',
                        fontSize: '.78rem',
                        whiteSpace: 'pre-wrap',
                        overflowX: 'auto',
                        maxHeight: '70vh',
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
