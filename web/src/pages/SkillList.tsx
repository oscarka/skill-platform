import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';

const STATUS_LABEL: Record<string, string> = {
  pending: '待审核', reviewing: '审核中', published: '已发布',
  rejected: '已拒绝', disabled: '已禁用',
};

export default function SkillList() {
  const navigate = useNavigate();
  const [skills, setSkills] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterType, setFilterType] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [q, setQ] = useState('');

  const load = () => {
    setLoading(true);
    api.skills.list({ type: filterType || undefined, status: filterStatus || undefined, q: q || undefined })
      .then(d => setSkills(d.skills))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [filterType, filterStatus]);

  const handleSearch = (e: React.FormEvent) => { e.preventDefault(); load(); };

  const typeIcon = (t: string) => t === 'internal' ? '🔵' : '🟢';
  const skillTypeIcon = (st: string) => st === 'prompt' ? '📝' : '💻';

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Skill 列表</h1>
          <p>管理所有已上传的 Skill</p>
        </div>
        <button className="btn btn-primary" onClick={() => navigate('/skills/new')}>
          ➕ 上传 Skill
        </button>
      </div>

      {/* Filters */}
      <div className="card mb-4">
        <form onSubmit={handleSearch} style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div style={{ flex: 1, minWidth: 200 }}>
            <input className="form-input" placeholder="搜索名称/描述…" value={q} onChange={e => setQ(e.target.value)} />
          </div>
          <select className="form-select" style={{ width: 130 }} value={filterType} onChange={e => setFilterType(e.target.value)}>
            <option value="">全部类型</option>
            <option value="internal">内部 Internal</option>
            <option value="external">外部 External</option>
          </select>
          <select className="form-select" style={{ width: 130 }} value={filterStatus} onChange={e => setFilterStatus(e.target.value)}>
            <option value="">全部状态</option>
            <option value="pending">待审核</option>
            <option value="published">已发布</option>
            <option value="rejected">已拒绝</option>
            <option value="disabled">已禁用</option>
          </select>
          <button className="btn btn-primary" type="submit">搜索</button>
        </form>
      </div>

      {loading ? (
        <div className="loading">加载中…</div>
      ) : skills.length === 0 ? (
        <div className="empty-state">
          <p>暂无 Skill，点击「上传 Skill」开始添加</p>
        </div>
      ) : (
        <div className="skill-grid">
          {skills.map(skill => (
            <div key={skill.id} className="skill-card" onClick={() => navigate(`/skills/${skill.id}`)}>
              <div className="skill-card-header">
                <div className="skill-card-icon">{typeIcon(skill.type)}</div>
                <div>
                  <div className="skill-card-title">{skill.name}</div>
                  <div style={{ fontSize: '.75rem', color: 'var(--gray-400)', marginTop: 2 }}>
                    {skillTypeIcon(skill.skill_type)} {skill.skill_type === 'prompt' ? 'Prompt 模板' : '代码逻辑'}
                    {skill.author_name && ` · ${skill.author_name}`}
                  </div>
                </div>
              </div>
              <div className="skill-card-desc">{skill.description || '（无描述）'}</div>
              <div className="skill-card-meta">
                <span className={`badge badge-${skill.status}`}>{STATUS_LABEL[skill.status]}</span>
                <span className={`badge badge-${skill.type}`}>{skill.type === 'internal' ? '内部' : '外部'}</span>
                {skill.preferred_model && (
                  <span className="badge" style={{ background: 'var(--gray-100)', color: 'var(--gray-600)' }}>
                    {skill.preferred_model.split('-')[0]}
                  </span>
                )}
              </div>
              {skill.ai_review && (
                <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--gray-100)', display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: '.78rem', color: 'var(--gray-500)' }}>AI 评分</span>
                  <span style={{ fontWeight: 700, color: skill.ai_review.score >= 80 ? 'var(--success)' : skill.ai_review.score >= 60 ? 'var(--warning)' : 'var(--danger)' }}>
                    {skill.ai_review.score}
                  </span>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
