#!/usr/bin/env node
/**
 * DeepSeek → Gemini Fallback 测试
 * 
 * 验证方式：通过 PATCH /api/skills/:id/model 临时给 skill 设置一个不存在的 ARK 模型名
 *          → 触发 ARK 401/404 → L2 fallback 到 Gemini → 工单完成
 *          → 测试结束后恢复原始模型
 * 
 * 监控项：
 *   1. 日志中出现 [call_ai] L1 failed + L2 trying fallback
 *   2. 工单最终 status=done（Gemini 接管成功）
 *   3. 记录各阶段耗时
 */

const BASE = 'https://skill-platform-yo5337ccva-de.a.run.app';
const SKILL_NAME = 'AI营养师';
const BROKEN_MODEL = 'deepseek-v4-flash-BROKEN-test';  // 故意错误的模型名

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const t0 = Date.now();
  const elapsed = () => `[${Math.round((Date.now() - t0) / 1000)}s]`;

  console.log('═'.repeat(60));
  console.log('  DeepSeek → Gemini Fallback E2E 测试');
  console.log('═'.repeat(60));

  // 1. 找 skill
  const skillsData = await (await fetch(`${BASE}/api/skills`)).json();
  const skill = (skillsData.skills || []).find(s => s.name === SKILL_NAME);
  if (!skill) { console.error(`❌ 找不到 ${SKILL_NAME}`); process.exit(1); }
  const originalModel = skill.preferred_model || '';
  console.log(`✅ skill: ${skill.name}  preferred_model="${originalModel || '(默认ARK)'}"`);

  // 2. 临时设置一个不存在的模型名，让 ARK 主路径失败
  console.log(`\n${elapsed()} 临时设置模型为 "${BROKEN_MODEL}" (故意失败)`);
  const patchRes = await fetch(`${BASE}/api/skills/${skill.id}/model`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ preferred_model: BROKEN_MODEL }),
  });
  if (!patchRes.ok) {
    console.error('❌ PATCH 失败:', await patchRes.text());
    process.exit(1);
  }
  console.log(`✅ 模型已设置为 ${BROKEN_MODEL}`);

  let status = 'submitted';
  try {
    // 3. 创建工单
    const ticketData = await (await fetch(`${BASE}/api/tickets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skill_id: skill.id, patient_name: 'Fallback测试' }),
    })).json();
    const ticketId = ticketData.ticket?.id;
    const token    = ticketData.ticket?.token;
    if (!ticketId) { console.error('❌ 创建工单失败'); process.exit(1); }
    console.log(`${elapsed()} ✅ 工单: ${ticketId}`);

    // 4. 提交表单
    const fields = JSON.stringify({
      name: 'Fallback测试', age: '30', gender: '女', height: '165', weight: '55',
      nutrition_goal: '日常均衡饮食',
      diet_preference: '清淡', activity_level: '适度运动', allergies: '无',
    });
    const submitRes = await fetch(`${BASE}/api/h5/${token}/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ fields }).toString(),
    });
    if (!(await submitRes.json()).success) { console.error('❌ 提交失败'); process.exit(1); }
    console.log(`${elapsed()} ✅ 表单提交成功`);

    // 5. 轮询（ARK 失败 + Gemini fallback，可能更慢，给 8 分钟）
    console.log(`\n${elapsed()} ⏳ 等待 AI 处理（ARK 应失败 → Gemini fallback，最多8分钟）...`);
    const pollStart = Date.now();
    while (Date.now() - pollStart < 480_000) {
      await sleep(5000);
      try {
        status = (await (await fetch(`${BASE}/api/tickets/${ticketId}/status`)).json()).status;
      } catch { status = 'fetch_error'; }
      process.stdout.write(`\r  ${elapsed()} status=${status}   `);
      if (['done', 'error', 'failed'].includes(status)) { console.log(); break; }
    }

    // 6. 结果
    const detail = await (await fetch(`${BASE}/api/tickets/${ticketId}`)).json();
    const result = detail.result;
    const totalSec = Math.round((Date.now() - t0) / 1000);

    console.log('─'.repeat(60));
    if (status === 'done' && result?.raw_result) {
      console.log(`✅ Fallback 成功！耗时: ${totalSec}s  输出: ${result.raw_result.length}字`);
      console.log(`   预览: ${result.raw_result.slice(0, 120)}...`);
      console.log(`   报告: ${BASE}/api/results/${ticketId}/report`);
      console.log(`\n⚠️  请检查 sandbox-service 日志确认：`);
      console.log(`   1. [call_ai] L1 failed: ... (ARK 模型名错误)`);
      console.log(`   2. [call_ai] L2 trying fallback ... (切换 Gemini)`);
      console.log(`   3. [llm] -> ... provider=gemini ... (Gemini 实际执行)`);
    } else {
      console.error(`❌ 失败 status=${status} elapsed=${totalSec}s`);
      if (result?.raw_result) console.error('   错误:', result.raw_result.slice(0, 300));
    }
  } finally {
    // 7. 恢复原始模型
    console.log(`\n${elapsed()} 恢复模型为 "${originalModel || '(默认ARK)'}"`);
    await fetch(`${BASE}/api/skills/${skill.id}/model`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preferred_model: originalModel || '' }),
    });
    console.log(`✅ 模型已恢复`);
  }

  console.log('\n' + (status === 'done'
    ? '✅ Fallback 测试通过！ARK 失败后 Gemini 成功接管'
    : '❌ Fallback 测试失败'));
  return status;
}

main().then(status => {
  if (status !== 'done') process.exit(1);
}).catch(e => { console.error(e); process.exit(1); });

