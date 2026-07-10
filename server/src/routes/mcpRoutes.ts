import { Router } from 'express';
import * as db from '../db';
import { randomUUID } from 'crypto';

export const mcpRouter = Router();

// GET /api/mcp-configs
mcpRouter.get('/', async (_req, res) => {
  try {
    const rows = await db.allAsync<any>('SELECT * FROM mcp_configs ORDER BY created_at DESC', []);
    res.json({ configs: rows });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// POST /api/mcp-configs
mcpRouter.post('/', async (req, res) => {
  const { name, command, args = '', env, description } = req.body;
  if (!name || !command) return res.status(400).json({ error: 'name 和 command 为必填项' });
  try {
    const id = randomUUID();
    await db.runAsync(
      `INSERT INTO mcp_configs (id, name, command, args, env, description)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET command=excluded.command, args=excluded.args,
         env=excluded.env, description=excluded.description`,
      [id, name, command, args, env ? JSON.stringify(env) : null, description || null]
    );
    const row = await db.getAsync<any>('SELECT * FROM mcp_configs WHERE name=?', [name]);
    res.json({ config: row });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// PUT /api/mcp-configs/:id
mcpRouter.put('/:id', async (req, res) => {
  const { name, command, args, env, description } = req.body;
  try {
    await db.runAsync(
      `UPDATE mcp_configs SET name=?, command=?, args=?, env=?, description=? WHERE id=?`,
      [name, command, args ?? '', env ? JSON.stringify(env) : null, description || null, req.params.id]
    );
    const row = await db.getAsync<any>('SELECT * FROM mcp_configs WHERE id=?', [req.params.id]);
    res.json({ config: row });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/mcp-configs/:id
mcpRouter.delete('/:id', async (req, res) => {
  try {
    await db.runAsync('DELETE FROM mcp_configs WHERE id=?', [req.params.id]);
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// POST /api/mcp-configs/from-progress  ← 沙箱完成后自动解析 mcporter 配置
mcpRouter.post('/from-progress', async (req, res) => {
  const { events } = req.body as { events: Array<{ step: string; detail: string }> };
  if (!Array.isArray(events)) return res.status(400).json({ error: 'events required' });
  const saved: string[] = [];
  for (const e of events) {
    const m = (e.detail || '').match(
      /mcporter\s+config\s+add\s+(\S+)\s+--command\s+(\S+)(?:\s+--args\s+'([^']*)')?/
    );
    if (m) {
      const [, name, command, args = ''] = m;
      try {
        await db.runAsync(
          `INSERT INTO mcp_configs (id, name, command, args)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(name) DO UPDATE SET command=excluded.command, args=excluded.args`,
          [randomUUID(), name, command, args]
        );
        saved.push(name);
      } catch { /* ignore */ }
    }
  }
  res.json({ saved });
});
