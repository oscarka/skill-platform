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
import { processAgentChat, handleJobCallback, saveAgentProfile, listAgentProfiles, deleteAgentProfile, updateAgentTask, appendTaskEvent, taskEventBus, reconcileStaleTasks, createAgentTask } from '../agentService';
import { enqueueDelivery, startDispatcherLoop } from '../dispatcherService';
import { processTicket } from '../aiProcessor';
import * as db from '../db';

export { startDispatcherLoop };  // 供 server.ts 在启动时调用


export const agentRouter = express.Router();

// ─── 渠道适配辅助 ─────────────────────────────────────────────────────────────

const CUA_SEND_URL  = process.env.CUA_SEND_URL  || '';  // Mac mini 发消息接口
const JUHE_SEND_URL = process.env.JUHE_SEND_URL || '';  // juhe-api /api/send 接口

// ── 渠道身份表查询 / 自动登记 ────────────────────────────────────────────
interface DeliveryRoute {
  channel:      string;    // 'juhe' | 'wecom' | 'feishu' | ...
  channel_uid:  string;
  conv_id:      string | null;
  display_name: string;
}

interface MergeCandidate {
  peer_channel:      string;
  peer_channel_uid:  string;
  peer_unified_id:   string;
  peer_display_name: string;
  peer_avatar:       string | null;
  name_match:        boolean;
  avatar_match:      boolean;
}

interface ChannelIdentity {
  unified_id:       string;
  display_name:     string;
  delivery_routes:  DeliveryRoute[];
  match_result?:    'auto_merged' | 'partial' | null;
  merge_candidate?: MergeCandidate | null;
}

async function resolveIdentity(
  channel: string,
  channel_uid: string,
  from_name: string,
  conversation_id: string,
  extra?: { unionid?: string | null; conv_id?: string | null; avatar?: string | null }
): Promise<ChannelIdentity> {
  const incomingUnionid = extra?.unionid || null;
  const incomingConvId  = extra?.conv_id  || conversation_id || null;
  const incomingAvatar  = extra?.avatar   || null;

  // ── 步骤 1：尝试按当前渠道 (channel, channel_uid) 查现有记录 ──
  let row = await db.getAsync<any>(
    `SELECT unified_id, display_name FROM skill_platform.channel_identities
     WHERE channel = $1 AND channel_uid = $2`,
    [channel, channel_uid]
  );

  let unified_id: string;
  let match_result: 'auto_merged' | 'partial' | null = null;
  let merge_candidate: MergeCandidate | null = null;

  if (row) {
    unified_id = row.unified_id;
    // 更新 conv_id / unionid / avatar
    await db.runAsync(
      `UPDATE skill_platform.channel_identities
       SET conv_id    = COALESCE($1, conv_id),
           unionid    = COALESCE($2, unionid),
           avatar     = COALESCE($3, avatar),
           updated_at = now()
       WHERE channel = $4 AND channel_uid = $5`,
      [incomingConvId || null, incomingUnionid, incomingAvatar, channel, channel_uid]
    ).catch(() => {});

    // ── 跨渠道匹配检测（三级策略）──
    if (incomingAvatar || from_name) {
      // 1) name + avatar 都匹配 → 自动合并
      if (incomingAvatar && from_name) {
        const exactPeer = await db.getAsync<any>(
          `SELECT unified_id, channel, channel_uid, display_name, avatar
           FROM skill_platform.channel_identities
           WHERE avatar = $1 AND display_name = $2
             AND channel != $3 AND unified_id != $4 LIMIT 1`,
          [incomingAvatar, from_name, channel, unified_id]
        );
        if (exactPeer) {
          const oldId = unified_id;
          unified_id = exactPeer.unified_id;
          await db.runAsync(
            `UPDATE skill_platform.channel_identities
             SET unified_id = $1, updated_at = now()
             WHERE unified_id = $2`,
            [unified_id, oldId]
          ).catch(() => {});
          match_result = 'auto_merged';
          console.log(`[Identity] ✅ 自动合并: ${oldId} → ${unified_id} (name=${from_name})`);
        }
      }

      // 2) 只匹配一项 → 记录候选，调用方负责发通知
      if (!match_result) {
        const namePeer = from_name ? await db.getAsync<any>(
          `SELECT unified_id, channel, channel_uid, display_name, avatar
           FROM skill_platform.channel_identities
           WHERE display_name = $1 AND channel != $2 AND unified_id != $3 LIMIT 1`,
          [from_name, channel, unified_id]
        ) : null;
        const avatarPeer = incomingAvatar ? await db.getAsync<any>(
          `SELECT unified_id, channel, channel_uid, display_name, avatar
           FROM skill_platform.channel_identities
           WHERE avatar = $1 AND channel != $2 AND unified_id != $3 LIMIT 1`,
          [incomingAvatar, channel, unified_id]
        ) : null;

        // 确保两个 peer 不是同一条记录（否则已被 exactPeer 处理）
        const peer = namePeer || avatarPeer;
        if (peer) {
          match_result = 'partial';
          merge_candidate = {
            peer_channel:      peer.channel,
            peer_channel_uid:  peer.channel_uid,
            peer_unified_id:   peer.unified_id,
            peer_display_name: peer.display_name,
            peer_avatar:       peer.avatar || null,
            name_match:        !!namePeer,
            avatar_match:      !!avatarPeer,
          };
        }
      }
    }
  } else {
    // ── 步骤 2：新客户 — 先按 unionid 查是否已有其他渠道的记录（跨渠道合并）
    if (incomingUnionid) {
      const existing = await db.getAsync<any>(
        `SELECT unified_id FROM skill_platform.channel_identities
         WHERE unionid = $1 LIMIT 1`,
        [incomingUnionid]
      );
      unified_id = existing?.unified_id || incomingUnionid;
    } else {
      unified_id = `${channel}_${channel_uid}`;
    }

    // INSERT 新行（ON CONFLICT 兜底，防止并发重复）
    await db.runAsync(
      `INSERT INTO skill_platform.channel_identities
         (unified_id, channel, channel_uid, display_name, conv_id, unionid, avatar, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,now(),now())
       ON CONFLICT (channel,channel_uid) DO UPDATE
         SET unified_id  = EXCLUDED.unified_id,
             conv_id     = COALESCE(EXCLUDED.conv_id,    skill_platform.channel_identities.conv_id),
             unionid     = COALESCE(EXCLUDED.unionid,    skill_platform.channel_identities.unionid),
             avatar      = COALESCE(EXCLUDED.avatar,     skill_platform.channel_identities.avatar),
             updated_at  = now()`,
      [unified_id, channel, channel_uid, from_name,
       incomingConvId || null, incomingUnionid, incomingAvatar]
    ).catch(() => {});

    console.log(`[Identity] 新客户注册: channel=${channel} uid=${channel_uid} unified=${unified_id}`);
  }

  // ── 步骤 3：查出该 unified_id 下所有渠道的出站句柄（delivery_routes）──
  const allRows = await db.allAsync<any>(
    `SELECT channel, channel_uid, conv_id, display_name
     FROM skill_platform.channel_identities
     WHERE unified_id = $1`,
    [unified_id]
  );

  const delivery_routes: DeliveryRoute[] = (allRows || []).map((r: any) => ({
    channel:      r.channel,
    channel_uid:  r.channel_uid,
    conv_id:      r.conv_id || null,
    display_name: r.display_name || from_name,
  }));

  const display_name = allRows?.[0]?.display_name || from_name;

  return { unified_id, display_name, delivery_routes, match_result, merge_candidate };
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

    // 身份统一：查 channel_identities，新客户自动注册，带 unionid 时自动跨渠道合并
    const identity       = await resolveIdentity(channel, from_user_id, from_name || from_user_id, sessionId, {
      unionid: req.body.unionid || null,
      conv_id: conversation_id || null,
      avatar:  req.body.avatar  || null,
    });
    const unified_id      = identity.unified_id;
    const display_name    = identity.display_name;
    const delivery_routes = identity.delivery_routes;
    // 向后兼容：从 routes 中找 juhe 的 conv_id（sendReply 和 dispatcherService 都会用）
    const juhe_conv_id    = delivery_routes.find((r: DeliveryRoute) => r.channel === 'juhe')?.conv_id || null;

    // ── 附件暂存：记录用户最近24小时上传的文件 ──────────────────────────────
    const attachments = Array.isArray(req.body.attachments) ? req.body.attachments : [];
    const media_url   = req.body.media_url || null;
    const file_name   = req.body.file_name || '';
    const file_type   = req.body.file_type || (msgtype === 'image' ? 'image' : 'file');

    const filesToSave = attachments.length > 0
      ? attachments.map((a: any) => ({
          fileUrl:  a.fileUrl || a.mediaUrl,
          fileName: a.fileName || a.name || '未命名附件',
          fileType: a.msgtype || a.fileType || 'file',
          summary:  a.summary || a.extractedText || '',
        })).filter((a: any) => a.fileUrl)
      : (media_url ? [{ fileUrl: media_url, fileName: file_name || '未命名附件', fileType: file_type, summary: content }] : []);

    if (filesToSave.length > 0) {
      const now = Date.now();
      for (const f of filesToSave) {
        const fileId = uuidv4();
        try {
          await db.runAsync(
            `INSERT INTO user_recent_files (id, user_id, file_url, file_name, file_type, summary, content_hash, created_at)
             VALUES (?,?,?,?,?,?,NULL,?)`,
            [fileId, unified_id, f.fileUrl, f.fileName, f.fileType, (f.summary || '').slice(0, 2000), now]
          );
          console.log(`[Orch/Ingest] 📎 保存用户 ${unified_id} 最近24小时附件: ${f.fileName} (${f.fileUrl})`);

          // ── 异步计算文件内容 MD5，用于真正的内容去重 ──────────────────────────
          // 不阻塞 ingest 响应，后台下载计算
          (async () => {
            try {
              const https = await import('https');
              const http  = await import('http');
              const crypto = await import('crypto');
              const fetchModule = f.fileUrl.startsWith('https') ? https : http;
              const hash = crypto.createHash('md5');
              await new Promise<void>((resolve, reject) => {
                fetchModule.get(f.fileUrl, (resp) => {
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
              console.log(`[Orch/Ingest] 🔑 MD5 计算完成 file=${f.fileName} hash=${md5.slice(0,8)}…`);
            } catch (hashErr: any) {
              console.warn(`[Orch/Ingest] ⚠️ MD5 计算失败 file=${f.fileName}: ${hashErr.message}`);
              // 失败不影响功能，content_hash 保持 NULL，回退到文件名去重
            }
          })();

        } catch (err: any) {
          console.warn(`[Orch/Ingest] 保存附件失败:`, err.message);
        }
      }
      const cutoff24h = now - 24 * 60 * 60 * 1000;
      await db.runAsync(`DELETE FROM user_recent_files WHERE created_at < ?`, [cutoff24h]).catch(() => {});

      // ── 检查该用户是否有处于 waiting_input 的待填写工单 ──────────────────────
      // 附件到达时只做"预填更新"，不改工单状态、不触发 AI 执行
      const recentWaitingTicket = await db.getAsync<any>(
        `SELECT * FROM tickets WHERE created_by=? AND status='waiting_input' AND created_at > ? ORDER BY created_at DESC LIMIT 1`,
        [unified_id, now - 30 * 60 * 1000]
      );

      if (recentWaitingTicket && filesToSave.some((f: any) => f.summary)) {
        // ① 更新 notes（追加 OCR 摘要）
        const ocrItems = filesToSave.filter((f: any) => f.summary).map((f: any) => `【附件: ${f.fileName}】\n${f.summary}`);
        const newNotesPart = ocrItems.join('\n\n');
        const updatedNotes = recentWaitingTicket.notes
          ? `${recentWaitingTicket.notes}\n\n${newNotesPart}`
          : newNotesPart;

        // ② 写入 ticket_inputs（文件记录）
        for (const f of filesToSave) {
          await db.runAsync(
            `INSERT INTO ticket_inputs (id, ticket_id, field_key, field_type, file_path, file_name, mime_type, created_at)
             VALUES (?,?,?,?,?,?,?,?)`,
            [uuidv4(), recentWaitingTicket.id, 'file', 'file', f.fileUrl, f.fileName, f.fileType === 'image' ? 'image/jpeg' : 'application/pdf', now]
          );
        }

        // ③ 从 OCR 摘要中提取报告上的患者姓名、年龄、性别
        const allSummaryText = filesToSave.map((f: any) => f.summary || '').join('\n');
        const reportNameMatch = allSummaryText.match(/(?:姓\s*名|患者|病人|受检者|体检人)[：:\s]*([^\s,，;；\n]{2,5})/);
        const reportAgeMatch  = allSummaryText.match(/(?:年\s*龄|Age)[：:\s]*(\d{1,3})\s*(?:岁|歲|years?)?/i);
        const reportGenderMatch = allSummaryText.match(/(?:性\s*别|Sex|Gender)[：:\s]*(男|女|Male|Female)/i);
        const reportName   = reportNameMatch ? reportNameMatch[1].trim() : '';
        const reportAge    = reportAgeMatch ? reportAgeMatch[1] : '';
        const reportGender = reportGenderMatch ? reportGenderMatch[1] : '';

        // ④ 判断本人/代问：比对报告上的姓名和工单当前的 patient_name
        const ticketPatientName = (recentWaitingTicket.patient_name || '').trim();
        const isSamePatient = !reportName || reportName === ticketPatientName
          || ticketPatientName.includes(reportName) || reportName.includes(ticketPatientName);

        // ⑤ 智能更新 prefilled_values
        let existingPrefilled: Record<string, any> = {};
        try { if (recentWaitingTicket.prefilled_values) existingPrefilled = JSON.parse(recentWaitingTicket.prefilled_values); } catch { /* ignore */ }

        // 更新附件列表（带去重：按 URL 和文件名去重）
        const existingFiles = existingPrefilled.prefilled_files || [];
        const newFiles = filesToSave.map((f: any) => ({
          name: f.fileName || '附件',
          url: f.fileUrl,
          type: f.fileType || 'file',
          summary: f.summary || '',
        }));
        // 去重：已有的 URL 集合 + 已有的文件名集合
        const existingUrls = new Set(existingFiles.map((f: any) => f.url));
        const existingNames = new Set(existingFiles.map((f: any) => (f.name || '').toLowerCase()));
        const dedupedNew = newFiles.filter((f: any) => {
          const url = f.url || '';
          const name = (f.name || '').toLowerCase();
          // 同 URL 或同文件名的都跳过
          if (existingUrls.has(url)) return false;
          if (name && existingNames.has(name)) return false;
          existingUrls.add(url);
          existingNames.add(name);
          return true;
        });
        existingPrefilled.prefilled_files = [...existingFiles, ...dedupedNew];

        if (isSamePatient) {
          // 本人：补充缺失字段
          if (reportAge && !existingPrefilled.patient_age) existingPrefilled.patient_age = reportAge;
          if (reportGender && !existingPrefilled.gender) existingPrefilled.gender = reportGender;
        } else {
          // 代问：标记不是本人，填入报告上的患者信息
          existingPrefilled.default_is_self = false;
          existingPrefilled.report_patient_name = reportName;
          if (reportAge) existingPrefilled.report_patient_age = reportAge;
          if (reportGender) existingPrefilled.report_patient_gender = reportGender;
          console.log(`[Orch/Ingest] 👥 代问检测：工单患者=${ticketPatientName}，报告患者=${reportName}，default_is_self=false`);
        }

        // ── OCR 智能预填：报告类型 + 补充信息（与 agentService 保持一致）────────
        const allIngestSummary = existingPrefilled.prefilled_files.map((f: any) => f.summary || '').join('\n');
        if (allIngestSummary) {
          if (!existingPrefilled.reportType) {
            if (/检验|化验|血常规|尿常规|生化|血液/.test(allIngestSummary)) {
              existingPrefilled.reportType = '检验报告';
            } else if (/影像|CT|MRI|X[光线]|超声|B超|彩超|胸片|磁共振/.test(allIngestSummary)) {
              existingPrefilled.reportType = '影像报告';
            } else if (/体检|健康检查|体格检查/.test(allIngestSummary)) {
              existingPrefilled.reportType = '体检报告';
            } else {
              existingPrefilled.reportType = '其他';
            }
          }
          if (!existingPrefilled.extraInfo) {
            const ocrExtracts = existingPrefilled.prefilled_files
              .filter((f: any) => f.summary)
              .map((f: any) => {
                let text = f.summary;
                const innerMatch = text.match(/\[图片内容[：:]\s*([\s\S]*)\]/);
                if (innerMatch) text = innerMatch[1];
                return text.trim();
              })
              .filter(Boolean);
            if (ocrExtracts.length > 0) {
              existingPrefilled.extraInfo = ocrExtracts.join('\n\n').slice(0, 2000);
            }
          }
        }

        const updatedPrefilledJson = JSON.stringify(existingPrefilled);

        // ⑥ 只更新 notes + prefilled_values，不改 status
        await db.runAsync(
          `UPDATE tickets SET notes=?, prefilled_values=?, updated_at=? WHERE id=?`,
          [updatedNotes, updatedPrefilledJson, now, recentWaitingTicket.id]
        );

        console.log(`[Orch/Ingest] 📋 工单 ${recentWaitingTicket.id} 预填更新完成（状态保持 waiting_input），isSamePatient=${isSamePatient}，reportName=${reportName || '(未提取到)'}，files=${existingPrefilled.prefilled_files.length}`);
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
        agent_id:   req.body.agent_id || process.env.ACTIVE_AGENT_ID || 'default',
        meta: {
          from_name:       display_name,
          user_id:         unified_id,
          unionid:         req.body.unionid || null,
          channel_uid:     from_user_id,
          juhe_conv_id:    juhe_conv_id || '',
          delivery_routes: delivery_routes,
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
          // 出站持久化入队（<5ms），实际发送由 Dispatcher 后台异步处理
          await enqueueDelivery({
            taskId:     result.request_id || '',
            customerId: unified_id,
            reply:      result.reply,
            routes:     delivery_routes,
            requestId:  result.request_id || '',
            sessionId:  unified_id,
            status:     result.status,
            reasoning:  result.reasoning,
            delivery:   result.delivery,
          }).catch(e => console.warn('[Orch/Ingest] enqueueDelivery error:', e.message));
          console.log(`[Orch/Ingest] ⏱️ process=${processMs}ms enqueue=${Date.now() - t0Send}ms`);
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

/**
 * POST /api/orch/identity-sync
 * 轻量接口：juhe-api / 其他渠道上报身份信息，不触发 Agent。
 * 用于同步 conv_id、unionid、avatar 到 channel_identities，并检测跨渠道匹配。
 */
agentRouter.post('/identity-sync', async (req, res) => {
  try {
    const { channel, channel_uid, conv_id, display_name, unionid, avatar } = req.body;
    if (!channel || !channel_uid) {
      return res.status(400).json({ error: 'channel and channel_uid are required' });
    }
    const result = await resolveIdentity(
      channel, channel_uid,
      display_name || channel_uid,
      conv_id || '',
      { unionid: unionid || null, conv_id: conv_id || null, avatar: avatar || null }
    );
    res.json({
      ok: true, channel, channel_uid,
      unified_id:      result.unified_id,
      match_result:    result.match_result    || null,
      merge_candidate: result.merge_candidate || null,
    });
  } catch (err: any) {
    console.error('[IdentitySync] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/orch/identity-merge
 * 管理员手动确认合并两个 unified_id。
 */
agentRouter.post('/identity-merge', async (req, res) => {
  try {
    const { unified_id_from, unified_id_to } = req.body;
    if (!unified_id_from || !unified_id_to) {
      return res.status(400).json({ error: 'unified_id_from and unified_id_to are required' });
    }
    await db.runAsync(
      `UPDATE skill_platform.channel_identities
       SET unified_id = $1, updated_at = now()
       WHERE unified_id = $2`,
      [unified_id_to, unified_id_from]
    );
    console.log(`[Identity] 手动合并: ${unified_id_from} → ${unified_id_to}`);
    res.json({ ok: true, merged_from: unified_id_from, merged_to: unified_id_to });
  } catch (err: any) {
    console.error('[IdentityMerge] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});



agentRouter.get('/tasks', async (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  try {
    // 自动收敛超过 1 小时的僵尸任务（对应已完成工单的自动同步，超时的自动标记超时）
    await reconcileStaleTasks(60 * 60 * 1000);

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

// ─── PATCH /api/v1/agent/tasks/:id — 更新任务状态 ───────────────────────────

agentRouter.patch('/tasks/:id', async (req, res) => {
  try {
    const taskId = req.params.id;
    const { status, errorMessage } = req.body;
    if (!status) return res.status(400).json({ error: 'status is required' });
    await updateAgentTask(taskId, {
      status,
      errorMessage,
      endedAt: (status === 'done' || status === 'failed' || status === 'error') ? Date.now() : undefined,
    });
    res.json({ ok: true, taskId, status });
  } catch (err: any) {
    console.error('[AgentRoute] PATCH /tasks/:id error:', err.message);
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

const safeParseJson = (v: any, fallback: any) => {
  if (!v) return fallback;
  try { return JSON.parse(v); } catch { return fallback; }
};

agentRouter.get('/profile', async (_req, res) => {
  try {
    const activeId = process.env.ACTIVE_AGENT_ID || 'default';
    const row = await db.getAsync<any>('SELECT * FROM agent_profiles WHERE id = ?', [activeId]);
    if (!row) {
      // 返回默认 profile（原始内容，一字未改，仅追加新字段）
      return res.json({
        id:               activeId,
        name:             '服务助理',
        role_desc:        '专业健康顾问助理，协助客户了解检查报告和日常健康管理',
        reply_style:      '亲切、专业，回复简洁不超过200字',
        service_flow:     '1. 判断是否为健康相关问题\n2. 健康问题优先调用对应 skill 深度分析\n3. 非健康问题礼貌回复并适当引导',
        taboos:           ['不诊断疾病', '不推荐具体药物品牌', '不承诺治疗效果'],
        reassurance_mode: 'ai',
        reassurance_tpl:  '',
        skill_mode:       'auto',
        skill_ids:        [],
        routing_examples: null,   // 新增：null = 使用原始提示词（不影响现有行为）
        knowledge_config: null,   // 新增：null = 使用原有 WIKI 逻辑
      });
    }
    res.json({
      ...row,
      taboos:           safeParseJson(row.taboos, []),
      skill_ids:        safeParseJson(row.skill_ids, []),
      routing_examples: safeParseJson(row.routing_examples, null),
      knowledge_config: safeParseJson(row.knowledge_config, null),
    });
  } catch (err: any) {
    console.error('[AgentRoute] GET /profile error:', err.message);
    res.status(500).json({ error: 'db_error', message: err.message });
  }
});

// ─── PUT /api/v1/agent/profile ────────────────────────────────────────────────

agentRouter.put('/profile', async (req, res) => {
  try {
    const activeId = process.env.ACTIVE_AGENT_ID || 'default';
    const profile = await saveAgentProfile(req.body, activeId);
    console.log(`[AgentRoute] Profile saved (${activeId}): skill_mode=${profile.skill_mode}`);
    res.json(profile);
  } catch (err: any) {
    console.error('[AgentRoute] PUT /profile error:', err.message);
    res.status(500).json({ error: 'db_error', message: err.message });
  }
});

// ─── Multi-Agent 实例管理 API ─────────────────────────────────────────────────
// GET    /api/v1/agent/profiles          — 列表所有 Agent 实例
// POST   /api/v1/agent/profiles          — 新建 Agent 实例
// GET    /api/v1/agent/profiles/:id      — 读取某个 Agent 配置
// PUT    /api/v1/agent/profiles/:id      — 更新某个 Agent 配置
// DELETE /api/v1/agent/profiles/:id      — 删除某个 Agent 实例

agentRouter.get('/profiles', async (_req, res) => {
  try {
    const profiles = await listAgentProfiles();
    res.json(profiles);
  } catch (err: any) {
    res.status(500).json({ error: 'db_error', message: err.message });
  }
});

agentRouter.post('/profiles', async (req, res) => {
  try {
    const { id, ...data } = req.body;
    if (!id) return res.status(400).json({ error: 'id is required' });
    const profile = await saveAgentProfile(data, id);
    res.status(201).json(profile);
  } catch (err: any) {
    res.status(500).json({ error: 'db_error', message: err.message });
  }
});

agentRouter.get('/profiles/:id', async (req, res) => {
  try {
    const row = await db.getAsync<any>(
      'SELECT * FROM agent_profiles WHERE id = ?', [req.params.id]
    );
    if (!row) return res.status(404).json({ error: 'not_found' });
    res.json({
      ...row,
      taboos:           safeParseJson(row.taboos, []),
      skill_ids:        safeParseJson(row.skill_ids, []),
      routing_examples: safeParseJson(row.routing_examples, null),
      knowledge_config: safeParseJson(row.knowledge_config, null),
    });
  } catch (err: any) {
    res.status(500).json({ error: 'db_error', message: err.message });
  }
});

agentRouter.put('/profiles/:id', async (req, res) => {
  try {
    const profile = await saveAgentProfile(req.body, req.params.id);
    res.json(profile);
  } catch (err: any) {
    res.status(500).json({ error: 'db_error', message: err.message });
  }
});

agentRouter.delete('/profiles/:id', async (req, res) => {
  try {
    const ok = await deleteAgentProfile(req.params.id);
    if (!ok) return res.status(403).json({ error: 'cannot_delete_default' });
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: 'db_error', message: err.message });
  }
});


// ─── GET /api/v1/agent/skills/available ────────────────────────────────────────

agentRouter.get('/skills/available', async (_req, res) => {
  try {
    // 只返回有 "agent版" 标签的已发布 skill
    // tags 存储为 JSON 数组字符串，如 '["agent版"]'
    const skills = await db.allAsync<any>(
      `SELECT id, name, description, category, tags FROM skills
       WHERE status = 'published'
         AND tags IS NOT NULL
         AND tags LIKE '%agent版%'
       ORDER BY name`,
      []
    );
    res.json(skills.map((s: any) => ({
      ...s,
      tags: s.tags ? JSON.parse(s.tags) : [],
    })));
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
