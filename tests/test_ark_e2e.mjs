#!/usr/bin/env node
/**
 * ARK 路径 E2E 测试
 * 默认模型已是 deepseek-v4-flash-ga-260731（ARK 火山），无需手动设置 preferred_model
 * 直接创建工单 → 提交 → 验证是否走 ARK 路径并完成
 */

const BASE = 'https://skill-platform-yo5337ccva-de.a.run.app';
const SKILL_NAME = 'AI营养师';

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log('═'.repeat(60));
  console.log('  DeepSeek V4 Flash (ARK) 默认路径 E2E 测试');
  console.log('═'.repeat(60));

  // 1. 找 skill
  const skillsData = await (await fetch(`${BASE}/api/skills`)).json();
  const skill = (skillsData.skills || []).find(s => s.name === SKILL_NAME);
  if (!skill) { console.error(`❌ 找不到 ${SKILL_NAME}`); process.exit(1); }
  console.log(`✅ skill: ${skill.name}  status=${skill.status}  preferred_model=${skill.preferred_model || '(none=默认ARK)'}`);

  // 2. 创建工单
  const ticketData = await (await fetch(`${BASE}/api/tickets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ skill_id: skill.id, patient_name: 'ARK默认模型测试' }),
  })).json();
  const ticketId = ticketData.ticket?.id;
  const token    = ticketData.ticket?.token;
  if (!ticketId) { console.error('❌ 创建工单失败:', JSON.stringify(ticketData)); process.exit(1); }
  console.log(`✅ 工单创建: ${ticketId}`);

  // 3. 提交表单
  const fields = JSON.stringify({
    name: 'ARK默认模型测试', age: '35', gender: '男', height: '175', weight: '75',
    nutrition_goal: '控制血压，保持健康体重',
    diet_preference: '低盐清淡', activity_level: '轻度活动', allergies: '无',
  });
  const submitRes = await fetch(`${BASE}/api/h5/${token}/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ fields }).toString(),
  });
  const submitData = await submitRes.json();
  if (!submitData.success) { console.error('❌ 提交失败:', JSON.stringify(submitData)); process.exit(1); }
  console.log(`✅ 表单提交成功`);

  // 4. 轮询（最多 5 分钟）
  console.log('\n⏳ 等待 AI 处理 (最多5分钟)...');
  const t0 = Date.now();
  let status = 'submitted';
  while (Date.now() - t0 < 300_000) {
    await sleep(5000);
    status = (await (await fetch(`${BASE}/api/tickets/${ticketId}/status`)).json()).status;
    process.stdout.write(`\r  [${Math.round((Date.now()-t0)/1000)}s] ${status}   `);
    if (status === 'done' || status === 'error') { console.log(); break; }
  }

  const elapsed = Math.round((Date.now() - t0) / 1000);
  const detail  = await (await fetch(`${BASE}/api/tickets/${ticketId}`)).json();
  const result  = detail.result;

  console.log('─'.repeat(60));
  if (status === 'done' && result?.raw_result) {
    const len = result.raw_result.length;
    console.log(`✅ 成功！耗时: ${elapsed}s  输出: ${len}字`);
    console.log(`   预览: ${result.raw_result.slice(0, 120)}...`);
    console.log(`   报告: ${BASE}/api/results/${ticketId}/report`);
    if (len < 1000) console.warn(`⚠️  输出偏短（${len}字），可能 token 被截断`);
  } else {
    console.error(`❌ 失败 status=${status} elapsed=${elapsed}s`);
    if (result?.raw_result) console.error('   错误:', result.raw_result.slice(0, 300));
    process.exit(1);
  }

  console.log('\n' + (status === 'done' ? '✅ ARK 默认路径测试通过！' : '❌ 测试失败'));
}

main().catch(e => { console.error(e); process.exit(1); });
