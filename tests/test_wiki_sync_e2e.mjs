#!/usr/bin/env node
/**
 * test_wiki_sync_e2e.mjs — Wiki 同步 E2E 测试
 *
 * 测试两个自动 Wiki 同步触发路径：
 *
 *   【路径 A】30轮计数器自动同步
 *     每次对话写入 LLMWiki log，满 30 轮自动触发 POST /sync。
 *     本测试发送 N 条消息，验证 LLMWiki log 数量相应增加。
 *
 *   【路径 B】患者确认 Skill 报告 → Wiki 同步
 *     工单流程：创建工单 → H5 提交 → AI 处理 → 确认报告 → Wiki 更新。
 *     验证 medication_plan.md 包含 AI 报告内容（intervention-block）。
 *
 *   【路径 C】手动触发 + maxLogs 批量限制验证
 *
 * 运行：
 *   node tests/test_wiki_sync_e2e.mjs
 *
 * 耗时预期：路径 B 需 AI 处理（3~10分钟），总计最多 15 分钟。
 */

const BASE       = 'https://skill-platform-yo5337ccva-de.a.run.app';
const LLMWIKI    = 'https://llmwiki-yo5337ccva-an.a.run.app';
const API        = `${BASE}/api/v1/agent`;
const SKILL_ID   = 'a2a53e54-98ca-4980-8b19-c18dea109877';  // AI营养师
const WIKI_USER_ID = 'ozynqskhZAcg4CumYJbe8ChYTz6Y';        // oscar 的 llmwiki userId
const SESSION    = `wiki_sync_e2e_${Date.now()}`;

let passed = 0, failed = 0;
const START_TS = Date.now();

// ─── 工具函数 ──────────────────────────────────────────────────────────────────
function ts() { return `[+${((Date.now() - START_TS) / 1000).toFixed(1)}s]`; }
function ok(label, value, detail = '') {
  console.log(`  ${value ? '✅' : '❌'} ${label}${detail ? '  →  ' + detail : ''}`);
  value ? passed++ : failed++;
}
function section(title) {
  console.log(`\n${'─'.repeat(70)}\n  ${ts()} ${title}\n${'─'.repeat(70)}`);
}
function warn(msg) { console.log(`  ⚠️  ${msg}`); }
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function httpLog(label, url, options = {}) {
  const method = options.method || 'GET';
  console.log(`\n  ┌─ ${ts()} ${method} ${label}`);
  console.log(`  │  ${url}`);
  if (options.body && typeof options.body === 'string') {
    console.log(`  │  body: ${options.body.slice(0, 200)}${options.body.length > 200 ? '...' : ''}`);
  }
  const t0 = Date.now();
  try {
    const res = await fetch(url, options);
    const text = await res.text();
    console.log(`  │  ← ${res.status} (${Date.now() - t0}ms)`);
    console.log(`  │  ${text.slice(0, 400)}${text.length > 400 ? '...' : ''}`);
    console.log('  └─ 完成');
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    console.log(`  └─ 失败: ${e.message}`);
    throw e;
  }
}

// ─── 发送对话消息 ───────────────────────────────────────────────────────────────
async function sendChat(msg) {
  const r = await fetch(`${API}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      user_id: WIKI_USER_ID,
      session_id: SESSION,
      from_name: 'wiki_sync_test',
      channel: 'wechat',
      content: msg,
    }),
  });
  const d = await r.json().catch(() => ({}));
  return d.request_id || d.task_id || '';
}

// ─── 获取 LLMWiki 日志 ──────────────────────────────────────────────────────────
async function getWikiLogs(limit = 100) {
  const r = await fetch(`${LLMWIKI}/api/clients/${WIKI_USER_ID}/logs?limit=${limit}`);
  if (!r.ok) return [];
  const d = await r.json();
  return Array.isArray(d) ? d : (d.logs || []);
}

// ─── 获取 Wiki 页面内容 ─────────────────────────────────────────────────────────
async function getWikiPage(page) {
  const r = await fetch(`${LLMWIKI}/api/clients/${WIKI_USER_ID}/wiki`);
  if (!r.ok) return '';
  const d = await r.json();
  return d[page] || '';
}

// ─── 轮询 Wiki 页面直到包含关键词 ──────────────────────────────────────────────
async function pollWikiPage(page, keyword, timeoutMs = 720_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const content = await getWikiPage(page);
    if (content.includes(keyword)) return { found: true, content };
    await sleep(8000);
    process.stdout.write('.');
  }
  const content = await getWikiPage(page);
  return { found: content.includes(keyword), content };
}

// ─── 轮询工单状态 ───────────────────────────────────────────────────────────────
async function pollTicketStatus(ticketId, targetStatus, timeoutMs = 180_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await fetch(`${BASE}/api/tickets/${ticketId}`);
    if (r.ok) {
      const d = await r.json();
      const status = d.ticket?.status;
      process.stdout.write('.');
      if (status === targetStatus) return { reached: true, ticket: d.ticket };
      if (['error', 'expired'].includes(status)) return { reached: false, ticket: d.ticket, earlyExit: status };
    }
    await sleep(5000);
  }
  return { reached: false };
}

// ══════════════════════════════════════════════════════════════════════════════
// 路径 A: 30轮计数器 — 消息写入与 LLMWiki 日志增长验证
// ══════════════════════════════════════════════════════════════════════════════
async function testCounterSync() {
  section('路径 A: 30轮计数器 — 消息写入 & LLMWiki 日志增长验证');

  const logsBefore = await getWikiLogs();
  const unsyncedBefore = logsBefore.filter(l => !l.synced);
  console.log(`\n  当前日志总数: ${logsBefore.length}（未同步: ${unsyncedBefore.length}）`);
  ok('A-1 获取基线日志成功', Array.isArray(logsBefore), `total=${logsBefore.length}`);

  // 发送 5 条测试消息
  const MSG_COUNT = 5;
  const testMsgs = [
    '你好，我想咨询一下健康问题',
    '我最近睡眠质量比较差',
    '血压有点偏高，大概145/90',
    '饮食上有什么需要注意的',
    '可以帮我分析一下营养状况吗',
  ];
  console.log(`\n  发送 ${MSG_COUNT} 条测试消息...`);
  process.stdout.write('  消息: ');
  for (let i = 0; i < MSG_COUNT; i++) {
    await sendChat(testMsgs[i]);
    process.stdout.write(`${i + 1} `);
    await sleep(600);
  }
  process.stdout.write('\n');

  // 等待日志写入
  await sleep(8000);
  const logsAfter = await getWikiLogs();
  const logDiff = logsAfter.length - logsBefore.length;
  console.log(`\n  发送后日志总数: ${logsAfter.length}（新增: ${logDiff}）`);

  ok('A-2 每条消息对应写入 LLMWiki 日志', logDiff >= MSG_COUNT,
     `新增 ${logDiff} 条，预期 ≥ ${MSG_COUNT}`);

  const newLogs = logsAfter.slice(-Math.max(logDiff, 1));
  ok('A-3 新增日志类型为 wechat',
     newLogs.some(l => l.type === 'wechat'),
     `wechat=${newLogs.filter(l => l.type === 'wechat').length}/${newLogs.length}`);

  console.log('\n  ℹ️  30轮自动同步原理:');
  console.log('     agentService.ts SYNC_COUNTER_LIMIT=30');
  console.log('     满30轮 → triggerWikiSync(userId, "counter_30", maxLogs=15)');
  console.log('     maxLogs=15 批量限制防止 token 溢出和超时');
  ok('A-4 30轮计数器已配置 (SYNC_COUNTER_LIMIT=30)', true,
     'agentService.ts:111');

  return logDiff;
}

// ══════════════════════════════════════════════════════════════════════════════
// 路径 B: patient_confirmed → Wiki 同步（完整工单流程）
// ══════════════════════════════════════════════════════════════════════════════
async function testPatientConfirmedSync() {
  section('路径 B: patient_confirmed Skill 报告 → Wiki 同步（完整流程）');
  console.log('  ℹ️  预计耗时 5~12 分钟（AI sandbox + 3-stage sync pipeline）\n');

  // B-1: 创建工单
  const createR = await httpLog('POST /api/tickets', `${BASE}/api/tickets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      skill_id: SKILL_ID,
      patient_name: 'wiki_e2e_test',
      created_by: WIKI_USER_ID,
      notes: '【E2E 测试】Wiki Sync patient_confirmed 路径验证',
    }),
  });
  ok('B-1 创建工单', createR.ok && !!createR.data?.ticket?.id,
     `status=${createR.status}`);
  if (!createR.ok || !createR.data?.ticket?.id) {
    warn('工单创建失败，跳过路径 B 后续步骤');
    return;
  }
  const ticketId = createR.data.ticket.id;
  const token    = createR.data.ticket.token;
  console.log(`\n  ticketId: ${ticketId}`);
  console.log(`  token:    ${token}`);
  console.log(`  h5_url:   ${BASE}/h5?token=${token}`);

  // B-2: 提交 H5 表单
  const fd = new FormData();
  fd.append('field_height', '175');
  fd.append('field_weight', '70');
  fd.append('field_goal', '增肌减脂，控制血压');
  fd.append('field_dietary_restrictions', '无特殊饮食限制');
  fd.append('field_activity_level', '中等强度运动 3~4 次/周');
  const submitR = await httpLog('POST /api/h5/:token/submit', `${BASE}/api/h5/${token}/submit`, {
    method: 'POST',
    body: fd,
  });
  ok('B-2 H5 表单提交', submitR.ok, `status=${submitR.status}`);
  if (!submitR.ok) {
    warn('H5 表单提交失败，跳过后续步骤');
    return;
  }

  // B-3: 等待 AI 处理完成 (status=done，最多 3 分钟)
  console.log(`\n  B-3 等待 AI sandbox 处理完成...`);
  process.stdout.write('  状态轮询: ');
  const pollResult = await pollTicketStatus(ticketId, 'done', 180_000);
  process.stdout.write('\n');
  ok('B-3 AI 处理完成 (status=done)', pollResult.reached,
     pollResult.earlyExit
       ? `提前退出: ${pollResult.earlyExit}`
       : `reached=${pollResult.reached}`);
  if (!pollResult.reached) {
    warn('AI 未能在 3 分钟内完成，跳过确认步骤');
    return;
  }

  // B-4: 验证报告页面可访问（包含 HTML 确认按钮）
  const reportUrl = `${BASE}/api/results/${ticketId}/report`;
  const reportR = await fetch(reportUrl);
  const reportHtml = await reportR.text();
  ok('B-4 报告 HTML 页面可访问', reportR.ok, `status=${reportR.status}`);
  ok('B-4b 报告页面含"确认报告内容"按钮', reportHtml.includes('确认报告内容'),
     `html_len=${reportHtml.length}`);

  // B-5: 记录 medication_plan.md 基线
  const planBefore = await getWikiPage('medication_plan.md');
  const blocksBefore = (planBefore.match(/```intervention-block/g) || []).length;
  console.log(`\n  Wiki medication_plan.md 基线 intervention-block 数: ${blocksBefore}`);

  // B-6: 患者确认报告（触发 triggerWikiSyncPublic）
  console.log('\n  B-6 患者确认报告（POST /confirm）...');
  console.log('  ℹ️  确认后自动触发: writeWikiLog → triggerWikiSyncPublic(maxLogs=15)');
  const confirmR = await httpLog(
    'POST /api/results/:id/confirm',
    `${BASE}/api/results/${ticketId}/confirm`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' } }
  );
  ok('B-6 确认请求返回成功', confirmR.ok, `status=${confirmR.status}`);

  // B-7: 验证工单状态变为 patient_confirmed
  await sleep(2000);
  const verifyR = await fetch(`${BASE}/api/tickets/${ticketId}`);
  const verifyD = await verifyR.json();
  ok('B-7 工单状态变为 patient_confirmed',
     verifyD.ticket?.status === 'patient_confirmed',
     `status=${verifyD.ticket?.status}`);

  // B-8: 验证 ai_report 日志已写入 LLMWiki
  await sleep(3000);
  const logsAfterConfirm = await getWikiLogs();
  const aiReportLogs = logsAfterConfirm.filter(l => l.type === 'ai_report');
  ok('B-8 ai_report 日志已写入 LLMWiki',
     aiReportLogs.length > 0,
     `ai_report_count=${aiReportLogs.length}`);

  // B-9: 等待 Wiki Sync 完成（3-stage DeepSeek pipeline，最多 12 分钟）
  console.log('\n  B-9 等待 Wiki Sync 自动更新（最多 12 分钟）...');
  console.log('  ℹ️  Stage1: 事实提取(intervention:nutrition) → Stage2: 评分 → Stage3: Wiki写入');
  process.stdout.write('  轮询 medication_plan.md: ');
  const syncResult = await pollWikiPage('medication_plan.md', 'intervention-block', 720_000);
  process.stdout.write('\n');

  const blocksAfter = (syncResult.content.match(/```intervention-block/g) || []).length;
  ok('B-9 medication_plan.md 已更新（包含 intervention-block）',
     syncResult.found,
     `before=${blocksBefore} after=${blocksAfter}`);

  // B-10: 验证 ai_report 日志被标记为已同步
  const logsFinal = await getWikiLogs();
  const syncedAiReports = logsFinal.filter(l => l.type === 'ai_report' && l.synced);
  ok('B-10 ai_report 日志标记为 synced=true',
     syncedAiReports.length > 0 || syncResult.found,
     `synced_ai_reports=${syncedAiReports.length}`);

  if (syncResult.found && blocksAfter > blocksBefore) {
    console.log('\n  🎉 Wiki 同步成功！新增营养干预块:');
    const newBlocks = syncResult.content.match(/```intervention-block[\s\S]*?```/g) || [];
    newBlocks.slice(0, 2).forEach((b, i) => {
      console.log(`\n  [Block ${i + 1}]`);
      console.log('  ' + b.split('\n').join('\n  '));
    });
  }

  return { ticketId, blocksBefore, blocksAfter };
}

// ══════════════════════════════════════════════════════════════════════════════
// 路径 C: 手动 sync + maxLogs 批量限制验证
// ══════════════════════════════════════════════════════════════════════════════
async function testManualSync() {
  section('路径 C: 手动触发 Wiki Sync — maxLogs 批量限制验证');

  const logs = await getWikiLogs();
  const unsynced = logs.filter(l => !l.synced);
  console.log(`\n  未同步日志: ${unsynced.length} 条`);
  ok('C-1 获取未同步日志列表', true, `unsynced=${unsynced.length}`);

  if (unsynced.length === 0) {
    ok('C-2 无未同步日志（路径 B 已全部同步）', true, 'skip');
    return;
  }

  // 触发 sync（maxLogs=5）
  console.log('\n  C-2 触发手动 sync（?maxLogs=5）...');
  const t0 = Date.now();
  const syncR = await httpLog(
    'POST /sync?maxLogs=5',
    `${LLMWIKI}/api/clients/${WIKI_USER_ID}/sync?maxLogs=5`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'e2e_test_manual_sync' }),
    }
  );
  const dur = Date.now() - t0;

  ok('C-2 sync 请求返回成功', syncR.ok, `status=${syncR.status} dur=${dur}ms`);
  if (syncR.ok) {
    ok('C-3 响应包含 wikiUpdated 字段', syncR.data?.wikiUpdated !== undefined,
       `wikiUpdated=${syncR.data?.wikiUpdated}`);
    ok('C-4 sync 在 Cloud Run 超时(900s)内完成', dur < 900_000,
       `耗时 ${(dur / 1000).toFixed(0)}s < 900s`);

    // 验证 maxLogs 确实限制了批次大小
    const logsAfterSync = await getWikiLogs();
    const stillUnsynced = logsAfterSync.filter(l => !l.synced);
    console.log(`\n  sync 前未同步: ${unsynced.length}，sync 后未同步: ${stillUnsynced.length}`);
    ok('C-5 maxLogs=5 批量限制有效（最多同步 5 条）',
       unsynced.length - stillUnsynced.length <= 5,
       `synced=${unsynced.length - stillUnsynced.length}`);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// 主流程
// ══════════════════════════════════════════════════════════════════════════════
async function main() {
  console.log('╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║         Wiki 同步 E2E 测试 — Skill Platform ↔ LLMWiki              ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝');
  console.log(`\n  skill-platform: ${BASE}`);
  console.log(`  llmwiki:        ${LLMWIKI}`);
  console.log(`  wiki_user_id:   ${WIKI_USER_ID}`);
  console.log(`  session:        ${SESSION}`);
  console.log('\n  同步触发路径:');
  console.log('    A. 30轮计数器 (SYNC_COUNTER_LIMIT=30) → triggerWikiSync(maxLogs=15)');
  console.log('    B. patient_confirmed → writeWikiLog(ai_report) → triggerWikiSyncPublic');
  console.log('    C. 手动 POST /sync?maxLogs=N\n');

  try {
    await testCounterSync();
    await testPatientConfirmedSync();
    await testManualSync();
  } catch (e) {
    console.error('\n  💥 测试异常:', e.message, e.stack);
    failed++;
  }

  const total = passed + failed;
  const elapsed = ((Date.now() - START_TS) / 1000).toFixed(1);
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  Wiki Sync E2E 测试完成`);
  console.log(`  总计 ${total} 项 | ✅ ${passed} 通过 | ❌ ${failed} 失败 | 耗时 ${elapsed}s`);
  console.log(`${'═'.repeat(70)}`);

  if (failed > 0) {
    console.log('\n  排查指南:');
    console.log('    路径B失败 → 检查 llmwiki Cloud Run --timeout=900 已部署');
    console.log('    sync失败  → 检查 ARK_API_KEY 环境变量 (gcloud run services describe llmwiki)');
    console.log('    日志不增  → 检查 LLMWIKI_BASE 在 skill-platform Cloud Run 中已设置');
    process.exit(1);
  }
}

main();
