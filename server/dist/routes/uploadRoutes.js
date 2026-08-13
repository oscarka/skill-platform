"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.uploadRouter = void 0;
const express_1 = __importDefault(require("express"));
const multer_1 = __importDefault(require("multer"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const uuid_1 = require("uuid");
exports.uploadRouter = express_1.default.Router();
const UPLOAD_DIR = path_1.default.resolve(process.env.UPLOAD_DIR || path_1.default.join(__dirname, '..', '..', '..', 'uploads', 'files'));
try {
    if (!fs_1.default.existsSync(UPLOAD_DIR))
        fs_1.default.mkdirSync(UPLOAD_DIR, { recursive: true });
}
catch { /* Cloud Run read-only FS; GCS used instead */ }
const storage = multer_1.default.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, file, cb) => {
        const ext = path_1.default.extname(file.originalname);
        cb(null, `${(0, uuid_1.v4)()}${ext}`);
    },
});
const upload = (0, multer_1.default)({
    storage,
    limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
    fileFilter: (_req, file, cb) => {
        const allowed = [
            'application/pdf', 'image/jpeg', 'image/png', 'image/gif',
            'image/webp', 'text/plain', 'application/json',
        ];
        if (allowed.includes(file.mimetype))
            cb(null, true);
        else
            cb(new Error(`File type ${file.mimetype} not allowed`));
    },
});
/**
 * POST /api/upload
 * Upload one or more files. Returns file info array.
 */
exports.uploadRouter.post('/', upload.array('files', 10), (req, res) => {
    try {
        const files = req.files || [];
        const result = files.map(f => ({
            file_id: path_1.default.parse(f.filename).name,
            original_name: f.originalname,
            file_name: f.filename,
            file_path: f.path,
            mime_type: f.mimetype,
            size: f.size,
        }));
        res.json({ files: result });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
/**
 * GET /api/upload/:filename
 * Serve an uploaded file by filename.
 */
exports.uploadRouter.get('/:filename', (req, res) => {
    const filePath = path_1.default.join(UPLOAD_DIR, req.params.filename);
    if (!fs_1.default.existsSync(filePath))
        return res.status(404).json({ error: 'File not found' });
    res.sendFile(filePath);
});
