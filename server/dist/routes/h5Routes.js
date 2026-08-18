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
exports.h5Router = void 0;
const express_1 = __importDefault(require("express"));
const multer_1 = __importDefault(require("multer"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const uuid_1 = require("uuid");
const db = __importStar(require("../db"));
const aiProcessor_1 = require("../aiProcessor");
const agentService_1 = require("../agentService");
exports.h5Router = express_1.default.Router();
const UPLOAD_DIR = path_1.default.resolve(process.env.UPLOAD_DIR || path_1.default.join(__dirname, '..', '..', '..', 'uploads', 'files'));
try {
    if (!fs_1.default.existsSync(UPLOAD_DIR))
        fs_1.default.mkdirSync(UPLOAD_DIR, { recursive: true });
}
catch { /* Cloud Run read-only FS */ }
const storage = multer_1.default.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, file, cb) => {
        const ext = path_1.default.extname(file.originalname);
        cb(null, `${(0, uuid_1.v4)()}${ext}`);
    },
});
const upload = (0, multer_1.default)({
    storage,
    limits: { fileSize: 50 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
        const allowed = ['application/pdf', 'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'text/plain'];
        if (allowed.includes(file.mimetype))
            cb(null, true);
        else
            cb(new Error(`File type not allowed: ${file.mimetype}`));
    },
});
/**
 * GET /api/h5/:token
 * Used by H5 page to fetch form config.
 */
exports.h5Router.get('/:token', async (req, res) => {
    try {
        const ticket = await db.getAsync('SELECT * FROM tickets WHERE token=?', [req.params.token]);
        if (!ticket)
            return res.status(404).json({ error: 'Invalid link', code: 'NOT_FOUND' });
        if (Date.now() > ticket.expires_at && ticket.status === 'waiting_input')
            return res.status(410).json({ error: 'This link has expired. Please contact the staff.', code: 'EXPIRED' });
        if (ticket.status === 'submitted' || ticket.status === 'processing') {
            return res.json({ already_submitted: true, status: ticket.status, message: '您已成功提交，AI 正在处理，请耐心等待工作人员反馈。' });
        }
        if (ticket.status === 'done' || ticket.status === 'patient_confirmed' || ticket.status === 'patient_rejected') {
            const serviceBase = process.env.SERVICE_URL || process.env.PUBLIC_BASE_URL || '';
            const report_url = `${serviceBase}/api/results/${ticket.id}/report`;
            return res.json({ already_submitted: true, status: ticket.status, report_url, message: '报告已生成，点击查看' });
        }
        if (ticket.status === 'created') {
            await db.runAsync(`UPDATE tickets SET status='waiting_input', updated_at=? WHERE id=?`, [Date.now(), ticket.id]);
        }
        const skill = await db.getAsync('SELECT name, h5_config FROM skills WHERE id=?', [ticket.skill_id]);
        const h5Config = skill?.h5_config ? JSON.parse(skill.h5_config) : null;
        // 解析预填字段
        let prefilledValues = {};
        try {
            if (ticket.prefilled_values)
                prefilledValues = JSON.parse(ticket.prefilled_values);
        }
        catch { /* ignore */ }
        res.json({
            ticket_id: ticket.id,
            status: ticket.status === 'created' ? 'waiting_input' : ticket.status,
            return_reason: ticket.return_reason,
            skill_name: skill?.name,
            h5_config: h5Config,
            prefilled_values: prefilledValues,
            expires_at: ticket.expires_at,
        });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
/**
 * POST /api/h5/:token/submit
 * Client submits form data + files.
 * ✅ Automatically triggers AI processing after successful submission.
 */
exports.h5Router.post('/:token/submit', upload.array('files', 10), async (req, res) => {
    try {
        const ticket = await db.getAsync('SELECT * FROM tickets WHERE token=?', [req.params.token]);
        if (!ticket)
            return res.status(404).json({ error: 'Invalid link' });
        if (ticket.status === 'submitted' || ticket.status === 'done')
            return res.status(400).json({ error: '您已提交过，无法再次修改。如需补充请联系工作人员。' });
        if (Date.now() > ticket.expires_at)
            return res.status(410).json({ error: '链接已过期，请联系工作人员重新发送。' });
        const now = Date.now();
        // Parse text fields
        let fields = {};
        try {
            fields = req.body.fields ? JSON.parse(req.body.fields) : req.body;
        }
        catch {
            fields = req.body || {};
        }
        // ── 是否本人校验（is_self=true 且未 force 时，比对预填信息）───────────────
        const isSelf = req.body.is_self === 'true' || req.body.is_self === true;
        const isForce = req.body.force === 'true' || req.body.force === true;
        if (isSelf && !isForce && ticket.prefilled_values) {
            let prefilled = {};
            try {
                prefilled = JSON.parse(ticket.prefilled_values);
            }
            catch { /* ignore */ }
            const mismatches = [];
            // patient_name 不符：提交的姓名与预填不同（均非空）
            const subName = String(fields.patient_name || '').trim();
            const preNames = prefilled.patient_name ? prefilled.patient_name.trim() : '';
            if (subName && preNames && subName !== preNames)
                mismatches.push('patient_name');
            // patient_age 不符：年龄差超过 10 岁
            const subAge = parseInt(String(fields.patient_age || '0'), 10);
            const preAge = parseInt(String(prefilled.patient_age || '0'), 10);
            if (subAge > 0 && preAge > 0 && Math.abs(subAge - preAge) > 10)
                mismatches.push('patient_age');
            if (mismatches.length > 0) {
                return res.status(200).json({
                    warning: true,
                    mismatch_fields: mismatches,
                    message: `您提交的信息与档案中的记录不符（${mismatches.map(f => ({ patient_name: '姓名', patient_age: '年龄' })[f] || f).join('、')}），请确认是否填写正确。如需更新个人档案信息，请联系管理员。`,
                });
            }
        }
        // Delete old inputs if resubmitting after return
        await db.runAsync('DELETE FROM ticket_inputs WHERE ticket_id=?', [ticket.id]);
        // Save text fields
        for (const [key, value] of Object.entries(fields)) {
            if (key === 'fields')
                continue;
            const strValue = (value === null || value === undefined)
                ? ''
                : (typeof value === 'object' ? JSON.stringify(value) : String(value));
            await db.runAsync(`INSERT INTO ticket_inputs (id, ticket_id, field_key, field_type, value, created_at)
         VALUES (?,?,?,?,?,?)`, [(0, uuid_1.v4)(), ticket.id, key, 'text', strValue, now]);
        }
        // Save kept prefilled files (from WeChat auto-mount)
        let keptFiles = [];
        try {
            if (req.body.kept_files) {
                keptFiles = typeof req.body.kept_files === 'string' ? JSON.parse(req.body.kept_files) : req.body.kept_files;
            }
        }
        catch { /* ignore */ }
        for (const kf of keptFiles) {
            if (kf && kf.url) {
                await db.runAsync(`INSERT INTO ticket_inputs (id, ticket_id, field_key, field_type, file_path, file_name, mime_type, created_at)
           VALUES (?,?,?,?,?,?,?,?)`, [(0, uuid_1.v4)(), ticket.id, 'file', 'file', kf.url, kf.name || '附件', kf.type === 'image' ? 'image/jpeg' : 'application/pdf', now]);
            }
        }
        // Save uploaded files
        const files = req.files || [];
        for (const file of files) {
            // multer decodes originalname as latin1; re-encode as utf8 for Chinese filenames
            let fileName = file.originalname;
            try {
                fileName = Buffer.from(file.originalname, 'latin1').toString('utf8');
            }
            catch { /* keep original if conversion fails */ }
            await db.runAsync(`INSERT INTO ticket_inputs (id, ticket_id, field_key, field_type, file_path, file_name, mime_type, created_at)
         VALUES (?,?,?,?,?,?,?,?)`, [(0, uuid_1.v4)(), ticket.id, 'file', 'file', file.path, fileName, file.mimetype, now]);
        }
        // Update ticket status
        await db.runAsync(`UPDATE tickets SET status='submitted', h5_submitted_at=?, updated_at=? WHERE id=?`, [now, now, ticket.id]);
        // ── 创建独立处理任务（左侧列表独立显示，状态 processing → done）───────────────
        const skill = await db.getAsync('SELECT name, id FROM skills WHERE id=?', [ticket.skill_id]);
        const skillName = skill?.name || '技能';
        const processingTaskId = `req_h5_${ticket.id.slice(0, 8)}_${now}`;
        await (0, agentService_1.createAgentTask)({
            id: processingTaskId,
            sessionId: `h5_${ticket.id}`,
            userId: ticket.created_by || 'unknown',
            sourceChannel: 'wechat',
            inputContent: `[表单提交] ${skillName} — ${ticket.patient_name || '用户'} 提交了表单`,
            meta: { ticketId: ticket.id, skillName, patientName: ticket.patient_name, fromH5: true },
        });
        await (0, agentService_1.updateAgentTask)(processingTaskId, {
            status: 'processing',
            routeType: 'ticket_processing',
            skillId: ticket.skill_id,
        });
        // ticket_submitted 事件：记录用户已提交表单
        void (0, agentService_1.appendTaskEvent)(processingTaskId, 'ticket_submitted', {
            ticketId: ticket.id,
            skillName,
            fieldCount: Object.keys(fields).length,
            patientName: ticket.patient_name || '',
            submittedAt: new Date(now).toISOString(),
        });
        // ticket.request_id 指向新任务，后续进度/完成事件都写这里
        await db.runAsync(`UPDATE tickets SET request_id=?, updated_at=? WHERE id=?`, [processingTaskId, now, ticket.id]);
        // ✅ 异步触发 AI（非阻塞，客户立即收到响应）
        console.log(`[H5] Ticket ${ticket.id} submitted — auto-triggering AI, task=${processingTaskId}`);
        (0, aiProcessor_1.processTicket)(ticket.id, processingTaskId).catch(err => {
            console.error(`[H5→AI] Ticket ${ticket.id} AI failed:`, err.message);
            void (0, agentService_1.updateAgentTask)(processingTaskId, { status: 'error', errorMessage: err.message, endedAt: Date.now() });
        });
        res.json({ success: true, message: '提交成功！AI 正在为您处理，结果将由工作人员反馈给您。' });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
