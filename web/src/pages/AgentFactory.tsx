import { useState, useRef } from 'react';

// ── API base ─────────────────────────────────────────────────────────────────
const API = (import.meta as any).env?.VITE_API_BASE || '';

// ── Types ─────────────────────────────────────────────────────────────────────
interface DeliveryConfig {
  max_reply_length: number;
  use_emoji: boolean;
  greeting_style: 'formal' | 'casual' | 'warm';
  response_tone: 'professional' | 'friendly' | 'empathetic';
}

interface RoutingExample {
  user_says: string;
  route_to: string;
  reason: string;
}

interface AgentSpec {
  id: string;
  name: string;
  role_desc: string;
  reply_style: string;
  service_flow: string;
  taboos: string[];
  reassurance_tpl: string;
  skill_ids: string[];
  routing_examples: RoutingExample[];
  delivery_config: DeliveryConfig;
  knowledge_domain: string;
  intent_prompt: string;
}

interface GenResult {
  spec: AgentSpec;
  confidence: number;
  clarification_needed: string | null;
  generation_notes: string[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const DOMAIN_LABELS: Record<string, string> = {
  health: '健康管理', social_ops: '私域社群', sales: '销售客户', hr_recruiting: '招聘 HR',
};
const TONE_LABELS: Record<string, string> = {
  professional: '专业', friendly: '友好', empathetic: '共情',
};
const GREETING_LABELS: Record<string, string> = {
  formal: '正式', casual: '随和', warm: '温暖',
};

function confColor(c: number) {
  if (c >= 0.85) return '#22c55e';
  if (c >= 0.70) return '#f59e0b';
  return '#ef4444';
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function AgentFactory() {
  const [intent, setIntent] = useState('');
  const [extraContext, setExtraContext] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<GenResult | null>(null);
  const [spec, setSpec] = useState<AgentSpec | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [activeTab, setActiveTab] = useState<'basic' | 'style' | 'safety' | 'routing'>('basic');
  const [newTaboo, setNewTaboo] = useState('');
  const intentRef = useRef<HTMLTextAreaElement>(null);

  // ── Generate ─────────────────────────────────────────────────────────────
  async function handleGenerate() {
    if (!intent.trim()) return;
    setLoading(true); setError(''); setResult(null); setSpec(null); setSaved(false);
    try {
      const res = await fetch(`${API}/api/v1/meta/agents/generate-spec`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ intent: intent.trim(), extra_context: extraContext.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '生成失败');
      setResult(data);
      setSpec({ ...data.spec });
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  // ── Submit ────────────────────────────────────────────────────────────────
  async function handleSubmit() {
    if (!spec) return;
    setSaving(true); setError('');
    try {
      const res = await fetch(`${API}/api/v1/meta/agents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(spec),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '提交失败');
      setSaved(true);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  // ── Spec field helpers ────────────────────────────────────────────────────
  function updateSpec(field: keyof AgentSpec, value: any) {
    setSpec(prev => prev ? { ...prev, [field]: value } : prev);
  }
  function updateDelivery(field: keyof DeliveryConfig, value: any) {
    setSpec(prev => prev ? { ...prev, delivery_config: { ...prev.delivery_config, [field]: value } } : prev);
  }
  function removeTaboo(i: number) {
    setSpec(prev => prev ? { ...prev, taboos: prev.taboos.filter((_, idx) => idx !== i) } : prev);
  }
  function addTaboo() {
    if (!newTaboo.trim()) return;
    setSpec(prev => prev ? { ...prev, taboos: [...prev.taboos, newTaboo.trim()] } : prev);
    setNewTaboo('');
  }

  return (
    <div style={{ maxWidth: 860, margin: '0 auto', padding: '8px 0 48px' }}>
      {/* ── Header ── */}
      <div style={{ marginBottom: 28 }}>
        <h1 style={{ fontSize: '1.55rem', fontWeight: 700, margin: 0, color: 'var(--text-primary)' }}>
          🏢 AI 员工招募工作台
        </h1>
        <p style={{ margin: '6px 0 0', color: 'var(--text-muted)', fontSize: '.9rem' }}>
          用自然语言描述招聘需求，AI 自动生成结构化员工画像，支持在线编辑后直接上线试用
        </p>
      </div>

      {/* ── Intent Input ── */}
      <div className="card" style={{ padding: 24, marginBottom: 20 }}>
        <label style={{ display: 'block', fontWeight: 600, marginBottom: 10, fontSize: '.95rem' }}>
          📝 招聘需求描述
        </label>
        <textarea
          ref={intentRef}
          value={intent}
          onChange={e => setIntent(e.target.value)}
          placeholder="例如：我要找一个私域运营经理，主要负责护肤品社群的日常维护、话题策划和复购引导，用户画像是30-45岁女性..."
          rows={4}
          style={{
            width: '100%', boxSizing: 'border-box',
            padding: '12px 14px', borderRadius: 10,
            border: '1.5px solid var(--border)',
            background: 'var(--bg-secondary)',
            color: 'var(--text-primary)',
            fontSize: '0.95rem', lineHeight: 1.6,
            resize: 'vertical', outline: 'none',
            transition: 'border-color .2s',
            fontFamily: 'inherit',
          }}
          onFocus={e => (e.target.style.borderColor = 'var(--accent)')}
          onBlur={e => (e.target.style.borderColor = 'var(--border)')}
          onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleGenerate(); }}
        />

        <details style={{ marginTop: 12 }}>
          <summary style={{ cursor: 'pointer', color: 'var(--text-muted)', fontSize: '.85rem', userSelect: 'none' }}>
            ＋ 补充背景（可选）
          </summary>
          <textarea
            value={extraContext}
            onChange={e => setExtraContext(e.target.value)}
            placeholder="如：企业类型、用户群体、特殊业务场景..."
            rows={2}
            style={{
              marginTop: 8, width: '100%', boxSizing: 'border-box',
              padding: '10px 14px', borderRadius: 8,
              border: '1.5px solid var(--border)', background: 'var(--bg-secondary)',
              color: 'var(--text-primary)', fontSize: '.875rem',
              resize: 'vertical', fontFamily: 'inherit', outline: 'none',
            }}
          />
        </details>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 16 }}>
          <button
            id="btn-generate-spec"
            onClick={handleGenerate}
            disabled={loading || !intent.trim()}
            style={{
              padding: '10px 28px', borderRadius: 8, border: 'none',
              background: loading || !intent.trim() ? 'var(--border)' : 'var(--accent)',
              color: loading || !intent.trim() ? 'var(--text-muted)' : '#fff',
              fontWeight: 600, fontSize: '.95rem', cursor: loading || !intent.trim() ? 'default' : 'pointer',
              transition: 'all .2s', letterSpacing: '.01em',
            }}
          >
            {loading ? '⏳ AI 生成中...' : '✨ 生成员工画像'}
          </button>
          <span style={{ fontSize: '.82rem', color: 'var(--text-muted)' }}>
            Cmd+Enter 快捷触发
          </span>
        </div>
      </div>

      {/* ── Loading skeleton ── */}
      {loading && (
        <div className="card" style={{ padding: 32, textAlign: 'center' }}>
          <div style={{ fontSize: '2rem', marginBottom: 12 }}>🤖</div>
          <div style={{ color: 'var(--text-muted)', fontSize: '.95rem' }}>
            AI 正在分析需求，生成员工画像配置...
          </div>
          <div style={{
            marginTop: 20, height: 4, borderRadius: 2,
            background: 'var(--border)',
            overflow: 'hidden',
          }}>
            <div style={{
              height: '100%', borderRadius: 2,
              background: 'var(--accent)',
              animation: 'progress-indeterminate 1.4s ease-in-out infinite',
            }} />
          </div>
          <style>{`@keyframes progress-indeterminate{0%{transform:translateX(-100%) scaleX(.3)}50%{transform:translateX(0%) scaleX(.5)}100%{transform:translateX(100%) scaleX(.3)}}`}</style>
        </div>
      )}

      {/* ── Error ── */}
      {error && (
        <div style={{
          padding: '14px 18px', borderRadius: 10, marginBottom: 16,
          background: 'rgba(239,68,68,.08)', border: '1px solid rgba(239,68,68,.3)',
          color: '#ef4444', fontSize: '.9rem',
        }}>
          ❌ {error}
        </div>
      )}

      {/* ── Result ── */}
      {result && spec && (
        <div>
          {/* Meta bar */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 16, flexWrap: 'wrap' }}>
            <span style={{
              padding: '4px 12px', borderRadius: 20, fontSize: '.82rem', fontWeight: 600,
              background: `${confColor(result.confidence)}22`,
              color: confColor(result.confidence),
              border: `1px solid ${confColor(result.confidence)}44`,
            }}>
              置信度 {(result.confidence * 100).toFixed(0)}%
            </span>
            <span style={{
              padding: '4px 12px', borderRadius: 20, fontSize: '.82rem',
              background: 'var(--bg-secondary)', color: 'var(--text-muted)',
              border: '1px solid var(--border)',
            }}>
              {DOMAIN_LABELS[spec.knowledge_domain] || spec.knowledge_domain} 领域
            </span>
            {result.clarification_needed && (
              <span style={{
                padding: '4px 12px', borderRadius: 20, fontSize: '.82rem',
                background: 'rgba(245,158,11,.1)', color: '#f59e0b',
                border: '1px solid rgba(245,158,11,.3)',
              }}>
                ⚠️ {result.clarification_needed}
              </span>
            )}
            {result.generation_notes.map((n, i) => (
              <span key={i} style={{ fontSize: '.8rem', color: 'var(--text-muted)' }}>ℹ️ {n}</span>
            ))}
          </div>

          {/* Spec Editor Card */}
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            {/* Card Header */}
            <div style={{
              padding: '20px 24px 0',
              borderBottom: '1px solid var(--border)',
            }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, marginBottom: 16 }}>
                <div style={{
                  width: 48, height: 48, borderRadius: 12,
                  background: 'linear-gradient(135deg, var(--accent), #7c3aed)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: '1.4rem', flexShrink: 0,
                }}>🤖</div>
                <div style={{ flex: 1 }}>
                  <input
                    id="spec-name"
                    value={spec.name}
                    onChange={e => updateSpec('name', e.target.value)}
                    style={{
                      fontSize: '1.2rem', fontWeight: 700,
                      border: 'none', background: 'transparent',
                      color: 'var(--text-primary)', width: '100%',
                      outline: 'none', padding: 0,
                      borderBottom: '1.5px dashed transparent',
                    }}
                    onFocus={e => (e.target.style.borderBottomColor = 'var(--accent)')}
                    onBlur={e => (e.target.style.borderBottomColor = 'transparent')}
                  />
                  <div style={{ fontSize: '.82rem', color: 'var(--text-muted)', marginTop: 2 }}>
                    ID: <code style={{ fontSize: '.8rem' }}>{spec.id}</code>
                  </div>
                </div>
              </div>

              {/* Tabs */}
              <div style={{ display: 'flex', gap: 0 }}>
                {(['basic', 'style', 'safety', 'routing'] as const).map(tab => {
                  const labels: Record<string, string> = {
                    basic: '📋 基本信息', style: '💬 回复风格', safety: '🚫 安全禁忌', routing: '🔀 路由配置',
                  };
                  return (
                    <button
                      key={tab}
                      id={`tab-${tab}`}
                      onClick={() => setActiveTab(tab)}
                      style={{
                        padding: '10px 18px', border: 'none', background: 'transparent',
                        borderBottom: activeTab === tab ? '2px solid var(--accent)' : '2px solid transparent',
                        color: activeTab === tab ? 'var(--accent)' : 'var(--text-muted)',
                        fontWeight: activeTab === tab ? 600 : 400,
                        cursor: 'pointer', fontSize: '.88rem', transition: 'all .15s',
                      }}
                    >
                      {labels[tab]}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Tab Content */}
            <div style={{ padding: 24 }}>
              {/* ── Basic ── */}
              {activeTab === 'basic' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                  <Field label="职责描述" hint="描述员工是谁、做什么、边界在哪里">
                    <textarea
                      id="spec-role-desc"
                      value={spec.role_desc}
                      onChange={e => updateSpec('role_desc', e.target.value)}
                      rows={3}
                      style={textareaStyle}
                    />
                  </Field>
                  <Field label="服务流程" hint="动词序列，最多6步，用 → 分隔">
                    <input
                      id="spec-service-flow"
                      value={spec.service_flow}
                      onChange={e => updateSpec('service_flow', e.target.value)}
                      placeholder="了解需求 → 提供方案 → 跟进反馈"
                      style={inputStyle}
                    />
                  </Field>
                  <Field label="安抚话术模板" hint="用户情绪激动时使用，1-2句自然语言">
                    <input
                      id="spec-reassurance"
                      value={spec.reassurance_tpl}
                      onChange={e => updateSpec('reassurance_tpl', e.target.value)}
                      style={inputStyle}
                    />
                  </Field>
                  <Field label="知识领域">
                    <select
                      id="spec-domain"
                      value={spec.knowledge_domain}
                      onChange={e => updateSpec('knowledge_domain', e.target.value)}
                      style={{ ...inputStyle, cursor: 'pointer' }}
                    >
                      {Object.entries(DOMAIN_LABELS).map(([v, l]) => (
                        <option key={v} value={v}>{l}</option>
                      ))}
                    </select>
                  </Field>
                </div>
              )}

              {/* ── Style ── */}
              {activeTab === 'style' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                  <Field label="回复风格描述" hint="说明语气、字数上限、禁止格式（不描述内容）">
                    <textarea
                      id="spec-reply-style"
                      value={spec.reply_style}
                      onChange={e => updateSpec('reply_style', e.target.value)}
                      rows={3}
                      style={textareaStyle}
                    />
                  </Field>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                    <Field label="最大回复长度（字）">
                      <input
                        id="spec-max-length"
                        type="number"
                        min={50} max={500}
                        value={spec.delivery_config.max_reply_length}
                        onChange={e => updateDelivery('max_reply_length', parseInt(e.target.value))}
                        style={inputStyle}
                      />
                    </Field>
                    <Field label="问候风格">
                      <select
                        id="spec-greeting-style"
                        value={spec.delivery_config.greeting_style}
                        onChange={e => updateDelivery('greeting_style', e.target.value)}
                        style={{ ...inputStyle, cursor: 'pointer' }}
                      >
                        {Object.entries(GREETING_LABELS).map(([v, l]) => (
                          <option key={v} value={v}>{l}</option>
                        ))}
                      </select>
                    </Field>
                    <Field label="回复语气">
                      <select
                        id="spec-response-tone"
                        value={spec.delivery_config.response_tone}
                        onChange={e => updateDelivery('response_tone', e.target.value)}
                        style={{ ...inputStyle, cursor: 'pointer' }}
                      >
                        {Object.entries(TONE_LABELS).map(([v, l]) => (
                          <option key={v} value={v}>{l}</option>
                        ))}
                      </select>
                    </Field>
                    <Field label="使用 Emoji">
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingTop: 10 }}>
                        <label className="toggle-switch" style={{ position: 'relative', display: 'inline-block', width: 44, height: 24 }}>
                          <input
                            id="spec-use-emoji"
                            type="checkbox"
                            checked={spec.delivery_config.use_emoji}
                            onChange={e => updateDelivery('use_emoji', e.target.checked)}
                            style={{ opacity: 0, width: 0, height: 0 }}
                          />
                          <span style={{
                            position: 'absolute', cursor: 'pointer', inset: 0,
                            background: spec.delivery_config.use_emoji ? 'var(--accent)' : 'var(--border)',
                            borderRadius: 24, transition: '.3s',
                          }}>
                            <span style={{
                              position: 'absolute',
                              width: 18, height: 18, left: spec.delivery_config.use_emoji ? 22 : 3,
                              top: 3, background: '#fff', borderRadius: '50%', transition: '.3s',
                            }} />
                          </span>
                        </label>
                        <span style={{ fontSize: '.88rem', color: 'var(--text-muted)' }}>
                          {spec.delivery_config.use_emoji ? '启用' : '禁用'}
                        </span>
                      </div>
                    </Field>
                  </div>
                </div>
              )}

              {/* ── Safety / Taboos ── */}
              {activeTab === 'safety' && (
                <div>
                  <div style={{ fontSize: '.88rem', color: 'var(--text-muted)', marginBottom: 14 }}>
                    前 5 条为系统基线禁忌，不可删除。其余为 AI 推断或手动添加的领域专属禁忌。
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {spec.taboos.map((t, i) => {
                      const isBaseline = i < 5;
                      return (
                        <div key={i} style={{
                          display: 'flex', alignItems: 'center', gap: 10,
                          padding: '10px 14px', borderRadius: 8,
                          background: isBaseline ? 'rgba(239,68,68,.05)' : 'var(--bg-secondary)',
                          border: `1px solid ${isBaseline ? 'rgba(239,68,68,.15)' : 'var(--border)'}`,
                        }}>
                          <span style={{ fontSize: '.9rem', flexShrink: 0 }}>
                            {isBaseline ? '🔒' : '❌'}
                          </span>
                          <input
                            id={`taboo-${i}`}
                            value={t}
                            disabled={isBaseline}
                            onChange={e => {
                              const next = [...spec.taboos];
                              next[i] = e.target.value;
                              updateSpec('taboos', next);
                            }}
                            style={{
                              flex: 1, border: 'none', background: 'transparent',
                              color: isBaseline ? 'var(--text-muted)' : 'var(--text-primary)',
                              fontSize: '.9rem', outline: 'none',
                            }}
                          />
                          {!isBaseline && (
                            <button
                              onClick={() => removeTaboo(i)}
                              style={{
                                background: 'none', border: 'none', cursor: 'pointer',
                                color: '#ef4444', fontSize: '.9rem', padding: '2px 6px', borderRadius: 4,
                              }}
                            >✕</button>
                          )}
                        </div>
                      );
                    })}

                    {/* Add taboo */}
                    <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                      <input
                        id="new-taboo-input"
                        value={newTaboo}
                        onChange={e => setNewTaboo(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') addTaboo(); }}
                        placeholder="添加新禁忌..."
                        style={{ ...inputStyle, flex: 1 }}
                      />
                      <button
                        id="btn-add-taboo"
                        onClick={addTaboo}
                        disabled={!newTaboo.trim()}
                        style={{
                          padding: '10px 16px', borderRadius: 8, border: 'none',
                          background: newTaboo.trim() ? 'var(--accent)' : 'var(--border)',
                          color: newTaboo.trim() ? '#fff' : 'var(--text-muted)',
                          cursor: newTaboo.trim() ? 'pointer' : 'default',
                          fontWeight: 600, fontSize: '.88rem',
                        }}
                      >+ 添加</button>
                    </div>
                  </div>
                </div>
              )}

              {/* ── Routing ── */}
              {activeTab === 'routing' && (
                <div>
                  {spec.routing_examples.length === 0 ? (
                    <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '24px 0', fontSize: '.9rem' }}>
                      暂无路由示例，AI 可在测试过程中自动补充
                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                      {spec.routing_examples.map((ex, i) => (
                        <div key={i} style={{
                          padding: '14px 16px', borderRadius: 10,
                          background: 'var(--bg-secondary)', border: '1px solid var(--border)',
                        }}>
                          <div style={{ fontSize: '.82rem', color: 'var(--text-muted)', marginBottom: 4 }}>用户说：</div>
                          <div style={{ fontWeight: 500, marginBottom: 8 }}>"{ex.user_says}"</div>
                          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                            <span style={{
                              padding: '3px 10px', borderRadius: 20, fontSize: '.8rem',
                              background: 'rgba(99,102,241,.12)', color: 'var(--accent)',
                              border: '1px solid rgba(99,102,241,.2)', fontWeight: 600,
                            }}>→ {ex.route_to}</span>
                            <span style={{ fontSize: '.82rem', color: 'var(--text-muted)' }}>{ex.reason}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* ── Footer Actions ── */}
            <div style={{
              padding: '16px 24px', borderTop: '1px solid var(--border)',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              gap: 12, flexWrap: 'wrap',
              background: 'var(--bg-secondary)',
            }}>
              <div style={{ fontSize: '.85rem', color: 'var(--text-muted)' }}>
                修改后点击「提交试用」，候选员工将进入 Ralph 考评飞轮
              </div>
              <div style={{ display: 'flex', gap: 10 }}>
                <button
                  id="btn-regenerate"
                  onClick={handleGenerate}
                  disabled={loading}
                  style={{
                    padding: '9px 18px', borderRadius: 8,
                    border: '1.5px solid var(--border)',
                    background: 'var(--bg-primary)', color: 'var(--text-primary)',
                    fontWeight: 600, cursor: 'pointer', fontSize: '.88rem',
                  }}
                >
                  🔄 重新生成
                </button>
                <button
                  id="btn-submit-agent"
                  onClick={handleSubmit}
                  disabled={saving || saved}
                  style={{
                    padding: '9px 22px', borderRadius: 8, border: 'none',
                    background: saved ? '#22c55e' : 'var(--accent)',
                    color: '#fff', fontWeight: 600, cursor: saving || saved ? 'default' : 'pointer',
                    fontSize: '.88rem', transition: 'all .2s',
                  }}
                >
                  {saved ? '✅ 已提交试用' : saving ? '提交中...' : '🚀 提交试用'}
                </button>
              </div>
            </div>
          </div>

          {/* ── Hint after submit ── */}
          {saved && (
            <div style={{
              marginTop: 16, padding: '14px 18px', borderRadius: 10,
              background: 'rgba(34,197,94,.08)', border: '1px solid rgba(34,197,94,.25)',
              color: '#16a34a', fontSize: '.9rem',
            }}>
              ✅ 候选员工 <strong>{spec.name}</strong>（{spec.id}）已成功登记！
              <br />
              <span style={{ fontSize: '.82rem', opacity: .8 }}>
                在「Agent 实例管理」中可查看试用期状态，并在准备好后启动 Ralph 评测飞轮。
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Field wrapper ─────────────────────────────────────────────────────────────
function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label style={{ display: 'block', fontWeight: 600, fontSize: '.88rem', marginBottom: 6, color: 'var(--text-primary)' }}>
        {label}
        {hint && <span style={{ fontWeight: 400, color: 'var(--text-muted)', marginLeft: 8, fontSize: '.82rem' }}>{hint}</span>}
      </label>
      {children}
    </div>
  );
}

// ── Shared styles ─────────────────────────────────────────────────────────────
const inputStyle: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box',
  padding: '10px 13px', borderRadius: 8,
  border: '1.5px solid var(--border)',
  background: 'var(--bg-secondary)',
  color: 'var(--text-primary)',
  fontSize: '.9rem', outline: 'none',
  fontFamily: 'inherit', transition: 'border-color .2s',
};

const textareaStyle: React.CSSProperties = {
  ...inputStyle,
  resize: 'vertical' as const,
  lineHeight: 1.6,
};
