import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import * as db from '../db';
import { runAI } from '../aiRunner';
import { runSandboxTest } from '../sandboxService';
import { getBundleStatus, buildBundle, markBundleReady, markBundleFailed, getBucketName } from '../bundleService';
import { readDisplayTranscript, readFullTranscript, readSpillFile, listTranscripts, summarizeTranscript } from '../transcriptService';
import https from 'https';
import http from 'http';

export const skillRouter = express.Router();

export interface SkillRecord {
  id: string;
  name: string;
  version: string;
  description?: string;
  category?: string;
  type: 'internal' | 'external';
  skill_type: 'prompt' | 'code' | 'plugin';
  author_name?: string;
  status: 'pending' | 'reviewing' | 'published' | 'rejected' | 'disabled';
  prompt_template?: string;
  code?: string;
  h5_config?: string;
  plugin_config?: string;
  preferred_model?: string;
  fallback_model?: string;
  test_inputs?: string;
  ai_review?: string;
  reject_reason?: string;
  created_at: number;
  updated_at: number;
  published_at?: number;
  sandbox_status?: 'none' | 'running' | 'done' | 'failed';
  sandbox_test?: string;
  content?: string;
  bundle_version?: number;
  bundle_path?: string;
  bundle_status?: 'none' | 'building' | 'ready' | 'failed';
  installed_at?: number;
}

// ─── ClaWHub API client ────────────────────────────────────────────────────────
const CLAWHUB_BASE = 'https://clawhub.ai';

async function clawhubApiGet(path: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const url = `${CLAWHUB_BASE}${path}`;
    https.get(url, {
      headers: {
        'User-Agent': 'SkillPlatform/1.0',
        'Accept': 'application/json',
      }
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`ClaWHub API parse error: ${data.slice(0, 200)}`)); }
      });
    }).on('error', reject);
  });
}

const clawhubApi = {
  // Search skills: GET /api/v1/skills?q=...&limit=N
  search: (q: string, limit = 10) =>
    clawhubApiGet(`/api/v1/skills?q=${encodeURIComponent(q)}&limit=${limit}`),

  // Get skill detail by slug: GET /api/v1/skills/{slug}
  // Returns skill.description = full SKILL.md content
  detail: (slug: string) =>
    clawhubApiGet(`/api/v1/skills/${encodeURIComponent(slug)}`),
};

/** Sanitize a skill record for API response (remove raw code for list views) */
function sanitize(skill: SkillRecord, full = false) {
  const base = {
    id: skill.id,
    name: skill.name,
    version: skill.version,
    description: skill.description,
    category: skill.category,
    type: skill.type,
    skill_type: skill.skill_type,
    author_name: skill.author_name,
    status: skill.status,
    preferred_model: skill.preferred_model,
    fallback_model: skill.fallback_model,
    h5_config: skill.h5_config ? JSON.parse(skill.h5_config) : null,
    ai_review: skill.ai_review ? JSON.parse(skill.ai_review) : null,
    reject_reason: skill.reject_reason,
    created_at: skill.created_at,
    updated_at: skill.updated_at,
    published_at: skill.published_at,
    sandbox_status: skill.sandbox_status || 'none',
    sandbox_test: skill.sandbox_test || null,
    bundle_status: skill.bundle_status || 'none',
    bundle_version: skill.bundle_version || 0,
    bundle_path: skill.bundle_path || null,
    installed_at: skill.installed_at || null,
  };
  if (full) {
    return {
      ...base,
      prompt_template: skill.prompt_template,
      code: skill.code,
      test_inputs: skill.test_inputs ? JSON.parse(skill.test_inputs) : null,
    };
  }
  return base;
}

// ─── GET /api/skills ──────────────────────────────────────────────────────────
skillRouter.get('/', async (req, res) => {
  try {
    const { type, status, q } = req.query as Record<string, string>;
    let sql = 'SELECT * FROM skills WHERE 1=1';
    const params: any[] = [];
    if (type) { sql += ' AND type=?'; params.push(type); }
    if (status) { sql += ' AND status=?'; params.push(status); }
    if (q) { sql += ' AND (name LIKE ? OR description LIKE ?)'; params.push(`%${q}%`, `%${q}%`); }
    sql += ' ORDER BY created_at DESC';
    const skills = await db.allAsync<SkillRecord>(sql, params);
    res.json({ skills: skills.map(s => sanitize(s)) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/skills/clawhub-search ──────────────────────────────────────────
// Search ClaWHub marketplace
skillRouter.get('/clawhub-search', async (req, res) => {
  try {
    const q = (req.query.q as string) || '';
    const limit = Math.min(parseInt(req.query.limit as string || '20'), 50);
    const data = await clawhubApi.search(q, limit);
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/skills/clawhub-install ────────────────────────────────────────
// Install a skill from ClaWHub by slug using the real ClaWHub API
skillRouter.post('/clawhub-install', async (req, res) => {
  try {
    const { slug, type = 'external' } = req.body;
    if (!slug) return res.status(400).json({ error: 'slug is required (e.g. "claw-markdown-preview")' });

    // Fetch skill detail from ClaWHub API
    const detail = await clawhubApi.detail(slug);
    if (!detail?.skill) {
      return res.status(404).json({ error: `Skill "${slug}" not found on ClaWHub` });
    }

    const skillInfo = detail.skill;
    const content = skillInfo.description || skillInfo.summary || '';
    if (!content || content.length < 20) {
      return res.status(400).json({ error: 'Skill has no content (description/SKILL.md is empty)' });
    }

    const name = skillInfo.displayName || slug;
    const author = detail.owner?.handle || '';
    const version = skillInfo.latestVersion?.version || skillInfo.tags?.latest || '1.0.0';
    const installCmd = `openclaw skills install ${author ? '@' + author + '/' : ''}${slug}`;

    const promptTemplate = `${content}

---
**当前任务输入：**
{{user_input}}

请根据以上 Skill 规范，处理用户的请求并给出结构化结果。`;

    const id = uuidv4();
    const now = Date.now();
    const pluginConfig = {
      source: 'clawhub',
      clawhub_url: `https://clawhub.com/${slug}`,
      clawhub_slug: slug,
      install_cmd: installCmd,
      original_author: author,
      original_version: version,
      stats: skillInfo.stats,
      topics: skillInfo.topics,
    };

    await db.runAsync(
      `INSERT INTO skills
        (id, name, version, description, category, type, skill_type, author_name,
         status, prompt_template, code, plugin_config, preferred_model, fallback_model,
         created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, name, version,
       skillInfo.summary || `ClaWHub Skill: ${name}`,
       skillInfo.topics?.[0] || 'clawhub', type, 'plugin', author || 'clawhub',
       'pending', promptTemplate, null,
       JSON.stringify(pluginConfig), null, null,
       now, now]
    );

    const skill = await db.getAsync<SkillRecord>('SELECT * FROM skills WHERE id=?', [id]);
    res.status(201).json({
      skill: sanitize(skill!, true),
      clawhub: {
        slug,
        name,
        author,
        version,
        installCmd,
        contentLength: content.length,
        stats: skillInfo.stats,
        preview: content.slice(0, 400) + (content.length > 400 ? '...' : ''),
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/skills/import-clawhub ─────────────────────────────────────────
// 支持三种模式：url（页面链接）/ slug（直接 slug）/ skill_content（粘贴 SKILL.md）
skillRouter.post('/import-clawhub', async (req, res) => {
  try {
    let { url, slug, type = 'external', skill_content, skill_name, skill_author } = req.body;

    // ── 从 CLI 命令提取 slug ─────────────────────────────────────────────────
    // 支持格式：openclaw skills install @a2mus/stitch-ui-designer
    if (!slug && url && url.trim().startsWith('openclaw')) {
      const tokens = url.trim().split(/\s+/);
      const pkg = tokens[tokens.length - 1]; // 最后一个词 e.g. "@a2mus/stitch-ui-designer"
      // 去掉 @ 和 author/ 前缀，只取 skill 部分
      slug = pkg.replace(/^@?[^/]+\//, '').replace(/^@/, '');
    }

    // ── 从 URL 提取 slug ──────────────────────────────────────────────────────
    // 支持格式：
    //   https://clawhub.ai/scrapfly-alerting
    //   https://clawhub.ai/skills/scrapfly-alerting
    //   https://clawhub.com/agistack/medical  → 先试 "medical", 再试 "agistack/medical"
    if (!slug && url && !url.trim().startsWith('openclaw')) {
      try {
        const u = new URL(url.trim());
        const parts = u.pathname.replace(/^\//, '').replace(/\/$/, '').split('/').filter(Boolean);
        // 去掉 "skills" 前缀段
        const pathParts = parts.filter(p => p !== 'skills');
        slug = pathParts.join('/');  // e.g. "scrapfly-alerting" or "agistack/medical"
      } catch {
        // 可能是纯 slug 如 "stitch-ui-designer"，直接使用
        slug = url.trim();
      }
    }

    // ── URL/Slug 模式：从 ClawHub API 获取 ───────────────────────────────────
    if (slug) {
      let detail: any = null;

      // 先尝试完整 slug，如果失败再试最后一段（兼容 owner/skill 格式）
      try { detail = await clawhubApi.detail(slug); } catch {}
      if (!detail?.skill && slug.includes('/')) {
        const lastPart = slug.split('/').pop()!;
        try { detail = await clawhubApi.detail(lastPart); } catch {}
        if (detail?.skill) slug = lastPart;
      }

      if (!detail?.skill) return res.status(404).json({ error: `Skill "${slug}" 在 ClaWHub 上找不到，请确认链接` });

      const skillInfo = detail.skill;
      // description 字段 = 完整 SKILL.md 内容（含 YAML frontmatter）
      const skillMd  = skillInfo.description || skillInfo.summary || '';
      const name     = skillInfo.displayName || slug;
      const author   = detail.owner?.handle || '';
      const version  = detail.latestVersion?.version || skillInfo.latestVersion?.version || '1.0.0';
      const summary  = skillInfo.summary || `ClawHub Skill: ${name}`;

      // prompt_template 存原始 SKILL.md，sandbox 直接用此内容
      const promptTemplate = skillMd;

      const id = uuidv4();
      const now = Date.now();
      await db.runAsync(
        `INSERT INTO skills (id,name,version,description,category,type,skill_type,author_name,status,prompt_template,code,plugin_config,preferred_model,fallback_model,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id, name, version, summary, 'clawhub', type, 'plugin', author || 'clawhub', 'pending',
         promptTemplate, null,
         JSON.stringify({ source: 'clawhub', slug, install_cmd: `openclaw skills install ${slug}`, original_author: author }),
         null, null, now, now]
      );
      const skill = await db.getAsync<SkillRecord>('SELECT * FROM skills WHERE id=?', [id]);
      return res.status(201).json({
        skill: sanitize(skill!, true),
        clawhub: { slug, name, author, version, contentLength: skillMd.length, preview: skillMd.slice(0, 400) + '...' }
      });
    }

    // ── 粘贴模式：用户直接贴入 SKILL.md 文本 ─────────────────────────────────
    if (!skill_content || skill_content.length < 30) {
      return res.status(400).json({ error: '请提供 ClawHub skill 链接（URL）或粘贴 SKILL.md 内容' });
    }
    const id  = uuidv4();
    const now = Date.now();
    const name   = skill_name || 'Imported Skill';
    const author = skill_author || 'unknown';
    await db.runAsync(
      `INSERT INTO skills (id,name,version,description,category,type,skill_type,author_name,status,prompt_template,code,plugin_config,preferred_model,fallback_model,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, name, '1.0.0', skill_content.slice(0, 200).replace(/\n/g, ' '), 'clawhub-paste', type, 'plugin',
       author, 'pending', skill_content, null,
       JSON.stringify({ source: 'paste', original_author: author }),
       null, null, now, now]
    );
    const skill = await db.getAsync<SkillRecord>('SELECT * FROM skills WHERE id=?', [id]);
    res.status(201).json({ skill: sanitize(skill!, true), parsed: { name, author, contentLength: skill_content.length, preview: skill_content.slice(0, 400) + '...' } });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});




// ─── GET /api/skills/:id ──────────────────────────────────────────────────────
skillRouter.get('/:id', async (req, res) => {
  try {
    const skill = await db.getAsync<SkillRecord>('SELECT * FROM skills WHERE id=?', [req.params.id]);
    if (!skill) return res.status(404).json({ error: 'Skill not found' });
    res.json({ skill: sanitize(skill, true) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/skills ─────────────────────────────────────────────────────────
// Create a new skill (status starts as 'pending')
skillRouter.post('/', async (req, res) => {
  try {
    const {
      name, description, category, type, skill_type,
      author_name, prompt_template, code, plugin_config,
      preferred_model, fallback_model, test_inputs,
    } = req.body;

    if (!name) return res.status(400).json({ error: '"name" is required' });
    if (!type || !['internal', 'external'].includes(type))
      return res.status(400).json({ error: '"type" must be internal or external' });
    if (!skill_type || !['prompt', 'code', 'plugin'].includes(skill_type))
      return res.status(400).json({ error: '"skill_type" must be prompt, code, or plugin' });
    if (skill_type === 'prompt' && !prompt_template)
      return res.status(400).json({ error: '"prompt_template" is required for prompt-type skills' });
    if (skill_type === 'code' && !code)
      return res.status(400).json({ error: '"code" is required for code-type skills' });
    // plugin type just needs a name + plugin_config (or code)

    const id = uuidv4();
    const now = Date.now();
    await db.runAsync(
      `INSERT INTO skills
        (id, name, version, description, category, type, skill_type, author_name,
         status, prompt_template, code, plugin_config, preferred_model, fallback_model, test_inputs,
         created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, name, '1.0.0', description || null, category || null,
       type, skill_type, author_name || null,
       'pending', prompt_template || null, code || null,
       plugin_config ? JSON.stringify(plugin_config) : null,
       preferred_model || null, fallback_model || null,
       test_inputs ? JSON.stringify(test_inputs) : null,
       now, now]
    );
    const skill = await db.getAsync<SkillRecord>('SELECT * FROM skills WHERE id=?', [id]);
    res.status(201).json({ skill: sanitize(skill!, true) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PUT /api/skills/:id ──────────────────────────────────────────────────────
// Update an unpublished skill
skillRouter.put('/:id', async (req, res) => {
  try {
    const skill = await db.getAsync<SkillRecord>('SELECT * FROM skills WHERE id=?', [req.params.id]);
    if (!skill) return res.status(404).json({ error: 'Skill not found' });
    if (skill.status === 'published')
      return res.status(400).json({ error: 'Cannot edit a published skill. Create a new version.' });

    const { name, description, category, author_name,
            prompt_template, code, preferred_model, fallback_model, test_inputs } = req.body;
    await db.runAsync(
      `UPDATE skills SET name=COALESCE(?,name), description=COALESCE(?,description),
       category=COALESCE(?,category), author_name=COALESCE(?,author_name),
       prompt_template=COALESCE(?,prompt_template), code=COALESCE(?,code),
       preferred_model=COALESCE(?,preferred_model), fallback_model=COALESCE(?,fallback_model),
       test_inputs=COALESCE(?,test_inputs), updated_at=?
       WHERE id=?`,
      [name||null, description||null, category||null, author_name||null,
       prompt_template||null, code||null, preferred_model||null, fallback_model||null,
       test_inputs ? JSON.stringify(test_inputs) : null,
       Date.now(), req.params.id]
    );
    const updated = await db.getAsync<SkillRecord>('SELECT * FROM skills WHERE id=?', [req.params.id]);
    res.json({ skill: sanitize(updated!, true) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/skills/:id/review ─────────────────────────────────────────────
// Trigger AI review of the skill. Sets status to 'reviewing', runs AI, stores result.
skillRouter.post('/:id/review', async (req, res) => {
  try {
    const skill = await db.getAsync<SkillRecord>('SELECT * FROM skills WHERE id=?', [req.params.id]);
    if (!skill) return res.status(404).json({ error: 'Skill not found' });

    await db.runAsync(`UPDATE skills SET status='reviewing', updated_at=? WHERE id=?`, [Date.now(), skill.id]);

    const content = skill.skill_type === 'prompt' ? skill.prompt_template : skill.code;
    const testInputs = skill.test_inputs ? JSON.parse(skill.test_inputs) : null;

    const reviewPrompt = `你是一个 Skill 平台的 AI 评审专家。请对以下 Skill 进行全面评审。

## Skill 基本信息
- 名称：${skill.name}
- 类型：${skill.type === 'internal' ? '内部Skill（员工使用）' : '外部Skill（客户使用）'}
- 执行方式：${skill.skill_type === 'prompt' ? 'Prompt模板型' : '代码逻辑型'}
- 描述：${skill.description || '（未填写）'}

## Skill 内容
\`\`\`
${content}
\`\`\`

${testInputs ? `## 测试素材
${JSON.stringify(testInputs, null, 2)}` : ''}

## 请完成以下评审任务：

1. **格式检查**：内容是否完整，关键占位符是否合理（仅限Prompt型）
2. **逻辑评估**：能否完成描述中所述的任务
3. **质量打分**：0-100分，给出理由
4. **优点**：列举3-5条具体优点
5. **不足**：列举具体问题和改进建议
${skill.type === 'external' ? `6. **H5字段建议**：分析该Skill需要收集哪些客户信息和文件，给出建议的H5表单字段配置` : ''}

请以JSON格式返回，结构如下：
{
  "score": 85,
  "passed": true,
  "strengths": ["...", "..."],
  "weaknesses": ["...", "..."],
  "suggestions": ["...", "..."],
  "summary": "一段总体评述"${skill.type === 'external' ? `,
  "h5_config_suggestion": {
    "title": "...",
    "description": "...",
    "fields": [{ "key": "field_key", "label": "显示标签", "type": "text|number|textarea|select|date", "required": true, "options": [] }],
    "uploads": { "accept": ["application/pdf", "image/*"], "maxFiles": 3, "maxSizeMB": 20, "label": "上传说明" }
  }` : ''}
}`;

    let reviewResult: any;
    try {
      const aiRes = await runAI(reviewPrompt, {
        model: skill.preferred_model || undefined,
        fallback: skill.fallback_model || undefined,
        systemPrompt: '你是 Skill 平台的 AI 评审助手，请只返回合法 JSON，不要有其他文字。',
      });
      const jsonMatch = aiRes.text.match(/\{[\s\S]*\}/);
      reviewResult = jsonMatch ? JSON.parse(jsonMatch[0]) : { score: 0, passed: false, summary: aiRes.text };
    } catch (aiErr: any) {
      reviewResult = { score: 0, passed: false, summary: `AI评审失败: ${aiErr.message}` };
    }

    const finalStatus = reviewResult.passed ? 'approved' : 'rejected';
    await db.runAsync(
      `UPDATE skills SET ai_review=?, status=?, updated_at=? WHERE id=?`,
      [JSON.stringify(reviewResult), finalStatus, Date.now(), skill.id]
    );

    const updated = await db.getAsync<SkillRecord>('SELECT * FROM skills WHERE id=?', [skill.id]);
    res.json({ skill: sanitize(updated!, true), review: reviewResult });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PUT /api/skills/:id/h5-config ───────────────────────────────────────────
// Save the confirmed H5 config (for external skills, before publish)
skillRouter.put('/:id/h5-config', async (req, res) => {
  try {
    const { h5_config } = req.body;
    if (!h5_config) return res.status(400).json({ error: 'h5_config is required' });
    const skill = await db.getAsync<SkillRecord>('SELECT id, type FROM skills WHERE id=?', [req.params.id]);
    if (!skill) return res.status(404).json({ error: 'Skill not found' });
    if (skill.type !== 'external')
      return res.status(400).json({ error: 'h5_config only applies to external skills' });
    await db.runAsync(
      `UPDATE skills SET h5_config=?, updated_at=? WHERE id=?`,
      [JSON.stringify(h5_config), Date.now(), req.params.id]
    );
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PUT /api/skills/:id/publish ─────────────────────────────────────────────
skillRouter.put('/:id/publish', async (req, res) => {
  try {
    const skill = await db.getAsync<SkillRecord>('SELECT * FROM skills WHERE id=?', [req.params.id]);
    if (!skill) return res.status(404).json({ error: 'Skill not found' });
    if (skill.status === 'published')
      return res.status(400).json({ error: 'Skill is already published' });
    // External skills must have h5_config before publishing
    if (skill.type === 'external' && !skill.h5_config)
      return res.status(400).json({ error: 'External skills must have H5 config before publishing' });

    const now = Date.now();
    await db.runAsync(
      `UPDATE skills SET status='published', published_at=?, updated_at=? WHERE id=?`,
      [now, now, req.params.id]
    );
    const updated = await db.getAsync<SkillRecord>('SELECT * FROM skills WHERE id=?', [req.params.id]);
    res.json({ skill: sanitize(updated!, true) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PUT /api/skills/:id/reject ──────────────────────────────────────────────
skillRouter.put('/:id/reject', async (req, res) => {
  try {
    const { reason } = req.body;
    if (!reason) return res.status(400).json({ error: 'Rejection reason is required' });
    const skill = await db.getAsync<SkillRecord>('SELECT * FROM skills WHERE id=?', [req.params.id]);
    if (!skill) return res.status(404).json({ error: 'Skill not found' });

    await db.runAsync(
      `UPDATE skills SET status='rejected', reject_reason=?, updated_at=? WHERE id=?`,
      [reason, Date.now(), req.params.id]
    );
    const updated = await db.getAsync<SkillRecord>('SELECT * FROM skills WHERE id=?', [req.params.id]);
    res.json({ skill: sanitize(updated!, true) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE /api/skills/:id ──────────────────────────────────────────────────
skillRouter.delete('/:id', async (req, res) => {
  try {
    const skill = await db.getAsync<{ id: string }>('SELECT id FROM skills WHERE id=?', [req.params.id]);
    if (!skill) return res.status(404).json({ error: 'Skill not found' });
    await db.runAsync('DELETE FROM skills WHERE id=?', [req.params.id]);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});


// ─── POST /api/skills/:id/sandbox-test ───────────────────────────────────────
// 触发沙箱测试（异步，立即返回 202）
// body 可选：{ oauthTokens: JSON.stringify({google: {access_token, refresh_token, ...}}) }
skillRouter.post('/:id/sandbox-test', async (req, res) => {
  try {
    const skill = await db.getAsync<SkillRecord>('SELECT * FROM skills WHERE id=?', [req.params.id]);
    if (!skill) return res.status(404).json({ error: 'Skill not found' });

    if (skill.sandbox_status === 'running') {
      return res.status(409).json({ error: 'Sandbox test already running' });
    }

    const content = (skill as any).prompt_template || (skill as any).code || '';
    if (!content) {
      return res.status(400).json({ error: 'Skill has no content to test' });
    }

    // 可选：管理员授权后传入 OAuth tokens，注入沙箱供 MCP 工具使用
    const oauthTokens: string | undefined = req.body?.oauthTokens || undefined;

    res.status(202).json({ message: 'Sandbox test started', skillId: skill.id });

    runSandboxTest(skill.id, oauthTokens).catch(err => {
      console.error('[SandboxRoute] Unhandled error:', err.message);
    });

  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
// ─── POST /api/skills/:id/install ─────────────────────────────────────────────
// 审核通过后安装 Skill Bundle → 打包依赖上传 GCS
skillRouter.post('/:id/install', async (req, res) => {
  try {
    const skill = await db.getAsync<any>('SELECT id, name, status, content, bundle_status, bundle_version FROM skills WHERE id=?', [req.params.id]);
    if (!skill) return res.status(404).json({ error: 'Skill not found' });
    if (skill.bundle_status === 'building') return res.status(409).json({ error: '正在安装中，请稍候' });

    await buildBundle(skill.id);
    res.json({ message: '安装已触发', skillId: skill.id });

    // 异步执行沙箱安装
    runSandboxTest(skill.id).then(async (result: any) => {
      if (result?.passed) {
        const bundlePath = `gs://${getBucketName()}/${skill.id}/v${(skill.bundle_version || 0) + 1}.tar.gz`;
        await markBundleReady(skill.id, bundlePath);
        console.log(`[Bundle] Skill "${skill.name}" installed: ${bundlePath}`);
      } else {
        await markBundleFailed(skill.id);
      }
    }).catch(async () => {
      await markBundleFailed(skill.id);
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
// ─── POST /api/skills/:id/sandbox-callback ───────────────────────────────────
// 接收两种消息：
//   1. type="progress"  → 把 event 追加到 sandbox_progress（实时进度）
//   2. type="result"    → 写入最终测试结果到 sandbox_test
skillRouter.post('/:id/sandbox-callback', async (req, res) => {
  try {
    const EXPECTED_SECRET = process.env.SANDBOX_SECRET || 'sandbox-secret-2024';
    const headerSecret = req.headers['x-sandbox-secret'] || '';
    const bodySecret   = req.body?.secret || '';
    if (headerSecret !== EXPECTED_SECRET && bodySecret !== EXPECTED_SECRET) {
      return res.status(403).json({ error: 'forbidden' });
    }

    const id = req.params.id;

    // ── 进度事件（runner.py 每个 turn/tool 都会 POST 一次）──────────────────
    if (req.body?.type === 'progress' && req.body?.event) {
      const event = req.body.event;
      const row = await db.getAsync<any>('SELECT sandbox_progress FROM skills WHERE id=?', [id]);
      const events: object[] = row?.sandbox_progress ? JSON.parse(row.sandbox_progress) : [];
      events.push(event);
      await db.runAsync(
        `UPDATE skills SET sandbox_progress=?, updated_at=? WHERE id=?`,
        [JSON.stringify(events), Date.now(), id]
      );
      return res.json({ ok: true, appended: true });
    }

    // ── 最终结果（runner.py 执行完毕 POST 一次）───────────────────────────────
    const body = req.body;
    const { passed, output, duration_ms, tested_at, transcript, transcript_gcs, testInput, model } = body;
    const result = {
      skillId: id,
      passed,
      output,
      transcript: transcript || [],        // 截断版对话记录（给前端展示）
      transcript_gcs: transcript_gcs || null,  // GCS 完整版路径
      testInput: testInput || null,        // AI 生成的测试输入
      model: model || null,               // 使用的模型名
      durationMs: duration_ms,
      testedAt: tested_at,
    };
    await db.runAsync(
      `UPDATE skills SET sandbox_test=?, sandbox_status=?, updated_at=? WHERE id=?`,
      [JSON.stringify(result), 'done', Date.now(), id]
    );
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/skills/:id/sandbox-progress ────────────────────────────────────
// 前端轮询获取沙箱测试进度
skillRouter.get('/:id/sandbox-progress', async (req, res) => {
  try {
    const row = await db.getAsync<any>(
      'SELECT sandbox_status, sandbox_progress FROM skills WHERE id=?',
      [req.params.id]
    );
    if (!row) return res.status(404).json({ error: 'Skill not found' });
    const events = row.sandbox_progress ? JSON.parse(row.sandbox_progress) : [];
    res.json({ status: row.sandbox_status, events });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/skills/:id/upload-scripts ─────────────────────────────────────
// 用户上传 skill zip/tar.gz 包，解压后把 scripts/ 路径记录到 DB
// 请求体：multipart/form-data，字段名 "archive"
skillRouter.post('/:id/upload-scripts', async (req, res) => {
  try {
    const skill = await db.getAsync<SkillRecord>('SELECT * FROM skills WHERE id=?', [req.params.id]);
    if (!skill) return res.status(404).json({ error: 'Skill not found' });

    // 读取 raw body（base64 编码的 zip，前端用 FileReader.readAsDataURL）
    const { archiveBase64, filename } = req.body as { archiveBase64?: string; filename?: string };
    if (!archiveBase64) {
      return res.status(400).json({ error: 'archiveBase64 field required' });
    }

    const fs = await import('fs');
    const path = await import('path');
    const os = await import('os');
    const { execSync: exec2 } = await import('child_process');

    // 解压到临时目录
    const tmpDir = path.join(os.tmpdir(), `skill-scripts-${skill.id}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    // 写入 zip 文件
    const ext = (filename || 'archive.zip').endsWith('.gz') ? '.tar.gz' : '.zip';
    const archivePath = path.join(tmpDir, `archive${ext}`);
    const buf = Buffer.from(archiveBase64.replace(/^data:[^;]+;base64,/, ''), 'base64');
    fs.writeFileSync(archivePath, buf);

    // 解压
    if (ext === '.tar.gz') {
      exec2(`tar xzf ${archivePath} -C ${tmpDir} 2>/dev/null || true`);
    } else {
      exec2(`unzip -q -o ${archivePath} -d ${tmpDir} 2>/dev/null || true`);
    }

    // 找 scripts/ 目录（可能在根目录或子目录里）
    let scriptsPath = '';
    try {
      const result = exec2(`find ${tmpDir} -name "scripts" -type d | head -1`, { encoding: 'utf8' });
      scriptsPath = result.trim();
    } catch { /* ignore */ }

    if (!scriptsPath) {
      // scripts/ 不存在，就用解压根目录
      scriptsPath = tmpDir;
    }

    // 记录到 DB（存在 settings 表或 skill 的 metadata 字段）
    await db.runAsync('UPDATE skills SET scripts_path=?, updated_at=? WHERE id=?', [scriptsPath, Date.now(), skill.id]);

    return res.json({
      message: 'Scripts uploaded and extracted',
      scriptsPath,
      skillId: skill.id,
    });

  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/skills/:id/transcripts ──────────────────────────────────────────
// 列出某个 skill 的所有 transcript 记录
skillRouter.get('/:id/transcripts', async (req, res) => {
  try {
    const list = await listTranscripts(req.params.id);
    res.json({ transcripts: list });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/skills/:id/transcript/full ──────────────────────────────────────
// 读取完整版 transcript（从 GCS）
skillRouter.get('/:id/transcript/full', async (req, res) => {
  try {
    const skill = await db.getAsync<any>('SELECT sandbox_test FROM skills WHERE id=?', [req.params.id]);
    if (!skill) return res.status(404).json({ error: 'not found' });

    const st = skill.sandbox_test ? JSON.parse(skill.sandbox_test) : null;
    const gcsInfo = st?.transcript_gcs;
    if (!gcsInfo) return res.json({ entries: [], message: 'no GCS transcript available' });

    const entries = await readFullTranscript(gcsInfo);
    const summary = summarizeTranscript(entries);
    res.json({ entries, summary });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/skills/:id/transcript/spill/:entryId ───────────────────────────
// 读取 spill 文件（大输出的完整内容）
skillRouter.get('/:id/transcript/spill/:spillPath', async (req, res) => {
  try {
    const content = await readSpillFile(decodeURIComponent(req.params.spillPath));
    res.json({ content });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/skills/:id/preview ─────────────────────────────────────────────
// 管理员 staging 预览：返回 skill 的 prompt + 配置（无需审核通过）
skillRouter.get('/:id/preview', async (req, res) => {
  try {
    const skill = await db.getAsync<any>('SELECT * FROM skills WHERE id=?', [req.params.id]);
    if (!skill) return res.status(404).json({ error: 'Skill not found' });
    res.json({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      skill_type: skill.skill_type,
      type: skill.type,
      status: skill.status,
      prompt_template: skill.prompt_template || '',
      plugin_config: skill.plugin_config ? JSON.parse(skill.plugin_config) : null,
      requires: null,  // from SKILL.md frontmatter if parsed
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/skills/:id/preview/chat ───────────────────────────────────────
// 管理员 staging 预览：用 SKILL.md 作 system prompt，转发聊天消息给 AI
skillRouter.post('/:id/preview/chat', async (req, res) => {
  try {
    const skill = await db.getAsync<any>(
      'SELECT id, name, prompt_template, preferred_model FROM skills WHERE id=?',
      [req.params.id]
    );
    if (!skill) return res.status(404).json({ error: 'Skill not found' });

    const { messages = [], user_message } = req.body;
    if (!user_message && messages.length === 0) {
      return res.status(400).json({ error: 'messages or user_message required' });
    }

    // 从 settings 表拿 AI 配置
    const getSetting = (k: string) =>
      db.getAsync<{value: string}>('SELECT value FROM settings WHERE key=?', [k]).then(r => r?.value || '');
    const [apiKey, baseUrl, model] = await Promise.all([
      getSetting('doubao_api_key').then(k => k || getSetting('deepseek_api_key')),
      getSetting('doubao_base_url').then(u => u || getSetting('deepseek_base_url')),
      Promise.resolve(skill.preferred_model || ''),
    ]);
    const defaultModel = await getSetting('default_model');
    const targetModel = model || defaultModel || 'doubao-seed-1-8-251228';

    const systemPrompt = skill.prompt_template || `You are ${skill.name}.`;
    const chatMessages = [
      { role: 'system', content: systemPrompt },
      ...messages,
      ...(user_message ? [{ role: 'user', content: user_message }] : []),
    ];

    const aiRes = await fetch(`${baseUrl || 'https://ark.cn-beijing.volces.com/api/v3'}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: targetModel, messages: chatMessages }),
    });
    if (!aiRes.ok) {
      const err = await aiRes.text();
      return res.status(502).json({ error: `AI API error: ${err.slice(0, 200)}` });
    }
    const aiData = await aiRes.json() as any;
    const reply = aiData.choices?.[0]?.message?.content || '';
    res.json({ reply, model: targetModel });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/skills/:id/sandbox-cancel ─────────────────────────────────────
// 管理员手动停止沙箱测试：把状态标为 cancelled（Job 本身已超时或结束）
skillRouter.post('/:id/sandbox-cancel', async (req, res) => {
  try {
    const skill = await db.getAsync<any>('SELECT id, sandbox_status FROM skills WHERE id=?', [req.params.id]);
    if (!skill) return res.status(404).json({ error: 'Skill not found' });
    if (skill.sandbox_status !== 'running') {
      return res.json({ ok: true, message: 'not running' });
    }
    await db.runAsync(
      `UPDATE skills SET sandbox_status='cancelled', updated_at=? WHERE id=?`,
      [Date.now(), skill.id]
    );
    res.json({ ok: true, message: 'cancelled' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
