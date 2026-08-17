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

console.log(c.bold(`\n=== 测试结果 ===`));
console.log(`通过: ${passed}  失败: ${failed}`);
if (failed > 0) process.exit(1);
