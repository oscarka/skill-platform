import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';

const STATUS_LABEL: Record<string, string> = {
  pending: '待审核', reviewing: 'AI 评审中…', published: '已发布',
  rejected: '已拒绝', disabled: '已禁用',
};

export default function SkillDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [skill, setSkill] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [reviewing, setReviewing] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [showReject, setShowReject] = useState(false);
  const [h5Config, setH5Config] = useState<any>(null);
  const [h5Editing, setH5Editing] = useState(false);
  const [sandboxing, setSandboxing] = useState(false);
  const [sandboxProgress, setSandboxProgress] = useState<{step:string;detail:string;ts:string;elapsed_s?:number}[]>([]);
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [showTrace, setShowTrace] = useState(false);

  const load = () => {
    api.skills.get(id!).then(d => {
      setSkill(d.skill);
      if (d.skill.h5_config) setH5Config(d.skill.h5_config);
      else if (d.skill.ai_review?.h5_config_suggestion) setH5Config(d.skill.ai_review.h5_config_suggestion);
    }).finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [id]);

  // 轮询：sandbox_status === 'running' 时每 5 秒刷新 + 获取进度
  // 注意：done 后保留 events（不清空），让用户看到完整日志
  useEffect(() => {
    const fetchProgress = async () => {
      try {
        const r = await fetch(`/api/skills/${id}/sandbox-progress`);
        const d = await r.json();
        if (d.events && d.events.length > 0) setSandboxProgress(d.events);
      } catch {}
      load();
    };

    if (!skill) return;

    if (skill.sandbox_status === 'running') {
      fetchProgress(); // 立即查一次
      const timer = setInterval(fetchProgress, 5000);
      return () => clearInterval(timer);
    } else {
      // 非 running 时做一次最终 fetch（展示已完成的日志），不清空 events
      fetchProgress();
    }
  }, [skill?.sandbox_status]);


  const flash = (type: 'success' | 'error', text: string) => {
    setMsg({ type, text });
    setTimeout(() => setMsg(null), 4000);
  };

  const handleReview = async () => {
    setReviewing(true);
    try {
      await api.skills.review(id!);
      flash('success', 'AI 评审完成，请查看评审报告');
      load();
    } catch (e: any) { flash('error', e.message); }
    finally { setReviewing(false); }
  };

  const handlePublish = async () => {
    try {
      await api.skills.publish(id!);
      flash('success', 'Skill 已发布！');
      load();
    } catch (e: any) { flash('error', e.message); }
  };

  const handleReject = async () => {
    if (!rejectReason.trim()) return;
    try {
      await api.skills.reject(id!, rejectReason);
      setShowReject(false);
      flash('success', '已拒绝');
      load();
    } catch (e: any) { flash('error', e.message); }
  };

  const handleSaveH5 = async () => {
    try {
      await api.skills.setH5Config(id!, h5Config);
      flash('success', 'H5 配置已保存');
      setH5Editing(false);
      load();
    } catch (e: any) { flash('error', e.message); }
  };

  const handleSandboxTest = async () => {
    setSandboxing(true);
    try {
      await api.skills.sandboxTest(id!);
      flash('success', '沙箱测试已启动，AI 正在运行 ReAct 循环…');
      load();
    } catch (e: any) { flash('error', e.message); }
    finally { setSandboxing(false); }
  };

  const [uploadingScripts, setUploadingScripts] = useState(false);
  const handleUploadScripts = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingScripts(true);
    try {
      await (api.skills as any).uploadScripts(id!, file);
      flash('success', `✅ scripts/ 已上传：${file.name}，可以重新运行沙箱测试`);
      load();
    } catch (err: any) { flash('error', err.message); }
    finally { setUploadingScripts(false); e.target.value = ''; }
  };


  if (loading) return <div className="loading">加载中…</div>;
  if (!skill) return <div className="alert alert-error">Skill 不存在</div>;

  const review = skill.ai_review;
  const scoreClass = review?.score >= 80 ? 'score-high' : review?.score >= 60 ? 'score-mid' : 'score-low';

  return (
    <div>
      {/* Header */}
      <div className="page-header">
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
            <h1>{skill.name}</h1>
            <span className={`badge badge-${skill.status}`}>{STATUS_LABEL[skill.status]}</span>
            <span className={`badge badge-${skill.type}`}>{skill.type === 'internal' ? '内部' : '外部'}</span>
          </div>
          <p>{skill.description || '（无描述）'} · {skill.author_name || '未署名'}</p>
        </div>
        <button className="btn btn-ghost" onClick={() => navigate('/skills')}>← 返回</button>
      </div>

      {msg && <div className={`alert alert-${msg.type}`}>{msg.text}</div>}

      {/* Action Bar */}
      <div className="card mb-4">
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <button className="btn btn-secondary" onClick={handleReview} disabled={reviewing || skill.status === 'reviewing'}>
            {reviewing ? '⏳ 评审中…' : '🤖 触发 AI 评审'}
          </button>
          {skill.status !== 'published' && (
            <button className="btn btn-success" onClick={handlePublish}
              disabled={skill.type === 'external' && !skill.h5_config}>
              ✅ 发布 Skill
            </button>
          )}
          <button className="btn btn-danger btn-sm" onClick={() => setShowReject(true)}>❌ 拒绝</button>
          <button
            className="btn btn-secondary btn-sm"
            onClick={handleSandboxTest}
            disabled={sandboxing || skill.sandbox_status === 'running'}
            title="在 AI 沙箱中测试这个技能的 ReAct 循环">
            {skill.sandbox_status === 'running' ? '🔄 测试运行中…' : '🐳 沙箱测试'}
          </button>
          <button
            className="btn btn-sm"
            style={{ color: 'var(--danger)' }}
            onClick={async () => {
              if (!confirm(`确定要删除 Skill「${skill.name}」吗？此操作不可恢复。`)) return;
              try { await api.skills.delete(id!); navigate('/skills'); } catch { alert('删除失败'); }
            }}
            title="永久删除这个 Skill">
            🗑️ 删除
          </button>
          <span className="text-muted text-xs ml-auto">
            创建：{new Date(skill.created_at).toLocaleDateString('zh-CN')}
            {skill.preferred_model && ` · 模型：${skill.preferred_model}`}
          </span>
        </div>
        {skill.type === 'external' && !skill.h5_config && (
          <div className="alert alert-info" style={{ marginTop: 10, marginBottom: 0 }}>
            💡 外部 Skill 发布前需先确认 H5 配置。请先触发 AI 评审获取建议，然后在下方确认。
          </div>
        )}
        {showReject && (
          <div style={{ marginTop: 14, display: 'flex', gap: 8, alignItems: 'center' }}>
            <input className="form-input" style={{ flex: 1 }} placeholder="拒绝原因…" value={rejectReason} onChange={e => setRejectReason(e.target.value)} />
            <button className="btn btn-danger btn-sm" onClick={handleReject}>确认拒绝</button>
            <button className="btn btn-ghost btn-sm" onClick={() => setShowReject(false)}>取消</button>
          </div>
        )}
      </div>

      {/* AI Review */}
      {review && (
        <div className="card mb-4">
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16 }}>
            <div className={`score-ring ${scoreClass}`}>{review.score}</div>
            <div style={{ flex: 1 }}>
              <div className="card-title" style={{ marginBottom: 6 }}>🤖 AI 评审报告</div>
              <p style={{ color: 'var(--gray-600)', marginBottom: 12 }}>{review.summary}</p>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                {review.strengths?.length > 0 && (
                  <div>
                    <div style={{ fontSize: '.8rem', fontWeight: 600, color: 'var(--success)', marginBottom: 6 }}>✅ 优点</div>
                    <ul style={{ paddingLeft: 16, fontSize: '.85rem', color: 'var(--gray-600)' }}>
                      {review.strengths.map((s: string, i: number) => <li key={i} style={{ marginBottom: 4 }}>{s}</li>)}
                    </ul>
                  </div>
                )}
                {review.weaknesses?.length > 0 && (
                  <div>
                    <div style={{ fontSize: '.8rem', fontWeight: 600, color: 'var(--danger)', marginBottom: 6 }}>⚠️ 不足</div>
                    <ul style={{ paddingLeft: 16, fontSize: '.85rem', color: 'var(--gray-600)' }}>
                      {review.weaknesses.map((s: string, i: number) => <li key={i} style={{ marginBottom: 4 }}>{s}</li>)}
                    </ul>
                  </div>
                )}
              </div>
              {review.suggestions?.length > 0 && (
                <div style={{ marginTop: 12 }}>
                  <div style={{ fontSize: '.8rem', fontWeight: 600, color: 'var(--primary)', marginBottom: 6 }}>💡 改进建议</div>
                  <ul style={{ paddingLeft: 16, fontSize: '.85rem', color: 'var(--gray-600)' }}>
                    {review.suggestions.map((s: string, i: number) => <li key={i} style={{ marginBottom: 4 }}>{s}</li>)}
                  </ul>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* H5 Config (External only) */}
      {skill.type === 'external' && h5Config && (
        <div className="card mb-4">
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
            <div className="card-title" style={{ margin: 0 }}>📱 H5 配置</div>
            <div style={{ marginLeft: 8 }}>
              {skill.h5_config ? <span className="badge badge-published">已锁定</span> : <span className="badge badge-pending">AI 建议（待确认）</span>}
            </div>
            <button className="btn btn-ghost btn-sm ml-auto" onClick={() => setH5Editing(!h5Editing)}>
              {h5Editing ? '收起' : '✏️ 编辑'}
            </button>
            {!skill.h5_config && (
              <button className="btn btn-primary btn-sm" style={{ marginLeft: 8 }} onClick={handleSaveH5}>确认保存</button>
            )}
          </div>
          {h5Editing ? (
            <div>
              <div className="form-group">
                <label className="form-label">标题</label>
                <input className="form-input" value={h5Config.title || ''} onChange={e => setH5Config({ ...h5Config, title: e.target.value })} />
              </div>
              <div className="form-group">
                <label className="form-label">描述</label>
                <input className="form-input" value={h5Config.description || ''} onChange={e => setH5Config({ ...h5Config, description: e.target.value })} />
              </div>
              <div className="form-group">
                <label className="form-label">配置 JSON（高级）</label>
                <textarea className="form-textarea font-mono" rows={10} style={{ fontSize: '.8rem' }}
                  value={JSON.stringify(h5Config, null, 2)}
                  onChange={e => { try { setH5Config(JSON.parse(e.target.value)); } catch { } }} />
              </div>
              <button className="btn btn-primary btn-sm" onClick={handleSaveH5}>💾 保存 H5 配置</button>
            </div>
          ) : (
            <div>
              <p><strong>标题：</strong>{h5Config.title}</p>
              <p style={{ marginTop: 4 }}><strong>描述：</strong>{h5Config.description}</p>
              {h5Config.fields?.length > 0 && (
                <div style={{ marginTop: 10 }}>
                  <div style={{ fontSize: '.8rem', fontWeight: 600, marginBottom: 6, color: 'var(--gray-600)' }}>表单字段：</div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {h5Config.fields.map((f: any) => (
                      <span key={f.key} className="badge" style={{ background: 'var(--gray-100)', color: 'var(--gray-700)' }}>
                        {f.label}{f.required ? ' *' : ''}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {h5Config.uploads && (
                <div style={{ marginTop: 10 }}>
                  <div style={{ fontSize: '.8rem', fontWeight: 600, marginBottom: 4, color: 'var(--gray-600)' }}>文件上传：</div>
                  <span className="text-sm text-muted">最多 {h5Config.uploads.maxFiles} 个文件 · {h5Config.uploads.label}</span>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Sandbox Test Result */}
      {(() => {
        const st = skill.sandbox_test ? (() => { try { return JSON.parse(skill.sandbox_test); } catch { return null; } })() : null;
        const status = skill.sandbox_status || 'none';
        return (
          <div className="card mb-4">
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12, gap: 10 }}>
              <div className="card-title" style={{ margin: 0 }}>🐳 沙箱测试</div>
              {status === 'running' && <span className="badge" style={{ background: '#e8f4fd', color: '#1a6fab', animation: 'pulse 1.5s infinite' }}>● 运行中…</span>}
              {status === 'done' && st && <span className={`badge ${st.passed ? 'badge-published' : 'badge-rejected'}`}>{st.passed ? '✅ AI 通过' : '❌ AI 不通过'} · {st.score}分</span>}
              {status === 'failed' && <span className="badge badge-rejected">测试失败</span>}
              {status !== 'none' && st && <span className="text-xs text-muted ml-auto">{st.durationMs ? `${(st.durationMs / 1000).toFixed(1)}s` : ''} · {st.model}</span>}
            </div>

            {status === 'none' && (
              <p className="text-muted text-sm">点击「沙箱测试」按钮，AI 将运行 3 轮 ReAct 循环测试这个技能。</p>
            )}

            {status === 'running' && (
              <div>
                <div style={{ padding: '12px 0 8px', color: 'var(--gray-500)', display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: '1.4rem' }}>⚙️</span>
                  <span>AI Agent 正在沙箱中运行（Cloud Run Job），预计 2-5 分钟…</span>
                </div>
                {sandboxProgress.length > 0 && (
                  <div style={{
                    background: '#0d1117', borderRadius: 8, padding: '12px 16px',
                    fontFamily: 'monospace', fontSize: '.78rem', maxHeight: 200,
                    overflowY: 'auto', marginTop: 8
                  }}>
                    {sandboxProgress.map((e, i) => {
                      const icon = e.step === 'submit' ? '📤' : e.step === 'running' ? '🚀'
                        : e.step.startsWith('tool:') ? '🔧' : e.step.startsWith('turn_') ? '🤖'
                        : e.step === 'done' ? '✅' : e.step === 'error' ? '❌' : '•';
                      const elapsed = e.elapsed_s ? ` [${e.elapsed_s}s]` : '';
                      return (
                        <div key={i} style={{ color: e.step === 'error' ? '#ff6b6b' : e.step === 'done' ? '#69db7c' : '#a0cfff', marginBottom: 2 }}>
                          {icon} <span style={{ color: '#888' }}>{new Date(e.ts).toLocaleTimeString()}{elapsed}</span> {e.step}: <span style={{ color: '#ddd' }}>{e.detail}</span>
                        </div>
                      );
                    })}
                    <div id="progress-bottom" />
                  </div>
                )}
              </div>
            )}

            {status === 'done' && st && (
              <div>
                {/* 评语 */}
                <div style={{ background: 'var(--gray-50)', borderRadius: 'var(--radius-sm)', padding: '12px 16px', marginBottom: 16 }}>
                  <p style={{ fontWeight: 600, marginBottom: 4 }}>📋 {st.comment}</p>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 8 }}>
                    {st.strengths?.length > 0 && (
                      <div>
                        <div style={{ fontSize: '.78rem', fontWeight: 600, color: 'var(--success)', marginBottom: 4 }}>✅ 优点</div>
                        <ul style={{ paddingLeft: 14, fontSize: '.83rem', color: 'var(--gray-600)' }}>
                          {st.strengths.map((s: string, i: number) => <li key={i}>{s}</li>)}
                        </ul>
                      </div>
                    )}
                    {st.weaknesses?.length > 0 && (
                      <div>
                        <div style={{ fontSize: '.78rem', fontWeight: 600, color: 'var(--danger)', marginBottom: 4 }}>⚠️ 不足</div>
                        <ul style={{ paddingLeft: 14, fontSize: '.83rem', color: 'var(--gray-600)' }}>
                          {st.weaknesses.map((s: string, i: number) => <li key={i}>{s}</li>)}
                        </ul>
                      </div>
                    )}
                  </div>
                </div>

                {/* 测试输入 */}
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: '.8rem', fontWeight: 600, color: 'var(--gray-500)', marginBottom: 4 }}>📥 测试输入（AI 生成）</div>
                  <pre style={{ background: '#f8f9fa', border: '1px solid var(--gray-200)', borderRadius: 6, padding: '10px 12px', fontSize: '.82rem', whiteSpace: 'pre-wrap', maxHeight: 150, overflow: 'auto' }}>{st.testInput}</pre>
                </div>

                {/* 最终输出 */}
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: '.8rem', fontWeight: 600, color: 'var(--gray-500)', marginBottom: 4 }}>📤 最终输出</div>
                  <pre style={{ background: '#f8f9fa', border: '1px solid var(--gray-200)', borderRadius: 6, padding: '10px 12px', fontSize: '.82rem', whiteSpace: 'pre-wrap', maxHeight: 300, overflow: 'auto' }}>{st.finalOutput}</pre>
                </div>

                {/* Transcript 完整对话记录（仿 OpenClaw JSONL Transcript） */}
                {(st.transcript?.length > 0 || st.trace?.length > 0) && (
                  <div>
                    <button className="btn btn-ghost btn-sm" onClick={() => setShowTrace(!showTrace)}>
                      {showTrace ? '▲ 收起' : `▼ 查看完整对话记录（${st.transcript?.length || st.trace?.length} 条）`}
                    </button>
                    {showTrace && (
                      <div style={{ marginTop: 8, borderLeft: '3px solid var(--gray-200)', paddingLeft: 12, maxHeight: 600, overflow: 'auto' }}>
                        {(st.transcript || st.trace || []).map((t: any, i: number) => (
                          <div key={i} style={{ marginBottom: 12 }}>
                            <div style={{
                              fontSize: '.78rem', fontWeight: 600, marginBottom: 4,
                              color: t.role === 'assistant' ? 'var(--primary)' : t.role === 'tool' ? 'var(--success)' : 'var(--gray-500)'
                            }}>
                              {t.role === 'assistant' ? `🤖 AI 回复（轮 ${t.turn}）` : t.role === 'tool' ? `🔧 ${t.tool || '工具'}` : `轮 ${t.round || t.turn}`}
                              {t.ts && <span style={{ fontWeight: 400, color: 'var(--gray-400)', marginLeft: 8 }}>{t.ts.slice(11,19)}</span>}
                            </div>
                            {/* AI 回复内容 */}
                            {t.role === 'assistant' && t.content && (
                              <pre style={{ background: '#f0f4ff', borderRadius: 4, padding: '8px 10px', fontSize: '.8rem', whiteSpace: 'pre-wrap', maxHeight: 400, overflow: 'auto', margin: 0 }}>{t.content}</pre>
                            )}
                            {/* Tool 输入 */}
                            {t.role === 'tool' && t.input && (
                              <div style={{ marginBottom: 4 }}>
                                <div style={{ fontSize: '.75rem', color: 'var(--gray-500)' }}>输入：</div>
                                <pre style={{ background: '#f0fff4', borderRadius: 4, padding: '6px 8px', fontSize: '.78rem', whiteSpace: 'pre-wrap', maxHeight: 150, overflow: 'auto', margin: 0 }}>
                                  {typeof t.input === 'string' ? t.input : JSON.stringify(t.input, null, 2)}
                                </pre>
                              </div>
                            )}
                            {/* Tool 输出（完整，不截断） */}
                            {t.role === 'tool' && t.output && (
                              <div>
                                <div style={{ fontSize: '.75rem', color: 'var(--gray-500)' }}>输出：</div>
                                <pre style={{ background: '#fff8f0', borderRadius: 4, padding: '6px 8px', fontSize: '.78rem', whiteSpace: 'pre-wrap', maxHeight: 400, overflow: 'auto', margin: 0 }}>{t.output}</pre>
                              </div>
                            )}
                            {/* 旧 trace 兼容 */}
                            {t.content && t.role !== 'assistant' && t.role !== 'tool' && (
                              <pre style={{ background: '#f8f9fa', borderRadius: 4, padding: '8px 10px', fontSize: '.8rem', whiteSpace: 'pre-wrap', maxHeight: 200, overflow: 'auto', margin: 0 }}>{t.content}</pre>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* 人工批准操作 */}
                <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--gray-200)', display: 'flex', gap: 10, alignItems: 'center' }}>
                  <span style={{ fontSize: '.85rem', color: 'var(--gray-600)' }}>人工确认：</span>
                  <button className="btn btn-success btn-sm" onClick={handlePublish} disabled={!skill.h5_config && skill.type === 'external'}
                    title={!skill.h5_config && skill.type === 'external' ? '外部 Skill 需先配置 H5 表单' : ''}>
                    ✅ 批准发布
                  </button>
                  <button className="btn btn-danger btn-sm" onClick={() => setShowReject(true)}>❌ 打回</button>
                  <button className="btn btn-ghost btn-sm" onClick={handleSandboxTest} style={{ marginLeft: 'auto' }}>🔄 重新测试</button>
                  {/* 上传 scripts zip（脚本类技能用）*/}
                  <label className="btn btn-ghost btn-sm" title="上传 skill zip 包提供 scripts/ 目录" style={{ cursor: 'pointer' }}>
                    {uploadingScripts ? '上传中…' : '📦 上传 scripts.zip'}
                    <input type="file" accept=".zip,.tar.gz" style={{ display: 'none' }} onChange={handleUploadScripts} disabled={uploadingScripts} />
                  </label>
                </div>
              </div>
            )}

            {status === 'failed' && st && (
              <div>
                <div className="alert alert-error" style={{ marginBottom: 10 }}>{st.comment}</div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <button className="btn btn-ghost btn-sm" onClick={handleSandboxTest}>🔄 重试</button>
                  <label className="btn btn-ghost btn-sm" title="上传 skill zip 包提供 scripts/ 目录" style={{ cursor: 'pointer' }}>
                    {uploadingScripts ? '上传中…' : '📦 上传 scripts.zip'}
                    <input type="file" accept=".zip,.tar.gz" style={{ display: 'none' }} onChange={handleUploadScripts} disabled={uploadingScripts} />
                  </label>
                </div>
              </div>
            )}
          </div>
        );
      })()}

      {/* Skill Content Preview */}
      <div className="card">
        <div className="card-title">{skill.skill_type === 'prompt' ? '📝 Prompt 模板' : '💻 执行代码'}</div>
        <pre style={{
          background: 'var(--gray-50)', border: '1px solid var(--gray-200)',
          borderRadius: 'var(--radius-sm)', padding: 14,
          fontSize: '.82rem', fontFamily: 'monospace',
          overflowX: 'auto', whiteSpace: 'pre-wrap', maxHeight: 300,
        }}>
          {skill.prompt_template || skill.code || '（无内容）'}
        </pre>
      </div>
    </div>
  );
}
