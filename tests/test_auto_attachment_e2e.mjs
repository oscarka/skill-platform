/**
 * test_auto_attachment_e2e.mjs
 * 测试 24 小时内文件系统自动挂载到工单全流程：
 * 1. 模拟微信收到 PDF 报告，向 /api/orch/ingest 发送带 media_url 的消息
 * 2. 验证附件成功记入 user_recent_files 表（24小时有效期）
 * 3. 触发健康 Skill 建工单流程
 * 4. 验证新工单 ticket_inputs 和 prefilled_values.prefilled_files 中已自动包含该 PDF
 * 5. GET /api/h5/:token 返回包含 prefilled_files
 * 6. POST /api/h5/:token/submit 提交包含 kept_files，验证最终 ticket_inputs 成功保存附件
 *
 * 运行：node tests/test_auto_attachment_e2e.mjs
 */

const BASE = 'https://skill-platform-yo5337ccva-de.a.run.app';

const c = {
  ok:   s => `\x1b[32m✅ ${s}\x1b[0m`,
  fail: s => `\x1b[31m❌ ${s}\x1b[0m`,
  info: s => `\x1b[34mℹ️  ${s}\x1b[0m`,
  bold: s => `\x1b[1m${s}\x1b[0m`,
};
let passed = 0, failed = 0;

function assert(condition, label) {
  if (condition) { console.log(c.ok(label)); passed++; }
  else            { console.log(c.fail(label)); failed++; }
}

const testUserId = `test_user_${Date.now()}`;
const testUserName = '李先生';
const mockGcsUrl = `https://storage.googleapis.com/wechat-archiver-media/2026-08-17/test_report_${Date.now()}.pdf`;
const mockFileName = '2026年度体检化验报告.pdf';

console.log(c.bold('\n=== Step 1: 模拟用户发送 PDF 报告到 /api/orch/ingest ==='));
const ingestRes = await fetch(`${BASE}/api/orch/ingest`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    from_user_id: testUserId,
    from_name:    testUserName,
    content:      `[文件: ${mockFileName} | AI摘要: 客户甘油三酯偏高，尿酸偏高，需要报告解读]`,
    msgtype:      'file',
    media_url:    mockGcsUrl,
    file_name:    mockFileName,
    file_type:    'pdf',
    channel:      'wecom',
  }),
});
const ingestData = await ingestRes.json();
console.log(c.info(`ingest status=${ingestRes.status} res=${JSON.stringify(ingestData)}`));
assert(ingestRes.ok, 'Step 1: Ingest 接口成功接收带 media_url 的消息');

// 稍等 1 秒让数据库写入完成
await new Promise(r => setTimeout(r, 1000));

console.log(c.bold('\n=== Step 2: 用户要求做报告解读，触发建工单 ==='));
const chatRes = await fetch(`${BASE}/api/v1/agent/chat`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    content:    '请为我创建医学报告解读助手分析工单',
    source:     'wecom',
    session_id: testUserId,
    skill_id:   'bb5585f4-9c7e-4fc1-8b6d-824e61f1c675', // 医学报告解读助手（MD版）

    meta: {
      from_name: testUserName,
      user_id:   testUserId,
    },
    context: {
      available_apps: ['企业微信'],
    },
  }),
});




const chatData = await chatRes.json();
console.log(c.info(`chat route_type=${chatData.route_type} status=${chatData.status}`));
console.log(c.info(`reply: ${chatData.reply?.slice(0, 150)}...`));
assert(chatRes.ok, 'Step 2.1: Chat 接口返回 200');
assert(chatData.route_type === 'ticket_created' || chatData.reply?.includes('token='), 'Step 2.2: 成功触发建工单');

// 从回复中提取 token
const tokenMatch = (chatData.reply || '').match(/token=([a-f0-9]+)/i);
const token = tokenMatch ? tokenMatch[1] : null;
console.log(c.info(`提取到的 token: ${token}`));
assert(!!token, 'Step 2.3: 提取到有效的工单 token');

if (!token) {
  console.log(c.fail('未能获取 token，测试中止'));
  process.exit(1);
}

console.log(c.bold('\n=== Step 3: GET /api/h5/:token 验证附件已自动挂载 ==='));
const getH5Res = await fetch(`${BASE}/api/h5/${token}`);
const getH5Data = await getH5Res.json();
console.log(c.info(`H5 返回 prefilled_values: ${JSON.stringify(getH5Data.prefilled_values)}`));
assert(getH5Res.ok, 'Step 3.1: H5 获取工单信息返回 200');
assert(Array.isArray(getH5Data.prefilled_values?.prefilled_files), 'Step 3.2: 返回 prefilled_files 数组');

const attachedFile = (getH5Data.prefilled_values?.prefilled_files || []).find(f => f.name === mockFileName);
console.log(c.info(`匹配到的预填附件: ${JSON.stringify(attachedFile)}`));
assert(!!attachedFile, 'Step 3.3: 系统成功自动挂载 24 小时内 PDF 附件');
assert(attachedFile?.url === mockGcsUrl, 'Step 3.4: 附件 GCS 路径一致');

console.log(c.bold('\n=== Step 4: 提交 H5 表单（保留自动挂载的附件） ==='));
const fd = new FormData();
fd.append('fields', JSON.stringify({
  patient_name: testUserName,
  patient_age:  '40',
  contact_name: testUserName,
}));
fd.append('is_self', 'true');
fd.append('kept_files', JSON.stringify([attachedFile]));

const submitRes = await fetch(`${BASE}/api/h5/${token}/submit`, { method: 'POST', body: fd });
const submitData = await submitRes.json();
console.log(c.info(`提交结果: ${JSON.stringify(submitData)}`));
assert(submitRes.ok, 'Step 4.1: H5 提交成功返回 200');
assert(submitData.success === true || !submitData.warning, 'Step 4.2: 提交无警告并成功接收');

console.log(c.bold(`\n=== 测试结果（Suite A：24小时附件自动挂载） ===`));
console.log(`通过: ${passed}  失败: ${failed}`);
if (failed > 0) process.exit(1);

// ─────────────────────────────────────────────────────────────────────────────
// Suite B：跨 skill 旧工单不注入 waiting_input directive
// 场景：用户之前建了「AI营养师」waiting_input 工单还未填写，
//       然后说「帮我做报告解读」→ AI 不应推营养师工单链接
// ─────────────────────────────────────────────────────────────────────────────
let passedB = 0, failedB = 0;
function assertB(condition, label) {
  if (condition) { console.log(c.ok(label)); passedB++; }
  else            { console.log(c.fail(label)); failedB++; }
}

const userB = `test_crossskill_${Date.now()}`;
const nameB = '王女士';

// AI营养师 skill id（external, published）
const NUTRITIONIST_SKILL = 'a2a53e54-98ca-4980-8b19-c18dea109877';
// 医学报告解读助手 skill id
const MD_REPORT_SKILL    = 'bb5585f4-9c7e-4fc1-8b6d-824e61f1c675';

console.log(c.bold('\n\n═══════════════════════════════════════════════════════'));
console.log(c.bold('Suite B: 跨 skill 旧 waiting_input 工单不干扰新意图'));
console.log(c.bold('═══════════════════════════════════════════════════════'));

// Step B1: 先为用户创建一个营养师 waiting_input 工单
console.log(c.bold('\n=== Step B1: 建营养师工单（模拟用户之前已建，等待填写中）==='));
const chatB1 = await fetch(`${BASE}/api/v1/agent/chat`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    content:    '帮我创建AI营养师工单',
    source:     'wecom',
    session_id: userB,
    skill_id:   NUTRITIONIST_SKILL,
    meta:       { from_name: nameB, user_id: userB },
    context:    { available_apps: ['企业微信'] },
  }),
});
const dataB1 = await chatB1.json();
console.log(c.info(`营养师建单 route_type=${dataB1.route_type} reply(前80): ${dataB1.reply?.slice(0, 80)}...`));
assertB(chatB1.ok, 'Step B1.1: 营养师工单创建请求返回 200');
assertB(
  dataB1.route_type === 'ticket_created' || dataB1.reply?.includes('token='),
  'Step B1.2: 成功创建营养师 waiting_input 工单'
);

// 等 1 秒
await new Promise(r => setTimeout(r, 1000));

// Step B2: 同一用户，切换意图「帮我做报告解读」
console.log(c.bold('\n=== Step B2: 同用户改口要报告解读，旧营养师工单不应被推送 ==='));
const chatB2 = await fetch(`${BASE}/api/v1/agent/chat`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    content:    '不是营养师，帮我做医学报告解读',
    source:     'wecom',
    session_id: userB,
    skill_id:   MD_REPORT_SKILL,
    meta:       { from_name: nameB, user_id: userB },
    context:    { available_apps: ['企业微信'] },
  }),
});
const dataB2 = await chatB2.json();
const replyB2 = dataB2.reply || '';
console.log(c.info(`报告解读请求 route_type=${dataB2.route_type}`));
console.log(c.info(`reply(前200): ${replyB2.slice(0, 200)}...`));

assertB(chatB2.ok, 'Step B2.1: 报告解读请求返回 200');

// 关键断言：回复里不应出现营养师的工单链接（营养师 token）
// 同时应该建了报告解读工单或介绍了报告解读服务
const hasNutritionistLink = /AI营养师.*token=|token=.*AI营养师/.test(replyB2);
const hasMDTicketOrIntro  = replyB2.includes('医学报告解读') || dataB2.route_type === 'ticket_created';
assertB(!hasNutritionistLink, 'Step B2.2: 回复中未推送营养师工单链接（跨 skill 不干扰）');
assertB(hasMDTicketOrIntro,   'Step B2.3: 回复涉及医学报告解读服务');

// Step B3: 如果建了报告解读工单，验证 token 正确
const tokenB2 = replyB2.match(/token=([a-f0-9]+)/i)?.[1];
if (tokenB2) {
  console.log(c.bold('\n=== Step B3: 验证报告解读工单 H5 可正常访问 ==='));
  const h5B = await fetch(`${BASE}/api/h5/${tokenB2}`);
  const h5BData = await h5B.json();
  assertB(h5B.ok && !h5BData.error, 'Step B3.1: 报告解读工单 H5 链接有效');
  assertB(h5BData.skill_name?.includes('报告') || h5BData.form_config != null || h5BData.prefilled_values != null,
    'Step B3.2: H5 返回报告解读工单配置');
  console.log(c.info(`H5 skill=${h5BData.skill_name || '(检查 form_config)'} prefilled_keys=${Object.keys(h5BData.prefilled_values || {}).join(',')}`));
} else {
  console.log(c.info('未提取到报告解读 token，跳过 B3（守卫流程，尚未直接建单）'));
}

console.log(c.bold('\n=== Suite B 测试结果 ==='));
console.log(`通过: ${passedB}  失败: ${failedB}`);

// ─────────────────────────────────────────────────────────────────────────────
// Suite C：扫描件 PDF 消息（无 AI摘要）整体流程不触发 agent reply
//
// 真实场景：archiver 把扫描件 content 发到 /api/orch/ingest
// ⚠️  /api/orch/ingest 收到后应该：
//   a) 保存到 user_recent_files ✅
//   b) 不调用 processAgentChat / 不产生 agent reply
//      → 通过检查最新 agent task 时间戳来验证
//
// 注意：archiver.js 那层的拦截（不调 forwardToSkillPlatform）是另一道防线。
// 即使 archiver 失守，ingest 端也不应该对纯文件消息触发 agent reply。
// ─────────────────────────────────────────────────────────────────────────────
let passedC = 0, failedC = 0;
function assertC(condition, label) {
  if (condition) { console.log(c.ok(label)); passedC++; }
  else            { console.log(c.fail(label)); failedC++; }
}

const userC = `test_scanpdf_${Date.now()}`;
const nameC = '陈先生';
const scanPdfContent = '[文件: 影像诊断报告.pdf（扫描件/图片PDF，无可提取文字）]';
const scanGcsUrl = `https://storage.googleapis.com/wechat-archiver-media/2026-08-17/scan_${Date.now()}.pdf`;

console.log(c.bold('\n\n═══════════════════════════════════════════════════════'));
console.log(c.bold('Suite C: 文件消息（含AI摘要或无）均不触发 agent reply'));
console.log(c.bold('═══════════════════════════════════════════════════════'));

// 先记录当前最新 task 的 started_at，用于对比
const tasksBefore = await fetch(`${BASE}/api/v1/agent/tasks?limit=3`).then(r => r.json()).catch(() => []);
const latestTaskBefore = (Array.isArray(tasksBefore) ? tasksBefore : tasksBefore.tasks || [])[0];
const latestTimeBefore = latestTaskBefore?.started_at || 0;
console.log(c.info(`发送文件前最新 task: ${latestTaskBefore?.id || '(无)'} at ${latestTimeBefore}`));

// Step C1a: 扫描件（无 AI摘要）→ 应返回 file_saved
console.log(c.bold('\n=== Step C1a: 扫描件 PDF（无 AI摘要）→ ingest 应返回 file_saved ==='));
const ingestC = await fetch(`${BASE}/api/orch/ingest`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    from_user_id: userC,
    from_name:    nameC,
    content:      scanPdfContent,   // 无 AI摘要
    msgtype:      'file',
    media_url:    scanGcsUrl,
    file_name:    '影像诊断报告.pdf',
    file_type:    'pdf',
    channel:      'wecom',
  }),
});
const ingestCData = await ingestC.json();
console.log(c.info(`ingest status=${ingestC.status} res=${JSON.stringify(ingestCData)}`));
assertC(ingestC.ok && ingestCData.status === 'file_saved', 'Step C1a: 扫描件（无AI摘要）返回 file_saved');

// Step C1b: 有 AI摘要 的文件（模拟 Gemini Vision OCR 成功后）→ 也应返回 file_saved，不触发 agent
console.log(c.bold('\n=== Step C1b: 有 AI摘要 的文件（Gemini OCR 成功模拟）→ 也应返回 file_saved ==='));
const ocrContent = '[文件: 影像诊断报告.pdf | AI摘要: 该报告显示患者血压偏高（140/90mmHg），建议进一步检查]';
const ingestCb = await fetch(`${BASE}/api/orch/ingest`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    from_user_id: userC,
    from_name:    nameC,
    content:      ocrContent,   // 有 AI摘要 → 以前会触发 agent，现在不应该
    msgtype:      'file',
    media_url:    scanGcsUrl,
    file_name:    '影像诊断报告.pdf',
    file_type:    'pdf',
    channel:      'wecom',
  }),
});
const ingestCbData = await ingestCb.json();
console.log(c.info(`C1b ingest status=${ingestCb.status} res=${JSON.stringify(ingestCbData)}`));
assertC(ingestCb.ok && ingestCbData.status === 'file_saved',
  'Step C1b: 有AI摘要的文件消息也返回 file_saved（Gemini OCR 成功后也不触发 agent）');

// 等 5 秒让 processAgentChat 有充足时间执行（如果被错误触发的话）
await new Promise(r => setTimeout(r, 5000));

// Step C2: 验证 agent 没有被触发（没有新的 task 产生）
console.log(c.bold('\n=== Step C2: 验证扫描件消息没有触发 agent reply ==='));
const tasksAfter = await fetch(`${BASE}/api/v1/agent/tasks?limit=3`).then(r => r.json()).catch(() => []);
const latestTaskAfter = (Array.isArray(tasksAfter) ? tasksAfter : tasksAfter.tasks || [])[0];
const latestTimeAfter = latestTaskAfter?.started_at || 0;

console.log(c.info(`发送扫描件后最新 task: ${latestTaskAfter?.id || '(无)'} at ${latestTimeAfter}`));
console.log(c.info(`session_id: ${latestTaskAfter?.session_id?.slice(0, 20) || '(无)'}`));

// 没有产生属于 userC 的新 agent task
const hasNewTaskForScanUser = latestTaskAfter?.session_id?.includes(userC)
  || (latestTimeAfter > latestTimeBefore + 2000 && latestTaskAfter?.session_id?.includes(userC));
assertC(!hasNewTaskForScanUser, 'Step C2.1: 扫描件消息没有触发新的 agent task（正确静默）');

// 同时验证 user_recent_files 通过 ingest 媒体 URL 已记录
// （只发扫描件，文件 URL 应该已暂存，等后续用户发文字时附加到工单）
// 通过建工单验证：此时建一个工单，检查是否有该 PDF 被预填
console.log(c.bold('\n=== Step C3: 验证扫描件 URL 已暂存（建工单验证预填文件）==='));
const chatC3 = await fetch(`${BASE}/api/v1/agent/chat`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    content:    '帮我建医学报告解读工单',
    source:     'wecom',
    session_id: userC,
    skill_id:   MD_REPORT_SKILL,
    meta:       { from_name: nameC, user_id: userC },
    context:    { available_apps: ['企业微信'] },
  }),
});
const dataC3 = await chatC3.json();
const tokenC = (dataC3.reply || '').match(/token=([a-f0-9]+)/i)?.[1];
assertC(chatC3.ok && tokenC, 'Step C3.1: 手动触发建工单成功');

if (tokenC) {
  const h5C = await fetch(`${BASE}/api/h5/${tokenC}`).then(r => r.json());
  const hasPrefilledScanPdf = (h5C.prefilled_values?.prefilled_files || []).some(f => f.url === scanGcsUrl);
  assertC(hasPrefilledScanPdf, 'Step C3.2: 扫描件 URL 已被自动挂载到工单预填附件（暂存有效）');
  console.log(c.info(`预填文件: ${JSON.stringify(h5C.prefilled_values?.prefilled_files || [])}`));
}

// Step C4（第三道防线）：即使扫描件 content 意外进入 /api/v1/agent/chat，agent 也保持静默（不回任何话）
console.log(c.bold('\n=== Step C4（第三道防线）：文件占位符直接进 chat，agent 应完全静默 ==='));
const userC4 = `test_scanpdf_l2_${Date.now()}`;
const chatC4 = await fetch(`${BASE}/api/v1/agent/chat`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ content: scanPdfContent, source: 'wecom', session_id: userC4,
    meta: { from_name: '测试', user_id: userC4 }, context: { available_apps: ['企业微信'] } }),
});
const dataC4 = await chatC4.json();
const replyC4 = dataC4.reply || '';
// 第三道防线：agentService 检测到纯文件占位符，直接返回空 reply（完全静默，不回任何话）
assertC(replyC4 === '', 'Step C4: 文件占位符进入 chat，agent 返回空 reply（第三道防线：完全静默）');
console.log(c.info(`C4 route_type=${dataC4.route_type} reply长度=${replyC4.length} reply(前60): "${replyC4.slice(0, 60)}"`));


// ─────────────────────────────────────────────────────────────────────────────
// Suite D：用户明确问工单状态 → 正常推链接；用户发文件 → 不推
// ─────────────────────────────────────────────────────────────────────────────
let passedD = 0, failedD = 0;
function assertD(condition, label) {
  if (condition) { console.log(c.ok(label)); passedD++; }
  else            { console.log(c.fail(label)); failedD++; }
}

const userD = `test_querytkt_${Date.now()}`;
const nameD = '周女士';

console.log(c.bold('\n\n═══════════════════════════════════════════════════════'));
console.log(c.bold('Suite D: query_ticket waiting_input 仅在明确询问时推链接'));
console.log(c.bold('═══════════════════════════════════════════════════════'));

// Step D1: 建 waiting_input 工单
console.log(c.bold('\n=== Step D1: 建 waiting_input 工单 ==='));
const chatD1 = await fetch(`${BASE}/api/v1/agent/chat`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    content:    '帮我建医学报告解读工单',
    source:     'wecom',
    session_id: userD,
    skill_id:   MD_REPORT_SKILL,
    meta:       { from_name: nameD, user_id: userD },
    context:    { available_apps: ['企业微信'] },
  }),
});
const dataD1 = await chatD1.json();
assertD(chatD1.ok && (dataD1.route_type === 'ticket_created' || dataD1.reply?.includes('token=')),
  'Step D1: waiting_input 工单创建成功');
// 提取工单 token 用于对比
const tokenD = (dataD1.reply || '').match(/token=([a-f0-9]+)/i)?.[1];
console.log(c.info(`工单 token: ${tokenD || '(未提取到，在守卫流程)'}`));

await new Promise(r => setTimeout(r, 1000));

// Step D2: 用户明确询问工单填写链接 → 应推链接
console.log(c.bold('\n=== Step D2: 用户明确询问"工单怎么填" → 应提供链接 ==='));
const chatD2 = await fetch(`${BASE}/api/v1/agent/chat`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    content:    '我的工单在哪里填写？给我链接',
    source:     'wecom',
    session_id: userD,
    meta:       { from_name: nameD, user_id: userD },
    context:    { available_apps: ['企业微信'] },
  }),
});
const dataD2 = await chatD2.json();
const replyD2 = dataD2.reply || '';
console.log(c.info(`reply(前200): ${replyD2.slice(0, 200)}`));
assertD(chatD2.ok, 'Step D2.1: 请求返回 200');
// 明确询问时应该返回链接
const hasLinkD2 = /token=|h5\?/.test(replyD2) || /链接|填写|工单/.test(replyD2);
assertD(hasLinkD2, 'Step D2.2: 明确询问工单时回复包含链接或填写引导');

// Step D3: 用户只发文件（走真实 ingest 路径）→ 完全静默，不回任何话
// ⚠️  D3 应该测 /api/orch/ingest（真实的微信文件消息路径），
//      不能直接调 /api/v1/agent/chat（那会绕过 ingest 守卫）
console.log(c.bold('\n=== Step D3: 用户只发文件（ingest 路径）→ 完全静默，不回任何话 ==='));

// 记录此时最新 task，用于验证没有新 task 产生
const tasksD3Before = await fetch(`${BASE}/api/v1/agent/tasks?limit=3`).then(r => r.json()).catch(() => []);
const latestD3Before = (Array.isArray(tasksD3Before) ? tasksD3Before : tasksD3Before.tasks || [])[0];
const latestD3Time = latestD3Before?.started_at || 0;

const scanGcsD3 = `https://storage.googleapis.com/wechat-archiver-media/2026-08-17/scanD3_${Date.now()}.pdf`;
const ingestD3 = await fetch(`${BASE}/api/orch/ingest`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    from_user_id: userD,
    from_name:    nameD,
    content:      '[文件: 新的体检报告.pdf（扫描件/图片PDF，无可提取文字）]',
    msgtype:      'file',
    media_url:    scanGcsD3,
    file_name:    '新的体检报告.pdf',
    file_type:    'pdf',
    channel:      'wecom',
  }),
});
const ingestD3Data = await ingestD3.json();
console.log(c.info(`D3 ingest res=${JSON.stringify(ingestD3Data)}`));
assertD(ingestD3.ok && ingestD3Data.status === 'file_saved',
  'Step D3.1: 文件消息通过 ingest 返回 file_saved（不触发 agent）');

// 等 5 秒验证没有新 agent task（完全静默）
await new Promise(r => setTimeout(r, 5000));
const tasksD3After = await fetch(`${BASE}/api/v1/agent/tasks?limit=3`).then(r => r.json()).catch(() => []);
const latestD3After = (Array.isArray(tasksD3After) ? tasksD3After : tasksD3After.tasks || [])[0];
const hasNewD3Task = latestD3After?.session_id?.includes(userD)
  && (latestD3After?.started_at || 0) > latestD3Time;
assertD(!hasNewD3Task, 'Step D3.2: 用户发文件后没有新 agent task，完全静默（不回任何话）');
console.log(c.info(`D3 最新 task session: ${latestD3After?.session_id?.slice(0, 25) || '(无)'}`));


console.log(c.bold('\n=== Suite C 测试结果 ==='));
console.log(`通过: ${passedC}  失败: ${failedC}`);
console.log(c.bold('\n=== Suite D 测试结果 ==='));
console.log(`通过: ${passedD}  失败: ${failedD}`);

// ─────────────────────────────────────────────────────────────────────────────
// Suite E：先发文件（ingest暂存）→ 再发文字 → 路由应识别报告解读意图建工单
// 验证「路由上下文注入近期文件摘要」的 fix
// ─────────────────────────────────────────────────────────────────────────────
let passedE = 0, failedE = 0;
function assertE(condition, label) {
  if (condition) { console.log(c.ok(label)); passedE++; }
  else            { console.log(c.fail(label)); failedE++; }
}

// ── 前置：确保医学报告解读 skill 在 profile 中，且等缓存（30s）过期 ───────────
const REPORT_SKILL_ID = 'bb5585f4-9c7e-4fc1-8b6d-824e61f1c675';
{
  const profileRes = await fetch(`${BASE}/api/v1/agent/profile`).then(r => r.json());
  const hasReportSkill = Array.isArray(profileRes.skill_ids) && profileRes.skill_ids.includes(REPORT_SKILL_ID);
  if (!hasReportSkill) {
    console.log(c.info('Suite E 前置：profile 缺少医学报告解读 skill，自动补充...'));
    const newIds = [...new Set([...(profileRes.skill_ids || []), REPORT_SKILL_ID])];
    await fetch(`${BASE}/api/v1/agent/profile`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skill_ids: newIds }),
    });
    // 等服务端缓存（30s）过期
    console.log(c.info('等待服务端 skill 缓存（35s）过期...'));
    await new Promise(r => setTimeout(r, 35000));
  } else {
    // skill 已在 profile 但仍需等缓存，补等 35s 以防缓存了旧结果
    console.log(c.info('Suite E 前置：医学报告解读 skill 已在 profile，等 35s 缓存刷新...'));
    await new Promise(r => setTimeout(r, 35000));
  }
}

const userE = `test_file_then_text_${Date.now()}`;
const nameE = '李女士';
const fileGcsE = `https://storage.googleapis.com/wechat-archiver-media/2026-08-17/ct_report_${Date.now()}.pdf`;
const fileSummaryE = '[文件: 影像诊断报告.pdf | AI摘要: 本次胸部CT平扫显示双肺多发微小结节，评定为LUNG-RADS 2类，建议酌情年度复查]';

console.log(c.bold('\n\n═══════════════════════════════════════════════════════'));
console.log(c.bold('Suite E: 先发文件（ingest暂存）→ 再发文字 → 路由建工单'));
console.log(c.bold('═══════════════════════════════════════════════════════'));

// Step E1: 通过 ingest 发文件（含AI摘要）→ 应暂存到 user_recent_files
console.log(c.bold('\n=== Step E1: 通过 ingest 发文件（含AI摘要）→ file_saved 并暂存 ==='));
const ingestE1 = await fetch(`${BASE}/api/orch/ingest`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    from_user_id: userE,
    from_name:    nameE,
    content:      fileSummaryE,
    msgtype:      'file',
    media_url:    fileGcsE,
    file_name:    '影像诊断报告.pdf',
    file_type:    'pdf',
    channel:      'wecom',
  }),
});
const ingestE1Data = await ingestE1.json();
console.log(c.info(`E1 ingest res=${JSON.stringify(ingestE1Data)}`));
assertE(ingestE1.ok && ingestE1Data.status === 'file_saved',
  'Step E1: 文件通过 ingest 暂存（file_saved），不触发 agent');

// 等一下让 DB 写入完成
await new Promise(r => setTimeout(r, 1000));

// Step E2: 用户发文字询问报告分析 → 路由应识别到近期文件，建工单
console.log(c.bold('\n=== Step E2: 用户发文字「看看我这个报告，能做个报告分析吗」→ 应建工单 ==='));
const chatE2 = await fetch(`${BASE}/api/v1/agent/chat`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    content:    '看看我这个报告。能做个报告分析吗',
    source:     'wecom',
    session_id: userE,
    meta:       { from_name: nameE, user_id: userE },
    context:    { available_apps: ['企业微信'] },
  }),
});
const dataE2 = await chatE2.json();
const replyE2 = dataE2.reply || '';
console.log(c.info(`E2 route_type=${dataE2.route_type} reply(前120): ${replyE2.slice(0, 120)}`));
assertE(chatE2.ok, 'Step E2.1: chat 请求返回 200');
assertE(dataE2.route_type === 'ticket_created',
  `Step E2.2: 路由正确识别报告分析意图，建工单（route_type=ticket_created，实际=${dataE2.route_type}）`);
assertE(/token=/.test(replyE2),
  'Step E2.3: 回复中包含工单填写链接（token=）');

// Step E3: 验证工单预填附件包含该 PDF
console.log(c.bold('\n=== Step E3: 验证工单预填附件包含上传的 PDF ==='));
const tokenE = replyE2.match(/token=([a-f0-9]+)/i)?.[1];
if (tokenE) {
  const h5E = await fetch(`${BASE}/api/h5/${tokenE}`).then(r => r.json());
  const files = h5E.prefilled_values?.prefilled_files || [];
  const hasPdf = files.some(f => f.url === fileGcsE || f.name?.includes('影像诊断'));
  console.log(c.info(`E3 prefilled_files: ${JSON.stringify(files.map(f => f.name))}`));
  assertE(hasPdf, 'Step E3.1: 工单预填附件中包含用户上传的 PDF');
} else {
  console.log(c.info('E3: 无工单 token，跳过预填验证'));
  failedE++;
  console.log(c.fail('Step E3.1: 未能提取 token，无法验证预填'));
}

console.log(c.bold('\n=== Suite E 测试结果 ==='));
console.log(`通过: ${passedE}  失败: ${failedE}`);

// ── 总汇 ──────────────────────────────────────────────────────────────────────
const totalPass = passed + passedB + passedC + passedD + passedE;
const totalFail = failed + failedB + failedC + failedD + failedE;
console.log(c.bold(`\n╔══════════════════════════════════╗`));
console.log(c.bold(`  总计：通过 ${totalPass}  失败 ${totalFail}`));
console.log(c.bold(`╚══════════════════════════════════╝`));
if (totalFail > 0) process.exit(1);


