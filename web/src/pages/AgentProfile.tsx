import { useState, useEffect, useCallback } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';

const API = '/api/v1/agent';

interface PublishedSkill {
  id:          string;
  name:        string;
  description: string;
  category:    string;
  tags:        string[];
}

// ── 新增：分诊示例配置 ────────────────────────────────────────────────────────
interface RoutingExamples {
  high_desc:     string;   // 高置信度说明
  low_desc:      string;   // 低置信度说明
  examples_high: string[]; // 高置信度例句
  examples_low:  string[]; // 低置信度例句
  examples_none: string[]; // 无意图例句
}

// ── 新增：知识库工具配置 ───────────────────────────────────────────────────────
interface KnowledgeTool {
  name:         string;  // function call 名称（英文）
  display_name: string;  // 显示名称（中文）
  when_to_call: string;  // 调用时机描述
  target_page:  string;  // 对应知识库页面文件名
}
interface KnowledgeConfig {
  type:  string;         // 知识库类型标识
  tools: KnowledgeTool[];
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
  routing_examples: RoutingExamples | null;  // null = 使用系统默认分诊提示词
  knowledge_config: KnowledgeConfig | null;  // null = 使用系统默认知识库逻辑
  // 新用户欢迎语
  welcome_enabled:  boolean;
  welcome_msg:      string;
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
  routing_examples: null,
  knowledge_config: null,
  welcome_enabled:  false,
  welcome_msg:      '',
};

// 新建 Agent 时的分诊配置模板（用户可在此基础上修改）
const ROUTING_TEMPLATE: RoutingExamples = {
  high_desc:     '用户明确表达了要使用某个服务或有明确需求',
  low_desc:      '用户有相关问题但未明确要求使用服务，直接用AI知识回答即可',
  examples_high: ['帮我分析', '我想了解具体方案', '开始使用'],
  examples_low:  ['这个怎么回事', '有什么影响', '需要注意什么'],
  examples_none: ['你好', '在吗', '谢谢'],
};

// 新建知识库工具模板
const KNOWLEDGE_TEMPLATE: KnowledgeConfig = {
  type:  'wiki',
  tools: [
    {
      name:         'get_wiki_page',
      display_name: '知识库查询',
      when_to_call: '用户询问相关知识或需要参考资料时调用',
      target_page:  'index.md',
    },
  ],
};

export default function AgentProfilePage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const agentId = searchParams.get('agentId'); // null = default

  const [profile,       setProfile]       = useState<AgentProfile>(DEFAULT_PROFILE);
  const [skills,        setSkills]        = useState<PublishedSkill[]>([]);
  const [saving,        setSaving]        = useState(false);
  const [saveMsg,       setSaveMsg]       = useState('');
  const [newTaboo,      setNewTaboo]      = useState('');
  const [loading,       setLoading]       = useState(true);
  const [instanceName,  setInstanceName]  = useState('');

  // ── 分诊配置编辑临时状态 ──────────────────────────────────────────────────────
  const [newExHigh, setNewExHigh] = useState('');
  const [newExLow,  setNewExLow]  = useState('');
  const [newExNone, setNewExNone] = useState('');

  // ── 加载：agentId 存在时加载对应实例，否则加载默认 profile ──────────────────
  useEffect(() => {
    const profileUrl = agentId ? `${API}/profiles/${agentId}` : `${API}/profile`;
    Promise.all([
      fetch(profileUrl).then(r => r.json()),
      fetch(`${API}/skills/available`).then(r => r.json()),
    ]).then(([profileData, skillsData]) => {
      setProfile({ ...DEFAULT_PROFILE, ...profileData });
      setInstanceName(profileData.name ?? '');
      setSkills(Array.isArray(skillsData) ? skillsData : []);
    }).catch(console.error).finally(() => setLoading(false));
  }, [agentId]);

  // ── 保存：agentId 存在时保存到对应实例，否则保存到默认 profile ──────────────
  const save = useCallback(async () => {
    setSaving(true);
    setSaveMsg('');
    try {
      const saveUrl = agentId ? `${API}/profiles/${agentId}` : `${API}/profile`;
      const res = await fetch(saveUrl, {
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
  }, [profile, agentId]);

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

  // ── 分诊配置辅助函数 ──────────────────────────────────────────────────────────
  const re = profile.routing_examples;
  const updateRe = (key: keyof RoutingExamples, val: any) => {
    if (!re) return;
    updateField('routing_examples', { ...re, [key]: val });
  };
  const addReExample = (field: 'examples_high' | 'examples_low' | 'examples_none', val: string, clear: () => void) => {
    if (!val.trim() || !re) return;
    updateRe(field, [...re[field], val.trim()]);
    clear();
  };
  const removeReExample = (field: 'examples_high' | 'examples_low' | 'examples_none', i: number) => {
    if (!re) return;
    updateRe(field, re[field].filter((_: any, idx: number) => idx !== i));
  };

  // ── 知识库工具辅助函数 ────────────────────────────────────────────────────────
  const kc = profile.knowledge_config;
  const updateTool = (i: number, key: keyof KnowledgeTool, val: string) => {
    if (!kc) return;
    const tools = kc.tools.map((t, idx) => idx === i ? { ...t, [key]: val } : t);
    updateField('knowledge_config', { ...kc, tools });
  };
  const addTool = () => {
    const newTool: KnowledgeTool = { name: '', display_name: '', when_to_call: '', target_page: '' };
    updateField('knowledge_config', { ...(kc ?? KNOWLEDGE_TEMPLATE), tools: [...(kc?.tools ?? []), newTool] });
  };
  const removeTool = (i: number) => {
    if (!kc) return;
    updateField('knowledge_config', { ...kc, tools: kc.tools.filter((_: any, idx: number) => idx !== i) });
  };

  if (loading) return <div className="page-loading">加载中…</div>;

  return (
    <div style={{ maxWidth: 720, margin: '0 auto' }}>
      {/* 返回按钮 + 实例标题（从 agent-instances 进入时显示） */}
      {agentId ? (
        <div style={{ marginBottom: 24 }}>
          <button
            onClick={() => navigate('/agent-instances')}
            style={{
              background: 'none', border: '1px solid var(--border)', borderRadius: 8,
              padding: '6px 14px', cursor: 'pointer', color: 'var(--muted)',
              fontSize: '.82rem', marginBottom: 12,
            }}
          >
            ← 返回实例列表
          </button>
          <h1 style={{ fontSize: '1.4rem', fontWeight: 700, margin: 0 }}>
            ✏️ {instanceName || agentId}
          </h1>
          <p style={{ color: 'var(--muted)', margin: '6px 0 0', fontSize: '.88rem' }}>
            编辑此 Agent 实例的身份、服务流程和可用技能。
          </p>
        </div>
      ) : (
        <div style={{ marginBottom: 24 }}>
          <h1 style={{ fontSize: '1.4rem', fontWeight: 700, margin: 0 }}>🤖 服务配置</h1>
          <p style={{ color: 'var(--muted)', margin: '6px 0 0' }}>
            配置主 Agent 的身份、服务流程和可用技能，Agent 将根据这些配置自主决策如何回复客户。
          </p>
        </div>
      )}

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

      {/* ── 👋 新用户欢迎语 ───────────────────────────────────────────────── */}
      <Section title="👋 新用户欢迎语">
        <p style={{ fontSize: '.82rem', color: 'var(--muted)', margin: '0 0 14px' }}>
          客户第一次发消息时自动发送欢迎语，并收集其称呼和健康基本信息。<br />
          <span style={{ color: '#94a3b8' }}>触发条件：开关已开启 + 客户没有任何历史对话 + LLMWiki 档案为新建状态。</span>
        </p>

        {/* 开关 */}
        <label style={{
          display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14,
          cursor: 'pointer',
        }}>
          <div
            onClick={() => updateField('welcome_enabled', !profile.welcome_enabled)}
            style={{
              width: 40, height: 22, borderRadius: 11,
              background: profile.welcome_enabled ? '#6366f1' : 'rgba(255,255,255,.15)',
              position: 'relative', cursor: 'pointer', transition: 'background .2s',
              flexShrink: 0,
            }}
          >
            <div style={{
              position: 'absolute', top: 3, left: profile.welcome_enabled ? 21 : 3,
              width: 16, height: 16, borderRadius: '50%', background: '#fff',
              transition: 'left .2s',
            }} />
          </div>
          <span style={{ fontSize: '.9rem', fontWeight: 500 }}>
            {profile.welcome_enabled ? '✅ 欢迎语已开启' : '⚪ 关闭（内测模式）'}
          </span>
        </label>

        {/* 欢迎语编辑框 */}
        <Label text="欢迎语内容">
          <textarea
            className="form-input"
            rows={6}
            value={profile.welcome_msg}
            onChange={e => updateField('welcome_msg', e.target.value)}
            placeholder={`您好！我是[助手名] 🌿

认识您很高兴！想先问几个小问题，帮我更好地了解您：

1. 怎么称呼您？
2. 最近最想关注哪方面的健康（睡眠、饮食、血压、体重……）？
3. 年龄和性别方便告诉我吗？

期待您的回复～`}
            style={{ fontFamily: 'inherit', lineHeight: 1.7 }}
          />
        </Label>

        {/* 预览提示 */}
        {profile.welcome_msg && (
          <div style={{
            background: 'rgba(99,102,241,.06)', border: '1px solid rgba(99,102,241,.2)',
            borderRadius: 8, padding: '12px 14px', fontSize: '.82rem', color: '#c7d2fe',
            marginTop: 4,
          }}>
            <div style={{ fontWeight: 600, marginBottom: 6, color: '#a5b4fc' }}>👁️ 预览（客户将会看到）</div>
            <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.7 }}>{profile.welcome_msg}</div>
          </div>
        )}
      </Section>

      {/* ── Skill 权限 ────────────────────────────────────────────────────────── */}
      <Section title="可用 Skill">
        <p style={{ fontSize: '.82rem', color: 'var(--muted)', margin: '0 0 16px' }}>
          仅显示已打「agent版」标签的已审批 Skill。
        </p>
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
                  {(sk.tags ?? []).includes('agent版') && (
                    <span style={{
                      fontSize: '.7rem', padding: '2px 7px', borderRadius: 10,
                      background: 'rgba(34,197,94,.15)', color: '#86efac',
                      fontWeight: 600,
                    }}>agent版</span>
                  )}
                </label>
              );
            })}
          </div>
        )}
      </Section>

      {/* ── 🎯 分诊配置 ──────────────────────────────────────────────────────────── */}
      <Section title="🎯 分诊配置">
        <p style={{ fontSize: '.82rem', color: 'var(--muted)', margin: '0 0 14px' }}>
          告诉 Agent 如何判断用户消息的意图置信度。不配置则使用系统默认分诊逻辑（推荐默认 Agent 保持不变）。
        </p>

        {/* 开关：启用 / 使用默认 */}
        <div style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
          <button
            className={`btn ${re === null ? 'btn-secondary' : 'btn-primary'}`}
            style={{ fontSize: '.82rem', padding: '5px 14px' }}
            onClick={() => {
              if (re === null) updateField('routing_examples', ROUTING_TEMPLATE);
              else updateField('routing_examples', null);
            }}
          >
            {re === null ? '点击自定义分诊配置' : '✅ 已自定义 — 点击恢复系统默认'}
          </button>
        </div>

        {/* 系统默认预览（只读） */}
        {re === null && (
          <div style={{
            background: 'rgba(255,255,255,.03)', border: '1px dashed rgba(255,255,255,.12)',
            borderRadius: 8, padding: '12px 14px', fontSize: '.8rem', color: 'var(--muted)',
          }}>
            <div style={{ fontWeight: 600, color: '#94a3b8', marginBottom: 8 }}>📋 当前使用系统默认分诊逻辑：</div>
            <div style={{ marginBottom: 5 }}>🟢 <strong style={{ color: '#e2e8f0' }}>高意图</strong>：客户明确表达了要使用某个服务（如"帮我做营养分析""开始AI营养师"），可主动推荐</div>
            <div style={{ marginBottom: 5 }}>🟡 <strong style={{ color: '#e2e8f0' }}>低意图</strong>：客户有健康相关问题但没明确要求使用服务（如"我血糖高怎么办"），直接AI回答</div>
            <div>⚪ <strong style={{ color: '#e2e8f0' }}>无意图</strong>：普通聊天/问候/询问服务范围，直接回答，不涉及健康或服务</div>
          </div>
        )}

        {re !== null && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {/* high / low 描述 */}
            <Label text="「高意图」描述 — 可主动推荐服务的情形">
              <textarea
                className="form-input"
                rows={2}
                value={re.high_desc}
                onChange={e => updateRe('high_desc', e.target.value)}
                placeholder="用户明确表达了购买/使用意向…"
              />
            </Label>
            <Label text="「低意图」描述 — 有相关问题但无明确需求">
              <textarea
                className="form-input"
                rows={2}
                value={re.low_desc}
                onChange={e => updateRe('low_desc', e.target.value)}
                placeholder="用户有普通询问但无明显意向…"
              />
            </Label>

            {/* 例句组 */}
            <ExampleGroup
              label="「高意图」例句"
              color="rgba(99,241,99,.1)"
              borderColor="rgba(99,241,99,.25)"
              items={re.examples_high}
              inputVal={newExHigh}
              onInputChange={setNewExHigh}
              onAdd={() => addReExample('examples_high', newExHigh, () => setNewExHigh(''))}
              onRemove={i => removeReExample('examples_high', i)}
            />
            <ExampleGroup
              label="「低意图」例句"
              color="rgba(241,199,99,.1)"
              borderColor="rgba(241,199,99,.25)"
              items={re.examples_low}
              inputVal={newExLow}
              onInputChange={setNewExLow}
              onAdd={() => addReExample('examples_low', newExLow, () => setNewExLow(''))}
              onRemove={i => removeReExample('examples_low', i)}
            />
            <ExampleGroup
              label="「无意图」例句（普通聊天/问候）"
              color="rgba(148,163,184,.08)"
              borderColor="rgba(148,163,184,.2)"
              items={re.examples_none}
              inputVal={newExNone}
              onInputChange={setNewExNone}
              onAdd={() => addReExample('examples_none', newExNone, () => setNewExNone(''))}
              onRemove={i => removeReExample('examples_none', i)}
            />
          </div>
        )}
      </Section>

      {/* ── 📚 知识库工具配置 ─────────────────────────────────────────────────────── */}
      <Section title="📚 知识库工具">
        <p style={{ fontSize: '.82rem', color: 'var(--muted)', margin: '0 0 14px' }}>
          配置 Agent 可以调用的知识库查询工具。每个工具对应一个知识库页面，Agent 会在合适时机自动调用。不配置则使用系统默认知识库逻辑。
        </p>

        {/* 开关 */}
        <div style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
          <button
            className={`btn ${kc === null ? 'btn-secondary' : 'btn-primary'}`}
            style={{ fontSize: '.82rem', padding: '5px 14px' }}
            onClick={() => {
              if (kc === null) updateField('knowledge_config', KNOWLEDGE_TEMPLATE);
              else updateField('knowledge_config', null);
            }}
          >
            {kc === null ? '点击自定义知识库工具' : '✅ 已自定义 — 点击恢复系统默认'}
          </button>
        </div>

        {/* 系统默认预览（只读） */}
        {kc === null && (
          <div style={{
            background: 'rgba(255,255,255,.03)', border: '1px dashed rgba(255,255,255,.12)',
            borderRadius: 8, padding: '12px 14px', fontSize: '.8rem', color: 'var(--muted)',
          }}>
            <div style={{ fontWeight: 600, color: '#94a3b8', marginBottom: 8 }}>📋 当前使用系统默认知识库工具：</div>
            <div style={{ marginBottom: 5 }}>📖 <strong style={{ color: '#e2e8f0' }}>get_health_wiki</strong> — 查询用户健康档案 Wiki（含体检报告、病史摘要）</div>
            <div style={{ marginBottom: 5 }}>👤 <strong style={{ color: '#e2e8f0' }}>get_user_profile</strong> — 获取用户基本信息和个人档案</div>
            <div>🗂️ <strong style={{ color: '#e2e8f0' }}>query_ticket</strong> — 查询工单进度和分析报告（用户主动询问时触发）</div>
          </div>
        )}

        {kc !== null && (
          <div>
            {/* 类型标识 */}
            <Label text="知识库类型标识（英文，如 health_wiki / product_rag）">
              <input
                className="form-input"
                value={kc.type}
                onChange={e => updateField('knowledge_config', { ...kc, type: e.target.value })}
                placeholder="如: health_wiki"
              />
            </Label>

            {/* 工具列表 */}
            <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
              {kc.tools.map((tool, i) => (
                <div key={i} style={{
                  background: 'rgba(99,102,241,.06)', border: '1px solid rgba(99,102,241,.2)',
                  borderRadius: 10, padding: '14px 16px', position: 'relative',
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                    <span style={{ fontWeight: 600, fontSize: '.88rem', color: '#a5b4fc' }}>
                      工具 #{i + 1}
                    </span>
                    <button
                      onClick={() => removeTool(i)}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', fontSize: '1.1rem' }}
                    >×</button>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                    <Label text="Function 名称（英文）">
                      <input
                        className="form-input"
                        value={tool.name}
                        onChange={e => updateTool(i, 'name', e.target.value)}
                        placeholder="如: get_product_spec"
                      />
                    </Label>
                    <Label text="显示名称（中文）">
                      <input
                        className="form-input"
                        value={tool.display_name}
                        onChange={e => updateTool(i, 'display_name', e.target.value)}
                        placeholder="如: 产品规格查询"
                      />
                    </Label>
                  </div>
                  <Label text="调用时机">
                    <input
                      className="form-input"
                      value={tool.when_to_call}
                      onChange={e => updateTool(i, 'when_to_call', e.target.value)}
                      placeholder="用户询问…时调用"
                    />
                  </Label>
                  <Label text="知识库页面文件名">
                    <input
                      className="form-input"
                      value={tool.target_page}
                      onChange={e => updateTool(i, 'target_page', e.target.value)}
                      placeholder="如: products.md"
                    />
                  </Label>
                </div>
              ))}
            </div>

            <button
              className="btn btn-secondary"
              style={{ marginTop: 10, fontSize: '.82rem' }}
              onClick={addTool}
            >
              + 添加工具
            </button>
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

// ── 分诊例句组组件 ─────────────────────────────────────────────────────────────
function ExampleGroup({
  label, color, borderColor, items, inputVal, onInputChange, onAdd, onRemove,
}: {
  label: string;
  color: string;
  borderColor: string;
  items: string[];
  inputVal: string;
  onInputChange: (v: string) => void;
  onAdd: () => void;
  onRemove: (i: number) => void;
}) {
  return (
    <div>
      <div style={{ fontSize: '.82rem', fontWeight: 500, color: 'var(--muted)', marginBottom: 6 }}>{label}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
        {items.map((ex, i) => (
          <span key={i} style={{
            display: 'inline-flex', alignItems: 'center', gap: 5,
            background: color, border: `1px solid ${borderColor}`,
            borderRadius: 20, padding: '3px 10px', fontSize: '.8rem',
          }}>
            「{ex}」
            <button
              onClick={() => onRemove(i)}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', fontSize: '.85rem', padding: 0, lineHeight: 1 }}
            >×</button>
          </span>
        ))}
        {items.length === 0 && (
          <span style={{ fontSize: '.78rem', color: 'var(--muted)', fontStyle: 'italic' }}>暂无例句</span>
        )}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          className="form-input"
          style={{ flex: 1, fontSize: '.85rem' }}
          value={inputVal}
          onChange={e => onInputChange(e.target.value)}
          placeholder="输入例句后按 Enter 或点添加…"
          onKeyDown={e => e.key === 'Enter' && onAdd()}
        />
        <button className="btn btn-secondary" style={{ fontSize: '.82rem' }} onClick={onAdd}>添加</button>
      </div>
    </div>
  );
}
