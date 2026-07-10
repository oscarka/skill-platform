import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { initDb } from './db';
import { settingsRouter } from './routes/settingsRoutes';
import { skillRouter } from './routes/skillRoutes';
import { uploadRouter } from './routes/uploadRoutes';
import { ticketRouter } from './routes/ticketRoutes';
import { h5Router } from './routes/h5Routes';
import { resultRouter } from './routes/resultRoutes';
import { testRouter } from './routes/testRoutes';

const app = express();
const PORT = parseInt(process.env.PORT || '3100', 10);

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ─── Static: H5 client pages ─────────────────────────────────────────────────
const H5_DIR = path.resolve(__dirname, '..', '..', '..', 'h5');
app.use('/h5', express.static(H5_DIR));

// ─── API Routes ───────────────────────────────────────────────────────────────
app.use('/api/settings', settingsRouter);
app.use('/api/skills', skillRouter);
app.use('/api/upload', uploadRouter);
app.use('/api/tickets', ticketRouter);
app.use('/api/h5', h5Router);
app.use('/api/results', resultRouter);
app.use('/api/test', testRouter);

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: Date.now(), version: '1.0.0' });
});

// ─── Static: Web app (React build) — must come AFTER API routes ──────────────
// In production (Cloud Run), web/dist is copied to ./public
const WEB_DIST = path.resolve(__dirname, '..', 'public');
if (require('fs').existsSync(WEB_DIST)) {
  app.use(express.static(WEB_DIST));
  // SPA fallback — all non-API routes return index.html (app.use, not app.get('*'))
  app.use((_req, res) => {
    res.sendFile(path.join(WEB_DIST, 'index.html'));
  });
  console.log('[App] Serving web app from', WEB_DIST);
}

// ─── Error handler ────────────────────────────────────────────────────────────
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[Error]', err);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

// ─── Start ────────────────────────────────────────────────────────────────────
async function start() {
  await Promise.resolve(initDb());
  app.listen(PORT, () => {
    console.log(`\n🚀 Skill Platform API running at http://localhost:${PORT}`);
    console.log(`   Health: http://localhost:${PORT}/api/health`);
    console.log(`   Skills: http://localhost:${PORT}/api/skills`);
    console.log(`   Settings: http://localhost:${PORT}/api/settings\n`);
  });
}

start().catch(err => {
  console.error('[Fatal]', err);
  process.exit(1);
});
