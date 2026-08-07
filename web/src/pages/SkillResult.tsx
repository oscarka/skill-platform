import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';

function SimpleMarkdown({ text }: { text: string }) {
  const lines = text.split('\n');
  return (
    <div style={{ lineHeight: 1.8, fontSize: '.95rem', color: '#1e293b' }}>
      {lines.map((line, i) => {
        if (line.startsWith('### '))
          return <h3 key={i} style={{ margin: '16px 0 4px', fontSize: '1rem', fontWeight: 700, color: '#0f172a' }}>{line.slice(4)}</h3>;
        if (line.startsWith('## '))
          return <h2 key={i} style={{ margin: '20px 0 6px', fontSize: '1.1rem', fontWeight: 700, color: '#0f172a' }}>{line.slice(3)}</h2>;
        if (line.startsWith('# '))
          return <h1 key={i} style={{ margin: '24px 0 8px', fontSize: '1.25rem', fontWeight: 800, color: '#0f172a' }}>{line.slice(2)}</h1>;
        if (line.startsWith('- ') || line.startsWith('* '))
          return <li key={i} style={{ marginLeft: 18, marginBottom: 2 }}>{line.slice(2)}</li>;
        if (line.trim() === '')
          return <div key={i} style={{ height: 8 }} />;
        return <p key={i} style={{ margin: '4px 0' }}>{line}</p>;
      })}
    </div>
  );
}

export default function SkillResult() {
  const { requestId } = useParams<{ requestId: string }>();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [actionDone, setActionDone] = useState<'confirm' | 'decline' | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    if (!requestId) return;
    fetch(`/api/v1/agent/skill-result/${requestId}`)
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, [requestId]);

  const handleAction = async (action: 'confirm' | 'decline') => {
    setSubmitting(true);
    try {
      const res = await fetch(`/api/v1/agent/skill-result/${requestId}/wiki-confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const d = await res.json();
      if (res.ok) {
        setActionDone(action);
        setMsg({ type: 'success', text: action === 'confirm' ? '✅ 已确认！建议将纳入您的健康档案' : '已记录，本次建议不写入健康档案' });
      } else {
        setMsg({ type: 'error', text: d.error || '操作失败，请重试' });
      }
    } catch {
      setMsg({ type: 'error', text: '网络错误，请检查连接后重试' });
    } finally {
      setSubmitting(false);
    }
  };

  const page: React.CSSProperties = {
    minHeight: '100vh',
    background: 'linear-gradient(135deg, #f0f9ff 0%, #e0f2fe 50%, #f0fdf4 100%)',
    padding: '20px 16px 60px',
    fontFamily: "'PingFang SC','Helvetica Neue',Arial,sans-serif",
  };
  const card: React.CSSProperties = {
    maxWidth: 680, margin: '0 auto', background: '#fff',
    borderRadius: 16, boxShadow: '0 4px 24px rgba(0,0,0,.08)', overflow: 'hidden',
  };
  const header: React.CSSProperties = {
    background: 'linear-gradient(135deg, #1e40af, #0891b2)',
    padding: '24px 28px', color: '#fff',
  };
  const content: React.CSSProperties = { padding: '28px' };
  const actionBar: React.CSSProperties = {
    padding: '24px 28px', background: '#f8fafc', borderTop: '1px solid #e2e8f0',
    display: 'flex', gap: 12, justifyContent: 'center' as const, flexWrap: 'wrap' as const,
  };

  if (loading) return <div style={page}><div style={{ ...card, padding: 40, textAlign: 'center', color: '#64748b' }}>⏳ 加载中…</div></div>;

  if (!data || data.error) return (
    <div style={page}><div style={{ ...card, padding: 40, textAlign: 'center', color: '#dc2626' }}>
      ❌ 未找到分析结果，请检查链接是否正确
    </div></div>
  );

  if (data.status !== 'done') return (
    <div style={page}><div style={{ ...card, padding: 40, textAlign: 'center', color: '#0891b2' }}>
      <div style={{ fontSize: '2rem', marginBottom: 16 }}>⏳</div>
      <div style={{ fontWeight: 700, fontSize: '1.1rem', marginBottom: 8 }}>分析进行中</div>
      <div style={{ color: '#64748b' }}>请稍候，AI 正在处理您的健康数据…</div>
    </div></div>
  );

  const alreadyConfirmed = data.wiki_confirmed;
  const alreadyDeclined  = data.wiki_declined;

  return (
    <div style={page}>
      <div style={card}>
        <div style={header}>
          <div style={{ fontSize: '.78rem', opacity: .8, marginBottom: 4 }}>健康分析结果</div>
          <div style={{ fontSize: '1.25rem', fontWeight: 700 }}>{data.skill_name || '专项分析'} 报告</div>
          {data.ended_at && (
            <div style={{ fontSize: '.75rem', opacity: .7, marginTop: 6 }}>
              完成时间：{new Date(data.ended_at).toLocaleString('zh-CN')}
            </div>
          )}
        </div>

        <div style={content}>
          {msg && (
            <div style={{
              padding: '12px 16px', borderRadius: 10, marginBottom: 20,
              background: msg.type === 'success' ? '#f0fdf4' : '#fef2f2',
              border: `1px solid ${msg.type === 'success' ? '#86efac' : '#fca5a5'}`,
              color: msg.type === 'success' ? '#166534' : '#dc2626', fontWeight: 600,
            }}>{msg.text}</div>
          )}
          <SimpleMarkdown text={data.output || '（暂无内容）'} />
        </div>

        {!actionDone && !alreadyConfirmed && !alreadyDeclined && (
          <div style={actionBar}>
            <div style={{ width: '100%', textAlign: 'center', marginBottom: 8, color: '#475569', fontSize: '.88rem' }}>
              📋 您希望将以上建议纳入您的健康档案吗？
            </div>
            <button id="btn-confirm-wiki" onClick={() => handleAction('confirm')} disabled={submitting}
              style={{
                padding: '12px 28px',
                background: 'linear-gradient(135deg, #059669, #0891b2)',
                color: '#fff', border: 'none', borderRadius: 10, fontWeight: 700,
                fontSize: '1rem', cursor: submitting ? 'not-allowed' : 'pointer',
                opacity: submitting ? 0.7 : 1, boxShadow: '0 2px 8px rgba(5,150,105,.3)',
              }}>
              ✅ 我认可并愿意执行这个建议
            </button>
            <button id="btn-decline-wiki" onClick={() => handleAction('decline')} disabled={submitting}
              style={{
                padding: '12px 24px', background: '#f1f5f9', color: '#475569',
                border: '1px solid #cbd5e1', borderRadius: 10, fontWeight: 600,
                fontSize: '.95rem', cursor: submitting ? 'not-allowed' : 'pointer',
                opacity: submitting ? 0.7 : 1,
              }}>
              ❌ 暂不采纳
            </button>
          </div>
        )}

        {(actionDone || alreadyConfirmed || alreadyDeclined) && (
          <div style={{ ...actionBar, justifyContent: 'center' }}>
            {(actionDone === 'confirm' || alreadyConfirmed)
              ? <div style={{ textAlign: 'center', color: '#059669', fontWeight: 700 }}>✅ 建议已纳入健康档案，感谢您的信任！</div>
              : <div style={{ textAlign: 'center', color: '#64748b' }}>已记录，本次建议不写入健康档案</div>
            }
          </div>
        )}
      </div>
      <div style={{ textAlign: 'center', marginTop: 24, color: '#94a3b8', fontSize: '.75rem' }}>
        由 AI 健康顾问提供 · 仅供参考，不替代医疗诊断
      </div>
    </div>
  );
}
