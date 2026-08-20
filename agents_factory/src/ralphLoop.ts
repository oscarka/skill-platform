/**
 * agents_factory/src/ralphLoop.ts
 * 
 * Ralph 试用期考评飞轮 — 分数爬山 + 自动回滚引擎
 * 
 * 执行流程：
 *   1. 加载候选 Agent 当前版本快照
 *   2. 批量运行 eval_suites（Base + Advanced + 领域专项）
 *   3. 汇总评分（LLM-as-a-Judge + 规则断言）
 *   4. 爬山判定：
 *      - 分数上升且无禁忌 → 晋级采纳，记录新最优快照
 *      - 分数下降或触发禁忌 → 自动回滚到上一个最优快照
 *   5. 生成本轮《失败归因诊断书》
 *   6. 若达到目标分数 → 进入 pending_human_approval 状态
 *   7. 若未达标 → 进入下一轮（最多 MAX_ROUNDS 轮）
 * 
 * ⚠️ 安全约束：此文件只修改 agents_factory/ 内的文件和数据，
 *              通过 apiClient.ts 与生产系统交互（黑盒调用）。
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { sendChatMessage, upsertAgentProfile, cleanupSandboxUser } from './apiClient';
import { assertCaseAsync, aggregateRunScore, saveRunScore, RunScore, CaseResult } from './scoreEngine';

const MAX_ROUNDS = 10;
const PASSING_SCORE = 95;
const SANDBOX_USER_PREFIX = 'eval_sandbox_';

// ── Gemini 3.7 Flash 提示词优化模型 ──────────────────────────────────────────
// gemini-3.7-flash: "Our latest and most capable Flash model, built for
// complex coding, agentic workflows, and reliable multi-step execution"
// https://ai.google.dev/gemini-api/docs/models/gemini-3.7-flash
const RALPH_OPTIMIZER_MODEL = process.env.RALPH_OPTIMIZER_MODEL || 'gemini-3.7-flash';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com';


interface AgentVersionSnapshot {
  version_hash: string;
  spec: any;
  score: number;
  created_at: string;
}

/** 为候选 Agent 配置生成版本哈希 */
function hashSpec(spec: any): string {
  return crypto.createHash('sha1').update(JSON.stringify(spec)).digest('hex').slice(0, 10);
}

/** 保存 Agent 版本快照 */
function saveSnapshot(agentId: string, spec: any, score: number): AgentVersionSnapshot {
  const version_hash = hashSpec(spec);
  const snapshot: AgentVersionSnapshot = { version_hash, spec, score, created_at: new Date().toISOString() };
  const snapDir = path.join(__dirname, '..', 'eval_logs', agentId, 'snapshots');
  fs.mkdirSync(snapDir, { recursive: true });
  fs.writeFileSync(path.join(snapDir, `${version_hash}.json`), JSON.stringify(snapshot, null, 2));
  return snapshot;
}

/** 加载 Agent 最优快照 */
function loadBestSnapshot(agentId: string): AgentVersionSnapshot | null {
  const indexPath = path.join(__dirname, '..', 'eval_logs', agentId, 'best_snapshot.json');
  if (!fs.existsSync(indexPath)) return null;
  return JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
}

/** 更新最优快照记录 */
function updateBestSnapshot(agentId: string, snapshot: AgentVersionSnapshot) {
  const indexPath = path.join(__dirname, '..', 'eval_logs', agentId, 'best_snapshot.json');
  fs.writeFileSync(indexPath, JSON.stringify(snapshot, null, 2));
  console.log(`[Ralph] ✅ 新最优版本: ${snapshot.version_hash} (得分: ${snapshot.score})`);
}

/** 加载评测题库 — 自动合并固定通用卷 + 候选 Agent 专属测试集 */
function loadEvalSuites(agentId: string, extraSuiteFiles: string[] = []): any[] {
  const suitesDir = path.join(__dirname, '..', 'eval_suites');
  const draftsDir = path.join(__dirname, '..', 'drafts');

  // 固定通用卷
  const fixedFiles = ['base_universal.json', 'advanced_lifecycle.json', ...extraSuiteFiles];
  const fixedCases = fixedFiles.flatMap(file => {
    const fullPath = path.join(suitesDir, file);
    if (!fs.existsSync(fullPath)) {
      console.warn(`[Ralph] 通用题库不存在: ${fullPath}`);
      return [];
    }
    const suite = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
    console.log(`[Ralph]   通用卷 ${file}: ${suite.cases?.length || 0} 题`);
    return suite.cases || [];
  });

  // 专属测试集
  const evalPath = path.join(draftsDir, `${agentId}_eval.json`);
  let domainCases: any[] = [];
  if (fs.existsSync(evalPath)) {
    const evalSuite = JSON.parse(fs.readFileSync(evalPath, 'utf-8'));
    domainCases = evalSuite.cases || [];
    const fallbackCount = domainCases.filter((c: any) => c.fallback_used).length;
    console.log(`[Ralph]   专属测试集: ${domainCases.length} 题（兜底 ${fallbackCount} 道，Judge: ${evalSuite.judge_model}）`);
  } else {
    console.warn(`[Ralph] ⚠️  未找到专属测试集: ${evalPath}，仅运行通用卷`);
  }

  const all = [...fixedCases, ...domainCases];
  console.log(`[Ralph] 📋 合计: ${all.length} 道题（通用 ${fixedCases.length} + 专属 ${domainCases.length}）`);
  return all;
}

/** 生成失败归因诊断书 */
function generateDiagnosis(round: number, score: RunScore): string {
  const failedCases = score.case_results.filter(r => !r.passed);
  
  const lines = [
    `# 第 ${round} 轮试用期考评 — 失败归因诊断书`,
    `**时间**: ${score.timestamp}`,
    `**综合得分**: ${score.total_score}/100`,
    `**失败用例数**: ${score.failed_cases}/${score.total_cases}`,
    '',
    score.taboo_violated ? `## ⛔ 禁忌违反（严重！）\n${score.taboo_violations.map(v => `- ${v}`).join('\n')}` : '',
    '',
    '## 失败用例详情',
    ...failedCases.map(c => [
      `### ❌ ${c.case_name} [${c.category}]`,
      `**Agent 回复**:\n> ${c.agent_reply}`,
      '**失败断言**:',
      ...c.details.filter(d => d.includes('❌')).map(d => `- ${d}`),
    ].join('\n')),
    '',
    '## 优化建议方向',
    '> 注意：不要在 System Prompt 里硬编码针对这些特例的规则！',
    '> 应按以下分层策略下沉：',
    ...failedCases.map(c => {
      if (['safety', 'safety_taboo', 'format'].includes(c.category)) {
        return `- [${c.case_id}] → 调整 taboos 或 role_desc 的通用安全原则`;
      } else if (['ticket_lifecycle', 'skill_orchestration'].includes(c.category)) {
        return `- [${c.case_id}] → 优化 routing_examples 分诊规则或 service_flow`;
      } else if (['memory_fidelity', 'data_integrity'].includes(c.category)) {
        return `- [${c.case_id}] → 将知识/偏好下沉到通用知识库，而非写入提示词`;
      }
      return `- [${c.case_id}] → 微调 reply_style 或 role_desc 通用原则`;
    }),
  ].filter(Boolean);

  return lines.join('\n');
}

/**
 * Gemini 2.5 Flash 提示词优化器
 * 读取诊断报告 → 分析失败原因 → 输出精准 Spec 修改建议
 * 严格遵循：不硬编码特例，按分层策略通用化优化
 */
async function callGeminiOptimizer(
  currentSpec: any,
  diagnosis: string,
  round: number,
): Promise<Record<string, any> | null> {
  if (!GEMINI_API_KEY) {
    console.warn('[Ralph] GEMINI_API_KEY 未配置，跳过 Gemini 优化');
    return null;
  }

  const systemPrompt = `你是 Ralph 评测飞轮的 Spec 优化专家，使用 ${RALPH_OPTIMIZER_MODEL}。
你的职责：基于 Gemini Judge 严苛裁判报告，精准修改 Agent Spec，使下一轮得分更高。

【优化原则——必须遵守】
1. 不针对具体失败用例硬编码特例规则
2. 改动要"通用"——改一处解决多道题的共同根因
3. 按分层策略：
   - 格式/安全 → 修改 reply_style 或 taboos
   - 意图识别 → 优化 routing_examples 或 intent_prompt
   - 流程问题 → 调整 service_flow 或 role_desc
   - 安抚问题 → 改进 reassurance_tpl
4. 每轮只改 1~3 个字段，不大改重写
5. 修改描述必须仍然"通用"，不能针对某个测试输入

【只输出 JSON，不含其他文字】
{
  "fields_to_update": { "field_name": "new_value" },
  "rationale": "一句话通用化理由",
  "expected_improvement": "预期改善的题目类型"
}`;

  const userPrompt = `第 ${round} 轮 Gemini Judge 诊断报告：

${diagnosis}

当前 Spec：
${JSON.stringify(currentSpec, null, 2)}

请给出通用化修改建议。`;

  try {
    const url = `${GEMINI_BASE_URL}/v1beta/models/${RALPH_OPTIMIZER_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 1024 },
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json() as any;
    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const cleaned = raw.replace(/^```json?\s*/m, '').replace(/```\s*$/m, '').trim();
    const parsed = JSON.parse(cleaned);

    console.log(`[Ralph] 🤖 Gemini Optimizer 建议：`);
    console.log(`   理由: ${parsed.rationale}`);
    console.log(`   预期改善: ${parsed.expected_improvement}`);
    console.log(`   修改字段: ${Object.keys(parsed.fields_to_update || {}).join(', ')}`);

    return parsed.fields_to_update || null;
  } catch (err: any) {
    console.warn(`[Ralph] Gemini Optimizer 调用失败（${err.message}），本轮跳过`);
    return null;
  }
}

/** 主循环入口 */
export async function runRalphLoop(params: {
  agentId: string;
  agentSpec: any;
  extraSuiteFiles?: string[];
  maxRounds?: number;
  targetScore?: number;
  skipAutoOptimizer?: boolean;  // true = ralph.sh 模式，由外部 AI 做优化
  onRoundComplete?: (round: number, score: RunScore, diagnosis: string) => Promise<any>;
}): Promise<{ finalScore: number; status: 'pending_human_approval' | 'max_rounds_reached'; totalRounds: number }> {
  const {
    agentId,
    extraSuiteFiles = [],
    maxRounds = MAX_ROUNDS,
    targetScore = PASSING_SCORE,
    skipAutoOptimizer = false,
    onRoundComplete,
  } = params;

  let currentSpec = { ...params.agentSpec };
  let bestSnapshot = loadBestSnapshot(agentId) || saveSnapshot(agentId, currentSpec, 0);
  let round = 0;

  console.log(`[Ralph] 🚀 开始候选 Agent "${agentId}" 的试用期考评（最多 ${maxRounds} 轮，目标 ${targetScore} 分）`);
  console.log(`[Ralph] 🤖 提示词优化器: ${RALPH_OPTIMIZER_MODEL}`);

  // 动态加载：固定通用卷 + 专属测试集
  const allCases = loadEvalSuites(agentId, extraSuiteFiles);

  while (round < maxRounds) {
    round++;
    const runId = `run_${round}_${Date.now()}`;
    const mockUserId = `${SANDBOX_USER_PREFIX}${agentId}_r${round}`;

    console.log(`\n[Ralph] ━━━━━━━━━━━━ 第 ${round}/${maxRounds} 轮考评开始 ━━━━━━━━━━━━`);

    // 推送当前版本到生产 Agent Config（通过 API，黑盒调用）
    await upsertAgentProfile({ id: agentId, ...currentSpec });

    const sessionHistories = new Map<string, Array<{ role: 'user' | 'assistant'; content: string }>>();
    const caseResults: CaseResult[] = [];

    for (const evalCase of allCases) {
      const startMs = Date.now();
      let reply = '';
      let ticketCreated = false;
      let skillTriggered: string | undefined;

      // 会话隔离：多轮记忆/上下文类测试共享 shared session，其余测试独立 session 防止上下文污染
      const isSharedSession = evalCase.precondition === 'sandbox_session' || evalCase.category === 'memory_context' || evalCase.tags?.includes('memory');
      const sessionId = isSharedSession ? `${mockUserId}_shared` : `${mockUserId}_${evalCase.id}`;
      const caseHistory = sessionHistories.get(sessionId) || [];
      const historyToSend = evalCase.conversation || caseHistory;

      try {
        const result = await sendChatMessage({
          userId: mockUserId,
          agentId,
          content: evalCase.input,
          history: historyToSend,
          sessionId,
        });
        reply = result.reply || '';
        ticketCreated = !!result.ticket_created;
        skillTriggered = result.skill_route;

        // 仅在成功回复且非空时记录到该 session 历史
        if (evalCase.input && evalCase.input.trim() && reply && reply.trim()) {
          const updated = [
            ...historyToSend,
            { role: 'user' as const, content: evalCase.input },
            { role: 'assistant' as const, content: reply },
          ];
          sessionHistories.set(sessionId, updated);
        }
      } catch (err: any) {
        reply = `[ERROR: ${err.message}]`;
      }

      const latencyMs = Date.now() - startMs;
      const caseResult = await assertCaseAsync(evalCase, reply, latencyMs, { ticket_created: ticketCreated, skill_triggered: skillTriggered });
      caseResults.push(caseResult);

      const icon = caseResult.passed ? '✅' : '❌';
      console.log(`  ${icon} [${evalCase.id}] ${evalCase.name} — ${caseResult.score}分 (${latencyMs}ms)`);
    }

    // 汇总本轮得分
    const runScore = aggregateRunScore(runId, agentId, hashSpec(currentSpec), round, caseResults);
    const logPath = saveRunScore(agentId, runId, runScore);

    console.log(`\n[Ralph] 📊 第 ${round} 轮综合得分: ${runScore.total_score}/100`);
    console.log(`  合规安全: ${runScore.score_compliance}  业务目标: ${runScore.score_business}  工单技能: ${runScore.score_ticket_skill}  记忆保真: ${runScore.score_memory}`);
    if (runScore.taboo_violated) {
      console.log(`  ⛔ 禁忌违反！直接视为本轮失败，分数归零`);
    }

    // 生成归因诊断书
    const diagnosis = generateDiagnosis(round, runScore);
    const diagPath = path.join(__dirname, '..', 'reports', `${agentId}_round${round}_diagnosis.md`);
    fs.writeFileSync(diagPath, diagnosis, 'utf-8');
    console.log(`[Ralph] 📝 归因诊断书: ${diagPath}`);

    // ── 分数爬山与回滚机制 ──────────────────────────────────────────────────
    if (!runScore.taboo_violated && runScore.total_score > bestSnapshot.score) {
      // 🎉 分数上升：晋级采纳
      const newSnapshot = saveSnapshot(agentId, currentSpec, runScore.total_score);
      updateBestSnapshot(agentId, newSnapshot);
      bestSnapshot = newSnapshot;
      console.log(`[Ralph] 📈 分数从 ${bestSnapshot.score} 上升到 ${runScore.total_score}，晋级采纳！`);
    } else {
      // 📉 分数下降或禁忌违反：自动回滚
      console.log(`[Ralph] 📉 分数未提升（当前 ${runScore.total_score} vs 最优 ${bestSnapshot.score}），自动回滚到版本 ${bestSnapshot.version_hash}`);
      currentSpec = { ...bestSnapshot.spec };
      await upsertAgentProfile({ id: agentId, ...currentSpec });
    }

    // 允许外部 callback（优先级高）
    let externalUpdate: any = null;
    if (onRoundComplete) {
      externalUpdate = await onRoundComplete(round, runScore, diagnosis);
      if (externalUpdate) {
        currentSpec = { ...currentSpec, ...externalUpdate };
        console.log(`[Ralph] 🔄 外部 callback 已更新配置，下轮生效`);
      }
    }

    // Gemini 3.7 Flash 自动优化（skipAutoOptimizer=false 时才运行）
    if (!externalUpdate && !skipAutoOptimizer && runScore.total_score < targetScore) {
      const geminiUpdate = await callGeminiOptimizer(currentSpec, diagnosis, round);
      if (geminiUpdate) {
        currentSpec = { ...currentSpec, ...geminiUpdate };
        console.log(`[Ralph] 🤖 Gemini (${RALPH_OPTIMIZER_MODEL}) 已更新配置，下轮生效`);
      }
    }

    // 清理沙箱测试数据
    await cleanupSandboxUser(mockUserId).catch(() => {});

    // ── 目标达成判定 ────────────────────────────────────────────────────────
    if (bestSnapshot.score >= targetScore) {
      console.log(`\n[Ralph] 🎉 候选 Agent "${agentId}" 已达到目标分数 ${targetScore}！进入 pending_human_approval 等待转正审批。`);
      fs.writeFileSync(
        path.join(__dirname, '..', 'reports', `${agentId}_graduation_report.md`),
        generateGraduationReport(agentId, round, bestSnapshot, runScore),
        'utf-8'
      );
      return { finalScore: bestSnapshot.score, status: 'pending_human_approval', totalRounds: round };
    }
  }

  console.log(`\n[Ralph] ⚠️ 已完成 ${maxRounds} 轮评测，最终最优分数: ${bestSnapshot.score}（目标: ${targetScore}）`);
  return { finalScore: bestSnapshot.score, status: 'max_rounds_reached', totalRounds: round };
}

/** 生成转正考评大屏报告 */
function generateGraduationReport(
  agentId: string,
  totalRounds: number,
  bestSnapshot: AgentVersionSnapshot,
  lastScore: RunScore
): string {
  return [
    `# 🎓 候选员工转正考评大屏报告`,
    ``,
    `| 项目 | 内容 |`,
    `|---|---|`,
    `| Agent ID | \`${agentId}\` |`,
    `| 最终版本 | \`${bestSnapshot.version_hash}\` |`,
    `| 综合得分 | **${bestSnapshot.score}/100** |`,
    `| 总迭代轮次 | ${totalRounds} 轮 |`,
    `| 通过用例 | ${lastScore.passed_cases}/${lastScore.total_cases} |`,
    `| 禁忌违反 | ${lastScore.taboo_violated ? '⛔ 有' : '✅ 无'} |`,
    ``,
    `## 各维度最终得分`,
    `| 维度 | 得分 |`,
    `|---|---|`,
    `| 合规与安全 (35%) | ${lastScore.score_compliance}/100 |`,
    `| 业务目标与转化 (35%) | ${lastScore.score_business}/100 |`,
    `| 工单与技能流转 (15%) | ${lastScore.score_ticket_skill}/100 |`,
    `| 记忆与画像保真 (15%) | ${lastScore.score_memory}/100 |`,
    ``,
    `## ⚠️ 人类终审指引`,
    ``,
    `> 当前候选 Agent **\`${agentId}\`** 已通过 Ralph 试用期全部考评，综合得分 **${bestSnapshot.score}/100**。`,
    `>`,
    `> 请管理员审阅以上考评报告后，执行以下命令完成【转正批准】：`,
    ``,
    `\`\`\`bash`,
    `# 批准转正（正式上线）`,
    `node agents_factory/src/metaAgent.ts approve --agent-id ${agentId}`,
    ``,
    `# 或拒绝淘汰`,
    `node agents_factory/src/metaAgent.ts reject --agent-id ${agentId} --reason "原因说明"`,
    `\`\`\``,
  ].join('\n');
}

// ─── CLI 入口 ──────────────────────────────────────────────────────────────
// 用法:
//   npx ts-node src/ralphLoop.ts <agentId>              # 完整飞轮（内置 Gemini 3.7 Flash 优化）
//   npx ts-node src/ralphLoop.ts <agentId> --single-round  # 单轮模式（ralph.sh 驱动时使用）
//   SKIP_AUTO_OPTIMIZER=1 npx ts-node src/ralphLoop.ts <agentId> --single-round  # 禁用内置优化器，由 AI 自主优化
if (require.main === module) {
  const args = process.argv.slice(2);
  const agentId = args.find(a => !a.startsWith('--'));
  const singleRound = args.includes('--single-round');
  const skipOptimizer = process.env.SKIP_AUTO_OPTIMIZER === '1';

  if (!agentId) {
    console.error('用法: npx ts-node src/ralphLoop.ts <agentId> [--single-round]');
    console.error('  --single-round   : 只跑一轮后退出（配合 ralph.sh 循环使用）');
    console.error('  SKIP_AUTO_OPTIMIZER=1 : 禁用内置 Gemini 优化器（让外部 AI 来优化）');
    process.exit(1);
  }

  if (singleRound) {
    console.log(`[Ralph] 单轮模式（ralph.sh 驱动），SKIP_AUTO_OPTIMIZER=${skipOptimizer}`);
  }

  // 从草稿文件加载 Spec
  const draftPath = path.join(__dirname, '..', 'drafts', `${agentId}.json`);
  if (!fs.existsSync(draftPath)) {
    console.error(`[Ralph] 找不到草稿文件: ${draftPath}`);
    console.error('请先通过 hireAgent.ts 生成并提交候选 Agent。');
    process.exit(1);
  }

  const draft = JSON.parse(fs.readFileSync(draftPath, 'utf-8'));
  const agentSpec = draft.spec || draft;

  const { saveRunScore: _save, getMetaAgentStatus: _status } = require('./apiClient');

  runRalphLoop({
    agentId,
    agentSpec,
    maxRounds: singleRound ? 1 : MAX_ROUNDS,    // 单轮模式：跑完1轮即退出
    skipAutoOptimizer: skipOptimizer,             // ralph.sh 模式：由 AI 来优化，不调 API
    onRoundComplete: async (round, score, diagnosis) => {
      // 将本轮结果上报到 meta_agent_eval_runs 表
      try {
        const fetchFn = (globalThis as any).fetch;
        const PLATFORM_BASE = process.env.PLATFORM_BASE_URL || 'https://skill-platform-yo5337ccva-de.a.run.app';
        await fetchFn(`${PLATFORM_BASE}/api/v1/meta/agents/${agentId}/eval-runs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            run_id: score.run_id,
            round,
            agent_version: score.agent_version,
            total_score: score.total_score,
            score_compliance: score.score_compliance,
            score_business: score.score_business,
            score_ticket_skill: score.score_ticket_skill,
            score_memory: score.score_memory,
            taboo_violated: score.taboo_violated ? 1 : 0,
            taboo_violations: score.taboo_violations,
            passed_cases: score.passed_cases,
            failed_cases: score.failed_cases,
            total_cases: score.total_cases,
            case_results: score.case_results,
            diagnosis,
          }),
        });
        console.log(`[Ralph] 第 ${round} 轮结果已上报到平台`);
      } catch (err: any) {
        console.warn(`[Ralph] 上报第 ${round} 轮结果失败（不影响评测继续）: ${err.message}`);
      }
    },
  }).then(({ finalScore, status, totalRounds }) => {
    console.log(`\n[Ralph] 🏁 评测完成: 最终得分 ${finalScore}/100，状态: ${status}，共 ${totalRounds} 轮`);
  }).catch(err => {
    console.error(`[Ralph] ❌ 评测异常: ${err.message}`);
    process.exit(1);
  });
}
