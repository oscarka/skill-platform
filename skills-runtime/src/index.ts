/**
 * skills-runtime/src/index.ts
 * 独立的 Skills 执行运行时服务
 * 与主服务完全隔离 — 即使这里崩溃，主服务不受影响
 */
import express from 'express';
import { executeSkill } from './executor';

const app = express();
app.use(express.json({ limit: '10mb' }));

const PORT = parseInt(process.env.PORT || '8090');

// ─── 健康检查 ─────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'skills-runtime' });
});

// ─── 执行 Skill ───────────────────────────────────────────────────────────────
// POST /execute/:skillId  body: { inputs, skill_md, model, api_key, api_base }
app.post('/execute/:skillId', async (req, res) => {
  const { skillId } = req.params;
  const { inputs = {}, skill_md = '', model, api_key, api_base } = req.body;

  if (!skill_md) {
    return res.status(400).json({ error: 'skill_md is required' });
  }

  try {
    const result = await executeSkill({ skillId, skillMd: skill_md, inputs, model, apiKey: api_key, apiBase: api_base });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── 已安装 Skills 列表 ───────────────────────────────────────────────────────
app.get('/skills', (_req, res) => {
  // TODO: 从本地目录读取已安装的 skills
  res.json({ skills: [] });
});

app.listen(PORT, () => {
  console.log(`[skills-runtime] Running on port ${PORT}`);
});
