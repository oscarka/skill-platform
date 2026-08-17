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
import { v4 as uuidv4 } from 'uuid';
import { processAgentChat, handleJobCallback, saveAgentProfile, updateAgentTask, appendTaskEvent, taskEventBus } from '../agentService';
import * as db from '../db';


export const agentRouter = express.Router();

// ─── 渠道适配辅助 ─────────────────────────────────────────────────────────────

const CUA_SEND_URL  = process.env.CUA_SEND_URL  || '';  // Mac mini 发消息接口
const JUHE_SEND_URL = process.env.JUHE_SEND_URL || '';  // juhe-api /api/send 接口

// ── 渠道身份表查询 / 自动登记 ────────────────────────────────────────────
interface ChannelIdentity {
  unified_id:   string;   // unionid or generated id
  display_name: string;
  juhe_conv_id: string | null;  // S:vid or R:roomid
}

async function resolveIdentity(
  channel: string, channel_uid: string,
  from_name: string, conversation_id: string
): Promise<ChannelIdentity> {
  // 1. 查询当前渠道的映射
  const row = await db.getAsync<any>(
    `SELECT ci.unified_id, ci.display_name,
            jci.conv_id AS juhe_conv_id
     FROM skill_platform.channel_identities ci
     LEFT JOIN skill_platform.channel_identities jci
       ON jci.unified_id = ci.unified_id AND jci.channel = 'juhe'
     WHERE ci.channel = $1 AND ci.channel_uid = $2`,
    [channel, channel_uid]
  );

  if (row) {
    // 如果 juhe 渠道且有新 conv_id，更新一下
    if (channel === 'juhe' && conversation_id && conversation_id !== row.juhe_conv_id) {
      await db.runAsync(
        `UPDATE skill_platform.channel_identities SET conv_id=$1, updated_at=now() WHERE channel='juhe' AND channel_uid=$2`,
        [conversation_id, channel_uid]
      ).catch(() => {});
    }
    return {
      unified_id:   row.unified_id,
      display_name: row.display_name || from_name,
      juhe_conv_id: channel === 'juhe' ? (conversation_id || row.juhe_conv_id) : row.juhe_conv_id,
    };
  }

  // 2. 新客户：自动创建（unified_id = channel_uid 先用原始 ID，后续关联后替换）
  const new_unified_id = channel === 'juhe'
    ? `juhe_${channel_uid}`
    : `wecom_${channel_uid}`;

  await db.runAsync(
    `INSERT INTO skill_platform.channel_identities
       (unified_id, channel, channel_uid, display_name, conv_id, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,now(),now())
     ON CONFLICT (channel,channel_uid) DO NOTHING`,
    [new_unified_id, channel, channel_uid, from_name,
     channel === 'juhe' ? conversation_id : null]
  ).catch(() => {});

  console.log(`[Orch/Ingest] 新客户自动注册: channel=${channel} uid=${channel_uid} unified=${new_unified_id}`);
  return {
    unified_id:   new_unified_id,
    display_name: from_name,
    juhe_conv_id: channel === 'juhe' ? conversation_id : null,
  };
}

// 回复优先 juhe，失败再 fallback CUA
async function sendReply(opts: {
  reply: string;
  juhe_conv_id: string | null;
  display_name: string;
  request_id: string;
  session_id: string;
  status: string;
  reasoning?: string;
  delivery?: any;
}) {
  const { reply, juhe_conv_id, display_name, request_id, session_id, status, reasoning, delivery } = opts;

  // ① 优先 juhe（不管消息从哪个渠道来）
  if (JUHE_SEND_URL && juhe_conv_id) {
    try {
      const r = await fetch(`${JUHE_SEND_URL.replace(/\/?$/, '')}/api/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversation_id: juhe_conv_id, content: reply }),
        signal: AbortSignal.timeout(20_000),
      });
      if (r.ok) {
        console.log(`[Orch/Ingest] juhe send OK conv=${juhe_conv_id}`);
        return;  // 成功，不需要 CUA
      }
      console.warn(`[Orch/Ingest] juhe send HTTP ${r.status}, fallback to CUA`);
    } catch (e: any) {
      console.warn(`[Orch/Ingest] juhe send failed: ${e.message}, fallback to CUA`);
    }
  }

  // ② Fallback: CUA（CUA 通过页面搜索人名发送）
  if (CUA_SEND_URL) {
    const cuaBody = {
      request_id,
      session_id,
      status: status === 'processing' ? 'done' : status,
      reply,
      delivery: delivery || { app: '企业微信', recipient: display_name, action: 'type_and_send' },
      reasoning,
    };
    const label = status === 'processing' ? '安抚' : '回复';
    fetch(`${CUA_SEND_URL}/api/agent-callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Agent-Secret': process.env.AGENT_SECRET || '' },
      body: JSON.stringify(cuaBody),
      signal: AbortSignal.timeout(30_000),
    }).then(r => console.log(`[Orch/Ingest] CUA fallback(${label}) HTTP ${r.status} recipient=${display_name}`))
      .catch(e => console.warn(`[Orch/Ingest] CUA fallback failed:`, e.message));
  }
}

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

    const sessionId = conversation_id || from_user_id;
    const history   = Array.isArray(req.body.history) ? req.body.history : [];
    const notes     = req.body.notes || '';

    // 身份统一：查 channel_identities，新客户自动注册
    const identity   = await resolveIdentity(channel, from_user_id, from_name || from_user_id, sessionId);
    const unified_id   = identity.unified_id;
    const display_name = identity.display_name;
    const juhe_conv_id = identity.juhe_conv_id;

    // ── 附件暂存：记录用户最近24小时上传的文件 ──────────────────────────────
    const media_url = req.body.media_url || null;
    const file_name = req.body.file_name || '';
    const file_type = req.body.file_type || (msgtype === 'image' ? 'image' : 'file');

    if (media_url) {
      const fileId = uuidv4();
      const now = Date.now();
      try {
        await db.runAsync(
          `INSERT INTO user_recent_files (id, user_id, file_url, file_name, file_type, summary, content_hash, created_at)
           VALUES (?,?,?,?,?,?,NULL,?)`,
          [fileId, unified_id, media_url, file_name || '未命名附件', file_type, content.slice(0, 500), now]
        );
        // 清理超过24小时的过期附件
        const cutoff24h = now - 24 * 60 * 60 * 1000;
        await db.runAsync(`DELETE FROM user_recent_files WHERE created_at < ?`, [cutoff24h]);
        console.log(`[Orch/Ingest] 📎 保存用户 ${unified_id} 最近24小时附件: ${file_name} (${media_url})`);

        // ── 异步计算文件内容 MD5，用于真正的内容去重 ──────────────────────────
        // 不阻塞 ingest 响应，后台下载计算
        (async () => {
          try {
            const https = await import('https');
            const http  = await import('http');
            const crypto = await import('crypto');
            const fetchModule = media_url.startsWith('https') ? https : http;
            const hash = crypto.createHash('md5');
            await new Promise<void>((resolve, reject) => {
              fetchModule.get(media_url, (resp) => {
                if (resp.statusCode && resp.statusCode >= 400) {
                  reject(new Error(`HTTP ${resp.statusCode}`)); return;
                }
                resp.on('data', (chunk: Buffer) => hash.update(chunk));
                resp.on('end', resolve);
                resp.on('error', reject);
              }).on('error', reject);
            });
            const md5 = hash.digest('hex');
            await db.runAsync(`UPDATE user_recent_files SET content_hash=? WHERE id=?`, [md5, fileId]);
            console.log(`[Orch/Ingest] 🔑 MD5 计算完成 file=${file_name} hash=${md5.slice(0,8)}…`);
          } catch (hashErr: any) {
            console.warn(`[Orch/Ingest] ⚠️ MD5 计算失败 file=${file_name}: ${hashErr.message}`);
            // 失败不影响功能，content_hash 保持 NULL，回退到文件名去重
          }
        })();

      } catch (err: any) {
        console.warn(`[Orch/Ingest] 保存附件失败:`, err.message);
      }
    }

    // ── 文件消息守卫：文件/图片（不管有没有 AI摘要）不触发 agent，只保存附件 ──────
    // archiver.js 是第一道拦截；ingest 这里是第二道防线
    // 规则：msgtype=file/image + media_url → 只存 user_recent_files，不进 processAgentChat
    //   （即使 Gemini OCR 提取出了 AI摘要，文件消息也不主动触发 agent）
    //   → 等用户主动发文字消息才触发 agent，届时文件自动挂载到工单
    const isFileOnlyContent = (
      msgtype === 'file' || msgtype === 'image'
    ) && !!media_url;

    console.log(`[Orch/Ingest] channel=${channel} from=${display_name}(${from_user_id}) unified=${unified_id} juhe_conv=${juhe_conv_id||'none'} content="${content.slice(0,60)}" isFileOnly=${isFileOnlyContent} history=${history.length}`);

    // 立即返回给 archiver（不阻塞）
    res.json({ ok: true, status: isFileOnlyContent ? 'file_saved' : 'processing' });

    if (isFileOnlyContent) {
      console.log(`[Orch/Ingest] 📎 纯文件消息（无 AI摘要），跳过 agent，仅暂存附件 file="${file_name}"`);
      // user_recent_files 已在上面保存，不需要额外处理
    } else {
      // 构造 AgentChatRequest
      const agentReq = {
        content:    content.trim(),
        source:     channel,
        source_channel: channel,
        session_id: unified_id,
        meta: {
          from_name:    display_name,
          user_id:      unified_id,
          channel_uid:  from_user_id,
          juhe_conv_id: juhe_conv_id || '',
        },
        context: {
          available_apps: ['企业微信'],
          current_recipient: display_name,
        },
        history,
        notes,
      };

      const t0Process = Date.now();
      processAgentChat(agentReq as any).then(async result => {
        const processMs = Date.now() - t0Process;
        console.log(`[Orch/Ingest] done unified=${unified_id} status=${result.status} processMs=${processMs} reply="${(result.reply || '').slice(0, 60)}"`);

        if (result.reply) {
          const t0Send = Date.now();
          await sendReply({
            reply:        result.reply,
            juhe_conv_id,
            display_name,
            request_id:  result.request_id || '',
            session_id:  unified_id,
            status:      result.status,
            reasoning:   result.reasoning,
            delivery:    result.delivery,
          }).catch(e => console.warn('[Orch/Ingest] sendReply error:', e.message));
          console.log(`[Orch/Ingest] ⏱️ total: process=${processMs}ms send=${Date.now() - t0Send}ms e2e=${Date.now() - t0Process}ms`);
        }
      }).catch(err => {
        console.error(`[Orch/Ingest] processAgentChat error:`, err.message);
        const failedReqId = (agentReq as any)._requestId || '';
        void updateAgentTask(failedReqId, { status: 'failed', errorMessage: err.message, endedAt: Date.now() });
        void appendTaskEvent(failedReqId, 'task_failed', { error: err.message, stack: (err.stack || '').slice(0, 500) });
      });
    }

  } catch (err: any) {
    console.error('[Orch/Ingest] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});


// ─── GET /api/v1/agent/tasks — 统一任务日志 ──────────────────────────────────

agentRouter.get('/tasks', async (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
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
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
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
      meta:             task.meta             ? JSON.parse(task.meta)             : null,
      job_transcript:   task.job_transcript   ? JSON.parse(task.job_transcript)   : null,
      context_snapshot: task.context_snapshot ? JSON.parse(task.context_snapshot) : null,
      cua_events:       task.cua_events       ? JSON.parse(task.cua_events)       : null,
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

// ─── GET /api/v1/agent/tasks/:id/stream — SSE 实时事件推送 ───────────────────

agentRouter.get('/tasks/:id/stream', async (req, res) => {
  const taskId = req.params.id;

  // SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',  // nginx/Cloud Run: disable buffering
  });
  res.flushHeaders();

  // Send initial events from DB
  try {
    const events = await db.allAsync<any>(
      `SELECT id, event_type, payload, ts FROM agent_task_events WHERE task_id=? ORDER BY ts ASC`,
      [taskId]
    );
    const parsed = events.map((e: any) => ({
      ...e, payload: e.payload ? JSON.parse(e.payload) : null,
    }));
    res.write(`data: ${JSON.stringify({ type: 'init', events: parsed })}\n\n`);
  } catch (e) { /* ignore */ }

  // Subscribe to real-time events
  const handler = (event: any) => {
    try {
      res.write(`data: ${JSON.stringify({ type: 'event', ...event })}\n\n`);
    } catch { /* client disconnected */ }
  };
  taskEventBus.on(`task:${taskId}`, handler);

  // Heartbeat every 15s to keep connection alive
  const heartbeat = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch { /* ignore */ }
  }, 15000);

  // Cleanup on disconnect
  req.on('close', () => {
    taskEventBus.removeListener(`task:${taskId}`, handler);
    clearInterval(heartbeat);
  });
});

// ─── POST /api/v1/agent/cua-step/:requestId — CUA 逐步事件推送 ───────────────

agentRouter.post('/cua-step/:requestId', async (req, res) => {
  const EXPECTED = process.env.SANDBOX_SECRET || 'sandbox-secret-2024';
  if (req.headers['x-sandbox-secret'] !== EXPECTED) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  res.json({ ok: true }); // respond immediately

  const { requestId } = req.params;
  const { step_index, event_type, detail, tool_name, tool_result, ts } = req.body;

  // Write as task event + auto-push via EventEmitter
  void appendTaskEvent(requestId, 'cua_step', {
    step_index,
    event_type: event_type || 'step',
    detail: typeof detail === 'string' ? detail.slice(0, 300) : detail,
    tool_name,
    tool_result: typeof tool_result === 'string' ? tool_result.slice(0, 200) : undefined,
    ts: ts || Date.now(),
  });
});

// ─── GET /api/v1/agent/skill-result/:requestId — 公开结果查看（无需登录）────
// Task 5: 用户点链接查看 skill 完整结果

agentRouter.get('/skill-result/:requestId', async (req, res) => {
  try {
    const { requestId } = req.params;
    const task = await db.getAsync<any>(
      `SELECT id, session_id, reply_content, status, route_type, skill_id, ended_at, started_at
       FROM agent_tasks WHERE id=?`,
      [requestId]
    );
    if (!task) return res.status(404).json({ error: 'not found' });
    if (task.status !== 'done') return res.status(202).json({ status: task.status, message: '分析尚未完成' });

    // 查 wiki 确认状态（存在 agent_tasks 的 reply_content 字段，从另一张表查更合适但这里暂存在内存中）
    // 简单方案：在 task events 里找 wiki_confirmed 事件
    const events = await db.allAsync<any>(
      `SELECT event_type, payload, ts FROM agent_task_events WHERE task_id=? ORDER BY ts ASC`,
      [requestId]
    );
    const confirmedEvent = events.find((e: any) => e.event_type === 'wiki_confirmed');
    const declinedEvent  = events.find((e: any) => e.event_type === 'wiki_declined');

    // 找 skill_id 对应的 skill 名称
    const skill = task.skill_id ? await db.getAsync<any>('SELECT name, description FROM skills WHERE id=?', [task.skill_id]) : null;

    res.json({
      request_id:   requestId,
      status:       task.status,
      skill_name:   skill?.name || '',
      output:       task.reply_content || '',  // 完整 skill output
      ended_at:     task.ended_at,
      wiki_confirmed: !!confirmedEvent,
      wiki_declined:  !!declinedEvent,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /api/v1/agent/skill-result/:requestId/wiki-confirm ─────────────────
// Task 6: 用户点「认可并执行」→ 触发 wiki sync

agentRouter.post('/skill-result/:requestId/wiki-confirm', async (req, res) => {
  try {
    const { requestId } = req.params;
    const { action } = req.body;  // 'confirm' | 'decline'

    const task = await db.getAsync<any>(
      `SELECT id, session_id, reply_content, status FROM agent_tasks WHERE id=?`,
      [requestId]
    );
    if (!task) {
      console.log(`[WikiConfirm] ❌ requestId=${requestId} 不存在`);
      return res.status(404).json({ error: 'not found' });
    }
    if (task.status !== 'done') {
      console.log(`[WikiConfirm] ⚠️ requestId=${requestId} 状态=${task.status}，尚未完成，拒绝确认`);
      return res.status(400).json({ error: '任务未完成' });
    }

    const userId = task.session_id?.replace(/^wechat_/, '') || '';

    if (action === 'confirm') {
      console.log(`[WikiConfirm] ✅ 用户确认: requestId=${requestId} userId=${userId} → 触发 wiki sync`);
      void appendTaskEvent(requestId, 'wiki_confirmed', {
        confirmed_at: Date.now(),
        userId,
        note: '用户点击「认可并执行」，触发 wiki 同步',
      });

      if (userId) {
        const { triggerWikiSyncPublic } = await import('../agentService');
        triggerWikiSyncPublic(userId, `user_confirmed:${requestId}`);
        console.log(`[WikiConfirm] 📤 wiki sync 已下发: userId=${userId} reason=user_confirmed:${requestId}`);
      } else {
        console.warn(`[WikiConfirm] ⚠️ session_id=${task.session_id} 无法解析 userId，wiki sync 跳过`);
      }

      res.json({ success: true, message: 'wiki 同步已触发' });
    } else if (action === 'decline') {
      console.log(`[WikiConfirm] ❌ 用户取消: requestId=${requestId} userId=${userId} → 不写入 wiki`);
      void appendTaskEvent(requestId, 'wiki_declined', {
        declined_at: Date.now(),
        userId,
        note: '用户点击「暂不采纳」，不写入 wiki',
      });
      res.json({ success: true, message: '已记录，不写入 wiki' });
    } else {
      console.log(`[WikiConfirm] ⚠️ 未知 action="${action}" requestId=${requestId}`);
      res.status(400).json({ error: 'action must be confirm or decline' });
    }
  } catch (e: any) {
    console.error(`[WikiConfirm] 💥 异常:`, e.message);
    res.status(500).json({ error: e.message });
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
  // runner.py sends progress callbacks with secret in body, final result in header
  const secret   = req.headers['x-sandbox-secret'] || (req.body as any)?.secret || '';

  if (secret !== EXPECTED) {
    console.warn(`[AgentRoute] job-callback: invalid secret for requestId=${req.params.requestId}`);
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { requestId } = req.params;
  const body = req.body as any;

  // ── 实时流式 transcript 上报（和工单系统相同机制）──────────────────────────
  if (body?.type === 'progress' || body?.type === 'transcript_step') {
    const stepEntry = body.entry || {
      type: 'event',
      event: body.event?.step || 'progress',
      detail: body.event?.detail || '',
      ts: body.event?.ts || new Date().toISOString(),
    };

    // 追加到 job_transcript JSON 数组（存在 agent_tasks 表）
    const taskRow = await db.getAsync<any>('SELECT job_transcript FROM agent_tasks WHERE id=?', [requestId]);
    let currentLog: any[] = [];
    if (taskRow?.job_transcript) {
      try { currentLog = JSON.parse(taskRow.job_transcript); } catch { currentLog = []; }
    }
    if (!stepEntry.id || !currentLog.some((e: any) => e.id === stepEntry.id)) {
      currentLog.push(stepEntry);
    }
    void updateAgentTask(requestId, { jobTranscript: JSON.stringify(currentLog) });

    return res.json({ ok: true, streamed: true });
  }

  // ── 最终结果回调 ──────────────────────────────────────────────────────────
  console.log(`[AgentRoute] job-callback received for requestId=${requestId}`);
  res.json({ ok: true });

  handleJobCallback(requestId, body).catch(err =>
    console.error(`[AgentRoute] job-callback forward error for ${requestId}:`, err)
  );
});

// ─── POST /api/v1/agent/cua-done/:requestId — CUA 执行完成后回传事件 ─────────────

agentRouter.post('/cua-done/:requestId', async (req, res) => {
  const EXPECTED = process.env.SANDBOX_SECRET || 'sandbox-secret-2024';
  const secret   = req.headers['x-sandbox-secret'];

  if (secret !== EXPECTED) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { requestId } = req.params;
  const body = req.body as any;

  res.json({ ok: true });

  try {
    const cuaEvents = body.cua_events || [];
    const deliveredAt = body.delivered_at || Date.now();
    const success = body.success !== false;

    // Store CUA events as cua_events column
    await updateAgentTask(requestId, {
      cuaEvents: JSON.stringify({
        events: cuaEvents,
        delivered_at: deliveredAt,
        success,
        recipient: body.recipient,
        app: body.app,
      }),
    } as any);

    // Also append a summary event to agent_task_events
    await appendTaskEvent(requestId, 'cua_delivered', {
      success,
      recipient: body.recipient,
      app: body.app || '企业微信',
      step_count: cuaEvents.length,
      delivered_at: deliveredAt,
      events_preview: cuaEvents.slice(0, 5).map((e: any) => ({
        type: e.type, phase: e.phase, text: (e.text || e.detail || e.content || '').slice(0, 80),
      })),
    });

    console.log(`[AgentRoute] cua-done: requestId=${requestId}, events=${cuaEvents.length}, success=${success}`);
  } catch (err: any) {
    console.error(`[AgentRoute] cua-done error for ${requestId}:`, err.message);
  }
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

// ─── Debug: 守卫状态查看 / 清理（仅供测试使用）────────────────────────────────

agentRouter.get('/debug/guards', async (req, res) => {
  try {
    const userId = req.query.user_id as string;
    if (!userId) return res.status(400).json({ error: 'user_id required' });
    // session_id = user_id for direct /chat requests (processMessage fallback)
    const guards = await db.allAsync<any>(
      `SELECT id, session_id, skill_id, skill_name, status, check_count, expires_at, created_at, close_reason
       FROM skill_confirm_guards
       WHERE session_id=?
       ORDER BY created_at DESC LIMIT 20`,
      [userId]
    );
    res.json({ guards, count: guards.length });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

agentRouter.delete('/debug/guards', async (req, res) => {
  try {
    const userId = req.query.user_id as string;
    if (!userId) return res.status(400).json({ error: 'user_id required' });
    const result = await db.runAsync(
      `UPDATE skill_confirm_guards SET status='closed', close_reason='debug_cleanup'
       WHERE session_id=? AND status='active'`,
      [userId]
    );
    const closed = (result as any).changes || 0;
    console.log(`[Debug] Closed ${closed} active guards for session=${userId}`);
    res.json({ ok: true, closed });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
