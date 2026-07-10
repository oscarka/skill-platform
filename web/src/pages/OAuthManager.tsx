import { useState, useEffect } from 'react';

interface McpOAuthToken {
  id: string;
  provider: string;
  mcp_name: string | null;
  expires_at: string | null;
  updated_at: string;
  status: 'valid' | 'expired';
}

export default function OAuthManager() {
  const [tokens, setTokens] = useState<McpOAuthToken[]>([]);
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    fetch('/api/oauth/mcp-tokens')
      .then(r => r.json())
      .then(d => setTokens(Array.isArray(d) ? d : []))
      .catch(() => setTokens([]))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  // 通用 OAuth popup（同 SkillDetail）
  const openOAuthPopup = (authUrl: string): Promise<{ hash: string; search: string } | null> => {
    return new Promise((resolve) => {
      const popup = window.open(authUrl, 'oauth-popup', 'width=500,height=620');
      const onMessage = (e: MessageEvent) => {
        if (e.origin !== window.location.origin) return;
        if (e.data?.type === 'oauth-callback') {
          window.removeEventListener('message', onMessage);
          clearTimeout(timer);
          resolve({ hash: e.data.hash || '', search: e.data.search || '' });
        }
      };
      window.addEventListener('message', onMessage);
      const timer = setTimeout(() => {
        window.removeEventListener('message', onMessage);
        popup?.close();
        resolve(null);
      }, 120000);
      const pollClose = setInterval(() => {
        if (popup?.closed) { clearInterval(pollClose); clearTimeout(timer); window.removeEventListener('message', onMessage); resolve(null); }
      }, 500);
    });
  };

  const handleAuthorize = async (provider: 'google') => {
    // 从服务端拿 client ID
    const cfgRes = await fetch('/api/oauth/google/config').catch(() => null);
    const cfg = await cfgRes?.json().catch(() => ({}));
    if (!cfg?.configured || !cfg?.clientId) {
      alert('❌ 平台未配置 Google OAuth Client ID');
      return;
    }
    const REDIRECT = `${window.location.origin}/oauth-callback.html`;
    const SCOPE = 'https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email';
    const url = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${cfg.clientId}&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=token&scope=${encodeURIComponent(SCOPE)}`;
    const result = await openOAuthPopup(url);
    if (!result) { alert('授权取消或失败'); return; }
    const params = new URLSearchParams(result.hash.replace(/^#/, ''));
    const access_token = params.get('access_token');
    const token_type = params.get('token_type') || 'Bearer';
    const scope = params.get('scope') || 'https://www.googleapis.com/auth/cloud-platform';
    const expires_in_val = params.get('expires_in');
    if (!access_token) { alert('未获取到 token'); return; }

    // 存入 mcp_oauth_tokens（含完整 token_data，runner.py 需要 token_type/scope/expiry_date）
    const expires_in_num = expires_in_val ? parseInt(expires_in_val) : 3600;
    const saveRes = await fetch('/api/oauth/mcp-tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider,
        mcp_name: provider === 'google' ? 'stitch-mcp-auto' : undefined,
        access_token,
        expires_in: expires_in_num,
        token_data: {
          access_token,
          token_type,
          scope,
          expiry_date: Date.now() + expires_in_num * 1000,
        },
      }),
    });
    if (saveRes.ok) {
      alert('✅ 授权成功，Token 已保存，沙箱测试将自动使用');
      load();
    } else {
      alert('保存 Token 失败');
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('确定要撤销这个授权吗？')) return;
    await fetch(`/api/oauth/mcp-tokens/${id}`, { method: 'DELETE' });
    load();
  };

  const providerLabel = (provider: string) => {
    const map: Record<string, string> = { google: '🟢 Google', tencent: '🔵 腾讯', github: '⚫ GitHub' };
    return map[provider] || provider;
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
                <div style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
                  {providerLabel(t.provider)}
                  {t.mcp_name && <span style={{ fontSize: '.78rem', color: 'var(--gray-400)', fontWeight: 400 }}>({t.mcp_name})</span>}
                  <span style={{
                    fontSize: '.72rem', padding: '2px 6px', borderRadius: 4,
                    background: t.status === 'valid' ? '#e8f5e9' : '#fce4ec',
                    color: t.status === 'valid' ? '#2e7d32' : '#c62828',
                  }}>{t.status === 'valid' ? '有效' : '已过期'}</span>
                </div>
                <div style={{ fontSize: '.78rem', color: 'var(--gray-400)', marginTop: 4 }}>
                  更新于 {new Date(parseInt(t.updated_at)).toLocaleString('zh-CN')}
                  {t.expires_at && parseInt(t.expires_at) > 0 && ` · 过期 ${new Date(parseInt(t.expires_at)).toLocaleString('zh-CN')}`}
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
