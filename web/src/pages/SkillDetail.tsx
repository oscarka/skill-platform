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

  // 检测 skill 是否需要 Google OAuth（含 stitch/gcloud 类 MCP 的 plugin skill）
  const needsGoogleOAuth = (s: any) => {
    if (s.skill_type !== 'plugin') return false;
    const pc = s.plugin_config ? (typeof s.plugin_config === 'string' ? JSON.parse(s.plugin_config) : s.plugin_config) : {};
    const pt = (s.prompt_template || '').toLowerCase();
    return pt.includes('stitch') || pt.includes('gcloud') || pt.includes('google cloud') || pc.source === 'clawhub';
  };

  // 通用 OAuth 弹窗：打开指定授权 URL，通过 postMessage 接收回调结果
  const openOAuthPopup = (authUrl: string): Promise<{ hash: string; search: string } | null> => {
    return new Promise((resolve) => {
      const popup = window.open(authUrl, 'oauth-popup', 'width=500,height=620');
      const onMessage = (e: MessageEvent) => {
        if (e.origin !== window.location.origin) return;
        if (e.data?.type === 'oauth-callback') {
          window.removeEventListener('message', onMessage);
          clearTimeout(timer);
          resolve({ hash: e.data.hash || '', search: e.data.search || '' });
        }
      };
      window.addEventListener('message', onMessage);
      // 超时或关闭
      const timer = setTimeout(() => {
        window.removeEventListener('message', onMessage);
        popup?.close();
        resolve(null);
      }, 120000);
      // 用户手动关了弹窗
      const pollClose = setInterval(() => {
        if (popup?.closed) { clearInterval(pollClose); clearTimeout(timer); window.removeEventListener('message', onMessage); resolve(null); }
      }, 500);
    });
  };

  // Google OAuth：通过平台服务端 /auth/google/start 流程
  // Google OAuth：先从服务端拿 client ID，再做 implicit flow 弹窗
  const getGoogleToken = async (): Promise<string | null> => {
    const configRes = await fetch('/api/oauth/google/config').catch(() => null);
    const config = await configRes?.json().catch(() => ({}));
    if (!config?.configured || !config?.clientId) {
      alert('❌ 平台未配置 Google OAuth Client ID');
      return null;
    }
    const REDIRECT = `${window.location.origin}/oauth-callback.html`;
    const SCOPE = 'https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email';
    const url = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${config.clientId}&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=token&scope=${encodeURIComponent(SCOPE)}`;
    const result = await openOAuthPopup(url);
    if (!result) return null;
    const params = new URLSearchParams(result.hash.replace(/^#/, ''));
    return params.get('access_token');
  };


  // 一次性授权：存 token 到 DB，以后所有测试自动复用
  const handleAuthorize = async (provider: 'google') => {
    flash('success', `请在弹窗中完成 ${provider === 'google' ? 'Google' : provider} 授权…`);
    try {
      let token: string | null = null;
      if (provider === 'google') token = await getGoogleToken();
      if (!token) { flash('error', '授权取消或失败'); return; }
      // 存入 DB
      await fetch('/api/oauth/mcp-tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider,
          mcp_name: provider === 'google' ? 'stitch-mcp-auto' : undefined,
          access_token: token,
          expires_in: 3600,
        }),
      });
      flash('success', `✅ ${provider === 'google' ? 'Google' : provider} 已授权并保存，下次「🐳 沙箱测试」将自动使用`);
    } catch (e: any) { flash('error', e.message); }
  };

  const handleSandboxTest = async (withOAuth = false) => {
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
            onClick={() => handleSandboxTest(false)}
            disabled={sandboxing || skill.sandbox_status === 'running'}
            title="在 AI 沙箱中测试这个技能的 ReAct 循环">
            {skill.sandbox_status === 'running' ? '🔄 测试运行中…' : '🐳 沙箱测试'}
          </button>
          {skill.sandbox_status === 'running' && (
            <button
              className="btn btn-danger btn-sm"
              onClick={async () => {
                try {
                  await api.skills.sandboxCancel(id!);
                  flash('success', '已停止沙箱测试');
                  load();
                } catch (e: any) { flash('error', e.message); }
              }}
              title="停止当前沙箱测试">
              ⏹ 停止
            </button>
          )}
          {needsGoogleOAuth(skill) && (
            <button
              className="btn btn-sm"
              style={{ background: '#1a73e8', color: '#fff' }}
              onClick={() => handleAuthorize('google')}
              title="授权 Google 账号（一次性，之后测试自动复用）">
              🔗 授权 Google
            </button>
          )}
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
        const stRaw = skill.sandbox_test ? (() => { try { return JSON.parse(skill.sandbox_test); } catch { return null; } })() : null;
        // 兼容新旧格式：新格式 output 是 AI 返回的 JSON 字符串，需要二次解析
        const st = stRaw ? (() => {
          const parsed = { ...stRaw };
          // 尝试解析 output 字段（可能是 JSON 字符串）
          if (typeof parsed.output === 'string') {
            try {
              const inner = JSON.parse(parsed.output);
              parsed.score = inner.score ?? parsed.score;
              parsed.passed = inner.passed ?? parsed.passed;
              parsed.comment = inner.output || inner.notes || parsed.comment || parsed.output;
              parsed.finalOutput = inner.output || parsed.output;
              parsed.notes = inner.notes;
              parsed.test_results = inner.test_results;
              // 如果旧格式没有 strengths/weaknesses，自动生成
              if (!parsed.strengths && parsed.passed) {
                parsed.strengths = ['沙箱 AI Agent 执行成功'];
              }
            } catch {
              // output 不是 JSON，直接用
              parsed.finalOutput = parsed.output;
              parsed.comment = parsed.output;
            }
          }
          return parsed;
        })() : null;
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
                  <pre style={{ background: '#f8f9fa', border: '1px solid var(--gray-200)', borderRadius: 6, padding: '10px 12px', fontSize: '.82rem', whiteSpace: 'pre-wrap', maxHeight: 300, overflow: 'auto' }}>{st.finalOutput}{st.notes ? `\n\n💡 ${st.notes}` : ''}</pre>
                </div>

                {/* 逐 Test Case 详细结果 */}
                {st.test_results?.length > 0 && (
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ fontSize: '.8rem', fontWeight: 600, color: 'var(--gray-500)', marginBottom: 8 }}>📊 逐用例测试结果</div>
                    {st.test_results.map((tr: any, i: number) => (
                      <div key={i} className="card" style={{ marginBottom: 10, padding: 12 }}>
                        <div style={{ fontWeight: 600, fontSize: '.85rem', marginBottom: 6 }}>
                          {tr.response?.startsWith('Error') ? '❌' : '✅'} {tr.case}
                        </div>
                        <div style={{ fontSize: '.8rem', color: 'var(--gray-500)', marginBottom: 4 }}>用户输入：</div>
                        <pre style={{ background: '#f0f4ff', borderRadius: 4, padding: '6px 10px', fontSize: '.8rem', whiteSpace: 'pre-wrap', maxHeight: 100, overflow: 'auto', margin: '0 0 8px' }}>{tr.input}</pre>
                        <div style={{ fontSize: '.8rem', color: 'var(--gray-500)', marginBottom: 4 }}>Skill 完整回复：</div>
                        <pre style={{ background: '#f0fff4', borderRadius: 4, padding: '6px 10px', fontSize: '.8rem', whiteSpace: 'pre-wrap', maxHeight: 400, overflow: 'auto', margin: '0 0 8px' }}>{tr.response}</pre>
                        {tr.evaluation && (
                          <div style={{ fontSize: '.78rem', color: 'var(--gray-600)', fontStyle: 'italic' }}>📝 评价：{tr.evaluation}</div>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {/* Transcript 完整对话记录（OpenClaw 风格双份 transcript） */}
                {(st.transcript?.length > 0 || st.trace?.length > 0) && (
                  <div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      <button className="btn btn-ghost btn-sm" onClick={() => setShowTrace(!showTrace)}>
                        {showTrace ? '▲ 收起' : `▼ 查看对话记录（${st.transcript?.length || st.trace?.length} 条）`}
                      </button>
                      {/* 查看 GCS 完整版按钮 */}
                      {st.transcript_gcs && (
                        <button className="btn btn-ghost btn-sm" style={{ fontSize: '.75rem', color: 'var(--primary)' }}
                          onClick={async () => {
                            try {
                              const r = await fetch(`${(window as any).__API_BASE || ''}/api/skills/${skill.id}/transcript/full`);
                              const data = await r.json();
                              if (data.entries?.length) {
                                alert(`完整版 transcript：${data.entries.length} 条\n摘要：${JSON.stringify(data.summary, null, 2)}\n\n（完整版已存储在 GCS，当前显示截断版）`);
                              } else {
                                alert(data.message || '无完整版 transcript');
                              }
                            } catch { alert('读取失败'); }
                          }}>
                          📂 查看完整版（GCS）
                        </button>
                      )}
                    </div>
                    {showTrace && (
                      <div style={{ marginTop: 8, borderLeft: '3px solid var(--gray-200)', paddingLeft: 12, maxHeight: 600, overflow: 'auto' }}>
                        {(st.transcript || st.trace || []).map((t: any, i: number) => (
                          <div key={i} style={{ marginBottom: 12 }}>
                            {/* 条目头 */}
                            <div style={{
                              fontSize: '.78rem', fontWeight: 600, marginBottom: 4,
                              color: t.role === 'assistant' ? 'var(--primary)'
                                : t.role === 'tool' ? 'var(--success)'
                                : t.type === 'event' ? '#e67700'
                                : 'var(--gray-500)'
                            }}>
                              {t.type === 'event' ? `⚡ ${t.event || '事件'}`
                                : t.role === 'assistant' ? `🤖 AI 回复（轮 ${t.turn}）`
                                : t.role === 'tool' ? `🔧 ${t.tool || '工具'}`
                                : `轮 ${t.round || t.turn}`}
                              {t.ts && <span style={{ fontWeight: 400, color: 'var(--gray-400)', marginLeft: 8 }}>{t.ts.slice(11,19)}</span>}
                              {/* 截断标记 */}
                              {t.is_truncated && (
                                <span style={{ marginLeft: 8, fontSize: '.7rem', color: '#e67700', background: '#fff3e0', padding: '1px 6px', borderRadius: 3 }}>
                                  ✂️ 已截断{t.original_length ? ` (原 ${(t.original_length/1024).toFixed(1)}KB)` : ''}
                                </span>
                              )}
                              {/* Spill 文件标记 */}
                              {t.spill_path && (
                                <span style={{ marginLeft: 8, fontSize: '.7rem', color: '#1a6fab', background: '#e8f4fd', padding: '1px 6px', borderRadius: 3 }}>
                                  💾 大文件已落盘
                                </span>
                              )}
                            </div>
                            {/* 事件详情 */}
                            {t.type === 'event' && t.detail && (
                              <div style={{ fontSize: '.8rem', color: 'var(--gray-600)' }}>{t.detail}</div>
                            )}
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
                            {/* Tool 输出 */}
                            {t.role === 'tool' && t.output && (
                              <div>
                                <div style={{ fontSize: '.75rem', color: 'var(--gray-500)' }}>
                                  输出{t.is_truncated ? '（截断版）' : ''}：
                                </div>
                                <pre style={{ background: '#fff8f0', borderRadius: 4, padding: '6px 8px', fontSize: '.78rem', whiteSpace: 'pre-wrap', maxHeight: 400, overflow: 'auto', margin: 0 }}>{t.output}</pre>
                              </div>
                            )}
                            {/* Tool calls 列表 */}
                            {t.role === 'assistant' && t.tool_calls?.length > 0 && (
                              <div style={{ marginTop: 4, fontSize: '.75rem', color: 'var(--gray-500)' }}>
                                🔧 调用工具：{t.tool_calls.map((tc: any) => tc.name).join(', ')}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}


                {/* 人工批准操作 */}
                <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--gray-200)', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '.85rem', color: 'var(--gray-600)' }}>人工确认：</span>
                  <button className="btn btn-success btn-sm" onClick={handlePublish} disabled={!skill.h5_config && skill.type === 'external'}
                    title={!skill.h5_config && skill.type === 'external' ? '外部 Skill 需先配置 H5 表单' : ''}>
                    ✅ 批准发布
                  </button>
                  <button className="btn btn-danger btn-sm" onClick={() => setShowReject(true)}>❌ 打回</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => handleSandboxTest(false)} style={{ marginLeft: 'auto' }}>🔄 重新测试</button>
                  {/* 下载完整上下文 MD */}
                  <button
                    className="btn btn-ghost btn-sm"
                    title="下载完整测试上下文（请求+输出+对话记录）"
                    onClick={() => {
                      // 生成 Markdown 文档
                      const lines: string[] = [];
                      const now = new Date().toLocaleString('zh-CN');
                      const skillName = skill.name || skill.id;

                      lines.push(`# 沙箱测试完整上下文`);
                      lines.push(`\n> Skill: **${skillName}** · 导出时间: ${now}\n`);

                      // Skill 定义
                      lines.push(`## 📋 Skill 定义\n`);
                      lines.push('```yaml');
                      lines.push(skill.prompt_template || skill.code || skill.definition || '（无）');
                      lines.push('```\n');

                      // 测试用例输入
                      if (st?.testInput) {
                        lines.push(`## 📥 测试输入（AI 生成）\n`);
                        lines.push('```json');
                        lines.push(st.testInput);
                        lines.push('```\n');
                      }

                      // AI 评测结论
                      if (st?.comment) {
                        lines.push(`## 🏆 AI 评测结论\n`);
                        lines.push(`**综合评价：** ${st.comment}\n`);
                        if (st.score !== undefined) lines.push(`**评分：** ${st.score}/100\n`);
                        if (st.strengths?.length) {
                          lines.push(`### ✅ 优点\n`);
                          st.strengths.forEach((s: string) => lines.push(`- ${s}`));
                          lines.push('');
                        }
                        if (st.weaknesses?.length) {
                          lines.push(`### ⚠️ 不足\n`);
                          st.weaknesses.forEach((s: string) => lines.push(`- ${s}`));
                          lines.push('');
                        }
                      }

                      // 逐用例测试结果
                      if (st?.test_results?.length) {
                        lines.push(`## 📊 逐用例测试结果\n`);
                        st.test_results.forEach((tr: any, i: number) => {
                          const ok = !tr.response?.startsWith('Error');
                          lines.push(`### ${ok ? '✅' : '❌'} 用例 ${i + 1}：${tr.case || ''}\n`);
                          if (tr.input) {
                            lines.push(`**用户输入：**\n`);
                            lines.push('```');
                            lines.push(tr.input);
                            lines.push('```\n');
                          }
                          if (tr.response) {
                            lines.push(`**Skill 完整回复：**\n`);
                            lines.push('```');
                            lines.push(tr.response);
                            lines.push('```\n');
                          }
                          if (tr.evaluation) {
                            lines.push(`**评价：** ${tr.evaluation}\n`);
                          }
                        });
                      }

                      // 最终输出
                      if (st?.finalOutput) {
                        lines.push(`## 📤 最终输出\n`);
                        lines.push('```');
                        lines.push(st.finalOutput);
                        if (st.notes) lines.push(`\n💡 ${st.notes}`);
                        lines.push('```\n');
                      }

                      // 对话记录：优先用 stRaw.transcript（callback 存的原始字段），再回退到 st.transcript/st.trace
                      const transcript = stRaw?.transcript || st?.transcript || st?.trace || [];
                      if (transcript.length > 0) {
                        lines.push(`## 💬 完整对话记录（${transcript.length} 条）\n`);
                        transcript.forEach((t: any, i: number) => {
                          const time = t.ts ? t.ts.slice(11, 19) : '';
                          if (t.type === 'event') {
                            lines.push(`### ⚡ 事件: ${t.event || ''}  ${time}`);
                            if (t.detail) lines.push(`\n${t.detail}\n`);
                          } else if (t.role === 'assistant') {
                            lines.push(`### 🤖 AI 回复（轮 ${t.turn ?? i}）  ${time}`);
                            if (t.is_truncated) lines.push(`\n> ✂️ 已截断（原始长度 ${t.original_length ?? '?'} 字符）\n`);
                            if (t.content) {
                              lines.push('\n' + t.content + '\n');
                            }
                            if (t.tool_calls?.length) {
                              lines.push(`\n🔧 调用工具: ${t.tool_calls.map((tc: any) => tc.name).join(', ')}\n`);
                            }
                          } else if (t.role === 'tool') {
                            lines.push(`### 🔧 工具: ${t.tool || ''}  ${time}`);
                            if (t.is_truncated) lines.push(`\n> ✂️ 输出已截断（原始 ${t.original_length ?? '?'} 字符）`);
                            if (t.spill_path) lines.push(`\n> 💾 大文件已落盘: ${t.spill_path}`);
                            if (t.input) {
                              lines.push('\n**输入：**\n');
                              lines.push('```');
                              lines.push(typeof t.input === 'string' ? t.input : JSON.stringify(t.input, null, 2));
                              lines.push('```\n');
                            }
                            if (t.output) {
                              lines.push('**输出：**\n');
                              lines.push('```');
                              lines.push(t.output);
                              lines.push('```\n');
                            }
                          }
                        });
                      }

                      // GCS 信息
                      if (st?.transcript_gcs) {
                        lines.push(`## ☁️ GCS 完整版\n`);
                        lines.push('```json');
                        lines.push(JSON.stringify(st.transcript_gcs, null, 2));
                        lines.push('```\n');
                      }

                      // 下载
                      const md = lines.join('\n');
                      const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement('a');
                      a.href = url;
                      a.download = `sandbox-${skillName.replace(/\s+/g, '-')}-${Date.now()}.md`;
                      a.click();
                      URL.revokeObjectURL(url);
                    }}
                  >
                    ⬇️ 下载完整上下文
                  </button>
                  {/* Bundle 安装按钮 */}
                  <button
                    className="btn btn-sm"
                    style={{ background: skill.bundle_status === 'ready' ? 'var(--success)' : 'var(--primary)', color: '#fff' }}
                    onClick={async () => {
                      try { await api.skills.install(id!); flash('success', '安装已触发，正在打包依赖...'); load(); } catch (e: any) { flash('error', e.message); }
                    }}
                    disabled={skill.bundle_status === 'building'}
                    title={skill.bundle_status === 'ready' ? `已安装 v${skill.bundle_version}` : '安装到系统（打包依赖到 GCS）'}>
                    {skill.bundle_status === 'building' ? '⏳ 安装中...' : skill.bundle_status === 'ready' ? `📦 已安装 v${skill.bundle_version}` : '📦 安装到系统'}
                  </button>
                  {/* 上传 scripts zip（脚本类技能用）*/}
                  <label className="btn btn-ghost btn-sm" title="上传 skill zip 包提供 scripts/ 目录" style={{ cursor: 'pointer' }}>
                    {uploadingScripts ? '上传中…' : '📦 上传 scripts.zip'}
                    <input type="file" accept=".zip,.tar.gz" style={{ display: 'none' }} onChange={handleUploadScripts} disabled={uploadingScripts} />
                  </label>
                </div>
                {/* Bundle 安装状态信息 */}
                {skill.bundle_status && skill.bundle_status !== 'none' && (
                  <div style={{ marginTop: 8, fontSize: '.8rem', color: 'var(--gray-500)' }}>
                    📦 Bundle: {skill.bundle_status === 'ready' ? `v${skill.bundle_version} 已就绪` : skill.bundle_status === 'building' ? '正在构建...' : skill.bundle_status === 'failed' ? '❌ 构建失败' : skill.bundle_status}
                    {skill.installed_at && ` · 安装于 ${new Date(skill.installed_at).toLocaleString('zh-CN')}`}
                    {skill.bundle_path && <span style={{ marginLeft: 8, color: 'var(--gray-400)' }}>{skill.bundle_path}</span>}
                  </div>
                )}
              </div>
            )}

            {status === 'failed' && st && (
              <div>
                <div className="alert alert-error" style={{ marginBottom: 10 }}>{st.comment}</div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <button className="btn btn-ghost btn-sm" onClick={() => handleSandboxTest(false)}>🔄 重试</button>
                  <label className="btn btn-ghost btn-sm" title="上传 skill zip 包提供 scripts/ 目录" style={{ cursor: 'pointer' }}>
                    {uploadingScripts ? '上传中…' : '📦 上传 scripts.zip'}
                    <input type="file" accept=".zip,.tar.gz" style={{ display: 'none' }} onChange={handleUploadScripts} disabled={uploadingScripts} />
                  </label>
                  {/* FAILED 状态也提供下载，便于排查 */}
                  <button
                    className="btn btn-ghost btn-sm"
                    title="下载测试上下文（含错误信息）"
                    onClick={() => {
                      const lines: string[] = [];
                      const now = new Date().toLocaleString('zh-CN');
                      const skillName = skill.name || skill.id;
                      lines.push(`# 沙箱测试上下文（FAILED）`);
                      lines.push(`\n> Skill: **${skillName}** · 导出时间: ${now}\n`);
                      lines.push(`## 📋 Skill 定义\n`);
                      lines.push('```yaml');
                      lines.push(skill.prompt_template || skill.code || skill.definition || '（无）');
                      lines.push('```\n');
                      if (st?.testInput) {
                        lines.push(`## 📥 测试输入\n`);
                        lines.push('```json');
                        lines.push(st.testInput);
                        lines.push('```\n');
                      }
                      lines.push(`## ❌ 错误信息\n`);
                      lines.push(st?.comment || st?.error || 'Job FAILED');
                      lines.push('');
                      if (st?.finalOutput) {
                        lines.push(`## 📤 最终输出\n`);
                        lines.push('```');
                        lines.push(st.finalOutput);
                        lines.push('```\n');
                      }
                      // 对话记录
                      const transcript = st?.transcript || st?.trace || [];
                      if (transcript.length > 0) {
                        lines.push(`## 💬 对话记录（${transcript.length} 条）\n`);
                        transcript.forEach((t: any, i: number) => {
                          const time = t.ts ? t.ts.slice(11, 19) : '';
                          if (t.role === 'assistant') {
                            lines.push(`### 🤖 AI（轮 ${t.turn ?? i}）${time}\n`);
                            if (t.content) lines.push(t.content + '\n');
                          } else if (t.role === 'tool') {
                            lines.push(`### 🔧 工具: ${t.tool || ''}  ${time}\n`);
                            if (t.output) { lines.push('```'); lines.push(t.output); lines.push('```\n'); }
                          } else if (t.type === 'event') {
                            lines.push(`### ⚡ ${t.event || ''} ${time}: ${t.detail || ''}\n`);
                          }
                        });
                      }
                      const md = lines.join('\n');
                      const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement('a');
                      a.href = url;
                      a.download = `sandbox-failed-${skillName.replace(/\s+/g, '-')}-${Date.now()}.md`;
                      a.click();
                      URL.revokeObjectURL(url);
                    }}
                  >
                    ⬇️ 下载上下文
                  </button>
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
