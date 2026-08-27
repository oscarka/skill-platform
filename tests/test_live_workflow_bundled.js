/**
 * test_live_workflow_bundled.js
 * 模拟 archiver 汇聚后发给 Ingest 的真实数据结构（文字 + 所有附件 OCR 摘要）
 */

const BASE_URL = 'https://skill-platform-yo5337ccva-de.a.run.app';
const TEST_USER = 'real_patient_' + Date.now();

async function delay(ms) {
    return new Promise(r => setTimeout(r, ms));
}

async function postJson(url, body) {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    return { status: res.status, data: await res.json() };
}

async function runBundledTest() {
    console.log('====================================================');
    console.log('🚀 测试真实汇聚入站：用户微信发文字+图片，archiver 解析汇聚后提交');
    console.log('测试用户 ID: ' + TEST_USER);
    console.log('====================================================\n');

    const reportSummary = '[图片内容:\n上海交通大学医学院附属瑞金医院临床实验诊断中心\n检验科报告单 | 标本号: 20260827_999\n姓名: 陈修国 | 门诊号: A50793E47\n空腹血糖: 7.4 mmol/L (参考值: 3.9-6.1, 偏高)\n甘油三酯: 2.8 mmol/L (参考值: 0.5-1.7, 偏高)\n总胆固醇: 6.1 mmol/L (偏高)]';

    const fullContent = `帮我全面分析一下这份化验单报告\n\n${reportSummary}`;

    const res = await postJson(`${BASE_URL}/api/orch/ingest`, {
        from_name: '陈修国',
        from_user_id: TEST_USER,
        content: fullContent,
        msgtype: 'text',
        channel: 'wecom',
        attachments: [
            {
                fileName: '瑞金化验单.jpg',
                fileUrl: 'https://storage.googleapis.com/wechat-archiver-media/2026-08-27/test_report.jpg',
                msgtype: 'image',
                summary: reportSummary,
                status: 'completed',
            }
        ]
    });

    console.log('-> Ingest 响应:', res.data);
    console.log('⏳ 等待 Agent 深度分析与工单创建 (8 秒)...');
    await delay(8000);

    console.log('\n✅ 执行完成，请调取云端日志查看解读与工单创建过程！');
}

runBundledTest().catch(err => {
    console.error('❌ 测试异常:', err);
    process.exit(1);
});
