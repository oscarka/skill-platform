import { useState, useEffect, useCallback } from 'react';

const API = '/api/v1/agent';

interface PublishedSkill {
  id:          string;
  name:        string;
  description: string;
  category:    string;
}

interface AgentProfile {
  name:             string;
  role_desc:        string;
  reply_style:      string;
  service_flow:     string;
  taboos:           string[];
  reassurance_mode: 'ai' | 'template';
  reassurance_tpl:  string;
  skill_mode:       'auto' | 'manual';
  skill_ids:        string[];
}

const DEFAULT_PROFILE: AgentProfile = {
  name:             '服务助理',
  role_desc:        '专业健康顾问助理，协助客户了解检查报告和日常健康管理',
  reply_style:      '亲切、专业，回复简洁不超过200字',
  service_flow:     '1. 判断是否为健康相关问题\n2. 健康问题优先调用对应 skill 深度分析\n3. 非健康问题礼貌回复并适当引导',
  taboos:           ['不诊断疾病', '不推荐具体药物品牌', '不承诺治疗效果'],
  reassurance_mode: 'ai',
  reassurance_tpl:  '',
  skill_mode:       'auto',
  skill_ids:        [],
};

export default function AgentProfilePage() {
  const [profile,       setProfile]       = useState<AgentProfile>(DEFAULT_PROFILE);
  const [skills,        setSkills]        = useState<PublishedSkill[]>([]);
  const [saving,        setSaving]        = useState(false);
  const [saveMsg,       setSaveMsg]       = useState('');
  const [newTaboo,      setNewTaboo]      = useState('');
  const [loading,       setLoading]       = useState(true);

  // ── 加载 ─────────────────────────────────────────────────────────────────────
  useEffect(() => {
    Promise.all([
      fetch(`${API}/profile`).then(r => r.json()),
      fetch(`${API}/skills/available`).then(r => r.json()),
    ]).then(([profileData, skillsData]) => {
      setProfile({ ...DEFAULT_PROFILE, ...profileData });
      setSkills(Array.isArray(skillsData) ? skillsData : []);
    }).catch(console.error).finally(() => setLoading(false));
  }, []);

  // ── 保存 ─────────────────────────────────────────────────────────────────────
  const save = useCallback(async () => {
    setSaving(true);
    setSaveMsg('');
    try {
      const res = await fetch(`${API}/profile`, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(profile),
      });
      if (!res.ok) throw new Error(await res.text());
      setSaveMsg('✅ 保存成功');
    } catch (e: any) {
      setSaveMsg(`❌ 保存失败: ${e.message}`);
    } finally {
      setSaving(false);
      setTimeout(() => setSaveMsg(''), 3000);
    }
  }, [profile]);

  const updateField = (key: keyof AgentProfile, val: any) =>
    setProfile(p => ({ ...p, [key]: val }));

  const addTaboo = () => {
    if (!newTaboo.trim()) return;
    updateField('taboos', [...profile.taboos, newTaboo.trim()]);
    setNewTaboo('');
  };

  const removeTaboo = (i: number) =>
    updateField('taboos', profile.taboos.filter((_, idx) => idx !== i));

  const toggleSkill = (id: string) => {
    const ids = profile.skill_ids.includes(id)
      ? profile.skill_ids.filter(s => s !== id)
      : [...profile.skill_ids, id];
    updateField('skill_ids', ids);
  };

  if (loading) return <div className="page-loading">加载中…</div>;

  return (
    <div style={{ maxWidth: 720, margin: '0 auto' }}>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: '1.4rem', fontWeight: 700, margin: 0 }}>🤖 服务配置</h1>
        <p style={{ color: 'var(--muted)', margin: '6px 0 0' }}>
          配置主 Agent 的身份、服务流程和可用技能，Agent 将根据这些配置自主决策如何回复客户。
        </p>
      </div>

      {/* ── 基本属性 ──────────────────────────────────────────────────────────── */}
      <Section title="基本属性">
        <Label text="Agent 名称">
          <input
            className="form-input"
            value={profile.name}
            onChange={e => updateField('name', e.target.value)}
            placeholder="如：健康顾问助理小林"
          />
        </Label>

        <Label text="角色定位">
          <textarea
            className="form-input"
            rows={2}
            value={profile.role_desc}
            onChange={e => updateField('role_desc', e.target.value)}
            placeholder="描述 Agent 的身份和专业范围"
          />
        </Label>

        <Label text="回复风格">
          <input
            className="form-input"
            value={profile.reply_style}
            onChange={e => updateField('reply_style', e.target.value)}
            placeholder="如：亲切、专业，回复简洁不超过200字"
          />
        </Label>
      </Section>

      {/* ── 服务流程 ──────────────────────────────────────────────────────────── */}
      <Section title="服务流程">
        <p style={{ fontSize: '.82rem', color: 'var(--muted)', margin: '0 0 8px' }}>
          告诉 Agent 应该按照什么逻辑处理各种情况。
        </p>
        <textarea
          className="form-input"
          rows={6}
          value={profile.service_flow}
          onChange={e => updateField('service_flow', e.target.value)}
          placeholder="1. 先判断是否为健康相关问题&#10;2. 健康问题优先调用 skill 深度分析&#10;3. 遇到紧急症状提示立即就医"
        />
      </Section>

      {/* ── 禁忌清单 ──────────────────────────────────────────────────────────── */}
      <Section title="禁忌清单">
        <p style={{ fontSize: '.82rem', color: 'var(--muted)', margin: '0 0 10px' }}>
          明确告诉 Agent 哪些事不能做。
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
          {profile.taboos.map((t, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{
                flex: 1, background: 'rgba(255,80,80,.1)', border: '1px solid rgba(255,80,80,.2)',
                borderRadius: 6, padding: '6px 10px', fontSize: '.88rem',
              }}>🚫 {t}</span>
              <button
                onClick={() => removeTaboo(i)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', fontSize: '1rem' }}
              >×</button>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            className="form-input"
            style={{ flex: 1 }}
            value={newTaboo}
            onChange={e => setNewTaboo(e.target.value)}
            placeholder="添加一条禁忌…"
            onKeyDown={e => e.key === 'Enter' && addTaboo()}
          />
          <button className="btn btn-secondary" onClick={addTaboo}>添加</button>
        </div>
      </Section>

      {/* ── 安抚消息 ──────────────────────────────────────────────────────────── */}
      <Section title="安抚消息">
        <p style={{ fontSize: '.82rem', color: 'var(--muted)', margin: '0 0 12px' }}>
          调用 Skill 时需要 2-3 分钟，期间先给客户发一条等待提示。
        </p>
        <div style={{ display: 'flex', gap: 16, marginBottom: 12 }}>
          <RadioOption
            checked={profile.reassurance_mode === 'ai'}
            onChange={() => updateField('reassurance_mode', 'ai')}
            label="🤖 AI 自动生成"
            hint="根据客户具体问题动态生成，更自然"
          />
          <RadioOption
            checked={profile.reassurance_mode === 'template'}
            onChange={() => updateField('reassurance_mode', 'template')}
            label="📝 固定模板"
            hint="每次发送相同内容"
          />
        </div>
        {profile.reassurance_mode === 'template' && (
          <input
            className="form-input"
            value={profile.reassurance_tpl}
            onChange={e => updateField('reassurance_tpl', e.target.value)}
            placeholder="{客户姓名}您好，我正在为您分析，请稍等约2分钟～"
          />
        )}
      </Section>

      {/* ── Skill 权限 ────────────────────────────────────────────────────────── */}
      <Section title="可用 Skill">
        <div style={{ display: 'flex', gap: 16, marginBottom: 16 }}>
          <RadioOption
            checked={profile.skill_mode === 'auto'}
            onChange={() => updateField('skill_mode', 'auto')}
            label="⚡ 全部已审批 Skill"
            hint="自动包含所有 published 状态的 skill，新审批的自动生效"
          />
          <RadioOption
            checked={profile.skill_mode === 'manual'}
            onChange={() => updateField('skill_mode', 'manual')}
            label="✋ 手动勾选"
            hint="只使用下方勾选的 skill"
          />
        </div>

        {skills.length === 0 ? (
          <p style={{ color: 'var(--muted)', fontSize: '.85rem' }}>暂无已审批的 Skill</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {skills.map(sk => {
              const checked = profile.skill_mode === 'auto' || profile.skill_ids.includes(sk.id);
              const disabled = profile.skill_mode === 'auto';
              return (
                <label
                  key={sk.id}
                  style={{
                    display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 12px',
                    background: checked ? 'rgba(99,102,241,.08)' : 'rgba(255,255,255,.03)',
                    border: `1px solid ${checked ? 'rgba(99,102,241,.3)' : 'rgba(255,255,255,.08)'}`,
                    borderRadius: 8, cursor: disabled ? 'default' : 'pointer',
                    opacity: disabled ? 0.7 : 1,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={disabled}
                    onChange={() => !disabled && toggleSkill(sk.id)}
                    style={{ marginTop: 2, accentColor: '#6366f1' }}
                  />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600, fontSize: '.9rem' }}>{sk.name}</div>
                    {sk.description && (
                      <div style={{ fontSize: '.8rem', color: 'var(--muted)', marginTop: 2 }}>
                        {sk.description}
                      </div>
                    )}
                  </div>
                  {sk.category && (
                    <span style={{
                      fontSize: '.72rem', padding: '2px 7px', borderRadius: 10,
                      background: 'rgba(99,102,241,.15)', color: '#a5b4fc',
                    }}>{sk.category}</span>
                  )}
                </label>
              );
            })}
          </div>
        )}
      </Section>

      {/* ── 保存按钮 ──────────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginTop: 8, paddingBottom: 40 }}>
        <button
          className="btn btn-primary"
          onClick={save}
          disabled={saving}
          style={{ minWidth: 120 }}
        >
          {saving ? '保存中…' : '保存配置'}
        </button>
        {saveMsg && <span style={{ fontSize: '.9rem' }}>{saveMsg}</span>}
      </div>
    </div>
  );
}

// ─── 子组件 ───────────────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{
      background: 'rgba(255,255,255,.04)', border: '1px solid rgba(255,255,255,.08)',
      borderRadius: 12, padding: '20px 24px', marginBottom: 16,
    }}>
      <h2 style={{ fontSize: '1rem', fontWeight: 600, margin: '0 0 14px', color: '#e2e8f0' }}>
        {title}
      </h2>
      {children}
    </div>
  );
}

function Label({ text, children }: { text: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: '.82rem', fontWeight: 500, color: 'var(--muted)', marginBottom: 5 }}>{text}</div>
      {children}
    </div>
  );
}

function RadioOption({
  checked, onChange, label, hint,
}: {
  checked: boolean; onChange: () => void; label: string; hint: string;
}) {
  return (
    <label style={{
      flex: 1, display: 'flex', flexDirection: 'column', gap: 4, padding: '10px 14px',
      background: checked ? 'rgba(99,102,241,.12)' : 'rgba(255,255,255,.03)',
      border: `1px solid ${checked ? 'rgba(99,102,241,.4)' : 'rgba(255,255,255,.08)'}`,
      borderRadius: 10, cursor: 'pointer',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input type="radio" checked={checked} onChange={onChange} style={{ accentColor: '#6366f1' }} />
        <span style={{ fontWeight: 600, fontSize: '.9rem' }}>{label}</span>
      </div>
      <span style={{ fontSize: '.78rem', color: 'var(--muted)', paddingLeft: 22 }}>{hint}</span>
    </label>
  );
}
