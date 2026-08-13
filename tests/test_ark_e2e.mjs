#!/usr/bin/env node
/**
 * 测试 DeepSeek V4 Flash (Volcano ARK) 路径
 * 通过设置 skill 的 preferred_model = deepseek-v4-flash-ga-260731
 */

const BASE = 'https://skill-platform-yo5337ccva-de.a.run.app';

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log('═'.repeat(60));
  console.log('  DeepSeek V4 Flash (ARK) 路径测试');
  console.log('═'.repeat(60));

  // 1. 找到 AI营养师 skill
  const skillsRes = await fetch(`${BASE}/api/skills`);
  const skillsData = await skillsRes.json();
  const skill = (skillsData.skills || []).find(s => s.name === 'AI营养师');
  if (!skill) { console.error('❌ 找不到 AI营养师 skill'); process.exit(1); }
  console.log(`✅ skill: ${skill.name} (id=${skill.id}) preferred_model=${skill.preferred_model||'(none)'}`);

  const origModel = skill.preferred_model;
  const arkModel  = 'deepseek-v4-flash-ga-260731';

  // 2. 临时改 preferred_model → ARK 模型
  console.log(`\n📝 设置 preferred_model → ${arkModel}`);
  await fetch(`${BASE}/api/skills/${skill.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ preferred_model: arkModel }),
  });

  // 3. 创建工单
  const ticketRes = await fetch(`${BASE}/api/tickets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ skill_id: skill.id, patient_name: 'ARK测试用户' }),
  });
  const ticketData = await ticketRes.json();
  const ticketId   = ticketData.ticket?.id;
  const token      = ticketData.ticket?.token;
  if (!ticketId) { console.error('❌ 创建工单失败:', JSON.stringify(ticketData)); process.exit(1); }
  console.log(`✅ 工单创建: ${ticketId}`);

  // 4. 提交表单（正确路径: /api/h5/:token/submit, x-www-form-urlencoded）
  const fields = JSON.stringify({
    name: 'ARK测试用户', age: '35', gender: '男', height: '175', weight: '75',
    nutrition_goal: '控制血压，保持健康体重',
    diet_preference: '低盐清淡',
    activity_level: '轻度活动',
    allergies: '无',
  });
  const submitRes = await fetch(`${BASE}/api/h5/${token}/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ fields }).toString(),
  });
  const submitData = await submitRes.json();
  console.log(`✅ 表单提交: HTTP ${submitRes.status} → ${submitData.message || JSON.stringify(submitData)}`);
  if (!submitData.success) {
    console.error('❌ 提交失败:', JSON.stringify(submitData));
    process.exit(1);
  }

  // 5. 轮询（最多 5 分钟）
  console.log('\n⏳ 等待 AI 处理 (最多5分钟)...');
  const t0 = Date.now();
  let status = 'submitted';
  while (Date.now() - t0 < 300_000) {
    await sleep(5000);
    const s = await (await fetch(`${BASE}/api/tickets/${ticketId}/status`)).json();
    status = s.status;
    process.stdout.write(`\r  [${Math.round((Date.now()-t0)/1000)}s] ${status}   `);
    if (status === 'done' || status === 'error') { console.log(); break; }
  }

  const elapsed = Math.round((Date.now() - t0) / 1000);
  const detail  = await (await fetch(`${BASE}/api/tickets/${ticketId}`)).json();
  const result  = detail.result;

  console.log('─'.repeat(60));
  if (status === 'done' && result?.raw_result) {
    console.log(`✅ 成功！耗时: ${elapsed}s  model: ${arkModel}`);
    console.log(`   输出: ${result.raw_result.length}字`);
    console.log(`   预览: ${result.raw_result.slice(0,120)}...`);
    console.log(`   报告: ${BASE}/api/results/${ticketId}/report`);
  } else {
    console.error(`❌ 失败 status=${status} elapsed=${elapsed}s`);
    if (result?.raw_result) console.error('   错误:', result.raw_result.slice(0,300));
  }

  // 6. 恢复 preferred_model
  await fetch(`${BASE}/api/skills/${skill.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ preferred_model: origModel || null }),
  });
  console.log(`✅ 已恢复 preferred_model → ${origModel||'(none)'}`);

  console.log(status === 'done' ? '\n✅ ARK 路径测试通过！' : '\n❌ ARK 路径测试失败');
  process.exit(status === 'done' ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
