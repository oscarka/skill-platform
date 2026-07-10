import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';

export default function TicketCreate() {
  const navigate = useNavigate();
  const [skills, setSkills] = useState<any[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState('');
  const [form, setForm] = useState({
    skill_id: '', title: '', patient_name: '', patient_phone: '', notes: '', created_by: '',
  });

  useEffect(() => {
    api.skills.list({ type: 'external', status: 'published' })
      .then(d => setSkills(d.skills));
  }, []);

  const set = (k: string, v: string) => setForm(f => ({ ...f, [k]: v }));
  const selectedSkill = skills.find(s => s.id === form.skill_id);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.skill_id) { setErr('请选择一个 Skill'); return; }
    setSubmitting(true); setErr('');
    try {
      const res = await api.tickets.create(form);
      navigate(`/tickets/${res.ticket.id}`);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>创建工单</h1>
          <p>选择 Skill，填写客户信息，生成专属 H5 链接发送给客户</p>
        </div>
        <button className="btn btn-ghost" onClick={() => navigate('/tickets')}>← 返回</button>
      </div>

      {err && <div className="alert alert-error">{err}</div>}

      {/* Two-column layout */}
      <form onSubmit={handleSubmit}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 360px', gap: 20, alignItems: 'start' }}>

          {/* Left — main form */}
          <div>
            {/* Skill 选择 */}
            <div className="card mb-4">
              <div className="card-title">选择 Skill</div>
              {skills.length === 0 ? (
                <div className="alert alert-info">暂无已发布的外部 Skill，请先发布 Skill 再创建工单。</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {skills.map(s => (
                    <div
                      key={s.id}
                      onClick={() => set('skill_id', s.id)}
                      className={`skill-select-card ${form.skill_id === s.id ? 'selected' : ''}`}
                    >
                      <div className="skill-dot" />
                      <div style={{ flex: 1 }}>
                        <div className="skill-select-card-name">{s.name}</div>
                        <div className="skill-select-card-desc">{s.description || '（无描述）'}</div>
                      </div>
                      {form.skill_id === s.id && (
                        <span style={{ color: 'var(--primary)', fontSize: '1.1rem', fontWeight: 700 }}>✓</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* 工单信息 */}
            <div className="card mb-4">
              <div className="card-title">客户信息</div>
              <div className="form-group">
                <label className="form-label">工单标题</label>
                <input className="form-input" value={form.title} onChange={e => set('title', e.target.value)}
                  placeholder="留空则自动生成（Skill名称 + 日期）" />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div className="form-group">
                  <label className="form-label">患者姓名</label>
                  <input className="form-input" value={form.patient_name} onChange={e => set('patient_name', e.target.value)} placeholder="可选" />
                </div>
                <div className="form-group">
                  <label className="form-label">患者手机</label>
                  <input className="form-input" value={form.patient_phone} onChange={e => set('patient_phone', e.target.value)} placeholder="可选" />
                </div>
              </div>
              <div className="form-group">
                <label className="form-label">创建人</label>
                <input className="form-input" value={form.created_by} onChange={e => set('created_by', e.target.value)} placeholder="员工姓名（可选）" />
              </div>
              <div className="form-group">
                <label className="form-label">备注</label>
                <textarea className="form-textarea" rows={2} value={form.notes} onChange={e => set('notes', e.target.value)} placeholder="内部备注，客户不可见" />
              </div>
            </div>

            <button className="btn btn-primary btn-lg" type="submit" disabled={submitting || skills.length === 0}>
              {submitting ? '创建中…' : '🔗 创建工单并生成 H5 链接'}
            </button>
          </div>

          {/* Right — info panel */}
          <div style={{ position: 'sticky', top: 80 }}>
            <div className="card mb-4" style={{ background: 'linear-gradient(135deg, #f0f7ff, #e8f0fe)' }}>
              <div className="card-title">📋 操作说明</div>
              <div style={{ fontSize: '.84rem', color: 'var(--gray-600)', lineHeight: 2 }}>
                <div>① 选择适合的 <strong>Skill</strong>（AI 处理模板）</div>
                <div>② 填写客户基本信息（姓名/手机）</div>
                <div>③ 创建后系统自动生成 H5 链接</div>
                <div>④ 将链接发送给客户填写提交</div>
                <div>⑤ 客户提交后 AI 自动处理</div>
                <div>⑥ 员工查看结果并下载报告</div>
              </div>
            </div>

            {selectedSkill ? (
              <div className="card">
                <div className="card-title">✅ 已选 Skill</div>
                <div style={{ fontWeight: 700, fontSize: '1rem', color: 'var(--gray-900)', marginBottom: 6 }}>
                  {selectedSkill.name}
                </div>
                <div style={{ fontSize: '.82rem', color: 'var(--gray-500)', lineHeight: 1.6 }}>
                  {selectedSkill.description || '（无描述）'}
                </div>
                {selectedSkill.h5_config?.fields?.length > 0 && (
                  <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--gray-100)' }}>
                    <div style={{ fontSize: '.72rem', fontWeight: 700, color: 'var(--gray-400)', textTransform: 'uppercase', letterSpacing: '.6px', marginBottom: 6 }}>
                      客户需填写的字段
                    </div>
                    {selectedSkill.h5_config.fields.map((f: any) => (
                      <div key={f.key} style={{ fontSize: '.8rem', color: 'var(--gray-600)', padding: '3px 0', display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ color: 'var(--primary)' }}>•</span>
                        {f.label}
                        {f.required && <span style={{ color: 'var(--danger)', fontSize: '.7rem' }}>必填</span>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div className="card" style={{ textAlign: 'center', padding: '32px 20px', color: 'var(--gray-400)' }}>
                <div style={{ fontSize: '2rem', marginBottom: 8 }}>👆</div>
                <div style={{ fontSize: '.84rem' }}>选择左侧的 Skill<br />查看客户需填字段</div>
              </div>
            )}
          </div>
        </div>
      </form>
    </div>
  );
}
