import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';

export default function SkillNew() {
  const navigate = useNavigate();
  const [models, setModels] = useState<any[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState('');
  const [mode, setMode] = useState<'manual' | 'clawhub'>('manual');

  // Manual form
  const [form, setForm] = useState({
    name: '', description: '', category: '', author_name: '',
    type: 'external', skill_type: 'prompt',
    prompt_template: '', code: '',
    preferred_model: '', fallback_model: '',
  });

  // ClaWHub import form
  const [clawhubUrl, setClawhubUrl] = useState('');
  const [clawhubType, setClawhubType] = useState('external');
  const [importResult, setImportResult] = useState<any>(null);

  useEffect(() => { api.settings.models().then(d => setModels(d.models)); }, []);

  const set = (k: string, v: string) => setForm(f => ({ ...f, [k]: v }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true); setErr('');
    try {
      const res = await api.skills.create(form);
      navigate(`/skills/${res.skill.id}`);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleClawhubImport = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true); setErr(''); setImportResult(null);
    try {
      const res = await api.skills.importClawhub(clawhubUrl, clawhubType);
      setImportResult(res);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setSubmitting(false);
    }
  };

  const typeOpts = [
    { v: 'external', icon: '🟢', title: '外部 Skill', desc: '客户通过 H5 链接提交，AI 处理后返回结果' },
    { v: 'internal', icon: '🔵', title: '内部 Skill', desc: '员工后台直接输入数据，无 H5 链接' },
  ];
  const skillTypeOpts = [
    { v: 'prompt', icon: '📝', title: 'Prompt 模板型', desc: '写 AI 指令，用 {{字段名}} 插入客户数据' },
    { v: 'code', icon: '💻', title: '代码逻辑型', desc: '编写 JS 业务逻辑，支持复杂多步处理' },
  ];

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>上传 Skill</h1>
          <p>填写 Skill 信息，上传后进入 AI 评审流程</p>
        </div>
        <button className="btn btn-ghost" onClick={() => navigate('/skills')}>← 返回</button>
      </div>

      {/* Mode switcher */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 20 }}>
        <button
          type="button"
          onClick={() => setMode('manual')}
          style={{
            padding: '10px 20px', borderRadius: 8, fontWeight: 600, cursor: 'pointer',
            border: `2px solid ${mode === 'manual' ? 'var(--primary)' : 'var(--gray-200)'}`,
            background: mode === 'manual' ? 'var(--primary-light)' : '#fff',
            color: mode === 'manual' ? 'var(--primary)' : 'var(--gray-600)',
            transition: 'all .15s',
          }}
        >✏️ 手动创建</button>
        <button
          type="button"
          onClick={() => setMode('clawhub')}
          style={{
            padding: '10px 20px', borderRadius: 8, fontWeight: 600, cursor: 'pointer',
            border: `2px solid ${mode === 'clawhub' ? '#7c3aed' : 'var(--gray-200)'}`,
            background: mode === 'clawhub' ? '#f5f3ff' : '#fff',
            color: mode === 'clawhub' ? '#7c3aed' : 'var(--gray-600)',
            transition: 'all .15s',
          }}
        >🔌 从 ClaWHub 导入</button>
      </div>

      {err && <div className="alert alert-error">{err}</div>}

      {/* ─── ClaWHub Import Mode ─── */}
      {mode === 'clawhub' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 340px', gap: 20, alignItems: 'start' }}>
          <div>
            <form onSubmit={handleClawhubImport}>
              <div className="card mb-4">
                <div className="card-title">🔌 从 ClaWHub 导入 Skill</div>
                <div className="form-group">
                  <label className="form-label required">ClaWHub 页面 URL</label>
                  <input
                    className="form-input"
                    value={clawhubUrl}
                    onChange={e => setClawhubUrl(e.target.value)}
                    placeholder="https://clawhub.ai/stitch-ui-designer 或 openclaw skills install @a2mus/stitch-ui-designer"
                    required
                  />
                  <p className="form-hint">支持：① ClawHub 页面 URL（clawhub.ai/...）② CLI 安装命令（openclaw skills install @author/skill）③ 直接填 slug（stitch-ui-designer）</p>
                </div>
                <div className="form-group">
                  <label className="form-label">使用类型</label>
                  <select className="form-select" value={clawhubType} onChange={e => setClawhubType(e.target.value)}>
                    <option value="external">外部（客户填 H5）</option>
                    <option value="internal">内部（员工使用）</option>
                  </select>
                </div>
                <button className="btn btn-primary" type="submit" disabled={submitting}>
                  {submitting ? '导入中…' : '🔌 一键导入'}
                </button>
              </div>
            </form>

            {importResult && (
              <div className="card" style={{ borderColor: '#7c3aed', borderWidth: 2 }}>
                <div className="card-title" style={{ color: '#7c3aed' }}>✅ 导入成功！</div>
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontWeight: 700, fontSize: '1rem' }}>{importResult.parsed?.name}</div>
                  <div style={{ fontSize: '.82rem', color: 'var(--gray-500)' }}>
                    作者：@{importResult.parsed?.author} · 内容长度：{importResult.parsed?.contentLength} 字符
                  </div>
                  {importResult.parsed?.installCmd && (
                    <div style={{ marginTop: 6, fontSize: '.8rem', fontFamily: 'monospace',
                      background: '#f5f3ff', padding: '6px 10px', borderRadius: 6, color: '#7c3aed' }}>
                      $ {importResult.parsed.installCmd}
                    </div>
                  )}
                </div>
                <div style={{ fontSize: '.8rem', color: 'var(--gray-500)', background: 'var(--gray-50)',
                  padding: 12, borderRadius: 8, fontFamily: 'monospace', lineHeight: 1.6,
                  maxHeight: 200, overflow: 'auto' }}>
                  {importResult.parsed?.preview}
                </div>
                <div style={{ marginTop: 14 }}>
                  <button className="btn btn-primary"
                    onClick={() => navigate(`/skills/${importResult.skill?.id}`)}>
                    📋 进入审核流程 →
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Right panel */}
          <div style={{ position: 'sticky', top: 80 }}>
            <div className="card mb-4" style={{ background: 'linear-gradient(135deg, #f5f3ff, #ede9fe)' }}>
              <div className="card-title" style={{ color: '#7c3aed' }}>🔌 ClaWHub 导入说明</div>
              <div style={{ fontSize: '.84rem', color: 'var(--gray-600)', lineHeight: 2 }}>
                <div>① 打开 <strong>clawhub.com</strong> 找到 Skill</div>
                <div>② 复制浏览器地址栏 URL</div>
                <div>③ 粘贴到左侧输入框</div>
                <div>④ 平台自动抓取 SKILL.md 内容</div>
                <div>⑤ 进入正常 AI 审核 → 发布流程</div>
              </div>
            </div>
            <div className="card mb-4">
              <div className="card-title">💡 推荐健康类 Skill</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {[
                  { name: 'Medical', url: 'https://clawhub.com/agistack/medical', desc: '健康记录隐私管理' },
                ].map(s => (
                  <div key={s.url} style={{ padding: '8px 10px', background: 'var(--gray-50)', borderRadius: 8,
                    border: '1px solid var(--gray-200)', cursor: 'pointer' }}
                    onClick={() => { setClawhubUrl(s.url); }}>
                    <div style={{ fontWeight: 600, fontSize: '.85rem' }}>🔗 {s.name}</div>
                    <div style={{ fontSize: '.75rem', color: 'var(--gray-500)' }}>{s.desc}</div>
                  </div>
                ))}
              </div>
            </div>
            <div className="card">
              <div className="card-title">⚠️ 兼容说明</div>
              <div style={{ fontSize: '.8rem', color: 'var(--gray-500)', lineHeight: 1.7 }}>
                ClaWHub 上的 Skill 本质是 AI 行为规范（Markdown），导入后作为 Prompt 模板使用。
                CLI 工具类 Skill（需要 gh、curl 等）在导入后需要手动调整。
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ─── Manual Create Mode ─── */}
      {mode === 'manual' && (
      <form onSubmit={handleSubmit}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 20, alignItems: 'start' }}>

          {/* Left — main form */}
          <div>
            {/* Basic Info */}
            <div className="card mb-4">
              <div className="card-title">基本信息</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                <div className="form-group" style={{ gridColumn: '1/-1' }}>
                  <label className="form-label required">Skill 名称</label>
                  <input className="form-input" value={form.name} onChange={e => set('name', e.target.value)}
                    placeholder="如：检验报告解读" required />
                </div>
                <div className="form-group">
                  <label className="form-label">分类</label>
                  <input className="form-input" value={form.category} onChange={e => set('category', e.target.value)} placeholder="如：医学报告" />
                </div>
                <div className="form-group">
                  <label className="form-label">作者/上传者</label>
                  <input className="form-input" value={form.author_name} onChange={e => set('author_name', e.target.value)} placeholder="姓名" />
                </div>
                <div className="form-group" style={{ gridColumn: '1/-1' }}>
                  <label className="form-label">描述</label>
                  <textarea className="form-textarea" rows={2} value={form.description}
                    onChange={e => set('description', e.target.value)} placeholder="这个 Skill 能做什么？" />
                </div>
              </div>
            </div>

            {/* Type Selection */}
            <div className="card mb-4">
              <div className="card-title">Skill 类型</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
                {typeOpts.map(opt => (
                  <div key={opt.v} onClick={() => set('type', opt.v)} style={{
                    border: `2px solid ${form.type === opt.v ? 'var(--primary)' : 'var(--gray-200)'}`,
                    borderRadius: 'var(--radius-lg)', padding: 14, cursor: 'pointer',
                    background: form.type === opt.v ? 'var(--primary-light)' : '#fff',
                    transition: 'all .15s',
                  }}>
                    <div style={{ fontSize: '1rem', fontWeight: 600, marginBottom: 4 }}>{opt.icon} {opt.title}</div>
                    <div style={{ fontSize: '.8rem', color: 'var(--gray-500)' }}>{opt.desc}</div>
                  </div>
                ))}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                {skillTypeOpts.map(opt => (
                  <div key={opt.v} onClick={() => set('skill_type', opt.v)} style={{
                    border: `2px solid ${form.skill_type === opt.v ? 'var(--primary)' : 'var(--gray-200)'}`,
                    borderRadius: 'var(--radius-lg)', padding: 14, cursor: 'pointer',
                    background: form.skill_type === opt.v ? 'var(--primary-light)' : '#fff',
                    transition: 'all .15s',
                  }}>
                    <div style={{ fontSize: '1rem', fontWeight: 600, marginBottom: 4 }}>{opt.icon} {opt.title}</div>
                    <div style={{ fontSize: '.8rem', color: 'var(--gray-500)' }}>{opt.desc}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Content */}
            <div className="card mb-4">
              <div className="card-title">{form.skill_type === 'prompt' ? '📝 Prompt 模板' : '💻 执行代码'}</div>
              {form.skill_type === 'prompt' ? (
                <>
                  <textarea
                    className="form-textarea" rows={14}
                    style={{ fontFamily: 'monospace', fontSize: '.84rem' }}
                    value={form.prompt_template}
                    onChange={e => set('prompt_template', e.target.value)}
                    placeholder={`你是一名专业医学报告解读专家。\n\n请对以下检验报告进行解读，用通俗易懂的语言给患者解释各项指标含义，并给出建议。\n\n患者年龄：{{age}}\n患者主诉：{{symptoms}}\n报告内容：{{report_text}}`}
                    required
                  />
                  <p className="form-hint">使用 &#123;&#123;字段名&#125;&#125; 作为占位符，平台会自动替换为客户填写的数据</p>
                </>
              ) : (
                <>
                  <textarea
                    className="form-textarea" rows={14}
                    style={{ fontFamily: 'monospace', fontSize: '.84rem' }}
                    value={form.code}
                    onChange={e => set('code', e.target.value)}
                    placeholder={`// index.js — 代码逻辑型 Skill\nasync function invoke(inputs, files, api) {\n  const result = await api.callAI(\`分析：\${inputs.text}\`);\n  return { summary: result };\n}`}
                    required
                  />
                  <p className="form-hint">代码将在安全沙箱中执行，不能访问系统文件和网络</p>
                </>
              )}
            </div>

            {/* Model */}
            <div className="card mb-4">
              <div className="card-title">⚡ AI 模型配置（可选）</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                <div className="form-group">
                  <label className="form-label">首选模型</label>
                  <select className="form-select" value={form.preferred_model} onChange={e => set('preferred_model', e.target.value)}>
                    <option value="">使用平台默认</option>
                    {models.map((m: any) => <option key={m.id} value={m.id}>{m.label}</option>)}
                  </select>
                </div>
                <div className="form-group">
                  <label className="form-label">备用模型</label>
                  <select className="form-select" value={form.fallback_model} onChange={e => set('fallback_model', e.target.value)}>
                    <option value="">无备用</option>
                    {models.map((m: any) => <option key={m.id} value={m.id}>{m.label}</option>)}
                  </select>
                </div>
              </div>
              <p className="form-hint">首选模型失败时自动切换备用模型</p>
            </div>

            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn btn-primary btn-lg" type="submit" disabled={submitting}>
                {submitting ? '提交中…' : '✅ 提交 Skill'}
              </button>
              <button className="btn btn-ghost" type="button" onClick={() => navigate('/skills')}>取消</button>
            </div>
          </div>

          {/* Right — tips panel */}
          <div style={{ position: 'sticky', top: 80 }}>
            <div className="card mb-4" style={{ background: 'linear-gradient(135deg, #f0f7ff, #e8f0fe)' }}>
              <div className="card-title">💡 上传须知</div>
              <div style={{ fontSize: '.84rem', color: 'var(--gray-600)', lineHeight: 2 }}>
                <div>① 提交后进入 <strong>AI 自动审核</strong></div>
                <div>② 审核通过需配置 <strong>H5 表单字段</strong></div>
                <div>③ 发布后才能创建工单</div>
                <div>④ 字段用 <code style={{ background: '#e8f0fe', padding: '1px 5px', borderRadius: 4 }}>{'{{key}}'}</code> 引用</div>
              </div>
            </div>

            <div className="card mb-4">
              <div className="card-title">📐 Prompt 示例</div>
              <pre style={{ fontSize: '.75rem', color: 'var(--gray-600)', lineHeight: 1.7, whiteSpace: 'pre-wrap', background: 'var(--gray-50)', padding: 12, borderRadius: 8 }}>
{`你是医疗助手。

患者：{{name}}，{{age}}岁
症状：{{symptoms}}

请分析并给出建议。`}
              </pre>
            </div>

            <div className="card">
              <div className="card-title">🔵 类型说明</div>
              <div style={{ fontSize: '.82rem', color: 'var(--gray-600)', lineHeight: 1.8 }}>
                <div><strong>外部</strong>：客户填 H5，AI 处理，员工看报告</div>
                <div style={{ marginTop: 6 }}><strong>内部</strong>：员工直接输入，AI 处理，内部使用</div>
              </div>
            </div>
          </div>
        </div>
      </form>
      )}
    </div>
  );
}
