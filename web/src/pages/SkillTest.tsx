import { useState, useEffect } from 'react';
import { api } from '../lib/api';

interface Field {
  key: string;
  label: string;
  type: string;
  required?: boolean;
  placeholder?: string;
}

export default function SkillTest() {
  const [skills, setSkills] = useState<any[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [skill, setSkill] = useState<any>(null);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [freePrompt, setFreePrompt] = useState('');
  const [createdBy, setCreatedBy] = useState('');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [history, setHistory] = useState<any[]>([]);
  const [activeTab, setActiveTab] = useState<'run' | 'history'>('run');

  // Load all skills
  useEffect(() => {
    api.skills.list().then(d => setSkills(d.skills || []));
  }, []);

  // Load skill detail + history when selection changes
  useEffect(() => {
    if (!selectedId) { setSkill(null); setHistory([]); return; }
    api.skills.get(selectedId).then(d => {
      setSkill(d.skill);
      // Reset inputs to match new skill's fields
      const h5 = d.skill.h5_config;
      if (h5?.fields) {
        const init: Record<string, string> = {};
        h5.fields.forEach((f: Field) => { init[f.key] = ''; });
        setInputs(init);
      } else {
        setInputs({});
      }
      setFreePrompt('');
      setResult(null);
    });
    api.test.runs(selectedId).then(d => setHistory(d.runs || []));
  }, [selectedId]);

  const handleRun = async () => {
    if (!selectedId) return;
    setRunning(true);
    setResult(null);
    try {
      const payload = skill?.skill_type === 'prompt' && skill?.h5_config?.fields
        ? inputs
        : { _free_prompt: freePrompt };
      const r = await api.test.run(selectedId, payload, createdBy || undefined);
      setResult(r);
      // Refresh history
      const h = await api.test.runs(selectedId);
      setHistory(h.runs || []);
    } catch (e: any) {
      setResult({ success: false, error: e.message });
    } finally {
      setRunning(false);
    }
  };

  const fields: Field[] = skill?.h5_config?.fields || [];
  const hasFields = fields.length > 0;

  return (
    <div>
      {/* ── Header ─────────────────────────────────────────────── */}
      <div className="page-header">
        <div>
          <h1>🧪 Skill 测试平台</h1>
          <p>直接调用任意 Skill，实时查看 AI 输出效果</p>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '280px 1fr', gap: 20, alignItems: 'start' }}>
        {/* ── Left: Skill Selector ──────────────────────────────── */}
        <div className="card" style={{ position: 'sticky', top: 20 }}>
          <div className="card-title">选择 Skill</div>
          <div className="form-group">
            <label className="form-label">Skill</label>
            <select className="form-select" value={selectedId} onChange={e => setSelectedId(e.target.value)}>
              <option value="">-- 选择 Skill --</option>
              {['external', 'internal'].map(type => (
                <optgroup key={type} label={type === 'external' ? '外部 Skill（H5）' : '内部 Skill（直接调用）'}>
                  {skills.filter(s => s.type === type).map(s => (
                    <option key={s.id} value={s.id}>
                      {s.name} [{s.status_label}]
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>

          {skill && (
            <div style={{ marginTop: 8, fontSize: '.8rem', color: 'var(--gray-500)', lineHeight: 1.6 }}>
              <div><strong>类型：</strong>{skill.type === 'external' ? '外部 H5' : '内部调用'} / {skill.skill_type}</div>
              <div><strong>模型：</strong>{skill.preferred_model || '默认模型'}</div>
              {skill.description && <div style={{ marginTop: 4 }}>{skill.description}</div>}
            </div>
          )}

          <div className="form-group" style={{ marginTop: 12 }}>
            <label className="form-label">测试人员</label>
            <input className="form-input" placeholder="你的名字（可选）"
              value={createdBy} onChange={e => setCreatedBy(e.target.value)} />
          </div>

          <button className="btn btn-primary" style={{ width: '100%', marginTop: 8 }}
            onClick={handleRun} disabled={!selectedId || running ||
              (hasFields ? Object.values(inputs).every(v => !v.trim()) : !freePrompt.trim())}>
            {running ? '⏳ 运行中…' : '▶️ 运行测试'}
          </button>

          {result && (
            <div style={{ marginTop: 8, padding: '8px 10px', borderRadius: 6,
              background: result.success ? 'var(--green-50, #f0fdf4)' : 'var(--red-50, #fef2f2)',
              color: result.success ? '#16a34a' : '#dc2626', fontSize: '.8rem' }}>
              {result.success
                ? `✅ 完成 · ${result.duration_ms}ms · ${result.result?.length || 0} 字`
                : `❌ 出错: ${result.error?.slice(0, 60)}`}
            </div>
          )}
        </div>

        {/* ── Right: Input + Output ─────────────────────────────── */}
        <div>
          {/* Tab bar */}
          <div style={{ display: 'flex', gap: 2, borderBottom: '1px solid var(--gray-200)', marginBottom: 16 }}>
            {(['run', 'history'] as const).map(tab => (
              <button key={tab} onClick={() => setActiveTab(tab)}
                className="btn btn-ghost btn-sm"
                style={{ borderRadius: '6px 6px 0 0', borderBottom: activeTab === tab ? '2px solid var(--primary)' : 'none',
                  color: activeTab === tab ? 'var(--primary)' : 'var(--gray-500)', fontWeight: activeTab === tab ? 600 : 400 }}>
                {tab === 'run' ? '输入 / 输出' : `历史记录 ${history.length > 0 ? `(${history.length})` : ''}`}
              </button>
            ))}
          </div>

          {activeTab === 'run' && (
            <div>
              {/* Input area */}
              {!selectedId && (
                <div className="card" style={{ textAlign: 'center', color: 'var(--gray-400)', padding: '40px 20px' }}>
                  ← 请先从左侧选择一个 Skill
                </div>
              )}

              {selectedId && hasFields && (
                <div className="card mb-4">
                  <div className="card-title">📝 输入字段</div>
                  {fields.map((f: Field) => (
                    <div key={f.key} className="form-group">
                      <label className="form-label">
                        {f.label}
                        {f.required && <span style={{ color: 'var(--red, #dc2626)', marginLeft: 2 }}>*</span>}
                      </label>
                      {f.type === 'textarea' ? (
                        <textarea className="form-textarea" rows={4}
                          placeholder={f.placeholder || `请输入${f.label}`}
                          value={inputs[f.key] || ''} onChange={e => setInputs(p => ({ ...p, [f.key]: e.target.value }))} />
                      ) : (
                        <input className="form-input" type={f.type === 'number' ? 'number' : 'text'}
                          placeholder={f.placeholder || `请输入${f.label}`}
                          value={inputs[f.key] || ''} onChange={e => setInputs(p => ({ ...p, [f.key]: e.target.value }))} />
                      )}
                    </div>
                  ))}
                </div>
              )}

              {selectedId && !hasFields && (
                <div className="card mb-4">
                  <div className="card-title">📝 自由输入</div>
                  <div className="form-group">
                    <label className="form-label">测试内容</label>
                    <textarea className="form-textarea" rows={6}
                      placeholder="输入任意测试内容，将直接作为用户输入发送给 AI…"
                      value={freePrompt} onChange={e => setFreePrompt(e.target.value)} />
                  </div>
                  {skill?.prompt_template && (
                    <div style={{ marginTop: 8, padding: '10px 12px', background: 'var(--gray-50)', borderRadius: 6, fontSize: '.8rem', color: 'var(--gray-500)' }}>
                      <strong>Prompt 模板预览：</strong>
                      <pre style={{ marginTop: 6, fontFamily: 'inherit', whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>
                        {skill.prompt_template.slice(0, 300)}{skill.prompt_template.length > 300 ? '…' : ''}
                      </pre>
                    </div>
                  )}
                </div>
              )}

              {/* Output area */}
              {result && (
                <div className="card">
                  <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
                    <div className="card-title" style={{ margin: 0 }}>🤖 AI 输出</div>
                    <span style={{ marginLeft: 8, fontSize: '.75rem', color: 'var(--gray-400)' }}>
                      {result.model} · {result.duration_ms}ms
                    </span>
                  </div>
                  {result.success ? (
                    <pre style={{ background: 'var(--gray-50)', border: '1px solid var(--gray-200)',
                      borderRadius: 'var(--radius-sm)', padding: 14, fontSize: '.875rem',
                      fontFamily: 'inherit', whiteSpace: 'pre-wrap', lineHeight: 1.8, maxHeight: 600, overflowY: 'auto' }}>
                      {result.result}
                    </pre>
                  ) : (
                    <div style={{ color: '#dc2626', background: '#fef2f2', padding: '12px 14px', borderRadius: 6 }}>
                      ❌ {result.error}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {activeTab === 'history' && (
            <div>
              {history.length === 0 ? (
                <div className="card" style={{ textAlign: 'center', color: 'var(--gray-400)', padding: '40px 20px' }}>
                  暂无测试记录
                </div>
              ) : (
                history.map((run: any) => (
                  <div key={run.id} className="card mb-3" style={{ padding: '12px 14px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                      <span style={{ fontSize: '.75rem', fontFamily: 'monospace', color: 'var(--gray-400)' }}>{run.id.slice(0, 8)}</span>
                      <span className={`badge ${run.error ? 'badge-rejected' : 'badge-published'}`} style={{ fontSize: '.7rem' }}>
                        {run.error ? '失败' : '成功'}
                      </span>
                      <span style={{ fontSize: '.75rem', color: 'var(--gray-400)', marginLeft: 'auto' }}>
                        {run.model} · {run.duration_ms}ms · {new Date(run.created_at).toLocaleString('zh-CN')}
                      </span>
                    </div>
                    <div style={{ fontSize: '.85rem', color: 'var(--gray-600)', background: 'var(--gray-50)',
                      padding: '8px 10px', borderRadius: 6, lineHeight: 1.6 }}>
                      {run.error ? <span style={{ color: '#dc2626' }}>❌ {run.error.slice(0, 100)}</span>
                        : (run.preview || '（无输出）')}
                    </div>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
