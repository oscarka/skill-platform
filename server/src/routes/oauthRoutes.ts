/**
 * oauthRoutes.ts — OAuth 授权管理路由
 * 
 * 支持 Google OAuth 授权流程：
 * 1. /auth/google/start   → 跳转 Google 授权
 * 2. /auth/google/callback → 接收授权码，换取 token，存入 DB
 * 3. /api/oauth/tokens     → 列出当前 session 的已授权 token
 * 4. /api/oauth/tokens/:id → 删除指定 token
 * 
 * session_id 通过 cookie 管理，确保不同用户 token 隔离
 */
import { Router } from 'express';
import * as db from '../db';
import { randomUUID } from 'crypto';

export const oauthRouter = Router();

// ─── Google OAuth 配置 ────────────────────────────────────────────────────────
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const OAUTH_REDIRECT_URI = process.env.OAUTH_REDIRECT_URI || '';

// ─── 确保 session_id cookie ──────────────────────────────────────────────────
function ensureSessionId(req: any, res: any): string {
  let sid = req.cookies?.['session_id'];
  if (!sid) {
    sid = randomUUID();
    res.cookie('session_id', sid, { maxAge: 365 * 24 * 60 * 60 * 1000, httpOnly: true, sameSite: 'lax' });
  }
  return sid;
}


// ─── GET /api/oauth/google/config ────────────────────────────────────────────
// 返回 Google OAuth 配置状态（供前端判断是否已配置）
oauthRouter.get('/google/config', (req, res) => {
  if (!GOOGLE_CLIENT_ID) {
    return res.json({ configured: false });
  }
  res.json({
    configured: true,
    clientId: GOOGLE_CLIENT_ID,
    redirectUri: process.env.OAUTH_REDIRECT_URI || '',
  });
});

// ─── GET /auth/google/start ──────────────────────────────────────────────────
// 启动 Google OAuth 授权流程
oauthRouter.get('/auth/google/start', (req, res) => {
  const sessionId = ensureSessionId(req, res);
  const skillId = (req.query.skill_id as string) || '';
  const scope = (req.query.scope as string) || 'https://www.googleapis.com/auth/userinfo.email';

  if (!GOOGLE_CLIENT_ID || !OAUTH_REDIRECT_URI) {
    return res.status(500).json({ error: '未配置 Google OAuth（GOOGLE_CLIENT_ID / OAUTH_REDIRECT_URI）' });
  }

  // state 参数：编码 session_id + skill_id
  const state = Buffer.from(JSON.stringify({ sessionId, skillId })).toString('base64url');

  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: OAUTH_REDIRECT_URI,
    response_type: 'code',
    scope,
    state,
    access_type: 'offline',
    prompt: 'consent',
  });

  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
});

// ─── GET /auth/google/callback ───────────────────────────────────────────────
// Google 授权回调 → 用 code 换 token → 存入 DB
oauthRouter.get('/auth/google/callback', async (req, res) => {
  try {
    const code = req.query.code as string;
    const stateRaw = req.query.state as string;
    if (!code) return res.status(400).send('Missing code');

    // 解码 state
    let sessionId = '', skillId = '';
    try {
      const stateObj = JSON.parse(Buffer.from(stateRaw || '', 'base64url').toString());
      sessionId = stateObj.sessionId || '';
      skillId = stateObj.skillId || '';
    } catch { sessionId = ensureSessionId(req, res); }

    // 用 code 换 token
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: OAUTH_REDIRECT_URI,
        grant_type: 'authorization_code',
      }),
    });
    const tokenData = await tokenRes.json() as any;

    if (!tokenRes.ok || !tokenData.access_token) {
      return res.status(400).send(`OAuth 错误：${tokenData.error_description || tokenData.error || '未知错误'}`);
    }

    // 存入 DB（skill_platform.oauth_tokens）
    const expiresAt = tokenData.expires_in
      ? new Date(Date.now() + tokenData.expires_in * 1000).toISOString()
      : null;

    await db.runAsync(
      `INSERT INTO oauth_tokens (id, session_id, provider, skill_id, access_token, refresh_token, token_type, expires_at, scope)
       VALUES (?, ?, 'google', ?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(), sessionId, skillId || null,
        tokenData.access_token, tokenData.refresh_token || null,
        tokenData.token_type || 'Bearer', expiresAt,
        tokenData.scope || '',
      ]
    );

    // 关闭弹窗或跳回平台
    res.send(`
      <html><head><title>授权成功</title></head><body style="font-family:sans-serif;text-align:center;padding:60px;">
        <h2>✅ Google 授权成功！</h2>
        <p>Token 已安全存储，可以关闭此窗口。</p>
        <script>if(window.opener){window.opener.postMessage('oauth-success','*');window.close();}else{setTimeout(()=>location.href='/',2000);}</script>
      </body></html>
    `);
  } catch (err: any) {
    res.status(500).send(`OAuth callback error: ${err.message}`);
  }
});

// ─── GET /api/oauth/tokens ───────────────────────────────────────────────────
// 列出当前 session 的已授权 token（只返回 provider + scope，不暴露真实 token）
oauthRouter.get('/api/oauth/tokens', async (req, res) => {
  try {
    const sessionId = ensureSessionId(req, res);
    const tokens = await db.allAsync<any>(
      `SELECT id, provider, skill_id, token_type, scope, expires_at, created_at
       FROM oauth_tokens WHERE session_id=? ORDER BY created_at DESC`,
      [sessionId]
    );
    res.json({ tokens });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE /api/oauth/tokens/:id ────────────────────────────────────────────
oauthRouter.delete('/api/oauth/tokens/:id', async (req, res) => {
  try {
    const sessionId = ensureSessionId(req, res);
    await db.runAsync('DELETE FROM oauth_tokens WHERE id=? AND session_id=?', [req.params.id, sessionId]);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/oauth/token-for-skill ──────────────────────────────────────────
// 沙箱调用时获取某个 skill 对应的 token（服务端内部用）
oauthRouter.get('/api/oauth/token-for-skill', async (req, res) => {
  try {
    const skillId = req.query.skill_id as string;
    if (!skillId) return res.status(400).json({ error: 'skill_id required' });

    // 查找与该 skill 关联的最新 token（不限 session）
    const token = await db.getAsync<any>(
      `SELECT access_token, refresh_token, token_type, expires_at
       FROM oauth_tokens WHERE (skill_id=? OR skill_id IS NULL) AND provider='google'
       ORDER BY created_at DESC LIMIT 1`,
      [skillId]
    );
    if (!token) return res.json({ token: null });
    res.json({ token: { accessToken: token.access_token, tokenType: token.token_type, expiresAt: token.expires_at } });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/oauth/mcp-tokens ──────────────────────────────────────────────
// 管理员授权后存储 MCP OAuth token（持久化，所有测试复用）
// body: { provider, mcp_name?, access_token, refresh_token?, expires_in?, token_data? }
oauthRouter.post('/mcp-tokens', async (req, res) => {
  try {
    const { provider, mcp_name, access_token, refresh_token, expires_in, token_data } = req.body;
    if (!provider || !access_token) return res.status(400).json({ error: 'provider and access_token required' });

    const expires_at = expires_in ? Date.now() + expires_in * 1000 : 0;
    const now = Date.now();
    const id = `${provider}-${mcp_name || 'default'}`;

    await db.runAsync(
      `INSERT INTO mcp_oauth_tokens (id, provider, mcp_name, access_token, refresh_token, expires_at, token_data, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (provider, mcp_name) DO UPDATE SET
         access_token=$4, refresh_token=$5, expires_at=$6, token_data=$7, updated_at=$9`,
      [id, provider, mcp_name || null, access_token, refresh_token || null, expires_at, token_data ? JSON.stringify(token_data) : null, now, now]
    );
    res.json({ ok: true, id });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ─── GET /api/oauth/mcp-tokens ───────────────────────────────────────────────
// 列出所有已存储的 MCP OAuth token（不返回 token 明文，只返回状态）
oauthRouter.get('/mcp-tokens', async (req, res) => {
  try {
    const rows = await db.allAsync<any>(
      `SELECT id, provider, mcp_name, expires_at, updated_at,
              CASE WHEN expires_at = 0 OR expires_at > $1 THEN 'valid' ELSE 'expired' END as status
       FROM mcp_oauth_tokens ORDER BY updated_at DESC`,
      [Date.now()]
    );
    res.json(rows);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ─── DELETE /api/oauth/mcp-tokens/:id ────────────────────────────────────────
oauthRouter.delete('/mcp-tokens/:id', async (req, res) => {
  try {
    await db.runAsync(`DELETE FROM mcp_oauth_tokens WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});
