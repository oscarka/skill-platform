"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ticketRouter = void 0;
const express_1 = __importDefault(require("express"));
const uuid_1 = require("uuid");
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const multer_1 = __importDefault(require("multer"));
const db = __importStar(require("../db"));
const aiProcessor_1 = require("../aiProcessor");
const agentService_1 = require("../agentService");
// Multer for ticket input file replacement
const UPLOADS_DIR = path_1.default.resolve(__dirname, '..', '..', '..', 'uploads', 'inputs');
if (!fs_1.default.existsSync(UPLOADS_DIR))
    try {
        fs_1.default.mkdirSync(UPLOADS_DIR, { recursive: true });
    }
    catch { /* Cloud Run read-only FS */ }
const inputUpload = (0, multer_1.default)({ dest: UPLOADS_DIR, limits: { fileSize: 30 * 1024 * 1024 } });
exports.ticketRouter = express_1.default.Router();
const EXPIRY_DAYS = async () => {
    const row = await db.getAsync('SELECT value FROM settings WHERE key=?', ['ticket_expiry_days']);
    return parseInt(row?.value || '3', 10);
};
const STATUS_LABEL = {
    created: '待发送', waiting_input: '等待提交', submitted: '已提交',
    processing: 'AI 处理中', done: '已完成', returned: '已打回',
    expired: '已过期', error: '处理出错', patient_confirmed: '患者已确认', patient_rejected: '患者不认可',
};
let _h5BaseCache = '';
let _h5BaseCacheExpire = 0;
async function h5BaseUrl() {
    if (_h5BaseCache && Date.now() < _h5BaseCacheExpire)
        return _h5BaseCache;
    const row = await db.getAsync('SELECT value FROM settings WHERE key=?', ['h5_base_url']);
    _h5BaseCache = row?.value || `http://localhost:3100/h5`;
    _h5BaseCacheExpire = Date.now() + 60_000; // 60s cache
    return _h5BaseCache;
}
async function ticketToResponse(t, skill) {
    const h5Base = await h5BaseUrl(); // 缓存命中，单次调用
    const base = h5Base.replace(/\/h5$/, '');
    const reportUrl = t.status === 'done' ? `${base}/api/results/${t.id}/report` : null;
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
        h5_url: `${h5Base}?token=${t.token}`,
        h5_submitted_at: t.h5_submitted_at,
        ai_started_at: t.ai_started_at,
        ai_completed_at: t.ai_completed_at,
        expires_at: t.expires_at,
        created_at: t.created_at,
        updated_at: t.updated_at,
        report_url: reportUrl, // done 状态才有值，供前端和测试直接读取
        request_id: t.request_id || null,
    };
}
// ─── POST /api/tickets — Create ticket ────────────────────────────────────────
exports.ticketRouter.post('/', async (req, res) => {
    try {
        const { skill_id, title, patient_name, patient_phone, notes, created_by } = req.body;
        if (!skill_id)
            return res.status(400).json({ error: '"skill_id" is required' });
        const skill = await db.getAsync('SELECT * FROM skills WHERE id=?', [skill_id]);
        if (!skill)
            return res.status(404).json({ error: 'Skill not found' });
        if (skill.status !== 'published')
            return res.status(400).json({ error: 'Skill must be published before creating tickets' });
        if (skill.type !== 'external')
            return res.status(400).json({ error: 'Tickets can only be created for external skills' });
        const id = (0, uuid_1.v4)();
        const token = (0, uuid_1.v4)().replace(/-/g, '');
        const now = Date.now();
        const expiresAt = (now + (await EXPIRY_DAYS()) * 24 * 60 * 60 * 1000);
        await db.runAsync(`INSERT INTO tickets
        (id, skill_id, token, title, patient_name, patient_phone, notes,
         created_by, status, return_count, expires_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, [id, skill_id, token,
            title || `${skill.name} — ${new Date(now).toLocaleDateString('zh-CN')}`,
            patient_name || null, patient_phone || null, notes || null,
            created_by || null, 'created', 0, expiresAt, now, now]);
        const ticket = await db.getAsync('SELECT * FROM tickets WHERE id=?', [id]);
        res.status(201).json({ ticket: await ticketToResponse(ticket, skill) });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// ─── GET /api/tickets — List tickets ──────────────────────────────────────────
exports.ticketRouter.get('/', async (req, res) => {
    try {
        const { status, skill_id, q, created_by } = req.query;
        const limit = Math.min(parseInt(req.query.limit || '100', 10), 500);
        const offset = parseInt(req.query.offset || '0', 10);
        let sql = `SELECT t.*, s.name as skill_name FROM tickets t
               LEFT JOIN skills s ON t.skill_id = s.id WHERE 1=1`;
        let countSql = `SELECT COUNT(*) as cnt FROM tickets t WHERE 1=1`;
        const params = [];
        const countParams = [];
        if (status) {
            sql += ' AND t.status=?';
            countSql += ' AND t.status=?';
            params.push(status);
            countParams.push(status);
        }
        if (skill_id) {
            sql += ' AND t.skill_id=?';
            countSql += ' AND t.skill_id=?';
            params.push(skill_id);
            countParams.push(skill_id);
        }
        if (created_by) {
            sql += ' AND t.created_by=?';
            countSql += ' AND t.created_by=?';
            params.push(created_by);
            countParams.push(created_by);
        }
        if (q) {
            sql += ' AND (t.title LIKE ? OR t.patient_name LIKE ? OR t.token LIKE ?)';
            countSql += ' AND (t.title LIKE ? OR t.patient_name LIKE ? OR t.token LIKE ?)';
            params.push(`%${q}%`, `%${q}%`, `%${q}%`);
            countParams.push(`%${q}%`, `%${q}%`, `%${q}%`);
        }
        sql += ` ORDER BY t.created_at DESC LIMIT ${limit} OFFSET ${offset}`;
        const [rows, countRow] = await Promise.all([
            db.allAsync(sql, params),
            db.getAsync(countSql, countParams),
        ]);
        const base = await h5BaseUrl();
        const tickets = await Promise.all(rows.map(async (t) => ({
            ...(await ticketToResponse(t)),
            skill_name: t.skill_name,
            h5_url: `${base}?token=${t.token}`,
        })));
        res.json({ tickets, total: countRow?.cnt ?? tickets.length, limit, offset });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// ─── GET /api/tickets/:id — Ticket detail ─────────────────────────────────────
exports.ticketRouter.get('/:id', async (req, res) => {
    try {
        const ticket = await db.getAsync('SELECT * FROM tickets WHERE id=?', [req.params.id]);
        if (!ticket)
            return res.status(404).json({ error: 'Ticket not found' });
        const skill = await db.getAsync('SELECT * FROM skills WHERE id=?', [ticket.skill_id]);
        const inputs = await db.allAsync('SELECT * FROM ticket_inputs WHERE ticket_id=? ORDER BY created_at', [ticket.id]);
        const result = await db.getAsync('SELECT * FROM ticket_results WHERE ticket_id=?', [ticket.id]);
        res.json({
            ticket: await ticketToResponse(ticket, skill),
            skill: skill ? { id: skill.id, name: skill.name, type: skill.type, h5_config: skill.h5_config ? JSON.parse(skill.h5_config) : null } : null,
            inputs,
            result,
        });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// ─── GET /api/tickets/token/:token — Get by token (H5 uses this) ──────────────
exports.ticketRouter.get('/token/:token', async (req, res) => {
    try {
        const ticket = await db.getAsync('SELECT * FROM tickets WHERE token=?', [req.params.token]);
        if (!ticket)
            return res.status(404).json({ error: 'Invalid or expired link' });
        if (Date.now() > ticket.expires_at && ticket.status !== 'submitted' && ticket.status !== 'done')
            return res.status(410).json({ error: 'Link has expired', expired: true });
        const skill = await db.getAsync('SELECT id, name, type, h5_config FROM skills WHERE id=?', [ticket.skill_id]);
        res.json({
            ticket: { id: ticket.id, status: ticket.status, expires_at: ticket.expires_at, return_reason: ticket.return_reason },
            skill: skill ? { id: skill.id, name: skill.name, h5_config: skill.h5_config ? JSON.parse(skill.h5_config) : null } : null,
        });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// ─── PUT /api/tickets/:id/return — Return ticket to client ────────────────────
exports.ticketRouter.put('/:id/return', async (req, res) => {
    try {
        const { reason } = req.body;
        const ticket = await db.getAsync('SELECT * FROM tickets WHERE id=?', [req.params.id]);
        if (!ticket)
            return res.status(404).json({ error: 'Ticket not found' });
        const now = Date.now();
        const newExpiry = (now + (await EXPIRY_DAYS()) * 24 * 60 * 60 * 1000);
        await db.runAsync(`UPDATE tickets SET status='returned', return_reason=?, return_count=return_count+1,
       expires_at=?, updated_at=? WHERE id=?`, [reason || '请补充信息后重新提交', newExpiry, now, ticket.id]);
        const updated = await db.getAsync('SELECT * FROM tickets WHERE id=?', [ticket.id]);
        res.json({ ticket: await ticketToResponse(updated) });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// ─── PUT /api/tickets/:id/status — Admin: override status directly ─────────────
const VALID_STATUSES = ['created', 'waiting_input', 'submitted', 'processing', 'done', 'returned', 'error', 'expired'];
exports.ticketRouter.put('/:id/status', async (req, res) => {
    try {
        const { status, return_reason } = req.body;
        if (!status || !VALID_STATUSES.includes(status)) {
            return res.status(400).json({ error: `status must be one of: ${VALID_STATUSES.join(', ')}` });
        }
        const ticket = await db.getAsync('SELECT * FROM tickets WHERE id=?', [req.params.id]);
        if (!ticket)
            return res.status(404).json({ error: 'Ticket not found' });
        const now = Date.now();
        await db.runAsync(`UPDATE tickets SET status=?, return_reason=COALESCE(?,return_reason), updated_at=? WHERE id=?`, [status, return_reason ?? null, now, ticket.id]);
        // 同步更新对应的 Agent Task 状态，防止工单已关闭但任务仍显示 processing
        if (ticket.request_id) {
            const taskStatus = (status === 'error' || status === 'expired') ? 'failed' : (status === 'done' ? 'done' : status);
            void (0, agentService_1.updateAgentTask)(ticket.request_id, {
                status: taskStatus,
                errorMessage: return_reason || (status === 'error' ? '工单已手动中止/出错' : undefined),
                endedAt: now,
            });
        }
        const updated = await db.getAsync('SELECT * FROM tickets WHERE id=?', [ticket.id]);
        res.json({ ticket: await ticketToResponse(updated) });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// ─── PATCH /api/tickets/:id — Admin: update ticket fields (notes, prefilled_values, etc.) ──
exports.ticketRouter.patch('/:id', async (req, res) => {
    try {
        const ticket = await db.getAsync('SELECT * FROM tickets WHERE id=?', [req.params.id]);
        if (!ticket)
            return res.status(404).json({ error: 'Ticket not found' });
        const { notes, title, patient_name, prefilled_values } = req.body;
        const updates = [];
        const params = [];
        if (notes !== undefined) {
            updates.push('notes=?');
            params.push(notes);
        }
        if (title !== undefined) {
            updates.push('title=?');
            params.push(title);
        }
        if (patient_name !== undefined) {
            updates.push('patient_name=?');
            params.push(patient_name);
        }
        if (prefilled_values !== undefined) {
            updates.push('prefilled_values=?');
            params.push(prefilled_values);
        }
        if (updates.length === 0)
            return res.status(400).json({ error: 'No updatable fields provided' });
        const now = Date.now();
        updates.push('updated_at=?');
        params.push(now, ticket.id);
        await db.runAsync(`UPDATE tickets SET ${updates.join(', ')} WHERE id=?`, params);
        const updated = await db.getAsync('SELECT * FROM tickets WHERE id=?', [ticket.id]);
        res.json({ ticket: await ticketToResponse(updated) });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// ─── GET /api/tickets/:id/status — Poll status ────────────────────────────────
exports.ticketRouter.get('/:id/status', async (req, res) => {
    try {
        const ticket = await db.getAsync('SELECT status, updated_at FROM tickets WHERE id=?', [req.params.id]);
        if (!ticket)
            return res.status(404).json({ error: 'Ticket not found' });
        res.json({ status: ticket.status, status_label: STATUS_LABEL[ticket.status], updated_at: ticket.updated_at });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// ─── POST /api/tickets/:id/agent-callback — Cloud Run Job result for plugin skills ──
// runner.py calls this when Agent finishes (same format as sandbox-callback in skillRoutes)
exports.ticketRouter.post('/:id/agent-callback', async (req, res) => {
    try {
        const EXPECTED_SECRET = process.env.SANDBOX_SECRET || 'sandbox-secret-2024';
        const secret = req.headers['x-sandbox-secret'];
        if (secret !== EXPECTED_SECRET) {
            return res.status(403).json({ error: 'Forbidden' });
        }
        const ticketId = req.params.id;
        const ticket = await db.getAsync('SELECT * FROM tickets WHERE id=?', [ticketId]);
        if (!ticket)
            return res.status(404).json({ error: 'Ticket not found' });
        const body = req.body;
        // ─── 实时流式进度上报 (Real-time CUA Transcript Streaming) ─────────────────────
        if (body?.type === 'progress' || body?.type === 'transcript_step') {
            const { v4: uuidv4 } = require('uuid');
            const stepEntry = body.entry || {
                id: uuidv4(),
                type: 'event',
                event: body.event?.step || 'progress',
                detail: body.event?.detail || '',
                ts: body.event?.ts || new Date().toISOString()
            };
            // 确保所有 stepEntry 都有 id（没有 id 的不会写入 AgentLogs 渠道消息）
            if (!stepEntry.id)
                stepEntry.id = uuidv4();
            const now = Date.now();
            const existing = await db.getAsync('SELECT * FROM ticket_results WHERE ticket_id=?', [ticketId]);
            let currentLog = [];
            if (existing?.ai_log) {
                try {
                    currentLog = JSON.parse(existing.ai_log);
                }
                catch {
                    currentLog = [];
                }
            }
            // 避免基于 ID 重复添加
            if (!stepEntry.id || !currentLog.some(e => e.id === stepEntry.id)) {
                currentLog.push(stepEntry);
            }
            const updatedAiLog = JSON.stringify(currentLog, null, 2);
            if (existing) {
                await db.runAsync(`UPDATE ticket_results SET ai_log=?, updated_at=? WHERE ticket_id=?`, [updatedAiLog, now, ticketId]);
            }
            else {
                const { v4: uuidv4 } = require('uuid');
                await db.runAsync(`INSERT INTO ticket_results (id, ticket_id, raw_result, ai_log, created_at, updated_at) VALUES (?,?,?,?,?,?)`, [uuidv4(), ticketId, '(处理中...)', updatedAiLog, now, now]);
            }
            if (ticket.status !== 'processing') {
                await db.runAsync(`UPDATE tickets SET status='processing', updated_at=? WHERE id=?`, [now, ticketId]);
            }
            // ── 实时写 AgentLogs：每个进度步骤写一条 ticket_progress 事件 ──────────────
            if (ticket.request_id && stepEntry.id && !currentLog.slice(0, -1).some((e) => e.id === stepEntry.id)) {
                const stepLabel = stepEntry.event || stepEntry.type || 'step';
                const rawDetail = stepEntry.detail || stepEntry.content || stepEntry.output || stepEntry.text || stepEntry.result || '';
                const stepDetail = typeof rawDetail === 'string' ? rawDetail : JSON.stringify(rawDetail);
                void (0, agentService_1.appendTaskEvent)(ticket.request_id, 'ticket_progress', {
                    ticketId,
                    stepId: stepEntry.id,
                    stepLabel,
                    stepDetail: stepDetail.slice(0, 500),
                    hasContent: stepDetail.length > 0,
                    ts: stepEntry.ts || new Date().toISOString(),
                });
            }
            return res.json({ ok: true, streamed: true });
        }
        // ─── 最终回调（Agent 执行完成或失败）────────────────────────────────────────
        const passed = body?.passed ?? false;
        let rawResult = body?.output || '';
        if (!rawResult && Array.isArray(body?.test_results) && body.test_results.length > 0) {
            rawResult = body.test_results[0]?.output || body.test_results[0]?.result || '';
        }
        if (!rawResult)
            rawResult = passed ? '(Agent completed, no output)' : '(Agent failed)';
        // Store transcript as ai_log for display
        const aiLog = body?.transcript
            ? JSON.stringify(body.transcript, null, 2)
            : '';
        const now = Date.now();
        const existing = await db.getAsync('SELECT id FROM ticket_results WHERE ticket_id=?', [ticketId]);
        if (existing) {
            await db.runAsync(`UPDATE ticket_results SET raw_result=?, ai_log=?, updated_at=? WHERE ticket_id=?`, [rawResult, aiLog, now, ticketId]);
        }
        else {
            const { v4: uuidv4 } = require('uuid');
            await db.runAsync(`INSERT INTO ticket_results (id, ticket_id, raw_result, ai_log, created_at, updated_at) VALUES (?,?,?,?,?,?)`, [uuidv4(), ticketId, rawResult, aiLog, now, now]);
        }
        const newStatus = passed ? 'done' : 'error';
        await db.runAsync(`UPDATE tickets SET status=?, ai_completed_at=?, updated_at=? WHERE id=?`, [newStatus, now, now, ticketId]);
        console.log(`[TicketAgent] Callback for ticket ${ticketId}: passed=${passed}, preview=${rawResult.slice(0, 80)}`);
        res.json({ ok: true });
        // ── 回写 AgentLogs（skill_done / reply_sent / updateAgentTask）──────────────
        if (ticket.request_id) {
            try {
                const skill = await db.getAsync('SELECT name FROM skills WHERE id=?', [ticket.skill_id]);
                const skillNameLog = skill?.name || '技能';
                const h5Base = (await db.getAsync(`SELECT value FROM settings WHERE key='h5_base_url'`))?.value || '';
                const serviceBase = h5Base.replace(/\/h5$/, '');
                const rUrl = passed && serviceBase ? `${serviceBase}/api/results/${ticketId}/report` : null;
                if (passed) {
                    void (0, agentService_1.appendTaskEvent)(ticket.request_id, 'skill_done', {
                        ticketId,
                        skillName: skillNameLog,
                        outputLen: rawResult.length,
                        output_preview: rawResult.slice(0, 200),
                        report_url: rUrl || '',
                    });
                    const replyMsg = rUrl
                        ? `${ticket.patient_name || '您'}，您的「${skillNameLog}」分析报告已生成 🎉\n\n点击查看完整报告：\n${rUrl}`
                        : rawResult.slice(0, 300);
                    void (0, agentService_1.appendTaskEvent)(ticket.request_id, 'reply_sent', { reply: replyMsg });
                }
                else {
                    void (0, agentService_1.appendTaskEvent)(ticket.request_id, 'skill_error', {
                        ticketId,
                        skillName: skillNameLog,
                        errorPreview: rawResult.slice(0, 200),
                    });
                }
                // 更新 AgentLogs 左侧任务状态
                void (0, agentService_1.updateAgentTask)(ticket.request_id, {
                    status: passed ? 'done' : 'error',
                    endedAt: Date.now(),
                });
            }
            catch (logErr) {
                console.warn(`[TicketAgent] 回写日志失败:`, logErr.message);
            }
        }
        // ── 通知用户：AI 处理完成 ──────────────────────────────────────────────────
        if (passed) {
            void (0, aiProcessor_1.notifyUserTicketDone)(ticketId).catch(e => console.error(`[TicketNotify] 通知失败 ticketId=${ticketId}:`, e.message));
        }
    }
    catch (err) {
        console.error('[TicketAgent] Callback error:', err.message);
        res.status(500).json({ error: err.message });
    }
});
// ─── PUT /api/tickets/:id/inputs — Staff edits submitted inputs ───────────────
// Accepts multipart/form-data:
//   fields         — JSON string: { fieldKey: newValue, ... }  (text inputs)
//   file_<inputId> — replacement file for that specific input row
exports.ticketRouter.put('/:id/inputs', inputUpload.any(), async (req, res) => {
    try {
        const ticket = await db.getAsync('SELECT * FROM tickets WHERE id=?', [req.params.id]);
        if (!ticket)
            return res.status(404).json({ error: 'Ticket not found' });
        const now = Date.now();
        const files = req.files || [];
        // ── Update text fields ────────────────────────────────────────────────────
        let fields = {};
        try {
            fields = req.body.fields ? JSON.parse(req.body.fields) : {};
        }
        catch {
            fields = {};
        }
        for (const [fieldKey, newValue] of Object.entries(fields)) {
            const strValue = typeof newValue === 'object'
                ? JSON.stringify(newValue)
                : String(newValue ?? '');
            const existing = await db.getAsync('SELECT id FROM ticket_inputs WHERE ticket_id=? AND field_key=? AND field_type=?', [ticket.id, fieldKey, 'text']);
            if (existing) {
                await db.runAsync('UPDATE ticket_inputs SET value=? WHERE id=?', [strValue, existing.id]);
            }
            else {
                await db.runAsync(`INSERT INTO ticket_inputs (id, ticket_id, field_key, field_type, value, created_at) VALUES (?,?,?,?,?,?)`, [(0, uuid_1.v4)(), ticket.id, fieldKey, 'text', strValue, now]);
            }
        }
        // ── Replace file inputs ───────────────────────────────────────────────────
        for (const file of files) {
            const match = file.fieldname.match(/^file_(.+)$/);
            if (!match)
                continue;
            const inputId = match[1];
            let fileName = file.originalname;
            try {
                fileName = Buffer.from(file.originalname, 'latin1').toString('utf8');
            }
            catch { }
            const oldRow = await db.getAsync('SELECT * FROM ticket_inputs WHERE id=?', [inputId]);
            const fieldKey = oldRow?.field_key || 'file';
            if (oldRow) {
                if (oldRow.file_path && fs_1.default.existsSync(oldRow.file_path)) {
                    try {
                        fs_1.default.unlinkSync(oldRow.file_path);
                    }
                    catch { }
                }
                await db.runAsync('DELETE FROM ticket_inputs WHERE id=?', [inputId]);
            }
            await db.runAsync(`INSERT INTO ticket_inputs (id, ticket_id, field_key, field_type, file_path, file_name, mime_type, created_at) VALUES (?,?,?,?,?,?,?,?)`, [(0, uuid_1.v4)(), ticket.id, fieldKey, 'file', file.path, fileName, file.mimetype, now]);
        }
        // Ensure ticket is reprocessable
        if (!['submitted', 'done', 'error'].includes(ticket.status)) {
            await db.runAsync(`UPDATE tickets SET status='submitted', updated_at=? WHERE id=?`, [now, ticket.id]);
        }
        else {
            await db.runAsync(`UPDATE tickets SET updated_at=? WHERE id=?`, [now, ticket.id]);
        }
        const updatedInputs = await db.allAsync('SELECT * FROM ticket_inputs WHERE ticket_id=? ORDER BY created_at', [ticket.id]);
        res.json({ ok: true, inputs: updatedInputs });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
