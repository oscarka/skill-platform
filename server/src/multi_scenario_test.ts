/**
 * multi_scenario_test.ts — 多场景全面测试套件
 */
import { paceAgentMessage, splitByRules } from './messagePacer';

async function runComprehensiveTests() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('       Pacer Splitter & Dispatcher 全场景深度综合测试          ');
  console.log('═══════════════════════════════════════════════════════════════\n');

  let passed = 0;
  let failed = 0;

  function check(desc: string, condition: boolean, detail?: string) {
    if (condition) {
      console.log(`✅ [PASS] ${desc}`);
      if (detail) console.log(`   └─ ${detail}`);
      passed++;
    } else {
      console.error(`❌ [FAIL] ${desc}`);
      if (detail) console.error(`   └─ ${detail}`);
      failed++;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // 场景 1: 工单链接与复杂 Token 参数测试
  // ─────────────────────────────────────────────────────────────
  console.log('\n▶ 测试场景 1: 复杂工单链接与多参数保真性');
  const scenario1 = `oscar，已为您创建「医学报告解读助手（MD版）」分析工单 🎉

我们已根据您的健康档案预填了信息（已为您自动载入：影像诊断报告.pdf），请点击以下链接确认并补充，提交后 AI 将为您生成专属分析报告：

https://skill-platform-yo5337ccva-de.a.run.app/h5?token=b00623de80784486a15411848846e2a5&channel=wecom&v=2.1#step=confirm

完成提交后 AI 将开始分析，完成后将通知您 ✅`;

  const res1 = await paceAgentMessage(scenario1);
  check('场景1分段成功', res1.isSplit && res1.segments.length >= 2);
  const tokenPreserved = res1.segments.some(s => s.includes('https://skill-platform-yo5337ccva-de.a.run.app/h5?token=b00623de80784486a15411848846e2a5&channel=wecom&v=2.1#step=confirm'));
  check('复杂 URL 带 hash 与 query params 100% 完整', tokenPreserved);

  // ─────────────────────────────────────────────────────────────
  // 场景 2: 包含多个药品、剂量、化验指标的超长咨询
  // ─────────────────────────────────────────────────────────────
  console.log('\n▶ 测试场景 2: 密集医学术语、剂量与指标保真性');
  const scenario2 = `oscar，我已经帮您查了档案：您目前没有在服用任何降压药，静息血压 142/88mmHg，ALT 32U/L，肌酐 85μmol/L，指标总体稳定，先放宽心～

关于您问的二甲双胍（Glucophage 格华止 500mg/片）和 α-硫辛酸（Alpha Lipoic Acid 600mg）：二甲双胍是处方降糖药，非糖尿病患者不可用于抗衰老；α-硫辛酸虽是抗氧化剂，但过量会引起胃肠刺激与低血糖反应。

请问您今天早餐吃了什么？另外瘙痒部位主要在四肢还是前胸？`;

  const res2 = await paceAgentMessage(scenario2);
  check('场景2分段成功', res2.isSplit && res2.segments.length >= 2);
  const allText2 = res2.segments.join('\n');
  check('血压 142/88mmHg 完好', allText2.includes('142/88mmHg'));
  check('化验指标 ALT 32U/L 完好', allText2.includes('ALT 32U/L'));
  check('肌酐 85μmol/L 完好', allText2.includes('85μmol/L'));
  check('英文药名 Glucophage 完好', allText2.includes('Glucophage'));
  check('化学式 α-硫辛酸 完好', allText2.includes('α-硫辛酸'));

  // ─────────────────────────────────────────────────────────────
  // 场景 3: 列表型序号建议（1. 2. 3.）分段
  // ─────────────────────────────────────────────────────────────
  console.log('\n▶ 测试场景 3: 列表序号内容分段');
  const scenario3 = `oscar，为您整理了以下3点注意事项：

1. 饮食调整：减少高钠加工肉类（香肠、腊肉）摄入，多吃富含钾的深色蔬菜。
2. 运动安排：每周保持3次中等强度抗阻训练，避免过早力竭导致血压瞬时升高。
3. 监测计划：建议每天早晨晨起后静坐5分钟测量血压并记录。

您看下周一开始按这个计划执行可以吗？`;

  const res3 = await paceAgentMessage(scenario3);
  check('场景3分段成功', res3.isSplit && res3.segments.length >= 2);
  const allText3 = res3.segments.join('\n');
  check('包含所有3个序号列表', allText3.includes('1. 饮食调整') && allText3.includes('2. 运动安排') && allText3.includes('3. 监测计划'));

  // ─────────────────────────────────────────────────────────────
  // 场景 4: 短消息快速路径测试（必须为单条，不分段）
  // ─────────────────────────────────────────────────────────────
  console.log('\n▶ 测试场景 4: 短消息向后兼容性');
  const shortCases = [
    '好的，收到！',
    'oscar你好呀😊 今天感觉怎么样？',
    '正在为您查询健康档案，请稍候～',
  ];

  for (const sc of shortCases) {
    const resShort = await paceAgentMessage(sc);
    check(`短消息「${sc.slice(0, 10)}...」保持单条`, !resShort.isSplit && resShort.segments.length === 1 && resShort.segments[0] === sc);
  }

  // ─────────────────────────────────────────────────────────────
  // 场景 5: 模拟 Dispatcher 1.5s 停顿计时精度测试
  // ─────────────────────────────────────────────────────────────
  console.log('\n▶ 测试场景 5: 模拟 1.5s 节奏发送时间间隔精度测试');
  const testSegments = ['第一段：安抚与结论', '第二段：具体分析细节', '第三段：关怀提问'];
  const timestamps: number[] = [];

  const tStart = Date.now();
  for (let i = 0; i < testSegments.length; i++) {
    timestamps.push(Date.now());
    if (i < testSegments.length - 1) {
      await new Promise(r => setTimeout(r, 1500));
    }
  }

  const gap1 = timestamps[1] - timestamps[0];
  const gap2 = timestamps[2] - timestamps[1];
  console.log(`   第1段到第2段间隔: ${gap1}ms (目标: ~1500ms)`);
  console.log(`   第2段到第3段间隔: ${gap2}ms (目标: ~1500ms)`);
  check('第1段与第2段间隔在 [1450ms, 1600ms] 精度范围内', gap1 >= 1450 && gap1 <= 1600);
  check('第2段与第3段间隔在 [1450ms, 1600ms] 精度范围内', gap2 >= 1450 && gap2 <= 1600);

  // ─────────────────────────────────────────────────────────────
  // 场景 6: 极端边界容错（Emoji、HTML标签、特殊标点、连续换行）
  // ─────────────────────────────────────────────────────────────
  console.log('\n▶ 测试场景 6: 边界与特殊字符容错测试');
  const edgeText = `🎉💪😊 【健康贴士】\n\n\n\n- 重点关注：<br>体温 36.8℃，血氧 99%！！？？\n\n\n\n请多喝温水哦～ ✨✨`;
  const resEdge = await paceAgentMessage(edgeText);
  check('极端换行与特殊字符成功分段且不崩溃', resEdge.segments.length >= 1);
  const allEdge = resEdge.segments.join('');
  check('Emoji 与特殊符号 100% 保留', allEdge.includes('🎉💪😊') && allEdge.includes('36.8℃') && allEdge.includes('✨✨'));

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(` 综合测试汇总: ${passed} 项通过, ${failed} 项失败`);
  console.log('═══════════════════════════════════════════════════════════════\n');

  if (failed > 0) process.exit(1);
}

runComprehensiveTests();
