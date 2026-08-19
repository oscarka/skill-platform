import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

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

const API = '/api/v1/agent';

const BADGE = {
  auto:   { label: '全部 Skill',  color: '#6366f1', bg: 'rgba(99,102,241,.15)' },
  manual: { label: '手动选择',   color: '#f59e0b', bg: 'rgba(245,158,11,.15)' },
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
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [cloneFrom, setCloneFrom] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  async function load() {
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

  useEffect(() => { load(); }, []);

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
      await load();
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
      await load();
    } catch (e: any) {
      alert('删除失败：' + (e as any).message);
    } finally {
      setDeleting(null);
    }
  }

  return (
    <div style={{ padding: '32px 36px', maxWidth: 960, margin: '0 auto' }}>
      {/* 页头 */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 32 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: '1.5rem', fontWeight: 700 }}>🤖 Agent 实例管理</h1>
          <p style={{ margin: '6px 0 0', color: 'var(--muted)', fontSize: '.88rem' }}>
            每个实例是独立的 Agent 角色，拥有自己的提示词、Skill 配置和分诊规则。
          </p>
        </div>
        <button
          className="btn btn-primary"
          style={{ whiteSpace: 'nowrap' }}
          onClick={() => { setShowNew(true); setCloneFrom(null); setNewName(''); setNewDesc(''); }}
        >
          ＋ 新建实例
        </button>
      </div>

      {/* 新建/克隆 弹窗 */}
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
                      onClick={() => setCloneFrom(p.id)}
                      style={{
                        background: 'rgba(99,102,241,.1)', border: '1px solid rgba(99,102,241,.3)',
                        borderRadius: 8, padding: '4px 12px', cursor: 'pointer',
                        fontSize: '.82rem', color: '#a5b4fc',
                      }}
                    >
                      📋 {p.name}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {cloneFrom && (
              <button
                onClick={() => setCloneFrom(null)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', fontSize: '.82rem', marginBottom: 16, padding: 0 }}
              >
                ↩ 取消克隆，从空白创建
              </button>
            )}

            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button className="btn btn-secondary" onClick={() => setShowNew(false)}>取消</button>
              <button
                className="btn btn-primary"
                onClick={handleCreate}
                disabled={creating || !newName.trim()}
              >
                {creating ? '创建中…' : cloneFrom ? '克隆并创建' : '创建'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 实例列表 */}
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
  );
}
