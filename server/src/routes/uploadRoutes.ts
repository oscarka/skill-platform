import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';

export const uploadRouter = express.Router();

const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, '..', '..', '..', 'uploads', 'files'));
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
  fileFilter: (_req, file, cb) => {
    const allowed = [
      'application/pdf', 'image/jpeg', 'image/png', 'image/gif',
      'image/webp', 'text/plain', 'application/json',
    ];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error(`File type ${file.mimetype} not allowed`));
  },
});

/**
 * POST /api/upload
 * Upload one or more files. Returns file info array.
 */
uploadRouter.post('/', upload.array('files', 10), (req, res) => {
  try {
    const files = (req.files as Express.Multer.File[]) || [];
    const result = files.map(f => ({
      file_id: path.parse(f.filename).name,
      original_name: f.originalname,
      file_name: f.filename,
      file_path: f.path,
      mime_type: f.mimetype,
      size: f.size,
    }));
    res.json({ files: result });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/upload/:filename
 * Serve an uploaded file by filename.
 */
uploadRouter.get('/:filename', (req, res) => {
  const filePath = path.join(UPLOAD_DIR, req.params.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  res.sendFile(filePath);
});
