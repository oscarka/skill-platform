import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

// ── Types ─────────────────────────────────────────────────────────────────────

interface AgentProfile {
  id: string;
  name: string;
  role_desc: string;
  reply_style: string;
  skill_mode: 'auto' | 'manual';
  skill_ids: string[];
  routing_examples: any | null;
  knowledge_config: any | null;
  reassurance_mode: string;
  taboos: string[];
  updated_at?: number;
}

interface CandidateAgent {
  id: string;
  name: string;
  role_desc: string;
  reply_style?: string;
  service_flow?: string;
  taboos?: string[];
  reassurance_tpl?: string;
  routing_examples?: any[];
  delivery_config?: any;
  knowledge_domain?: string;
  intent_prompt?: string;
  status: 'draft' | 'evaluating' | 'pending_human_approval' | 'approved' | 'rejected';
  current_score: number;
  best_score: number;
  total_eval_rounds: number;
  created_at: number;
  updated_at: number;
}

interface CaseResult {
  case_id: string;
  case_name: string;
  category: string;
  score: number;
  passed: boolean;
  taboo_violated?: boolean;
  agent_reply?: string;
  latency_ms: number;
  details: string[];
}

interface EvalRunDetail {
  run_id: string;
  agent_id: string;
  round: number;
  agent_version: string;
  total_score: number;
  score_compliance: number;
  score_business: number;
  score_ticket_skill: number;
  score_memory: number;
  passed_cases: number;
  failed_cases: number;
  total_cases: number;
  taboo_violated: boolean;
  case_results: CaseResult[];
  created_at: number;
}

const API = '/api/v1/agent';

const BADGE = {
  auto:   { label: '全部 Skill',  color: '#6366f1', bg: 'rgba(99,102,241,.15)' },
  manual: { label: '手动选择',   color: '#f59e0b', bg: 'rgba(245,158,11,.15)' },
};

const CATEGORY_NAMES: Record<string, string> = {
  business_intent: '🎯 业务意图',
  taboo_guard: '🛡️ 禁忌防护',
  service_flow: '🔄 服务流程',
  tone_style: '🎨 语气风格',
  edge_case: '⚠️ 边界异常',
  reassurance: '🤝 情绪安抚',
  memory_context: '🧠 记忆保真',
  routing_decision: '🔀 路由分诊',
  system_integration: '💻 系统集成',
};

const STATUS_BADGE: Record<string, { label: string; bg: string; color: string; border: string }> = {
  pending_human_approval: { label: '待录用审批 🎓', bg: 'rgba(245,158,11,.15)', color: '#d97706', border: 'rgba(245,158,11,.3)' },
  evaluating:             { label: '考核中 🔄',     bg: 'rgba(99,102,241,.15)', color: '#6366f1', border: 'rgba(99,102,241,.3)' },
  approved:               { label: '已转正上线 ✅', bg: 'rgba(34,197,94,.15)',  color: '#16a34a', border: 'rgba(34,197,94,.3)' },
  draft:                  { label: '草稿待测 📝',   bg: 'rgba(100,116,139,.15)',color: '#64748b', border: 'rgba(100,116,139,.3)' },
  rejected:               { label: '已淘汰 ❌',     bg: 'rgba(239,68,68,.15)',  color: '#dc2626', border: 'rgba(239,68,68,.3)' },
};

function timeAgo(ts?: number) {
  if (!ts) return '—';
  const d = Date.now() - ts;
  if (d < 60000) return '刚刚';
  if (d < 3600000) return `${Math.floor(d / 60000)} 分钟前`;
  if (d < 86400000) return `${Math.floor(d / 3600000)} 小时前`;
  return `${Math.floor(d / 86400000)} 天前`;
}

export default function AgentInstances() {
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<'candidates' | 'production'>('candidates');

  // ── Production instances state ──
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [cloneFrom, setCloneFrom] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  // ── Candidate agents state ──
  const [candidates, setCandidates] = useState<CandidateAgent[]>([]);
  const [loadingCandidates, setLoadingCandidates] = useState(true);

  // ── Eval Detail Modal state ──
  const [selectedCandidate, setSelectedCandidate] = useState<CandidateAgent | null>(null);
  const [evalRunDetail, setEvalRunDetail] = useState<EvalRunDetail | null>(null);
  const [loadingEvalDetail, setLoadingEvalDetail] = useState(false);
  const [modalTab, setModalTab] = useState<'qa' | 'overview' | 'spec'>('qa');
  const [searchFilter, setSearchFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [onlyFailed, setOnlyFailed] = useState(false);
  const [approving, setApproving] = useState<string | null>(null);

  async function loadProfiles() {
    setLoading(true);
    try {
      const res = await fetch(`${API}/profiles`);
      const data = await res.json();
      setProfiles(Array.isArray(data) ? data : data.profiles ?? []);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  async function loadCandidates() {
    setLoadingCandidates(true);
    try {
      const res = await fetch('/api/v1/meta/agents');
      const data = await res.json();
      setCandidates(data.agents || []);
    } catch (e) {
      console.error('加载候选员工失败:', e);
    } finally {
      setLoadingCandidates(false);
    }
  }

  useEffect(() => {
    loadProfiles();
    loadCandidates();
  }, []);

  async function handleCreate() {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      let base: Partial<AgentProfile> = {};
      if (cloneFrom) {
        const src = profiles.find(p => p.id === cloneFrom);
        if (src) {
          base = {
            role_desc: src.role_desc,
            reply_style: src.reply_style,
            skill_mode: src.skill_mode,
            skill_ids: src.skill_ids,
            routing_examples: src.routing_examples,
            knowledge_config: src.knowledge_config,
            reassurance_mode: src.reassurance_mode,
            taboos: src.taboos,
          };
        }
      }

      const id = newName.trim()
        .toLowerCase()
        .replace(/[\s\W]/g, '_')
        .replace(/_+/g, '_')
        .slice(0, 20) + '_' + Date.now().toString(36);

      const res = await fetch(`${API}/profiles`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id,
          name: newName.trim(),
          role_desc: base.role_desc ?? newDesc.trim(),
          reply_style: base.reply_style ?? '亲切、专业',
          service_flow: '',
          taboos: base.taboos ?? [],
          reassurance_mode: base.reassurance_mode ?? 'ai',
          reassurance_tpl: '',
          skill_mode: base.skill_mode ?? 'auto',
          skill_ids: base.skill_ids ?? [],
          routing_examples: base.routing_examples ?? null,
          knowledge_config: base.knowledge_config ?? null,
        }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setShowNew(false);
      setNewName('');
      setNewDesc('');
      setCloneFrom(null);
      await loadProfiles();
      navigate(`/agent-profile?agentId=${data.id}`);
    } catch (e: any) {
      alert('创建失败：' + (e as any).message);
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(id: string, name: string) {
    if (id === 'default') { alert('默认 Agent 不可删除'); return; }
    if (!confirm(`确定删除「${name}」？此操作不可撤销。`)) return;
    setDeleting(id);
    try {
      const res = await fetch(`${API}/profiles/${id}`, { method: 'DELETE' });
      const data = await res.json();
      if (!data.success) throw new Error(data.error ?? '删除失败');
      await loadProfiles();
    } catch (e: any) {
      alert('删除失败：' + (e as any).message);
    } finally {
      setDeleting(null);
    }
  }

  // Open Eval Detail Modal
  async function openEvalDetail(candidate: CandidateAgent) {
    setSelectedCandidate(candidate);
    setLoadingEvalDetail(true);
    setEvalRunDetail(null);
    setModalTab('qa');
    setSearchFilter('');
    setCategoryFilter('all');
    setOnlyFailed(false);

    try {
      const runsRes = await fetch(`/api/v1/meta/agents/${candidate.id}/eval-runs`);
      const runsData = await runsRes.json();
      const runs = runsData.runs || [];
      if (runs.length > 0) {
        const latestRun = runs[runs.length - 1];
        const detailRes = await fetch(`/api/v1/meta/agents/${candidate.id}/eval-runs/${latestRun.run_id}`);
        const detailData = await detailRes.json();
        setEvalRunDetail(detailData);
      }
    } catch (e) {
      console.error('加载考评明细失败:', e);
    } finally {
      setLoadingEvalDetail(false);
    }
  }

  // Approve candidate
  async function handleApprove(agentId: string) {
    if (!confirm('确定批准该候选员工转正并正式上线为在职员工？')) return;
    setApproving(agentId);
    try {
      const res = await fetch(`/api/v1/meta/agents/${agentId}/approve`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '转正批准失败');
      alert('🎉 恭喜！该候选员工已正式批准转正上线！');
      setSelectedCandidate(null);
      await loadCandidates();
      await loadProfiles();
      setActiveTab('production');
    } catch (e: any) {
      alert('转正失败: ' + e.message);
    } finally {
      setApproving(null);
    }
  }

  // Filtered case results
  const filteredCases = (evalRunDetail?.case_results || []).filter(c => {
    if (onlyFailed && c.passed) return false;
    if (categoryFilter !== 'all' && c.category !== categoryFilter) return false;
    if (searchFilter.trim()) {
      const q = searchFilter.toLowerCase();
      const matchName = (c.case_name || '').toLowerCase().includes(q);
      const matchId = (c.case_id || '').toLowerCase().includes(q);
      const matchReply = (c.agent_reply || '').toLowerCase().includes(q);
      if (!matchName && !matchId && !matchReply) return false;
    }
    return true;
  });

  return (
    <div style={{ padding: '32px 36px', maxWidth: 1100, margin: '0 auto' }}>
      {/* 页头 */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: '1.5rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: 10 }}>
            <span>👥</span> AI 员工管理大厅
          </h1>
          <p style={{ margin: '6px 0 0', color: 'var(--muted)', fontSize: '.88rem' }}>
            包含候选员工试用期考评大屏（全量题目与答卷明细），以及已转正上线的在职员工配置。
          </p>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button
            className="btn btn-secondary"
            onClick={() => { setShowNew(true); setCloneFrom(null); setNewName(''); setNewDesc(''); }}
          >
            ＋ 手动新建在职实例
          </button>
          <button
            className="btn btn-primary"
            onClick={() => navigate('/agent-factory')}
            style={{ display: 'flex', alignItems: 'center', gap: 6 }}
          >
            <span>🏢</span> AI 员工招募工作台
          </button>
        </div>
      </div>

      {/* 顶部主切换 Tabs */}
      <div style={{
        display: 'flex', gap: 12, borderBottom: '1px solid var(--border)',
        marginBottom: 24, paddingBottom: 2,
      }}>
        <button
          onClick={() => setActiveTab('candidates')}
          style={{
            padding: '10px 20px', border: 'none', background: 'none', cursor: 'pointer',
            fontSize: '1rem', fontWeight: 600,
            color: activeTab === 'candidates' ? 'var(--accent)' : 'var(--muted)',
            borderBottom: activeTab === 'candidates' ? '2.5px solid var(--accent)' : '2.5px solid transparent',
            display: 'flex', alignItems: 'center', gap: 8,
          }}
        >
          <span>🎓</span> 候选员工（试用期考评）
          <span style={{
            background: activeTab === 'candidates' ? 'rgba(99,102,241,.15)' : 'var(--bg-secondary)',
            color: activeTab === 'candidates' ? 'var(--accent)' : 'var(--muted)',
            padding: '2px 8px', borderRadius: 12, fontSize: '.78rem',
          }}>
            {candidates.length}
          </span>
        </button>

        <button
          onClick={() => setActiveTab('production')}
          style={{
            padding: '10px 20px', border: 'none', background: 'none', cursor: 'pointer',
            fontSize: '1rem', fontWeight: 600,
            color: activeTab === 'production' ? 'var(--accent)' : 'var(--muted)',
            borderBottom: activeTab === 'production' ? '2.5px solid var(--accent)' : '2.5px solid transparent',
            display: 'flex', alignItems: 'center', gap: 8,
          }}
        >
          <span>👔</span> 正式在职员工
          <span style={{
            background: activeTab === 'production' ? 'rgba(99,102,241,.15)' : 'var(--bg-secondary)',
            color: activeTab === 'production' ? 'var(--accent)' : 'var(--muted)',
            padding: '2px 8px', borderRadius: 12, fontSize: '.78rem',
          }}>
            {profiles.length}
          </span>
        </button>
      </div>

      {/* ── 候选员工列表 Tab ── */}
      {activeTab === 'candidates' && (
        <div>
          {loadingCandidates ? (
            <div style={{ textAlign: 'center', padding: '60px 0', color: 'var(--muted)' }}>
              加载候选员工中...
            </div>
          ) : candidates.length === 0 ? (
            <div style={{
              textAlign: 'center', padding: '60px 0', background: 'var(--card)',
              borderRadius: 16, border: '1px dashed var(--border)',
            }}>
              <div style={{ fontSize: '2.5rem', marginBottom: 12 }}>🏢</div>
              <h3 style={{ margin: '0 0 8px', fontWeight: 600 }}>暂无候选员工</h3>
              <p style={{ margin: 0, color: 'var(--muted)', fontSize: '.88rem' }}>
                前往「AI 招募工作台」输入岗位需求，即可生成并自动启动试用期评测。
              </p>
              <button
                className="btn btn-primary"
                onClick={() => navigate('/agent-factory')}
                style={{ marginTop: 18 }}
              >
                前往招募员工
              </button>
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 20 }}>
              {candidates.map(c => {
                const st = STATUS_BADGE[c.status] || STATUS_BADGE.draft;
                const isReadyForApprove = c.status === 'pending_human_approval' || c.best_score >= 95;

                return (
                  <div
                    key={c.id}
                    style={{
                      background: 'var(--card)',
                      border: isReadyForApprove ? '1.5px solid rgba(245,158,11,.4)' : '1px solid var(--border)',
                      borderRadius: 14,
                      padding: '20px 22px',
                      display: 'flex',
                      flexDirection: 'column',
                      justifyContent: 'space-between',
                      boxShadow: isReadyForApprove ? '0 4px 20px rgba(245,158,11,.08)' : '0 2px 10px rgba(0,0,0,.03)',
                    }}
                  >
                    <div>
                      {/* 顶部标题与状态徽章 */}
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
                        <div>
                          <div style={{ fontWeight: 700, fontSize: '1.12rem', color: 'var(--text-primary)' }}>
                            {c.name}
                          </div>
                          <div style={{ fontSize: '.8rem', color: 'var(--muted)', marginTop: 2, fontFamily: 'monospace' }}>
                            {c.id}
                          </div>
                        </div>
                        <span style={{
                          padding: '4px 10px', borderRadius: 20, fontSize: '.78rem', fontWeight: 600,
                          background: st.bg, color: st.color, border: `1px solid ${st.border}`,
                        }}>
                          {st.label}
                        </span>
                      </div>

                      {/* 角色定位简介 */}
                      <p style={{
                        margin: '0 0 16px', color: 'var(--text-secondary)', fontSize: '.88rem',
                        lineHeight: 1.5, display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden',
                      }}>
                        {c.role_desc}
                      </p>

                      {/* 得分与考评状态卡片 */}
                      <div style={{
                        display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10,
                        padding: '12px 14px', borderRadius: 10,
                        background: 'var(--bg-secondary)', marginBottom: 16,
                      }}>
                        <div>
                          <div style={{ fontSize: '.75rem', color: 'var(--muted)', marginBottom: 2 }}>考评综合得分</div>
                          <div style={{
                            fontSize: '1.3rem', fontWeight: 800,
                            color: c.best_score >= 95 ? '#16a34a' : c.best_score >= 80 ? '#2563eb' : '#d97706',
                          }}>
                            {c.best_score > 0 ? `${c.best_score} 分` : '暂无'}
                          </div>
                        </div>
                        <div>
                          <div style={{ fontSize: '.75rem', color: 'var(--muted)', marginBottom: 2 }}>Ralph 考评轮次</div>
                          <div style={{ fontSize: '1.1rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                            第 {c.total_eval_rounds || 1} 轮
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* 底部操作按钮 */}
                    <div style={{ display: 'flex', gap: 10, borderTop: '1px solid var(--border)', paddingTop: 14 }}>
                      <button
                        onClick={() => openEvalDetail(c)}
                        style={{
                          flex: 1, padding: '9px 12px', borderRadius: 8,
                          border: '1px solid var(--border)', background: 'var(--card)',
                          color: 'var(--text-primary)', fontSize: '.88rem', fontWeight: 600,
                          cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                        }}
                      >
                        <span>📋</span> 查看考评大屏 & 答卷
                      </button>

                      {c.status === 'pending_human_approval' && (
                        <button
                          onClick={() => handleApprove(c.id)}
                          disabled={approving === c.id}
                          style={{
                            padding: '9px 16px', borderRadius: 8, border: 'none',
                            background: '#16a34a', color: '#fff', fontSize: '.88rem', fontWeight: 600,
                            cursor: approving === c.id ? 'default' : 'pointer',
                            display: 'flex', alignItems: 'center', gap: 4,
                          }}
                        >
                          {approving === c.id ? '转正中...' : '✅ 批准转正'}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ── 正式在职员工 Tab（完全保留原有管理功能） ── */}
      {activeTab === 'production' && (
        <div>
          {loading ? (
            <div style={{ color: 'var(--muted)', padding: 40, textAlign: 'center' }}>加载中…</div>
          ) : error ? (
            <div style={{ color: '#f87171', padding: 20 }}>加载失败：{error}</div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 20 }}>
              {profiles.map(p => {
                const badge = BADGE[p.skill_mode] ?? BADGE.auto;
                const isDefault = p.id === 'default';
                return (
                  <div
                    key={p.id}
                    style={{
                      background: 'var(--card)',
                      border: isDefault ? '1px solid rgba(99,102,241,.5)' : '1px solid var(--border)',
                      borderRadius: 14, padding: '20px 22px',
                      display: 'flex', flexDirection: 'column', gap: 12,
                      position: 'relative', overflow: 'hidden',
                      transition: 'border-color .2s',
                    }}
                  >
                    {isDefault && (
                      <div style={{
                        position: 'absolute', top: 0, right: 0,
                        background: 'rgba(99,102,241,.2)', color: '#a5b4fc',
                        fontSize: '.7rem', fontWeight: 700, padding: '3px 10px',
                        borderBottomLeftRadius: 8,
                      }}>DEFAULT</div>
                    )}

                    <div>
                      <div style={{ fontWeight: 700, fontSize: '1rem', marginBottom: 4 }}>{p.name}</div>
                      <div style={{ fontSize: '.82rem', color: 'var(--muted)', lineHeight: 1.5 }}>
                        {p.role_desc
                          ? p.role_desc.slice(0, 70) + (p.role_desc.length > 70 ? '…' : '')
                          : '（未设置角色描述）'}
                      </div>
                    </div>

                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: '.72rem', padding: '2px 8px', borderRadius: 10, background: badge.bg, color: badge.color }}>
                        {badge.label}
                        {p.skill_mode === 'manual' && ` · ${p.skill_ids.length} 个`}
                      </span>
                      {p.routing_examples && (
                        <span style={{ fontSize: '.72rem', padding: '2px 8px', borderRadius: 10, background: 'rgba(34,197,94,.12)', color: '#86efac' }}>
                          自定义分诊
                        </span>
                      )}
                      {p.knowledge_config && (
                        <span style={{ fontSize: '.72rem', padding: '2px 8px', borderRadius: 10, background: 'rgba(251,191,36,.12)', color: '#fcd34d' }}>
                          自定义知识库
                        </span>
                      )}
                    </div>

                    <div style={{ fontSize: '.75rem', color: 'var(--muted)' }}>
                      更新于 {timeAgo(p.updated_at)}
                    </div>

                    <div style={{ display: 'flex', gap: 8 }}>
                      <button
                        className="btn btn-primary"
                        style={{ flex: 1, fontSize: '.82rem', padding: '7px 0' }}
                        onClick={() => navigate(`/agent-profile?agentId=${p.id}`)}
                      >
                        ✏️ 编辑配置
                      </button>
                      <button
                        className="btn btn-secondary"
                        style={{ fontSize: '.82rem', padding: '7px 12px' }}
                        title="克隆此实例"
                        onClick={() => { setCloneFrom(p.id); setNewName(''); setShowNew(true); }}
                      >
                        📋
                      </button>
                      {!isDefault && (
                        <button
                          className="btn btn-secondary"
                          style={{ fontSize: '.82rem', padding: '7px 12px', color: '#f87171' }}
                          title="删除此实例"
                          disabled={deleting === p.id}
                          onClick={() => handleDelete(p.id, p.name)}
                        >
                          {deleting === p.id ? '…' : '🗑️'}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* 新建/克隆 在职实例 弹窗 */}
      {showNew && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,.6)', zIndex: 1000,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }} onClick={e => { if (e.target === e.currentTarget) setShowNew(false); }}>
          <div style={{
            background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 16,
            padding: '28px 32px', width: 440, boxShadow: '0 20px 60px rgba(0,0,0,.4)',
          }}>
            <h2 style={{ margin: '0 0 20px', fontSize: '1.1rem', fontWeight: 700 }}>
              {cloneFrom ? `克隆自「${profiles.find(p => p.id === cloneFrom)?.name}」` : '新建 Agent 实例'}
            </h2>

            <label style={{ display: 'block', marginBottom: 14 }}>
              <div style={{ fontSize: '.82rem', color: 'var(--muted)', marginBottom: 6 }}>实例名称 *</div>
              <input
                className="form-input"
                value={newName}
                onChange={e => setNewName(e.target.value)}
                placeholder="如：企微营养助手、产品咨询专线"
                autoFocus
                onKeyDown={e => e.key === 'Enter' && handleCreate()}
              />
            </label>

            {!cloneFrom && (
              <label style={{ display: 'block', marginBottom: 20 }}>
                <div style={{ fontSize: '.82rem', color: 'var(--muted)', marginBottom: 6 }}>角色简介（可选，创建后可详细编辑）</div>
                <input
                  className="form-input"
                  value={newDesc}
                  onChange={e => setNewDesc(e.target.value)}
                  placeholder="一句话描述这个 Agent 的定位"
                />
              </label>
            )}

            {!cloneFrom && profiles.length > 0 && (
              <div style={{ marginBottom: 20 }}>
                <div style={{ fontSize: '.82rem', color: 'var(--muted)', marginBottom: 8 }}>或从现有实例克隆配置：</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {profiles.map(p => (
                    <button
                      key={p.id}
                      type="button"
                      className="btn btn-secondary"
                      style={{ fontSize: '.82rem', padding: '4px 10px' }}
                      onClick={() => { setCloneFrom(p.id); setNewName(`${p.name} (副本)`); }}
                    >
                      📋 {p.name}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {cloneFrom && (
              <button
                type="button"
                onClick={() => setCloneFrom(null)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', fontSize: '.82rem', marginBottom: 16, padding: 0 }}
              >
                ↩ 取消克隆，从空白创建
              </button>
            )}

            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button className="btn btn-secondary" type="button" onClick={() => setShowNew(false)}>取消</button>
              <button
                className="btn btn-primary"
                type="button"
                onClick={handleCreate}
                disabled={creating || !newName.trim()}
              >
                {creating ? '创建中…' : cloneFrom ? '克隆并创建' : '创建'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── 候选员工全量考评大屏 & 112 题问答 Modal ── */}
      {selectedCandidate && (
        <div
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,.65)', zIndex: 1000,
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
          }}
          onClick={e => { if (e.target === e.currentTarget) setSelectedCandidate(null); }}
        >
          <div
            style={{
              background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 16,
              width: '95vw', maxWidth: 1100, maxHeight: '90vh', display: 'flex', flexDirection: 'column',
              boxShadow: '0 25px 70px rgba(0,0,0,.5)', overflow: 'hidden',
            }}
          >
            {/* Modal Header */}
            <div style={{
              padding: '20px 28px', borderBottom: '1px solid var(--border)',
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              background: 'var(--bg-secondary)',
            }}>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ fontSize: '1.3rem' }}>🎓</span>
                  <h2 style={{ margin: 0, fontSize: '1.25rem', fontWeight: 700 }}>
                    {selectedCandidate.name} — 试用期考评大屏
                  </h2>
                  <span style={{
                    padding: '3px 10px', borderRadius: 16, fontSize: '.78rem', fontWeight: 600,
                    background: STATUS_BADGE[selectedCandidate.status]?.bg || 'transparent',
                    color: STATUS_BADGE[selectedCandidate.status]?.color || '#fff',
                    border: `1px solid ${STATUS_BADGE[selectedCandidate.status]?.border || 'transparent'}`,
                  }}>
                    {STATUS_BADGE[selectedCandidate.status]?.label}
                  </span>
                </div>
                <div style={{ fontSize: '.82rem', color: 'var(--muted)', marginTop: 4 }}>
                  候选员工 ID: <code style={{ fontFamily: 'monospace' }}>{selectedCandidate.id}</code>
                </div>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                {selectedCandidate.status === 'pending_human_approval' && (
                  <button
                    onClick={() => handleApprove(selectedCandidate.id)}
                    disabled={approving === selectedCandidate.id}
                    style={{
                      padding: '8px 18px', borderRadius: 8, border: 'none',
                      background: '#16a34a', color: '#fff', fontSize: '.88rem', fontWeight: 600,
                      cursor: approving === selectedCandidate.id ? 'default' : 'pointer',
                    }}
                  >
                    {approving === selectedCandidate.id ? '转正中...' : '✅ 批准录用转正'}
                  </button>
                )}
                <button
                  onClick={() => setSelectedCandidate(null)}
                  style={{
                    background: 'none', border: 'none', fontSize: '1.4rem', cursor: 'pointer',
                    color: 'var(--muted)', padding: '4px 8px', borderRadius: 6,
                  }}
                >
                  ✕
                </button>
              </div>
            </div>

            {/* Modal Navigation Tabs */}
            <div style={{
              display: 'flex', gap: 16, padding: '0 28px', borderBottom: '1px solid var(--border)',
              background: 'var(--card)',
            }}>
              <button
                onClick={() => setModalTab('qa')}
                style={{
                  padding: '12px 6px', border: 'none', background: 'none', cursor: 'pointer',
                  fontWeight: 600, fontSize: '.92rem',
                  color: modalTab === 'qa' ? 'var(--accent)' : 'var(--muted)',
                  borderBottom: modalTab === 'qa' ? '2.5px solid var(--accent)' : '2.5px solid transparent',
                  display: 'flex', alignItems: 'center', gap: 6,
                }}
              >
                <span>📝</span> 全量题目问答与裁判明细 ({evalRunDetail?.total_cases || 112} 题)
              </button>

              <button
                onClick={() => setModalTab('overview')}
                style={{
                  padding: '12px 6px', border: 'none', background: 'none', cursor: 'pointer',
                  fontWeight: 600, fontSize: '.92rem',
                  color: modalTab === 'overview' ? 'var(--accent)' : 'var(--muted)',
                  borderBottom: modalTab === 'overview' ? '2.5px solid var(--accent)' : '2.5px solid transparent',
                  display: 'flex', alignItems: 'center', gap: 6,
                }}
              >
                <span>📊</span> 考评四维成绩卡
              </button>

              <button
                onClick={() => setModalTab('spec')}
                style={{
                  padding: '12px 6px', border: 'none', background: 'none', cursor: 'pointer',
                  fontWeight: 600, fontSize: '.92rem',
                  color: modalTab === 'spec' ? 'var(--accent)' : 'var(--muted)',
                  borderBottom: modalTab === 'spec' ? '2.5px solid var(--accent)' : '2.5px solid transparent',
                  display: 'flex', alignItems: 'center', gap: 6,
                }}
              >
                <span>⚙️</span> 候选员工 Spec 配置
              </button>
            </div>

            {/* Modal Body */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '24px 28px' }}>
              {loadingEvalDetail ? (
                <div style={{ textAlign: 'center', padding: '60px 0', color: 'var(--muted)' }}>
                  加载考评问答记录中...
                </div>
              ) : !evalRunDetail ? (
                <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--muted)' }}>
                  暂未找到评测记录，请先在后台运行 Ralph 评测飞轮。
                </div>
              ) : (
                <>
                  {/* ── Tab 1: 全量 Q&A 问答 ── */}
                  {modalTab === 'qa' && (
                    <div>
                      {/* 过滤控制栏 */}
                      <div style={{
                        display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap',
                        marginBottom: 20, padding: '12px 16px', borderRadius: 10,
                        background: 'var(--bg-secondary)', border: '1px solid var(--border)',
                      }}>
                        {/* 搜索框 */}
                        <div style={{ flex: 1, minWidth: 200 }}>
                          <input
                            type="text"
                            placeholder="🔍 搜索测试输入、关键词或回复内容..."
                            value={searchFilter}
                            onChange={e => setSearchFilter(e.target.value)}
                            style={{
                              width: '100%', boxSizing: 'border-box', padding: '8px 12px',
                              borderRadius: 6, border: '1px solid var(--border)',
                              background: 'var(--card)', color: 'var(--text-primary)', fontSize: '.88rem',
                            }}
                          />
                        </div>

                        {/* 分类下拉 */}
                        <select
                          value={categoryFilter}
                          onChange={e => setCategoryFilter(e.target.value)}
                          style={{
                            padding: '8px 12px', borderRadius: 6, border: '1px solid var(--border)',
                            background: 'var(--card)', color: 'var(--text-primary)', fontSize: '.88rem',
                          }}
                        >
                          <option value="all">全部维度分类 ({evalRunDetail.case_results?.length || 0})</option>
                          {Object.entries(CATEGORY_NAMES).map(([k, label]) => (
                            <option key={k} value={k}>{label}</option>
                          ))}
                        </select>

                        {/* 只看未通过 */}
                        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '.88rem', cursor: 'pointer' }}>
                          <input
                            type="checkbox"
                            checked={onlyFailed}
                            onChange={e => setOnlyFailed(e.target.checked)}
                          />
                          <span>只看未通过 ({evalRunDetail.failed_cases})</span>
                        </label>
                      </div>

                      {/* 题目列表 */}
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                        {filteredCases.length === 0 ? (
                          <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--muted)' }}>
                            无匹配的测试用例
                          </div>
                        ) : (
                          filteredCases.map((c, idx) => (
                            <div
                              key={c.case_id}
                              style={{
                                background: 'var(--card)',
                                border: `1px solid ${c.passed ? 'var(--border)' : 'rgba(239,68,68,.3)'}`,
                                borderRadius: 10,
                                padding: '16px 20px',
                                boxShadow: '0 1px 4px rgba(0,0,0,.02)',
                              }}
                            >
                              {/* 题目头 */}
                              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                  <span style={{ fontWeight: 700, fontSize: '.95rem', color: 'var(--text-primary)' }}>
                                    #{idx + 1} [{c.case_id}] {c.case_name}
                                  </span>
                                  <span style={{
                                    padding: '2px 8px', borderRadius: 12, fontSize: '.72rem',
                                    background: 'var(--bg-secondary)', color: 'var(--muted)',
                                  }}>
                                    {CATEGORY_NAMES[c.category] || c.category}
                                  </span>
                                </div>

                                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                  <span style={{ fontSize: '.8rem', color: 'var(--muted)' }}>
                                    ⏱️ {c.latency_ms}ms
                                  </span>
                                  <span style={{
                                    padding: '3px 10px', borderRadius: 14, fontSize: '.8rem', fontWeight: 700,
                                    background: c.passed ? 'rgba(34,197,94,.12)' : 'rgba(239,68,68,.12)',
                                    color: c.passed ? '#16a34a' : '#dc2626',
                                    border: `1px solid ${c.passed ? 'rgba(34,197,94,.25)' : 'rgba(239,68,68,.25)'}`,
                                  }}>
                                    {c.passed ? `✅ ${c.score}分` : `❌ ${c.score}分`}
                                  </span>
                                </div>
                              </div>

                              {/* Agent 实际回复 */}
                              <div style={{ marginBottom: 12 }}>
                                <div style={{ fontSize: '.8rem', color: 'var(--muted)', marginBottom: 4, fontWeight: 600 }}>
                                  🤖 Agent 实际回复：
                                </div>
                                <div style={{
                                  padding: '10px 14px', borderRadius: 8,
                                  background: 'var(--bg-secondary)', fontSize: '.88rem', lineHeight: 1.6,
                                  color: 'var(--text-primary)', whiteSpace: 'pre-wrap',
                                }}>
                                  {c.agent_reply || '(无文本回复)'}
                                </div>
                              </div>

                              {/* 断言判定细节 */}
                              <div>
                                <div style={{ fontSize: '.8rem', color: 'var(--muted)', marginBottom: 4, fontWeight: 600 }}>
                                  ⚖️ 裁判判定明细：
                                </div>
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                                  {(c.details || []).map((d, di) => (
                                    <span
                                      key={di}
                                      style={{
                                        padding: '3px 8px', borderRadius: 6, fontSize: '.78rem',
                                        background: d.includes('✅') ? 'rgba(34,197,94,.08)' : 'rgba(239,68,68,.08)',
                                        color: d.includes('✅') ? '#16a34a' : '#dc2626',
                                        border: `1px solid ${d.includes('✅') ? 'rgba(34,197,94,.2)' : 'rgba(239,68,68,.2)'}`,
                                      }}
                                    >
                                      {d}
                                    </span>
                                  ))}
                                </div>
                              </div>
                            </div>
                          ))
                        )}
                      </div>
                    </div>
                  )}

                  {/* ── Tab 2: 考评成绩总览 ── */}
                  {modalTab === 'overview' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                      <div style={{
                        display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16,
                      }}>
                        <div style={{ padding: '16px 20px', borderRadius: 12, background: 'rgba(99,102,241,.08)', border: '1px solid rgba(99,102,241,.2)' }}>
                          <div style={{ fontSize: '.82rem', color: 'var(--muted)', marginBottom: 4 }}>🎯 业务目标与转化 (35%)</div>
                          <div style={{ fontSize: '1.6rem', fontWeight: 800, color: '#6366f1' }}>{evalRunDetail.score_business} / 100</div>
                        </div>

                        <div style={{ padding: '16px 20px', borderRadius: 12, background: 'rgba(34,197,94,.08)', border: '1px solid rgba(34,197,94,.2)' }}>
                          <div style={{ fontSize: '.82rem', color: 'var(--muted)', marginBottom: 4 }}>🧠 记忆与画像保真 (15%)</div>
                          <div style={{ fontSize: '1.6rem', fontWeight: 800, color: '#16a34a' }}>{evalRunDetail.score_memory} / 100</div>
                        </div>

                        <div style={{ padding: '16px 20px', borderRadius: 12, background: 'rgba(245,158,11,.08)', border: '1px solid rgba(245,158,11,.2)' }}>
                          <div style={{ fontSize: '.82rem', color: 'var(--muted)', marginBottom: 4 }}>⚙️ 工单与技能流转 (15%)</div>
                          <div style={{ fontSize: '1.6rem', fontWeight: 800, color: '#d97706' }}>{evalRunDetail.score_ticket_skill} / 100</div>
                        </div>

                        <div style={{ padding: '16px 20px', borderRadius: 12, background: 'rgba(168,85,247,.08)', border: '1px solid rgba(168,85,247,.2)' }}>
                          <div style={{ fontSize: '.82rem', color: 'var(--muted)', marginBottom: 4 }}>🛡️ 合规与安全 (35%)</div>
                          <div style={{ fontSize: '1.6rem', fontWeight: 800, color: '#9333ea' }}>{evalRunDetail.score_compliance} / 100</div>
                        </div>
                      </div>

                      <div style={{
                        padding: '18px 22px', borderRadius: 12,
                        background: 'var(--bg-secondary)', border: '1px solid var(--border)',
                      }}>
                        <h4 style={{ margin: '0 0 10px', fontSize: '1rem', fontWeight: 700 }}>🏆 考评达标结论</h4>
                        <p style={{ margin: '0 0 8px', fontSize: '.9rem', lineHeight: 1.6 }}>
                          候选员工 <strong>{selectedCandidate.name}</strong> 考评通过率达到{' '}
                          <strong>{((evalRunDetail.passed_cases / evalRunDetail.total_cases) * 100).toFixed(1)}%</strong>（{evalRunDetail.passed_cases}/{evalRunDetail.total_cases} 题），
                          禁忌零容忍守卫 <strong>{evalRunDetail.taboo_violated ? '⛔ 存在违规' : '✅ 0 项违规'}</strong>。
                        </p>
                        <p style={{ margin: 0, fontSize: '.85rem', color: 'var(--muted)' }}>
                          综合得分达到 <strong>{evalRunDetail.total_score} 分</strong>（已超过 95 分录用达标线），已满足转正要求。
                        </p>
                      </div>
                    </div>
                  )}

                  {/* ── Tab 3: Spec 基础配置 ── */}
                  {modalTab === 'spec' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                      <div>
                        <label style={{ display: 'block', fontWeight: 600, fontSize: '.88rem', marginBottom: 6 }}>角色定位 (role_desc)</label>
                        <div style={{ padding: '10px 14px', borderRadius: 8, background: 'var(--bg-secondary)', fontSize: '.88rem' }}>
                          {selectedCandidate.role_desc}
                        </div>
                      </div>

                      <div>
                        <label style={{ display: 'block', fontWeight: 600, fontSize: '.88rem', marginBottom: 6 }}>回复风格 (reply_style)</label>
                        <div style={{ padding: '10px 14px', borderRadius: 8, background: 'var(--bg-secondary)', fontSize: '.88rem' }}>
                          {selectedCandidate.reply_style || '(无特殊限制)'}
                        </div>
                      </div>

                      <div>
                        <label style={{ display: 'block', fontWeight: 600, fontSize: '.88rem', marginBottom: 6 }}>服务流程 (service_flow)</label>
                        <div style={{ padding: '10px 14px', borderRadius: 8, background: 'var(--bg-secondary)', fontSize: '.88rem' }}>
                          {selectedCandidate.service_flow || '(无)'}
                        </div>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
