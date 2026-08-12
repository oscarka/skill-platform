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
exports.h5Router = express_1.default.Router();
const UPLOAD_DIR = path_1.default.resolve(process.env.UPLOAD_DIR || path_1.default.join(__dirname, '..', '..', '..', 'uploads', 'files'));
if (!fs_1.default.existsSync(UPLOAD_DIR))
    fs_1.default.mkdirSync(UPLOAD_DIR, { recursive: true });
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
        if (ticket.status === 'submitted' || ticket.status === 'processing' || ticket.status === 'done')
            return res.json({ already_submitted: true, status: ticket.status, message: '您已成功提交，AI 正在处理或已完成，请耐心等待工作人员反馈。' });
        if (ticket.status === 'created') {
            await db.runAsync(`UPDATE tickets SET status='waiting_input', updated_at=? WHERE id=?`, [Date.now(), ticket.id]);
        }
        const skill = await db.getAsync('SELECT name, h5_config FROM skills WHERE id=?', [ticket.skill_id]);
        const h5Config = skill?.h5_config ? JSON.parse(skill.h5_config) : null;
        res.json({
            ticket_id: ticket.id,
            status: ticket.status === 'created' ? 'waiting_input' : ticket.status,
            return_reason: ticket.return_reason,
            skill_name: skill?.name,
            h5_config: h5Config,
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
        // Delete old inputs if resubmitting after return
        await db.runAsync('DELETE FROM ticket_inputs WHERE ticket_id=?', [ticket.id]);
        // Save text fields
        for (const [key, value] of Object.entries(fields)) {
            if (key === 'fields')
                continue;
            await db.runAsync(`INSERT INTO ticket_inputs (id, ticket_id, field_key, field_type, value, created_at)
         VALUES (?,?,?,?,?,?)`, [(0, uuid_1.v4)(), ticket.id, key, 'text', String(value), now]);
        }
        // Save uploaded files
        const files = req.files || [];
        for (const file of files) {
            await db.runAsync(`INSERT INTO ticket_inputs (id, ticket_id, field_key, field_type, file_path, file_name, mime_type, created_at)
         VALUES (?,?,?,?,?,?,?,?)`, [(0, uuid_1.v4)(), ticket.id, 'file', 'file', file.path, file.originalname, file.mimetype, now]);
        }
        // Update ticket status
        await db.runAsync(`UPDATE tickets SET status='submitted', h5_submitted_at=?, updated_at=? WHERE id=?`, [now, now, ticket.id]);
        // ✅ Auto-trigger AI processing (non-blocking — client gets response immediately)
        console.log(`[H5] Ticket ${ticket.id} submitted — auto-triggering AI...`);
        (0, aiProcessor_1.processTicket)(ticket.id).catch(err => {
            console.error(`[H5→AI] Ticket ${ticket.id} AI failed:`, err.message);
        });
        res.json({ success: true, message: '提交成功！AI 正在为您处理，结果将由工作人员反馈给您。' });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
