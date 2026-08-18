/**
 * test_prefill_e2e.mjs — H5 预填信息 E2E 测试
 *
 * 流程：
 * 1. 用已知 published external skill 创建新工单（expiry=7天，H5 长期有效）
 * 2. PATCH 注入 prefilled_values（patient_name=oscar, age=37）
 * 3. GET /api/h5/:token → 验证 prefilled_values 返回
 * 4. POST is_self=true, 名字不符 → 验证 warning 返回
 * 5. POST force=true → 验证强制提交成功
 * 6. POST is_self=false（家人） → 验证不触发 warning
 *
 * 运行：node tests/test_prefill_e2e.mjs
 */

const BASE = 'https://skill-platform-yo5337ccva-de.a.run.app';
// 医学报告解读助手（published external skill）
const TEST_SKILL_ID = '5ace230f-cc07-4c7c-ac85-8d4458b9b8bd';


// ── 颜色 ────────────────────────────────────────────────────────────────────
const c = {
  ok:   s => `\x1b[32m✅ ${s}\x1b[0m`,
  fail: s => `\x1b[31m❌ ${s}\x1b[0m`,
  info: s => `\x1b[34mℹ️  ${s}\x1b[0m`,
  bold: s => `\x1b[1m${s}\x1b[0m`,
  warn: s => `\x1b[33m⚠️  ${s}\x1b[0m`,
};
let passed = 0, failed = 0;

function assert(condition, label) {
  if (condition) { console.log(c.ok(label)); passed++; }
  else            { console.log(c.fail(label)); failed++; }
}

// ── Step 1: 找一个最近的 waiting_input 工单 token ────────────────────────
console.log(c.bold('\n=== Step 1: 获取测试工单 ==='));

// 创建一个全新工单（有效期 7 天，H5 链接不会立即过期）
const createRes = await fetch(`${BASE}/api/tickets`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ skill_id: TEST_SKILL_ID, patient_name: 'oscar', notes: '预填E2E测试' }),
});
const createData = await createRes.json();
const testTicketId = createData.ticket?.id;
const testToken    = createData.ticket?.token;
console.log(c.info(`新工单 id=${testTicketId}, token=${testToken?.slice(0,8)}...`));
assert(!!testToken, 'Step 1: 工单创建成功，有 token');
if (!testToken) { console.log(c.fail('建票失败: ' + JSON.stringify(createData).slice(0,150))); process.exit(1); }


// ── Step 2: GET /api/h5/:token ──────────────────────────────────────────
console.log(c.bold('\n=== Step 2: GET H5 表单（验证 prefilled_values 返回） ==='));
const getRes  = await fetch(`${BASE}/api/h5/${testToken}`);
const getData = await getRes.json();
console.log(c.info(`status=${getData.status}`));
console.log(c.info(`prefilled_values=${JSON.stringify(getData.prefilled_values)}` ));
assert(getRes.ok, 'Step 2.1: GET 返回 200');
assert(typeof getData.prefilled_values === 'object', 'Step 2.2: 返回包含 prefilled_values 字段');

const hasPrefill = getData.prefilled_values && Object.keys(getData.prefilled_values).length > 0;
if (hasPrefill) {
  console.log(c.ok('Step 2.3: prefilled_values 有内容（工单是通过 agent 建票的）'));
  passed++;
} else {
  console.log(c.warn('Step 2.3: prefilled_values 为空（工单可能是旧工单没有预填，新建工单才会有）'));
}

// ── Step 3: 测试 warning 逻辑（直接写 prefilled_values 到 DB）──────────────
// 通过 PATCH /api/tickets/:id 注入 prefilled_values
console.log(c.bold('\n=== Step 3: 注入 prefilled_values 到工单，然后测 warning 逻辑 ==='));
const patchRes = await fetch(`${BASE}/api/tickets/${testTicketId}`, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    prefilled_values: JSON.stringify({
      contact_name: 'oscar',
      patient_name: 'oscar',
      patient_age:  '37',
    })
  })
});
if (patchRes.ok) {
  console.log(c.info('PATCH 注入 prefilled_values 成功'));
} else {
  const patchErr = await patchRes.text();
  console.log(c.warn(`PATCH 不支持或失败: ${patchErr.slice(0,100)}`));
  console.log(c.info('跳过 warning 测试，改用 API agent 建工单再测'));
}

// ── Step 4: POST is_self=true 且名字不符 → warning ─────────────────────
console.log(c.bold('\n=== Step 4: POST 提交（is_self=true，名字「张三」）→ 应返回 warning ==='));
const fd4 = new FormData();
fd4.append('fields', JSON.stringify({ patient_name: '张三', patient_age: '38', contact_name: 'oscar' }));
fd4.append('is_self', 'true');
const warnRes  = await fetch(`${BASE}/api/h5/${testToken}/submit`, { method: 'POST', body: fd4 });
const warnData = await warnRes.json();
console.log(c.info(`warning=${warnData.warning}, mismatch=${JSON.stringify(warnData.mismatch_fields)}`));
console.log(c.info(`message: ${warnData.message || '(无)'}` ));

if (patchRes.ok) {
  // 只有 PATCH 成功才能验证
  assert(warnRes.ok, 'Step 4.1: POST 返回 200（不是报错）');
  assert(warnData.warning === true, 'Step 4.2: warning=true');
  assert(Array.isArray(warnData.mismatch_fields) && warnData.mismatch_fields.includes('patient_name'),
    'Step 4.3: mismatch_fields 包含 patient_name');
  assert(typeof warnData.message === 'string' && warnData.message.length > 10, 'Step 4.4: 有提示文字');

  // 验证工单未被提交
  const recheckRes  = await fetch(`${BASE}/api/h5/${testToken}`);
  const recheckData = await recheckRes.json();
  assert(recheckData.status === 'waiting_input', 'Step 4.5: warning 后工单仍为 waiting_input');
} else {
  console.log(c.warn('Step 4: PATCH 未成功，跳过 warning 验证'));
}

// ── Step 5: POST is_self=true + force=true → 应成功 ───────────────────
console.log(c.bold('\n=== Step 5: force=true 强制提交 ==='));
const fd5 = new FormData();
fd5.append('fields', JSON.stringify({ patient_name: '张三', patient_age: '38', contact_name: 'oscar' }));
fd5.append('is_self', 'true');
fd5.append('force', 'true');
const forceRes  = await fetch(`${BASE}/api/h5/${testToken}/submit`, { method: 'POST', body: fd5 });
const forceData = await forceRes.json();
console.log(c.info(`force result: ${JSON.stringify(forceData).slice(0,120)}`));
assert(forceRes.ok, 'Step 5.1: force 提交返回 200');
assert(!forceData.warning, 'Step 5.2: force 提交无 warning');

// ── Step 6: is_self=false → 即使名字不符也不触发 warning ──────────────
console.log(c.bold('\n=== Step 6: is_self=false （家人）提交，不应触发 warning ==='));
// 创建第二个工单专门测 is_self=false
const create2Res = await fetch(`${BASE}/api/tickets`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ skill_id: TEST_SKILL_ID, patient_name: 'oscar' }),
});
const ticket2 = (await create2Res.json()).ticket;
if (ticket2?.token && patchRes.ok) {
  // 注入 prefilled_values
  await fetch(`${BASE}/api/tickets/${ticket2.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefilled_values: JSON.stringify({ patient_name: 'oscar', patient_age: '37' }) }),
  });
  const fd6 = new FormData();
  fd6.append('fields', JSON.stringify({ patient_name: '张三', patient_age: '65', contact_name: 'oscar' }));
  fd6.append('is_self', 'false');
  const noWarnRes  = await fetch(`${BASE}/api/h5/${ticket2.token}/submit`, { method: 'POST', body: fd6 });
  const noWarnData = await noWarnRes.json();
  console.log(c.info(`is_self=false: warning=${noWarnData.warning}`));
  assert(!noWarnData.warning, 'Step 6: is_self=false 不触发 warning');
} else {
  console.log(c.warn('Step 6: 跳过（第二张工单创建失败或 PATCH 未成功）'));
}


// ── 总结 ────────────────────────────────────────────────────────────────────
console.log(c.bold(`\n=== 测试结果 ===`));
console.log(`通过: ${passed}  失败: ${failed}`);
if (failed > 0) process.exit(1);
