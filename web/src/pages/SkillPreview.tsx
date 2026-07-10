import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

interface SkillInfo {
  id: string;
  name: string;
  description: string;
  skill_type: string;
  type: string;
  status: string;
  plugin_config: any;
}

const API = (window as any).__API_BASE || '';

export default function SkillPreview() {
  const { id } = useParams<{ id: string }>();
  const [skill, setSkill] = useState<SkillInfo | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [skillLoading, setSkillLoading] = useState(true);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch(`${API}/api/skills/${id}/preview`)
      .then(r => r.json())
      .then(d => { setSkill(d); setSkillLoading(false); })
      .catch(() => { setError('无法加载 Skill 信息'); setSkillLoading(false); });
  }, [id]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  const send = async () => {
    if (!input.trim() || loading) return;
    const userMsg = input.trim();
    setInput('');
    const newMessages: Message[] = [...messages, { role: 'user', content: userMsg }];
    setMessages(newMessages);
    setLoading(true);
    setError('');
    try {
      const r = await fetch(`${API}/api/skills/${id}/preview/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: messages.map(m => ({ role: m.role, content: m.content })),
          user_message: userMsg,
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'AI 请求失败');
      setMessages([...newMessages, { role: 'assistant', content: d.reply }]);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  if (skillLoading) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', fontFamily: 'sans-serif' }}>
      加载中…
    </div>
  );

  if (!skill) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', color: 'red', fontFamily: 'sans-serif' }}>
      {error || 'Skill 不存在'}
    </div>
  );

  const isScript = skill.skill_type === 'plugin' || skill.skill_type === 'code';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', fontFamily: 'Inter, system-ui, sans-serif', background: '#f8f9fa' }}>
      {/* Header */}
      <div style={{ background: '#7c3aed', color: '#fff', padding: '12px 20px', display: 'flex', alignItems: 'center', gap: 12, boxShadow: '0 2px 8px rgba(124,58,237,0.3)' }}>
        <div style={{ fontSize: 22 }}>🔗</div>
        <div>
          <div style={{ fontWeight: 700, fontSize: '1rem' }}>{skill.name}</div>
          <div style={{ fontSize: '.75rem', opacity: 0.8 }}>
            管理员预览 · 状态: {skill.status} · {skill.type === 'external' ? '外部' : '内部'}
          </div>
        </div>
        <div style={{ marginLeft: 'auto', fontSize: '.7rem', background: 'rgba(255,255,255,0.15)', padding: '3px 8px', borderRadius: 12 }}>
          staging
        </div>
      </div>

      {/* Script skill warning */}
      {isScript && (
        <div style={{ background: '#fffbeb', borderBottom: '1px solid #fcd34d', padding: '10px 20px', fontSize: '.82rem', color: '#92400e' }}>
          ⚠️ 这是一个脚本/插件类 Skill（{skill.skill_type}），对话测试只能测试其 prompt 提示词部分。
          {skill.plugin_config?.source === 'clawhub' && (
            <span> MCP 工具（如 {skill.plugin_config?.install_cmd}）需要在本地环境中安装才能真正执行。</span>
          )}
        </div>
      )}

      {/* Messages */}
      <div style={{ flex: 1, overflow: 'auto', padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        {messages.length === 0 && (
          <div style={{ textAlign: 'center', color: '#9ca3af', marginTop: 40 }}>
            <div style={{ fontSize: 36, marginBottom: 8 }}>💬</div>
            <div style={{ fontSize: '.9rem' }}>向 <strong>{skill.name}</strong> 发送消息开始测试</div>
            {skill.description && (
              <div style={{ marginTop: 8, fontSize: '.8rem', color: '#d1d5db', maxWidth: 400, margin: '8px auto 0' }}>
                {skill.description}
              </div>
            )}
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} style={{ display: 'flex', justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start' }}>
            <div style={{
              maxWidth: '75%',
              padding: '10px 14px',
              borderRadius: m.role === 'user' ? '18px 18px 4px 18px' : '18px 18px 18px 4px',
              background: m.role === 'user' ? '#7c3aed' : '#fff',
              color: m.role === 'user' ? '#fff' : '#111',
              boxShadow: '0 1px 4px rgba(0,0,0,0.1)',
              fontSize: '.88rem',
              lineHeight: 1.6,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}>
              {m.content}
            </div>
          </div>
        ))}
        {loading && (
          <div style={{ display: 'flex' }}>
            <div style={{ padding: '10px 14px', borderRadius: '18px 18px 18px 4px', background: '#fff', boxShadow: '0 1px 4px rgba(0,0,0,0.1)', fontSize: '.88rem', color: '#6b7280' }}>
              ✦ 思考中…
            </div>
          </div>
        )}
        {error && (
          <div style={{ background: '#fee2e2', color: '#dc2626', padding: '8px 12px', borderRadius: 8, fontSize: '.82rem' }}>
            ⚠️ {error}
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div style={{ padding: '12px 16px', background: '#fff', borderTop: '1px solid #e5e7eb', display: 'flex', gap: 8 }}>
        <textarea
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
          placeholder="输入消息… (Enter 发送，Shift+Enter 换行)"
          rows={2}
          style={{
            flex: 1, resize: 'none', border: '1px solid #e5e7eb', borderRadius: 10,
            padding: '8px 12px', fontSize: '.88rem', outline: 'none',
            fontFamily: 'inherit', lineHeight: 1.5,
          }}
        />
        <button
          onClick={send}
          disabled={loading || !input.trim()}
          style={{
            background: loading || !input.trim() ? '#c4b5fd' : '#7c3aed',
            color: '#fff', border: 'none', borderRadius: 10,
            padding: '0 18px', cursor: loading ? 'not-allowed' : 'pointer',
            fontWeight: 600, fontSize: '.88rem',
          }}>
          发送
        </button>
      </div>
    </div>
  );
}
