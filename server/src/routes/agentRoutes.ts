/**
 * agentRoutes.ts — 通用 Agent HTTP 路由
 *
 * POST /api/v1/agent/chat                   — 主入口：接收消息，路由处理，返回 AgentResponse
 * POST /api/v1/agent/job-callback/:requestId — Cloud Run Job 完成时的内部回调
 * POST /api/orch/ingest                      — 渠道统一入口（wechat-archiver → Skill Platform）
 * GET  /api/v1/agent/profile                 — 读取 Agent Profile 配置
 * PUT  /api/v1/agent/profile                 — 保存 Agent Profile 配置
 * GET  /api/v1/agent/skills/available        — 读取所有已发布 skill（供前端配置页使用）
 * GET  /api/v1/agent/tasks                   — 统一任务日志（所有渠道）
 * GET  /api/v1/agent/tasks/:id               — 单个任务详情 + 事件流
 */

import express from 'express';
import { processAgentChat, handleJobCallback, saveAgentProfile, updateAgentTask, appendTaskEvent } from '../agentService';
import * as db from '../db';

export const agentRouter = express.Router();

// ─── 渠道适配辅助 ─────────────────────────────────────────────────────────────

const CUA_SEND_URL = process.env.CUA_SEND_URL || '';  // Mac mini 发消息接口（Step 5 用）

/**
 * POST /api/orch/ingest
 * wechat-archiver / 其他渠道 adapter 的统一推送入口
 *
 * Body（wechat-archiver 原生格式）：
 * {
 *   from_name: string,       // 发送者名称
 *   from_user_id: string,    // 企微 userId
 *   content: string,         // 消息内容（已聚合防抖后）
 *   msgtype: string,         // 'text' | 'image' | ...
 *   room_name?: string,      // 群名（群消息）
 *   channel: string,         // 'wecom'
 *   conversation_id?: string // 会话 ID
 * }
 *
 * 返回：{ task_id, status }（立即返回，AI 处理异步）
 */
agentRouter.post('/ingest', async (req, res) => {
  try {
    const { from_name, from_user_id, content, msgtype, channel = 'wecom', conversation_id } = req.body;

    if (!content || typeof content !== 'string' || !content.trim()) {
      return res.status(400).json({ error: 'content is required' });
    }
    if (!from_user_id) {
      return res.status(400).json({ error: 'from_user_id is required' });
    }

    // 只处理文字消息，其他类型（图片、语音）暂不处理
    if (msgtype && msgtype !== 'text') {
      console.log(`[Orch/Ingest] skip non-text msgtype=${msgtype} from=${from_name}`);
      return res.json({ ok: true, skipped: true, reason: 'non-text message' });
    }

    const sessionId = conversation_id || from_user_id;
    console.log(`[Orch/Ingest] channel=${channel} from=${from_name}(${from_user_id}) content="${content.slice(0, 80)}"`);

    // 构造 AgentChatRequest
    const agentReq = {
      content:    content.trim(),
      source:     channel,
      source_channel: channel,
      session_id: sessionId,
      meta: {
        from_name:  from_name || from_user_id,
        user_id:    from_user_id,
      },
      context: {
        available_apps: ['企业微信'],
        current_recipient: from_name || from_user_id,
      },
      history: [],
      // callback_url：skill 执行完成后通知 Mac mini CUA 发消息
      callback_url: CUA_SEND_URL ? `${CUA_SEND_URL}/api/agent-callback` : '',
    };

    // 立即返回，异步处理
    res.json({ ok: true, status: 'processing' });

    // 异步执行（fire and forget），错误只写日志不影响响应
    processAgentChat(agentReq as any).then(result => {
      console.log(`[Orch/Ingest] done from=${from_name} status=${result.status} reply="${(result.reply || '').slice(0, 60)}"`);
      // 若是同步回复（chat 或 health_direct），主动推给 CUA 发送
      if (result.status === 'done' && result.reply && CUA_SEND_URL) {
        // 同步回复：直接推给 CUA /api/agent-callback 执行发送
        fetch(`${CUA_SEND_URL}/api/agent-callback`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Agent-Secret': process.env.AGENT_SECRET || '' },
          body: JSON.stringify({
            request_id: result.request_id,
            session_id: sessionId,
            status:     'done',
            reply:      result.reply,
            delivery:   result.delivery || { app: '企业微信', recipient: from_name, action: 'type_and_send' },
            reasoning:  result.reasoning,
          }),
          signal: AbortSignal.timeout(30_000),
        }).then(r => console.log(`[Orch/Ingest] CUA callback HTTP ${r.status}`))
          .catch(e => console.warn(`[Orch/Ingest] CUA callback failed:`, e.message));
      }
    }).catch(err => {
      console.error(`[Orch/Ingest] processAgentChat error:`, err.message);
      // 把错误写回 agent_task 记录
      const reqIdMatch = err.stack ? null : null; // requestId is in agentReq.request_id if set
      const failedReqId = (agentReq as any)._requestId || '';
      void updateAgentTask(failedReqId, { status: 'failed', errorMessage: err.message, endedAt: Date.now() });
      void appendTaskEvent(failedReqId, 'task_failed', { error: err.message, stack: (err.stack || '').slice(0, 500) });
    });

  } catch (err: any) {
    console.error('[Orch/Ingest] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/v1/agent/tasks — 统一任务日志 ──────────────────────────────────

agentRouter.get('/tasks', async (req, res) => {
  try {
    const limit  = Math.min(parseInt(String(req.query.limit  || '50')), 200);
    const offset = parseInt(String(req.query.offset || '0'));
    const channel = req.query.channel as string | undefined;
    const status  = req.query.status  as string | undefined;
    const userId  = req.query.user_id as string | undefined;

    let where = 'WHERE 1=1';
    const params: any[] = [];
    if (channel) { where += ' AND source_channel=?'; params.push(channel); }
    if (status)  { where += ' AND status=?';          params.push(status); }
    if (userId)  { where += ' AND user_id=?';          params.push(userId); }

    const tasks = await db.allAsync<any>(
      `SELECT id, session_id, user_id, source_channel, input_content, route_type,
              skill_id, status, reply_content, error_message, meta,
              started_at, ended_at, duration_ms
       FROM agent_tasks ${where}
       ORDER BY started_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    const total = await db.getAsync<any>(
      `SELECT COUNT(*) as cnt FROM agent_tasks ${where}`, params
    );

    res.json({ tasks, total: total?.cnt || 0, limit, offset });
  } catch (err: any) {
    console.error('[AgentRoute] GET /tasks error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/v1/agent/tasks/:id — 单个任务 + 事件流 ────────────────────────

agentRouter.get('/tasks/:id', async (req, res) => {
  try {
    const task = await db.getAsync<any>(
      `SELECT * FROM agent_tasks WHERE id=?`, [req.params.id]
    );
    if (!task) return res.status(404).json({ error: 'not found' });

    const events = await db.allAsync<any>(
      `SELECT id, event_type, payload, ts FROM agent_task_events WHERE task_id=? ORDER BY ts ASC`,
      [req.params.id]
    );

    res.json({
      ...task,
      meta: task.meta ? JSON.parse(task.meta) : null,
      events: events.map((e: any) => ({
        ...e,
        payload: e.payload ? JSON.parse(e.payload) : null,
      })),
    });
  } catch (err: any) {
    console.error('[AgentRoute] GET /tasks/:id error:', err.message);
    res.status(500).json({ error: err.message });
  }
});


// ─── POST /api/v1/agent/chat ──────────────────────────────────────────────────

agentRouter.post('/chat', async (req, res) => {
  try {
    const { content, source, session_id, meta, context } = req.body;

    if (!content || typeof content !== 'string') {
      return res.status(400).json({ error: 'invalid_request', message: 'content is required (string)' });
    }
    if (!source) {
      return res.status(400).json({ error: 'invalid_request', message: 'source is required' });
    }
    if (!session_id) {
      return res.status(400).json({ error: 'invalid_request', message: 'session_id is required' });
    }
    if (!meta || !meta.from_name || !meta.user_id) {
      return res.status(400).json({ error: 'invalid_request', message: 'meta.from_name and meta.user_id are required' });
    }
    if (!context || !Array.isArray(context.available_apps)) {
      return res.status(400).json({ error: 'invalid_request', message: 'context.available_apps (array) is required' });
    }

    console.log(`[AgentRoute] POST /chat session=${session_id} source=${source} content="${content.slice(0, 60)}"`);

    const result = await processAgentChat(req.body);
    res.json(result);

  } catch (err: any) {
    console.error('[AgentRoute] /chat error:', err.message);
    res.status(500).json({
      error:   'agent_error',
      message: err.message || 'Internal agent error',
    });
  }
});

// ─── POST /api/v1/agent/job-callback/:requestId ───────────────────────────────

agentRouter.post('/job-callback/:requestId', async (req, res) => {
  const EXPECTED = process.env.SANDBOX_SECRET || 'sandbox-secret-2024';
  const secret   = req.headers['x-sandbox-secret'];

  if (secret !== EXPECTED) {
    console.warn(`[AgentRoute] job-callback: invalid secret for requestId=${req.params.requestId}`);
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { requestId } = req.params;
  console.log(`[AgentRoute] job-callback received for requestId=${requestId}`);

  res.json({ ok: true });

  handleJobCallback(requestId, req.body).catch(err =>
    console.error(`[AgentRoute] job-callback forward error for ${requestId}:`, err)
  );
});

// ─── GET /api/v1/agent/profile ────────────────────────────────────────────────

agentRouter.get('/profile', async (_req, res) => {
  try {
    const row = await db.getAsync<any>('SELECT * FROM agent_profiles WHERE id = ?', ['default']);
    if (!row) {
      // 返回默认 profile
      return res.json({
        id:               'default',
        name:             '服务助理',
        role_desc:        '专业健康顾问助理，协助客户了解检查报告和日常健康管理',
        reply_style:      '亲切、专业，回复简洁不超过200字',
        service_flow:     '1. 判断是否为健康相关问题\n2. 健康问题优先调用对应 skill 深度分析\n3. 非健康问题礼貌回复并适当引导',
        taboos:           ['不诊断疾病', '不推荐具体药物品牌', '不承诺治疗效果'],
        reassurance_mode: 'ai',
        reassurance_tpl:  '',
        skill_mode:       'auto',
        skill_ids:        [],
      });
    }
    res.json({
      ...row,
      taboos:    JSON.parse(row.taboos || '[]'),
      skill_ids: JSON.parse(row.skill_ids || '[]'),
    });
  } catch (err: any) {
    console.error('[AgentRoute] GET /profile error:', err.message);
    res.status(500).json({ error: 'db_error', message: err.message });
  }
});

// ─── PUT /api/v1/agent/profile ────────────────────────────────────────────────

agentRouter.put('/profile', async (req, res) => {
  try {
    const profile = await saveAgentProfile(req.body);
    console.log(`[AgentRoute] Profile saved: skill_mode=${profile.skill_mode}`);
    res.json(profile);
  } catch (err: any) {
    console.error('[AgentRoute] PUT /profile error:', err.message);
    res.status(500).json({ error: 'db_error', message: err.message });
  }
});

// ─── GET /api/v1/agent/skills/available ────────────────────────────────────────

agentRouter.get('/skills/available', async (_req, res) => {
  try {
    const skills = await db.allAsync<any>(
      "SELECT id, name, description, category FROM skills WHERE status = 'published' ORDER BY name",
      []
    );
    res.json(skills);
  } catch (err: any) {
    console.error('[AgentRoute] GET /skills/available error:', err.message);
    res.status(500).json({ error: 'db_error', message: err.message });
  }
});
