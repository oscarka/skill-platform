import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import * as db from '../db';
import { processTicket } from '../aiProcessor';
import { createAgentTask, updateAgentTask, appendTaskEvent, writeWikiLog } from '../agentService';

const LLMWIKI_BASE = process.env.LLMWIKI_BASE || '';

export const h5Router = express.Router();

const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, '..', '..', '..', 'uploads', 'files'));
try { if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true }); } catch { /* Cloud Run read-only FS */ }

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['application/pdf', 'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'text/plain'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error(`File type not allowed: ${file.mimetype}`));
  },
});

/**
 * GET /api/h5/:token
 * Used by H5 page to fetch form config.
 */
h5Router.get('/:token', async (req, res) => {
  try {
    const ticket = await db.getAsync<any>('SELECT * FROM tickets WHERE token=?', [req.params.token]);
    if (!ticket) return res.status(404).json({ error: 'Invalid link', code: 'NOT_FOUND' });

    if (Date.now() > ticket.expires_at && ticket.status === 'waiting_input')
      return res.status(410).json({ error: 'This link has expired. Please contact the staff.', code: 'EXPIRED' });

    if (ticket.status === 'submitted' || ticket.status === 'processing' || ticket.status === 'done')
      return res.json({ already_submitted: true, status: ticket.status, message: '您已成功提交，AI 正在处理或已完成，请耐心等待工作人员反馈。' });

    if (ticket.status === 'created') {
      await db.runAsync(`UPDATE tickets SET status='waiting_input', updated_at=? WHERE id=?`, [Date.now(), ticket.id]);
    }

    const skill = await db.getAsync<any>('SELECT name, h5_config FROM skills WHERE id=?', [ticket.skill_id]);
    const h5Config = skill?.h5_config ? JSON.parse(skill.h5_config) : null;

    // 从 llmwiki 获取用户已有档案，供前端预填
    let wikiPrefill: Record<string, string> = {};
    if (ticket.created_by && LLMWIKI_BASE) {
      try {
        const profileRes = await fetch(`${LLMWIKI_BASE}/api/clients/${ticket.created_by}/profile-fields`);
        if (profileRes.ok) {
          const profileData = await profileRes.json() as { fields?: Record<string, string> };
          wikiPrefill = profileData.fields || {};
        }
      } catch { /* wiki 不可用时静默跳过 */ }
    }

    res.json({
      ticket_id: ticket.id,
      status: ticket.status === 'created' ? 'waiting_input' : ticket.status,
      return_reason: ticket.return_reason,
      skill_name: skill?.name,
      h5_config: h5Config,
      expires_at: ticket.expires_at,
      wiki_prefill: Object.keys(wikiPrefill).length > 0 ? wikiPrefill : null,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/h5/:token/submit
 * Creates a NEW independent agent_task for the processing phase,
 * so it appears as a separate entry in AgentLogs left list.
 */
h5Router.post('/:token/submit', upload.array('files', 10), async (req, res) => {
  try {
    const ticket = await db.getAsync<any>('SELECT * FROM tickets WHERE token=?', [req.params.token]);
    if (!ticket) return res.status(404).json({ error: 'Invalid link' });

    if (ticket.status === 'submitted' || ticket.status === 'done')
      return res.status(400).json({ error: '您已提交过，无法再次修改。如需补充请联系工作人员。' });

    if (Date.now() > ticket.expires_at)
      return res.status(410).json({ error: '链接已过期，请联系工作人员重新发送。' });

    const now = Date.now();

    // Parse text fields
    let fields: Record<string, string> = {};
    try {
      fields = req.body.fields ? JSON.parse(req.body.fields) : req.body;
    } catch {
      fields = req.body || {};
    }

    // Delete old inputs if resubmitting after return
    await db.runAsync('DELETE FROM ticket_inputs WHERE ticket_id=?', [ticket.id]);

    // Save text fields
    for (const [key, value] of Object.entries(fields)) {
      if (key === 'fields') continue;
      const strValue = (value === null || value === undefined)
        ? ''
        : (typeof value === 'object' ? JSON.stringify(value) : String(value));
      await db.runAsync(
        `INSERT INTO ticket_inputs (id, ticket_id, field_key, field_type, value, created_at) VALUES (?,?,?,?,?,?)`,
        [uuidv4(), ticket.id, key, 'text', strValue, now]
      );
    }

    // Save uploaded files
    const files = (req.files as Express.Multer.File[]) || [];
    for (const file of files) {
      let fileName = file.originalname;
      try { fileName = Buffer.from(file.originalname, 'latin1').toString('utf8'); }
      catch { /* keep original */ }
      await db.runAsync(
        `INSERT INTO ticket_inputs (id, ticket_id, field_key, field_type, file_path, file_name, mime_type, created_at) VALUES (?,?,?,?,?,?,?,?)`,
        [uuidv4(), ticket.id, 'file', 'file', file.path, fileName, file.mimetype, now]
      );
    }

    // Update ticket status
    await db.runAsync(
      `UPDATE tickets SET status='submitted', h5_submitted_at=?, updated_at=? WHERE id=?`,
      [now, now, ticket.id]
    );

    // ─── 创建独立处理任务（左侧列表独立显示，状态 processing → done）───────────────
    const skill = await db.getAsync<any>('SELECT name, id FROM skills WHERE id=?', [ticket.skill_id]);
    const skillName = skill?.name || '技能';
    const fieldKeys = Object.keys(fields).filter(k => k !== 'fields');
    const processingTaskId = `req_h5_${ticket.id.slice(0, 8)}_${now}`;

    await createAgentTask({
      id: processingTaskId,
      sessionId: `h5_${ticket.id}`,
      userId: ticket.created_by || 'unknown',
      sourceChannel: 'wechat',
      inputContent: `[表单提交] ${skillName} — ${ticket.patient_name || '用户'} 提交了 ${fieldKeys.length} 个字段`,
      meta: { ticketId: ticket.id, skillName, patientName: ticket.patient_name, fromH5: true },
    });

    await updateAgentTask(processingTaskId, {
      status: 'processing',
      routeType: 'ticket_processing',
      skillId: ticket.skill_id,
    });

    // 从 ticket_inputs 读取字段值（最准确，直接来自 DB 已保存的数据）
    const savedInputs = await db.allAsync<any>(
      `SELECT field_key, value FROM ticket_inputs WHERE ticket_id=? AND field_type='text' LIMIT 20`,
      [ticket.id]
    );
    const fieldValues: Record<string, string> = {};
    for (const row of savedInputs) {
      fieldValues[row.field_key] = (row.value || '').slice(0, 200);
    }

    await appendTaskEvent(processingTaskId, 'ticket_submitted', {
      ticketId:    ticket.id,
      skillName,
      fieldCount:  savedInputs.length + files.length,
      fileCount:   files.length,
      fieldKeys:   savedInputs.map((r: any) => r.field_key),
      fieldValues,          // ← 从 DB 读取的 key→value 对，前端展开后可查看
      submittedAt: new Date(now).toISOString(),
      patientName: ticket.patient_name || '',
    });

    // ── 将问卷字段写入 llmwiki，作为患者档案来源之一 ────────────────────
    if (ticket.created_by && LLMWIKI_BASE && savedInputs.length > 0) {
      try {
        const skill2 = skill || await db.getAsync<any>('SELECT name, h5_config FROM skills WHERE id=?', [ticket.skill_id]);
        const h5Cfg = skill2?.h5_config ? JSON.parse(skill2.h5_config) : null;
        const fieldDefs: Record<string, string> = {};
        for (const f of (h5Cfg?.fields || [])) fieldDefs[f.key] = f.label || f.key;

        const filledBy = savedInputs.find((r: any) => r.field_key === 'filled_by')?.value || '未指定';
        const logLines = [`[${skillName}健康问卷 — ${filledBy}]`];
        for (const row of savedInputs) {
          if (row.field_key === 'filled_by') continue;
          const label = fieldDefs[row.field_key] || row.field_key;
          logLines.push(`- ${label}：${row.value || '（未填）'}`);
        }
        const logContent = logLines.join('\n');
        void writeWikiLog(ticket.created_by, logContent, 'intake_form', `${skillName}问卷提交`).catch(() => {});
        console.log(`[H5→Wiki] 问卷字段已写入 wiki userId=${ticket.created_by} fields=${savedInputs.length}`);
      } catch (e: any) {
        console.warn('[H5→Wiki] 写入 wiki 失败（不影响主流程）:', e.message);
      }
    }

    // 把 ticket.request_id 指向这个新 task，后续进度/完成事件都写这里
    await db.runAsync(`UPDATE tickets SET request_id=?, updated_at=? WHERE id=?`, [processingTaskId, now, ticket.id]);

    console.log(`[H5] Ticket ${ticket.id} submitted — processingTask=${processingTaskId}`);

    // ✅ 异步触发 AI（非阻塞）
    processTicket(ticket.id, processingTaskId).catch(err => {
      console.error(`[H5→AI] Ticket ${ticket.id} AI failed:`, err.message);
      void updateAgentTask(processingTaskId, { status: 'error', errorMessage: err.message, endedAt: Date.now() });
    });

    res.json({ success: true, message: '提交成功！AI 正在为您处理，结果将由工作人员反馈给您。' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
