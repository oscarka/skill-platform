#!/usr/bin/env node
/**
 * test_meta_agent_api.mjs
 * Phase 2 验收测试 — 测试 /api/v1/meta/agents 全部接口
 * 
 * 测试范围：
 *   1. 主服务健康检查（主服务不应受影响）
 *   2. Staging 服务健康检查
 *   3. POST   /api/v1/meta/agents          创建候选 Agent
 *   4. GET    /api/v1/meta/agents          列出候选 Agent
 *   5. GET    /api/v1/meta/agents/:id      读取候选 Agent 详情
 *   6. PUT    /api/v1/meta/agents/:id      更新候选 Agent 配置
 *   7. POST   /api/v1/meta/agents/:id/eval-runs    保存 Eval Run 日志
 *   8. GET    /api/v1/meta/agents/:id/eval-runs    列出 Eval Runs
 *   9. GET    /api/v1/meta/agents/:id/eval-runs/:runId   单轮详情
 *  10. POST   /api/v1/meta/agents/:id/approve  转正（状态未到时应拒绝）
 *  11. DELETE /api/v1/meta/sandbox/:userId     清理沙箱数据
 *  12. Staging 服务同样通过健康检查
 */

const PROD_BASE    = 'https://skill-platform-yo5337ccva-de.a.run.app';
const STAGING_BASE = 'https://skill-platform-staging-yo5337ccva-de.a.run.app';
const TEST_AGENT_ID = `test_meta_agent_${Date.now()}`;
const TEST_RUN_ID   = `run_test_${Date.now()}`;
const SANDBOX_USER  = `eval_sandbox_test_${Date.now()}`;

let passed = 0;
let failed = 0;

function log(icon, label, detail = '') {
  console.log(`  ${icon} ${label}${detail ? ` — ${detail}` : ''}`);
}

async function check(name, fn) {
  try {
    await fn();
    passed++;
    log('✅', name);
  } catch (err) {
    failed++;
    log('❌', name, err.message);
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg);
}

async function req(base, method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(15000),
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${base}${path}`, opts);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('  Phase 2 验收测试 — Meta-Agent 开放接口');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

// ── 1. 主服务健康检查 ────────────────────────────────────────────────────────
console.log('【1】主服务健康检查（确保主服务未受影响）');

await check('主服务 /api/agents 可访问', async () => {
  const { status } = await req(PROD_BASE, 'GET', '/api/agents', null);
  assert(status === 200, `HTTP ${status}`);
});

await check('主服务 GET /api/v1/meta/agents 路由已挂载', async () => {
  const { status, data } = await req(PROD_BASE, 'GET', '/api/v1/meta/agents', null);
  assert(status === 200, `HTTP ${status} — ${JSON.stringify(data).slice(0, 100)}`);
  assert(Array.isArray(data.agents), '返回值应包含 agents 数组');
});

// ── 2. Staging 服务健康检查 ──────────────────────────────────────────────────
console.log('\n【2】Staging 服务健康检查');

await check('Staging 服务响应正常', async () => {
  const { status } = await req(STAGING_BASE, 'GET', '/api/v1/meta/agents', null);
  assert(status === 200, `HTTP ${status}`);
});

// ── 3. 创建候选 Agent ────────────────────────────────────────────────────────
console.log('\n【3】创建候选 Agent (POST /api/v1/meta/agents)');

await check('正常创建候选 Agent', async () => {
  const { status, data } = await req(PROD_BASE, 'POST', '/api/v1/meta/agents', {
    id: TEST_AGENT_ID,
    name: '测试·群运营小助手',
    role_desc: '负责私域社群的日常运营与用户互动',
    reply_style: '亲切活泼，回复简洁，不超过120字，不使用Markdown',
    service_flow: '问候 → 了解需求 → 提供内容 → 引导转化',
    taboos: ['虚假宣传', '过度承诺'],
    skill_ids: ['1c0b3384-1c54-4281-98ad-da4c37279977'],
    intent_prompt: '招聘一个私域群运营员工，负责护肤品社群的活跃与复购引导',
    knowledge_domain: 'social_ops',
  });
  assert(status === 201, `HTTP ${status} — ${JSON.stringify(data).slice(0, 200)}`);
  assert(data.id === TEST_AGENT_ID, '返回 ID 应一致');
  assert(data.status === 'draft', '初始状态应为 draft');
  assert(Array.isArray(data.taboos), 'taboos 应解析为数组');
  assert(data.taboos.length === 2, '应有 2 条禁忌');
});

await check('重复创建同一 ID 应返回 409', async () => {
  const { status } = await req(PROD_BASE, 'POST', '/api/v1/meta/agents', {
    id: TEST_AGENT_ID, name: 'dup', role_desc: 'dup', reply_style: 'dup',
  });
  assert(status === 409, `HTTP ${status}（预期 409）`);
});

await check('缺少必填字段应返回 400', async () => {
  const { status } = await req(PROD_BASE, 'POST', '/api/v1/meta/agents', {
    id: 'no_required_fields',
  });
  assert(status === 400, `HTTP ${status}（预期 400）`);
});

await check('非法 ID 格式应返回 400', async () => {
  const { status } = await req(PROD_BASE, 'POST', '/api/v1/meta/agents', {
    id: 'INVALID ID WITH SPACES!', name: 'x', role_desc: 'x', reply_style: 'x',
  });
  assert(status === 400, `HTTP ${status}（预期 400）`);
});

// ── 4. 列出候选 Agent ────────────────────────────────────────────────────────
console.log('\n【4】列出候选 Agent (GET /api/v1/meta/agents)');

await check('列表包含刚创建的候选 Agent', async () => {
  const { status, data } = await req(PROD_BASE, 'GET', '/api/v1/meta/agents', null);
  assert(status === 200, `HTTP ${status}`);
  const found = data.agents.find(a => a.id === TEST_AGENT_ID);
  assert(found, `列表中未找到 ${TEST_AGENT_ID}`);
});

// ── 5. 读取候选 Agent 详情 ───────────────────────────────────────────────────
console.log('\n【5】读取候选 Agent 详情 (GET /api/v1/meta/agents/:id)');

await check('读取已存在的候选 Agent', async () => {
  const { status, data } = await req(PROD_BASE, 'GET', `/api/v1/meta/agents/${TEST_AGENT_ID}`, null);
  assert(status === 200, `HTTP ${status}`);
  assert(data.name === '测试·群运营小助手', `name 不正确: ${data.name}`);
  assert(data.knowledge_domain === 'social_ops', `knowledge_domain 不正确: ${data.knowledge_domain}`);
});

await check('读取不存在的 Agent 应返回 404', async () => {
  const { status } = await req(PROD_BASE, 'GET', '/api/v1/meta/agents/nonexistent_agent_xyz', null);
  assert(status === 404, `HTTP ${status}（预期 404）`);
});

// ── 6. 更新候选 Agent 配置 ───────────────────────────────────────────────────
console.log('\n【6】更新候选 Agent 配置 (PUT /api/v1/meta/agents/:id)');

await check('更新 reply_style 和 taboos', async () => {
  const { status, data } = await req(PROD_BASE, 'PUT', `/api/v1/meta/agents/${TEST_AGENT_ID}`, {
    reply_style: '亲切活泼专业，回复不超过150字',
    taboos: ['虚假宣传', '过度承诺', '泄露用户信息'],
    current_score: 72.5,
  });
  assert(status === 200, `HTTP ${status}`);
  assert(data.reply_style === '亲切活泼专业，回复不超过150字', `reply_style 未更新`);
  assert(data.taboos.length === 3, `taboos 应更新为 3 条，实际: ${data.taboos.length}`);
  assert(data.current_score === 72.5, `current_score 应为 72.5`);
});

// ── 7. 保存 Eval Run 日志 ────────────────────────────────────────────────────
console.log('\n【7】保存 Eval Run 日志 (POST /api/v1/meta/agents/:id/eval-runs)');

await check('保存第 1 轮评测日志', async () => {
  const { status, data } = await req(PROD_BASE, 'POST', `/api/v1/meta/agents/${TEST_AGENT_ID}/eval-runs`, {
    run_id: TEST_RUN_ID,
    round: 1,
    agent_version: 'abcdef1234',
    total_score: 72.5,
    score_compliance: 80,
    score_business: 65,
    score_ticket_skill: 70,
    score_memory: 75,
    taboo_violated: false,
    taboo_violations: [],
    passed_cases: 8,
    failed_cases: 2,
    total_cases: 10,
    case_results: [
      { case_id: 'base_001', passed: true, score: 100 },
      { case_id: 'base_002', passed: false, score: 0, details: ['❌ 含有禁止内容 "某某"'] },
    ],
    diagnosis: '# 第 1 轮诊断书\n主要问题：base_002 URL 免疫测试失败',
  });
  assert(status === 201, `HTTP ${status} — ${JSON.stringify(data).slice(0, 100)}`);
  assert(data.run_id === TEST_RUN_ID, '返回的 run_id 应一致');
});

// ── 8. 列出 Eval Runs ────────────────────────────────────────────────────────
console.log('\n【8】列出 Eval Runs (GET /api/v1/meta/agents/:id/eval-runs)');

await check('列表包含刚保存的 Eval Run', async () => {
  const { status, data } = await req(PROD_BASE, 'GET', `/api/v1/meta/agents/${TEST_AGENT_ID}/eval-runs`, null);
  assert(status === 200, `HTTP ${status}`);
  assert(data.total === 1, `应有 1 条记录，实际: ${data.total}`);
  assert(data.runs[0].run_id === TEST_RUN_ID, 'run_id 不一致');
  assert(data.runs[0].total_score === 72.5, `得分应为 72.5，实际: ${data.runs[0].total_score}`);
});

// ── 9. 单轮 Eval Run 详情 ────────────────────────────────────────────────────
console.log('\n【9】读取单轮 Eval Run 详情 (GET /api/v1/meta/agents/:id/eval-runs/:runId)');

await check('读取包含 case_results 的详情', async () => {
  const { status, data } = await req(PROD_BASE, 'GET', `/api/v1/meta/agents/${TEST_AGENT_ID}/eval-runs/${TEST_RUN_ID}`, null);
  assert(status === 200, `HTTP ${status}`);
  assert(Array.isArray(data.case_results), 'case_results 应为数组');
  assert(data.case_results.length === 2, `应有 2 条 case 结果，实际: ${data.case_results.length}`);
  assert(data.diagnosis.includes('第 1 轮诊断书'), '诊断书内容不正确');
});

// ── 10. 转正前置校验（状态 draft 时应拒绝 approve）────────────────────────────
console.log('\n【10】转正前置校验 (POST /api/v1/meta/agents/:id/approve)');

await check('draft 状态下 approve 应返回 400', async () => {
  const { status, data } = await req(PROD_BASE, 'POST', `/api/v1/meta/agents/${TEST_AGENT_ID}/approve`, {});
  assert(status === 400, `HTTP ${status}（预期 400，实际: ${JSON.stringify(data)}）`);
});

// ── 11. 沙箱数据清理守卫 ────────────────────────────────────────────────────
console.log('\n【11】沙箱数据清理守卫 (DELETE /api/v1/meta/sandbox/:userId)');

await check('清理 eval_sandbox_ 用户数据', async () => {
  const { status } = await req(PROD_BASE, 'DELETE', `/api/v1/meta/agents/sandbox/${SANDBOX_USER}`, null);
  assert(status === 200 || status === 404, `HTTP ${status}（预期 200 或 404）`);
});

await check('拒绝清理非沙箱用户（安全守卫）', async () => {
  const { status } = await req(PROD_BASE, 'DELETE', '/api/v1/meta/agents/sandbox/oscar_real_user', null);
  assert(status === 400, `HTTP ${status}（预期 400）`);
});

// ── 12. 清理测试数据 ─────────────────────────────────────────────────────────
console.log('\n【12】测试数据清理');

await check('淘汰并删除测试候选 Agent', async () => {
  const { status } = await req(PROD_BASE, 'POST', `/api/v1/meta/agents/${TEST_AGENT_ID}/reject`, {
    reason: '验收测试完成，自动清理',
  });
  assert(status === 200, `HTTP ${status}`);
});

// ── 汇总 ─────────────────────────────────────────────────────────────────────
console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`  测试结果: ✅ ${passed} 通过  ❌ ${failed} 失败  (共 ${passed + failed} 项)`);
if (failed === 0) {
  console.log('  🎉 Phase 2 验收通过！可以进入 Phase 3。');
} else {
  console.log('  ⚠️  存在失败项，请修复后重新测试。');
  process.exit(1);
}
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
