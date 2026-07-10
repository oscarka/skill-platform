import express from 'express';
import * as db from '../db';

export const settingsRouter = express.Router();

const ALLOWED_KEYS = [
  'gemini_api_key',
  'doubao_api_key',
  'doubao_base_url',
  'deepseek_api_key',
  'deepseek_base_url',
  'default_model',
  'ticket_expiry_days',
  'h5_base_url',
];

/**
 * GET /api/settings
 * Returns all settings. API keys are masked (show last 4 chars only).
 */
settingsRouter.get('/', async (_req, res) => {
  try {
    const rows = await db.allAsync<{ key: string; value: string; updated_at: number }>(
      'SELECT key, value, updated_at FROM settings ORDER BY key'
    );
    // Mask API keys
    const result = rows.map(r => ({
      key: r.key,
      value: r.key.includes('api_key') && r.value
        ? '****' + r.value.slice(-4)
        : r.value,
      configured: !!r.value,
      updated_at: r.updated_at,
    }));
    // Also include unconfigured keys from ALLOWED_KEYS
    const configuredKeys = new Set(rows.map(r => r.key));
    for (const k of ALLOWED_KEYS) {
      if (!configuredKeys.has(k)) {
        result.push({ key: k, value: '', configured: false, updated_at: 0 });
      }
    }
    result.sort((a, b) => a.key.localeCompare(b.key));
    res.json({ settings: result });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /api/settings
 * Update one or more settings.
 * Body: { key: string, value: string }[]  OR  { [key]: value }
 */
settingsRouter.put('/', async (req, res) => {
  try {
    const body = req.body;
    const updates: { key: string; value: string }[] = [];

    if (Array.isArray(body)) {
      updates.push(...body);
    } else if (typeof body === 'object') {
      for (const [k, v] of Object.entries(body)) {
        updates.push({ key: k, value: String(v) });
      }
    }

    for (const { key, value } of updates) {
      if (!ALLOWED_KEYS.includes(key)) {
        return res.status(400).json({ error: `Unknown setting key: "${key}"` });
      }
      // 防止掩码值被写回 DB（GET 接口返回 ****xxxx，前端可能原样提交）
      if (key.includes('api_key') && value.startsWith('****')) {
        continue; // 跳过掩码值，保留 DB 中的真实 key
      }
      await db.runAsync(
        'INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)',
        [key, value, Date.now()]
      );
    }

    res.json({ success: true, updated: updates.map(u => u.key) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/settings/models
 * Returns available model options (for frontend dropdowns).
 */
settingsRouter.get('/models', (_req, res) => {
  res.json({
    models: [
      { id: 'gemini-2.0-flash',              provider: 'gemini',   label: 'Gemini 2.0 Flash（多模态）' },
      { id: 'gemini-2.5-flash',              provider: 'gemini',   label: 'Gemini 2.5 Flash' },
      { id: 'doubao-seed-1-8-251228',        provider: 'doubao',   label: '豆包 Seed 1.8 ✅（推荐，速度+质量均衡）' },
      { id: 'doubao-seed-2-1-pro-260628',    provider: 'doubao',   label: '豆包 Seed 2.1 Pro（最新旗舰，推理强，较慢）' },
      { id: 'doubao-1-5-pro-32k-250115',     provider: 'doubao',   label: '豆包 1.5 Pro 32K（速度快，备用）' },
      { id: 'doubao-1-5-lite-32k-250115',    provider: 'doubao',   label: '豆包 1.5 Lite 32K（低成本）' },
      { id: 'deepseek-chat',                 provider: 'deepseek', label: 'DeepSeek Chat' },
      { id: 'deepseek-reasoner',             provider: 'deepseek', label: 'DeepSeek Reasoner（复杂推理）' },
    ]
  });
});
