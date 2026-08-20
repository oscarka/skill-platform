/**
 * messagePacer.test.ts — messagePacer 单元测试
 */
import { splitByRules, paceAgentMessage } from './messagePacer';

async function runTests() {
  console.log('🧪 开始运行 messagePacer 严格保真与分段测试...\n');
  let passCount = 0;
  let failCount = 0;

  function assert(cond: boolean, name: string) {
    if (cond) {
      console.log(`  ✓ PASS: ${name}`);
      passCount++;
    } else {
      console.error(`  ✗ FAIL: ${name}`);
      failCount++;
    }
  }

  // ── Test 1: 工单链接与 Token 绝对完整 ──
  const ticketMsg = `oscar，已为您创建「医学报告解读助手（MD版）」分析工单 🎉

我们已根据您的健康档案预填了信息（已为您自动载入：影像诊断报告.pdf），请点击以下链接确认并补充，提交后 AI 将为您生成专属分析报告：

https://skill-platform-yo5337ccva-de.a.run.app/h5?token=b00623de80784486a15411848846e2a5

完成提交后 AI 将开始分析，完成后将通知您 ✅ 如长时间未收到结果，请联系管理员处理。`;

  const ticketRes = await paceAgentMessage(ticketMsg);
  assert(ticketRes.isSplit, '工单消息成功分段');
  assert(
    ticketRes.segments.some(s => s.includes('https://skill-platform-yo5337ccva-de.a.run.app/h5?token=b00623de80784486a15411848846e2a5')),
    '工单 H5 完整 URL 100% 保留且未被截断'
  );

  // ── Test 2: 报告查看链接绝对完整 ──
  const reportMsg = `oscar，您的「医学报告解读助手（MD版）」分析报告已生成 🎉

点击查看完整报告：
https://skill-platform-yo5337ccva-de.a.run.app/api/results/e12d532f-dcaa-43e9-9b8f-8b75c9252921/report`;

  const reportRes = await paceAgentMessage(reportMsg);
  assert(
    reportRes.segments.some(s => s.includes('https://skill-platform-yo5337ccva-de.a.run.app/api/results/e12d532f-dcaa-43e9-9b8f-8b75c9252921/report')),
    '报告查看链接 100% 完整保留'
  );

  // ── Test 3: 医学药名、指标与数据零篡改 ──
  const medicalMsg = `oscar，我已经帮您查了档案：您目前没有在服用任何药物，血压指标维持在 145/90mmHg，所以这次的疲劳和瘙痒基本可以排除药物因素，先放宽心～

另外二甲双胍（格华止 500mg）和 α-硫辛酸 是针对糖尿病周围神经病变的处方药，您目前血糖 ALT 指标正常，不建议自行服用。

能麻烦您简单描述一下今天早饭吃了哪些东西吗？这样我能更准确地帮您判断～😊`;

  const medicalRes = await paceAgentMessage(medicalMsg);
  const combined = medicalRes.segments.join('\n\n');
  assert(combined.includes('145/90mmHg'), '血压数值 145/90mmHg 完好无损');
  assert(combined.includes('二甲双胍（格华止 500mg）'), '处方药名与剂量完好无损');
  assert(combined.includes('α-硫辛酸'), '化学名称完好无损');
  assert(combined.includes('ALT'), '化验指标完好无损');

  // ── Test 4: 短消息直接跳过（向后兼容） ──
  const shortMsg = '收到，我这就帮您查询～';
  const shortRes = await paceAgentMessage(shortMsg);
  assert(shortRes.segments.length === 1 && shortRes.segments[0] === shortMsg, '短消息直接走单条快速路径');

  // ── Test 5: 空值容错 ──
  const emptyRes = await paceAgentMessage('');
  assert(emptyRes.segments.length === 0, '空消息安全容错返回空数组');

  console.log(`\n📊 测试结果: ${passCount} 通过, ${failCount} 失败\n`);
  if (failCount > 0) process.exit(1);
}

runTests();
