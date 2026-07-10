import { useState, useEffect } from 'react';
import { api } from '../lib/api';

interface OAuthToken {
  id: string;
  provider: string;
  skill_id: string | null;
  scope: string;
  expires_at: string | null;
  created_at: string;
}

export default function OAuthManager() {
  const [tokens, setTokens] = useState<OAuthToken[]>([]);
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    fetch('/api/oauth/tokens', { credentials: 'include' })
      .then(r => r.json())
      .then(d => setTokens(d.tokens || []))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  // 监听 OAuth 回调弹窗消息
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (e.data === 'oauth-success') load();
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  const handleAuthorize = (provider: string = 'google') => {
    const w = 500, h = 600;
    const left = (screen.width - w) / 2, top = (screen.height - h) / 2;
    window.open(
      `/auth/${provider}/start`,
      'oauth',
      `width=${w},height=${h},left=${left},top=${top}`
    );
  };

  const handleDelete = async (id: string) => {
    if (!confirm('确定要撤销这个授权吗？')) return;
    await fetch(`/api/oauth/tokens/${id}`, { method: 'DELETE', credentials: 'include' });
    load();
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h2 style={{ margin: 0 }}>🔑 授权管理</h2>
        <button className="btn btn-primary" onClick={() => handleAuthorize('google')}>
          + 授权 Google 账号
        </button>
      </div>

      {loading ? (
        <div className="card" style={{ textAlign: 'center', padding: 40 }}>加载中...</div>
      ) : tokens.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: 40, color: 'var(--gray-500)' }}>
          <p style={{ fontSize: '2rem', margin: '0 0 12px' }}>🔒</p>
          <p>还没有授权任何账号</p>
          <p style={{ fontSize: '.85rem' }}>点击上方「授权 Google 账号」开始授权，授权后的 Token 会自动注入到沙箱测试中。</p>
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 12 }}>
          {tokens.map(t => (
            <div className="card" key={t.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ fontWeight: 600 }}>
                  {t.provider === 'google' ? '🟢 Google' : t.provider}
                  {t.skill_id && <span style={{ fontSize: '.8rem', color: 'var(--gray-500)', marginLeft: 8 }}>Skill: {t.skill_id.slice(0,8)}...</span>}
                </div>
                <div style={{ fontSize: '.82rem', color: 'var(--gray-500)', marginTop: 4 }}>
                  权限：{t.scope || '基础信息'}
                </div>
                <div style={{ fontSize: '.78rem', color: 'var(--gray-400)', marginTop: 2 }}>
                  授权于 {new Date(t.created_at).toLocaleString('zh-CN')}
                  {t.expires_at && ` · 过期 ${new Date(t.expires_at).toLocaleString('zh-CN')}`}
                </div>
              </div>
              <button
                className="btn btn-sm"
                style={{ color: 'var(--danger)' }}
                onClick={() => handleDelete(t.id)}
                title="撤销此授权">
                🗑️ 撤销
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
