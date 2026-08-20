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
  try {
    const userId = req.params.userId;
    if (!userId.startsWith('eval_sandbox_')) {
      return res.status(400).json({ error: '只允许删除 eval_sandbox_ 开头的虚拟用户数据' });
    }

    // 清理 agent_tasks、tickets、sessions 等中的沙箱数据
    await db.runAsync(`DELETE FROM agent_tasks WHERE user_id = ?`, [userId]);
    await db.runAsync(`DELETE FROM tickets WHERE user_id = ?`, [userId]);

    res.json({ success: true, message: `已清理沙箱用户 "${userId}" 的测试数据` });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
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
