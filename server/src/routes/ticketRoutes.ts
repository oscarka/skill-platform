import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import * as db from '../db';
import { notifyUserTicketDone } from '../aiProcessor';

// Multer for ticket input file replacement
const UPLOADS_DIR = path.resolve(__dirname, '..', '..', '..', 'uploads', 'inputs');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
const inputUpload = multer({ dest: UPLOADS_DIR, limits: { fileSize: 30 * 1024 * 1024 } });


export const ticketRouter = express.Router();

const EXPIRY_DAYS = async () => {
  const row = await db.getAsync<{ value: string }>('SELECT value FROM settings WHERE key=?', ['ticket_expiry_days']);
  return parseInt(row?.value || '3', 10);
};

export interface TicketRecord {
  id: string;
  skill_id: string;
  token: string;
  title?: string;
  patient_name?: string;
  patient_phone?: string;
  notes?: string;
  created_by?: string;
  status: 'created' | 'waiting_input' | 'submitted' | 'processing' | 'done' | 'returned' | 'expired' | 'error';
  return_reason?: string;
  return_count: number;
  h5_submitted_at?: number;
  ai_started_at?: number;
  ai_completed_at?: number;
  expires_at: number;
  created_at: number;
  updated_at: number;
}

const STATUS_LABEL: Record<string, string> = {
  created: '待发送', waiting_input: '等待提交', submitted: '已提交',
  processing: 'AI 处理中', done: '已完成', returned: '已打回',
  expired: '已过期', error: '处理出错',
};

async function h5BaseUrl(): Promise<string> {
  const row = await db.getAsync<{ value: string }>('SELECT value FROM settings WHERE key=?', ['h5_base_url']);
  return row?.value || `http://localhost:3100/h5`;
}

async function ticketToResponse(t: TicketRecord, skill?: any) {
  return {
    id: t.id,
    skill_id: t.skill_id,
    skill_name: skill?.name,
    token: t.token,
    title: t.title,
    patient_name: t.patient_name,
    patient_phone: t.patient_phone,
    notes: t.notes,
    created_by: t.created_by,
    status: t.status,
    status_label: STATUS_LABEL[t.status] || t.status,
    return_reason: t.return_reason,
    return_count: t.return_count,
    h5_url: `${await h5BaseUrl()}?token=${t.token}`,
    h5_submitted_at: t.h5_submitted_at,
    ai_started_at: t.ai_started_at,
    ai_completed_at: t.ai_completed_at,
    expires_at: t.expires_at,
    created_at: t.created_at,
    updated_at: t.updated_at,
  };
}

// ─── POST /api/tickets — Create ticket ────────────────────────────────────────
ticketRouter.post('/', async (req, res) => {
  try {
    const { skill_id, title, patient_name, patient_phone, notes, created_by } = req.body;
    if (!skill_id) return res.status(400).json({ error: '"skill_id" is required' });

    const skill = await db.getAsync<any>('SELECT * FROM skills WHERE id=?', [skill_id]);
    if (!skill) return res.status(404).json({ error: 'Skill not found' });
    if (skill.status !== 'published')
      return res.status(400).json({ error: 'Skill must be published before creating tickets' });
    if (skill.type !== 'external')
      return res.status(400).json({ error: 'Tickets can only be created for external skills' });

    const id = uuidv4();
    const token = uuidv4().replace(/-/g, '');
    const now = Date.now();
    const expiresAt = (now + (await EXPIRY_DAYS()) * 24 * 60 * 60 * 1000);

    await db.runAsync(
      `INSERT INTO tickets
        (id, skill_id, token, title, patient_name, patient_phone, notes,
         created_by, status, return_count, expires_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, skill_id, token,
       title || `${skill.name} — ${new Date(now).toLocaleDateString('zh-CN')}`,
       patient_name || null, patient_phone || null, notes || null,
       created_by || null, 'created', 0, expiresAt, now, now]
    );

    const ticket = await db.getAsync<TicketRecord>('SELECT * FROM tickets WHERE id=?', [id]);
    res.status(201).json({ ticket: await ticketToResponse(ticket!, skill) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/tickets — List tickets ──────────────────────────────────────────
ticketRouter.get('/', async (req, res) => {
  try {
    const { status, skill_id, q } = req.query as Record<string, string>;
    let sql = `SELECT t.*, s.name as skill_name FROM tickets t
               LEFT JOIN skills s ON t.skill_id = s.id WHERE 1=1`;
    const params: any[] = [];
    if (status) { sql += ' AND t.status=?'; params.push(status); }
    if (skill_id) { sql += ' AND t.skill_id=?'; params.push(skill_id); }
    if (q) { sql += ' AND (t.title LIKE ? OR t.patient_name LIKE ? OR t.token LIKE ?)'; params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
    sql += ' ORDER BY t.created_at DESC LIMIT 100';

    const rows = await db.allAsync<any>(sql, params);
    const base = await h5BaseUrl();
    const tickets = await Promise.all(rows.map(async t => ({
      ...(await ticketToResponse(t)),
      skill_name: t.skill_name,
      h5_url: `${base}?token=${t.token}`,
    })));
    res.json({ tickets });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/tickets/:id — Ticket detail ─────────────────────────────────────
ticketRouter.get('/:id', async (req, res) => {
  try {
    const ticket = await db.getAsync<TicketRecord>('SELECT * FROM tickets WHERE id=?', [req.params.id]);
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    const skill = await db.getAsync<any>('SELECT * FROM skills WHERE id=?', [ticket.skill_id]);
    const inputs = await db.allAsync<any>('SELECT * FROM ticket_inputs WHERE ticket_id=? ORDER BY created_at', [ticket.id]);
    const result = await db.getAsync<any>('SELECT * FROM ticket_results WHERE ticket_id=?', [ticket.id]);
    res.json({
      ticket: await ticketToResponse(ticket, skill),
      skill: skill ? { id: skill.id, name: skill.name, type: skill.type, h5_config: skill.h5_config ? JSON.parse(skill.h5_config) : null } : null,
      inputs,
      result,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/tickets/token/:token — Get by token (H5 uses this) ──────────────
ticketRouter.get('/token/:token', async (req, res) => {
  try {
    const ticket = await db.getAsync<TicketRecord>('SELECT * FROM tickets WHERE token=?', [req.params.token]);
    if (!ticket) return res.status(404).json({ error: 'Invalid or expired link' });
    if (Date.now() > ticket.expires_at && ticket.status !== 'submitted' && ticket.status !== 'done')
      return res.status(410).json({ error: 'Link has expired', expired: true });
    const skill = await db.getAsync<any>('SELECT id, name, type, h5_config FROM skills WHERE id=?', [ticket.skill_id]);
    res.json({
      ticket: { id: ticket.id, status: ticket.status, expires_at: ticket.expires_at, return_reason: ticket.return_reason },
      skill: skill ? { id: skill.id, name: skill.name, h5_config: skill.h5_config ? JSON.parse(skill.h5_config) : null } : null,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PUT /api/tickets/:id/return — Return ticket to client ────────────────────
ticketRouter.put('/:id/return', async (req, res) => {
  try {
    const { reason } = req.body;
    const ticket = await db.getAsync<TicketRecord>('SELECT * FROM tickets WHERE id=?', [req.params.id]);
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

    const now = Date.now();
    const newExpiry = (now + (await EXPIRY_DAYS()) * 24 * 60 * 60 * 1000);
    await db.runAsync(
      `UPDATE tickets SET status='returned', return_reason=?, return_count=return_count+1,
       expires_at=?, updated_at=? WHERE id=?`,
      [reason || '请补充信息后重新提交', newExpiry, now, ticket.id]
    );
    const updated = await db.getAsync<TicketRecord>('SELECT * FROM tickets WHERE id=?', [ticket.id]);
    res.json({ ticket: await ticketToResponse(updated!) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/tickets/:id/status — Poll status ────────────────────────────────
ticketRouter.get('/:id/status', async (req, res) => {
  try {
    const ticket = await db.getAsync<{ status: string; updated_at: number }>('SELECT status, updated_at FROM tickets WHERE id=?', [req.params.id]);
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    res.json({ status: ticket.status, status_label: STATUS_LABEL[ticket.status], updated_at: ticket.updated_at });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/tickets/:id/agent-callback — Cloud Run Job result for plugin skills ──
// runner.py calls this when Agent finishes (same format as sandbox-callback in skillRoutes)
ticketRouter.post('/:id/agent-callback', async (req, res) => {
  try {
    const EXPECTED_SECRET = process.env.SANDBOX_SECRET || 'sandbox-secret-2024';
    const secret = req.headers['x-sandbox-secret'];
    if (secret !== EXPECTED_SECRET) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const ticketId = req.params.id;
    const ticket = await db.getAsync<any>('SELECT * FROM tickets WHERE id=?', [ticketId]);
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

    const body = req.body as any;

    // ─── 实时流式进度上报 (Real-time CUA Transcript Streaming) ─────────────────────
    if (body?.type === 'progress' || body?.type === 'transcript_step') {
      const stepEntry = body.entry || {
        type: 'event',
        event: body.event?.step || 'progress',
        detail: body.event?.detail || '',
        ts: body.event?.ts || new Date().toISOString()
      };

      const now = Date.now();
      const existing = await db.getAsync<any>('SELECT * FROM ticket_results WHERE ticket_id=?', [ticketId]);
      let currentLog: any[] = [];
      if (existing?.ai_log) {
        try { currentLog = JSON.parse(existing.ai_log); } catch { currentLog = []; }
      }

      // 避免基于 ID 重复添加
      if (!stepEntry.id || !currentLog.some(e => e.id === stepEntry.id)) {
        currentLog.push(stepEntry);
      }

      const updatedAiLog = JSON.stringify(currentLog, null, 2);
      if (existing) {
        await db.runAsync(
          `UPDATE ticket_results SET ai_log=?, updated_at=? WHERE ticket_id=?`,
          [updatedAiLog, now, ticketId]
        );
      } else {
        const { v4: uuidv4 } = require('uuid');
        await db.runAsync(
          `INSERT INTO ticket_results (id, ticket_id, raw_result, ai_log, created_at, updated_at) VALUES (?,?,?,?,?,?)`,
          [uuidv4(), ticketId, '(处理中...)', updatedAiLog, now, now]
        );
      }

      if (ticket.status !== 'processing') {
        await db.runAsync(`UPDATE tickets SET status='processing', updated_at=? WHERE id=?`, [now, ticketId]);
      }

      return res.json({ ok: true, streamed: true });
    }

    // ─── 最终回调（Agent 执行完成或失败）────────────────────────────────────────
    const passed = body?.passed ?? false;
    let rawResult: string = body?.output || '';
    if (!rawResult && Array.isArray(body?.test_results) && body.test_results.length > 0) {
      rawResult = body.test_results[0]?.output || body.test_results[0]?.result || '';
    }
    if (!rawResult) rawResult = passed ? '(Agent completed, no output)' : '(Agent failed)';

    // Store transcript as ai_log for display
    const aiLog = body?.transcript
      ? JSON.stringify(body.transcript, null, 2)
      : '';

    const now = Date.now();
    const existing = await db.getAsync<any>('SELECT id FROM ticket_results WHERE ticket_id=?', [ticketId]);
    if (existing) {
      await db.runAsync(
        `UPDATE ticket_results SET raw_result=?, ai_log=?, updated_at=? WHERE ticket_id=?`,
        [rawResult, aiLog, now, ticketId]
      );
    } else {
      const { v4: uuidv4 } = require('uuid');
      await db.runAsync(
        `INSERT INTO ticket_results (id, ticket_id, raw_result, ai_log, created_at, updated_at) VALUES (?,?,?,?,?,?)`,
        [uuidv4(), ticketId, rawResult, aiLog, now, now]
      );
    }

    const newStatus = passed ? 'done' : 'error';
    await db.runAsync(
      `UPDATE tickets SET status=?, ai_completed_at=?, updated_at=? WHERE id=?`,
      [newStatus, now, now, ticketId]
    );

    console.log(`[TicketAgent] Callback for ticket ${ticketId}: passed=${passed}, preview=${rawResult.slice(0, 80)}`);
    res.json({ ok: true });

    // ── 通知用户：AI 处理完成 ──────────────────────────────────────────────────
    if (passed) {
      void notifyUserTicketDone(ticketId).catch(e =>
        console.error(`[TicketNotify] 通知失败 ticketId=${ticketId}:`, e.message)
      );
    }
  } catch (err: any) {
    console.error('[TicketAgent] Callback error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── PUT /api/tickets/:id/inputs — Staff edits submitted inputs ───────────────
// Accepts multipart/form-data:
//   fields         — JSON string: { fieldKey: newValue, ... }  (text inputs)
//   file_<inputId> — replacement file for that specific input row
ticketRouter.put('/:id/inputs', inputUpload.any(), async (req, res) => {
  try {
    const ticket = await db.getAsync<TicketRecord>('SELECT * FROM tickets WHERE id=?', [req.params.id]);
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

    const now = Date.now();
    const files = (req.files as Express.Multer.File[]) || [];

    // ── Update text fields ────────────────────────────────────────────────────
    let fields: Record<string, string> = {};
    try {
      fields = req.body.fields ? JSON.parse(req.body.fields) : {};
    } catch { fields = {}; }

    for (const [fieldKey, newValue] of Object.entries(fields)) {
      const strValue = typeof newValue === 'object'
        ? JSON.stringify(newValue)
        : String(newValue ?? '');
      const existing = await db.getAsync<any>(
        'SELECT id FROM ticket_inputs WHERE ticket_id=? AND field_key=? AND field_type=?',
        [ticket.id, fieldKey, 'text']
      );
      if (existing) {
        await db.runAsync('UPDATE ticket_inputs SET value=? WHERE id=?', [strValue, existing.id]);
      } else {
        await db.runAsync(
          `INSERT INTO ticket_inputs (id, ticket_id, field_key, field_type, value, created_at) VALUES (?,?,?,?,?,?)`,
          [uuidv4(), ticket.id, fieldKey, 'text', strValue, now]
        );
      }
    }

    // ── Replace file inputs ───────────────────────────────────────────────────
    for (const file of files) {
      const match = file.fieldname.match(/^file_(.+)$/);
      if (!match) continue;
      const inputId = match[1];

      let fileName = file.originalname;
      try { fileName = Buffer.from(file.originalname, 'latin1').toString('utf8'); } catch {}

      const oldRow = await db.getAsync<any>('SELECT * FROM ticket_inputs WHERE id=?', [inputId]);
      const fieldKey = oldRow?.field_key || 'file';
      if (oldRow) {
        if (oldRow.file_path && fs.existsSync(oldRow.file_path)) {
          try { fs.unlinkSync(oldRow.file_path); } catch {}
        }
        await db.runAsync('DELETE FROM ticket_inputs WHERE id=?', [inputId]);
      }

      await db.runAsync(
        `INSERT INTO ticket_inputs (id, ticket_id, field_key, field_type, file_path, file_name, mime_type, created_at) VALUES (?,?,?,?,?,?,?,?)`,
        [uuidv4(), ticket.id, fieldKey, 'file', file.path, fileName, file.mimetype, now]
      );
    }

    // Ensure ticket is reprocessable
    if (!['submitted', 'done', 'error'].includes(ticket.status)) {
      await db.runAsync(`UPDATE tickets SET status='submitted', updated_at=? WHERE id=?`, [now, ticket.id]);
    } else {
      await db.runAsync(`UPDATE tickets SET updated_at=? WHERE id=?`, [now, ticket.id]);
    }

    const updatedInputs = await db.allAsync<any>(
      'SELECT * FROM ticket_inputs WHERE ticket_id=? ORDER BY created_at', [ticket.id]
    );
    res.json({ ok: true, inputs: updatedInputs });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
