/**
 * server/src/routes/metaAgentRoutes.ts
 *
 * Meta-Agent 开放配置接口 — Phase 2
 * 提供候选 Agent 的完整生命周期管理 API。
 *
 * ⚠️ 所有写操作都只操作 meta_agents / meta_agent_eval_runs 两张隔离表，
 *    不修改 agent_profiles（生产在职员工表），除非明确执行 POST /approve。
 */

import express from 'express';
import * as db from '../db';

export const metaAgentRouter = express.Router();

// ─── 1. 列出所有候选 Agent ─────────────────────────────────────────────────
metaAgentRouter.get('/', async (_req, res) => {
  try {
    const rows = await db.allAsync<any>(
      `SELECT id, name, role_desc, status, current_score, best_score,
              total_eval_rounds, intent_prompt, created_at, updated_at
       FROM meta_agents ORDER BY created_at DESC`
    );
    res.json({ agents: rows, total: rows.length });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── 2. 创建候选 Agent（HR 开始招聘）────────────────────────────────────────
metaAgentRouter.post('/', async (req, res) => {
  try {
    const {
      id, name, role_desc, reply_style, service_flow = '',
      taboos = [], reassurance_tpl = '', skill_ids = [],
      routing_examples = [], delivery_config = {},
      knowledge_domain = '', intent_prompt = '',
    } = req.body;

    if (!id || !name || !role_desc || !reply_style) {
      return res.status(400).json({ error: 'id, name, role_desc, reply_style 为必填项' });
    }

    // 校验 id 格式
    if (!/^[a-z0-9_-]{3,64}$/.test(id)) {
      return res.status(400).json({ error: 'id 只允许小写字母、数字、下划线和连字符（3~64位）' });
    }

    const now = Date.now();
    await db.runAsync(
      `INSERT INTO meta_agents
         (id, name, role_desc, reply_style, service_flow, taboos, reassurance_tpl,
          skill_ids, routing_examples, delivery_config, knowledge_domain,
          intent_prompt, status, current_score, best_score, total_eval_rounds,
          created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'draft', 0, 0, 0, ?,?)`,
      [
        id, name, role_desc, reply_style,
        service_flow,
        JSON.stringify(taboos),
        reassurance_tpl,
        JSON.stringify(skill_ids),
        JSON.stringify(routing_examples),
        JSON.stringify(delivery_config),
        knowledge_domain,
        intent_prompt,
        now, now,
      ]
    );

    const created = await db.getAsync<any>('SELECT * FROM meta_agents WHERE id = ?', [id]);
    res.status(201).json(parseMetaAgent(created));
  } catch (err: any) {
    if (err.message?.includes('UNIQUE') || err.code === '23505') {
      return res.status(409).json({ error: `候选 Agent "${req.body.id}" 已存在` });
    }
    res.status(500).json({ error: err.message });
  }
});

// ─── 3. 读取候选 Agent 详情 ───────────────────────────────────────────────
metaAgentRouter.get('/:id', async (req, res) => {
  try {
    const row = await db.getAsync<any>('SELECT * FROM meta_agents WHERE id = ?', [req.params.id]);
    if (!row) return res.status(404).json({ error: `候选 Agent "${req.params.id}" 不存在` });
    res.json(parseMetaAgent(row));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── 4. 更新候选 Agent 配置（Meta-Agent 每轮优化调用此接口）────────────────
metaAgentRouter.put('/:id', async (req, res) => {
  try {
    const row = await db.getAsync<any>('SELECT id FROM meta_agents WHERE id = ?', [req.params.id]);
    if (!row) return res.status(404).json({ error: `候选 Agent "${req.params.id}" 不存在` });

    const allowedFields = [
      'name', 'role_desc', 'reply_style', 'service_flow', 'taboos',
      'reassurance_tpl', 'skill_ids', 'routing_examples', 'delivery_config',
      'knowledge_domain', 'status', 'current_score', 'best_score', 'total_eval_rounds',
    ];

    const updates: string[] = [];
    const values: any[] = [];

    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updates.push(`${field} = ?`);
        const val = req.body[field];
        values.push(typeof val === 'object' ? JSON.stringify(val) : val);
      }
    }

    if (updates.length === 0) return res.status(400).json({ error: '没有可更新的字段' });

    updates.push('updated_at = ?');
    values.push(Date.now(), req.params.id);

    await db.runAsync(
      `UPDATE meta_agents SET ${updates.join(', ')} WHERE id = ?`,
      values
    );

    const updated = await db.getAsync<any>('SELECT * FROM meta_agents WHERE id = ?', [req.params.id]);
    res.json(parseMetaAgent(updated));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── 5. 保存一轮 Eval Run 日志 ────────────────────────────────────────────
metaAgentRouter.post('/:id/eval-runs', async (req, res) => {
  try {
    const agentRow = await db.getAsync<any>('SELECT id FROM meta_agents WHERE id = ?', [req.params.id]);
    if (!agentRow) return res.status(404).json({ error: `候选 Agent "${req.params.id}" 不存在` });

    const { run_id, round, agent_version, total_score, score_compliance, score_business,
            score_ticket_skill, score_memory, taboo_violated, taboo_violations,
            passed_cases, failed_cases, total_cases, case_results, diagnosis } = req.body;

    const now = Date.now();
    await db.runAsync(
      `INSERT INTO meta_agent_eval_runs
         (run_id, agent_id, round, agent_version, total_score, score_compliance,
          score_business, score_ticket_skill, score_memory, taboo_violated, taboo_violations,
          passed_cases, failed_cases, total_cases, case_results, diagnosis, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        run_id, req.params.id, round, agent_version,
        total_score, score_compliance, score_business, score_ticket_skill, score_memory,
        taboo_violated ? 1 : 0,
        JSON.stringify(taboo_violations || []),
        passed_cases, failed_cases, total_cases,
        JSON.stringify(case_results || []),
        diagnosis || '',
        now,
      ]
    );

    // 同步更新候选 Agent 的轮次与分数
    await db.runAsync(
      `UPDATE meta_agents SET total_eval_rounds = ?, current_score = ?, updated_at = ?
       WHERE id = ?`,
      [round, total_score, now, req.params.id]
    );

    res.status(201).json({ success: true, run_id });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── 6. 读取候选 Agent 所有 Eval Run 日志（用于看板展示）─────────────────
metaAgentRouter.get('/:id/eval-runs', async (req, res) => {
  try {
    const runs = await db.allAsync<any>(
      `SELECT run_id, round, agent_version, total_score, score_compliance,
              score_business, score_ticket_skill, score_memory, taboo_violated,
              passed_cases, failed_cases, total_cases, created_at
       FROM meta_agent_eval_runs WHERE agent_id = ? ORDER BY round ASC`,
      [req.params.id]
    );
    res.json({ runs, total: runs.length });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── 7. 读取单轮 Eval Run 详情（包含每道题结果）────────────────────────────
metaAgentRouter.get('/:id/eval-runs/:runId', async (req, res) => {
  try {
    const run = await db.getAsync<any>(
      'SELECT * FROM meta_agent_eval_runs WHERE run_id = ? AND agent_id = ?',
      [req.params.runId, req.params.id]
    );
    if (!run) return res.status(404).json({ error: '评测记录不存在' });

    res.json({
      ...run,
      taboo_violations: JSON.parse(run.taboo_violations || '[]'),
      case_results: JSON.parse(run.case_results || '[]'),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── 8. 人类终审批准转正 ──────────────────────────────────────────────────
metaAgentRouter.post('/:id/approve', async (req, res) => {
  try {
    const meta = await db.getAsync<any>('SELECT * FROM meta_agents WHERE id = ?', [req.params.id]);
    if (!meta) return res.status(404).json({ error: `候选 Agent "${req.params.id}" 不存在` });

    if (meta.status !== 'pending_human_approval') {
      return res.status(400).json({
        error: `候选 Agent 当前状态为 "${meta.status}"，只有 pending_human_approval 状态才可转正`,
      });
    }

    const now = Date.now();

    // 将候选 Agent 的最优配置写入正式 agent_profiles 表
    const taboos = JSON.parse(meta.taboos || '[]');
    const skillIds = JSON.parse(meta.skill_ids || '[]');
    const routingExamples = meta.routing_examples || null;

    // 检查 agent_profiles 是否已存在
    const existing = await db.getAsync<any>(
      'SELECT id FROM agent_profiles WHERE id = ?', [meta.id]
    );

    if (existing) {
      await db.runAsync(
        `UPDATE agent_profiles SET name=?, role_desc=?, reply_style=?, service_flow=?,
         taboos=?, reassurance_tpl=?, routing_examples=?, updated_at=? WHERE id=?`,
        [meta.name, meta.role_desc, meta.reply_style, meta.service_flow,
         JSON.stringify(taboos), meta.reassurance_tpl, routingExamples, now, meta.id]
      );
    } else {
      await db.runAsync(
        `INSERT INTO agent_profiles (id, name, role_desc, reply_style, service_flow,
         taboos, reassurance_tpl, routing_examples, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [meta.id, meta.name, meta.role_desc, meta.reply_style, meta.service_flow,
         JSON.stringify(taboos), meta.reassurance_tpl, routingExamples, now, now]
      );
    }

    // 更新候选状态为 approved
    await db.runAsync(
      `UPDATE meta_agents SET status='approved', updated_at=? WHERE id=?`,
      [now, meta.id]
    );

    console.log(`[MetaAgent] ✅ 候选 Agent "${meta.id}" 已转正，写入 agent_profiles`);

    res.json({
      success: true,
      message: `候选 Agent "${meta.name}" 已转正上线！`,
      agent_id: meta.id,
      promoted_at: now,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── 9. 拒绝淘汰候选 Agent ───────────────────────────────────────────────
metaAgentRouter.post('/:id/reject', async (req, res) => {
  try {
    const meta = await db.getAsync<any>('SELECT id FROM meta_agents WHERE id = ?', [req.params.id]);
    if (!meta) return res.status(404).json({ error: `候选 Agent "${req.params.id}" 不存在` });

    await db.runAsync(
      `UPDATE meta_agents SET status='rejected', reject_reason=?, updated_at=? WHERE id=?`,
      [req.body.reason || '未说明原因', Date.now(), req.params.id]
    );

    res.json({ success: true, message: `候选 Agent "${req.params.id}" 已淘汰` });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── 10. 清除沙箱测试数据（虚拟用户产生的数据）──────────────────────────
metaAgentRouter.delete('/sandbox/:userId', async (req, res) => {
  const userId = req.params.userId;
  if (!userId.startsWith('eval_sandbox_')) {
    return res.status(400).json({ error: '只允许删除 eval_sandbox_ 开头的虚拟用户数据' });
  }

  // 各表独立容错清理：某张表不存在或无对应列不影响其他表的清理
  const cleaned: string[] = [];
  const errors: string[] = [];
  for (const [table, col] of [['agent_tasks', 'user_id'], ['tickets', 'user_id'], ['sessions', 'user_id']] as const) {
    try {
      await db.runAsync(`DELETE FROM ${table} WHERE ${col} = ?`, [userId]);
      cleaned.push(table);
    } catch {
      // 表不存在或无该列时静默跳过
      errors.push(table);
    }
  }

  res.json({
    success: true,
    message: `已清理沙箱用户 "${userId}" 的测试数据`,
    cleaned_tables: cleaned,
    skipped_tables: errors,
  });
});

// ─── Helper ───────────────────────────────────────────────────────────────
function parseMetaAgent(row: any) {
  if (!row) return null;
  return {
    ...row,
    taboos: tryParseJSON(row.taboos, []),
    skill_ids: tryParseJSON(row.skill_ids, []),
    routing_examples: tryParseJSON(row.routing_examples, []),
    delivery_config: tryParseJSON(row.delivery_config, {}),
  };
}

function tryParseJSON(str: string | null | undefined, fallback: any) {
  try { return str ? JSON.parse(str) : fallback; } catch { return fallback; }
}

// ─── 10. AI 生成 Spec（自然语言 → 员工画像）─────────────────────────────────
// POST /api/v1/meta/agents/generate-spec
// Body: { intent: string, extra_context?: string, extra_taboos?: string[] }
// 返回: { spec: MetaAgentSpec, confidence, clarification_needed, generation_notes }
metaAgentRouter.post('/generate-spec', async (req, res) => {
  try {
    const { intent, extra_context = '', extra_taboos = [] } = req.body;
    if (!intent?.trim()) {
      return res.status(400).json({ error: 'intent 为必填项' });
    }

    const apiKey = process.env.DOUBAO_API_KEY || process.env.ARK_API_KEY;
    const model  = process.env.SPEC_GEN_MODEL || 'doubao-1.5-pro-32k-250115';
    const baseUrl = process.env.ARK_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3';

    if (!apiKey) {
      return res.status(503).json({ error: '未配置 LLM API Key，请在平台设置中配置 DOUBAO_API_KEY' });
    }

    // 基线禁忌（不可绕过）
    const BASELINE_TABOOS = [
      '虚假宣传', '过度承诺', '泄露用户信息',
      '自行生成URL或链接', '使用Markdown格式（**加粗**、##标题、- 列表）',
    ];

    // 领域推断
    const DOMAIN_MAP: Record<string, string> = {
      '群运营': 'social_ops', '私域': 'social_ops', '社群': 'social_ops', '运营': 'social_ops',
      '销售': 'sales', '商务': 'sales', '客户': 'sales',
      '招聘': 'hr_recruiting', '面试': 'hr_recruiting',
      '健康': 'health', '医疗': 'health', '患者': 'health',
    };
    let knowledge_domain = 'social_ops';
    for (const [kw, domain] of Object.entries(DOMAIN_MAP)) {
      if (intent.includes(kw)) { knowledge_domain = domain; break; }
    }

    const systemPrompt = `你是一个 AI 员工招募顾问，将"招聘意图"转化为"员工画像配置"。

规则：
1. 生成「员工画像」，不是「业务脚本」。
2. reply_style 只描述"怎么说话"（语气、字数、格式约束），不描述内容。
3. service_flow 只描述"做事步骤"（动词序列），最多6步。
4. taboos 是零容忍行为禁区，必须具体可测试。
5. 不要过拟合：不要把例子直接写进 spec，要提炼为通用行为准则。

输出合法 JSON（不要加 Markdown 代码块）：
{
  "name": "岗位名称",
  "role_desc": "职责描述（2-3句）",
  "reply_style": "回复风格（语气/字数/格式，≤100字）",
  "service_flow": "步骤1 → 步骤2 → 步骤3（最多6步）",
  "taboos": ["禁忌1", "禁忌2"],
  "reassurance_tpl": "安抚话术（1-2句）",
  "suggested_skill_ids": [],
  "routing_examples": [{"user_says":"...","route_to":"...","reason":"..."}],
  "delivery_config": {"max_reply_length":150,"use_emoji":true,"greeting_style":"casual","response_tone":"friendly"},
  "confidence": 0.9,
  "clarification_needed": null,
  "generation_notes": []
}`;

    const userPrompt = `招聘需求：${intent}${extra_context ? '\n补充背景：' + extra_context : ''}${extra_taboos.length ? '\n额外禁忌：' + extra_taboos.join('、') : ''}`;

    const llmRes = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
        temperature: 0.3,
        max_tokens: 2048,
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!llmRes.ok) {
      const body = await llmRes.text();
      return res.status(502).json({ error: `LLM 调用失败: ${body.slice(0, 200)}` });
    }

    const llmData = await llmRes.json() as any;
    const raw = llmData.choices?.[0]?.message?.content || '';

    // 解析 JSON（容错处理 Markdown 代码块）
    const cleaned = raw.replace(/^```json?\s*/m, '').replace(/```\s*$/m, '').trim();
    let parsed: any;
    try { parsed = JSON.parse(cleaned); }
    catch { return res.status(502).json({ error: 'LLM 输出无法解析为 JSON', raw: raw.slice(0, 500) }); }

    // 合并基线禁忌
    const allTaboos = Array.from(new Set([...BASELINE_TABOOS, ...(parsed.taboos || []), ...extra_taboos]));

    // 生成 ID
    const { randomBytes } = await import('crypto');
    const slug = (parsed.name || '员工').replace(/[^\w\u4e00-\u9fa5]/g, '_').slice(0, 20);
    const id = `agent_${slug}_${randomBytes(3).toString('hex')}`;

    const spec = {
      id,
      name: parsed.name || '未命名员工',
      role_desc: parsed.role_desc || '',
      reply_style: parsed.reply_style || '',
      service_flow: parsed.service_flow || '',
      taboos: allTaboos,
      reassurance_tpl: parsed.reassurance_tpl || '我理解您的情况，请稍等。',
      skill_ids: (parsed.suggested_skill_ids || []).slice(0, 5),
      routing_examples: (parsed.routing_examples || []).slice(0, 5),
      delivery_config: {
        max_reply_length: parsed.delivery_config?.max_reply_length || 150,
        use_emoji: parsed.delivery_config?.use_emoji ?? true,
        greeting_style: parsed.delivery_config?.greeting_style || 'casual',
        response_tone: parsed.delivery_config?.response_tone || 'friendly',
      },
      knowledge_domain,
      intent_prompt: intent,
    };

    res.json({
      spec,
      confidence: parsed.confidence || 0.7,
      clarification_needed: parsed.clarification_needed || null,
      generation_notes: parsed.generation_notes || [],
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

