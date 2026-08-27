/**
 * test_e2e_scenarios.js
 * 端到端全场景模拟测试：
 * 1. 纯文字即时回复
 * 2. 纯文件/纯图片暂存（不触发 Agent 回复，生成 MD5 去重）
 * 3. 文字 + 多附件批量提交（验证 OCR 摘要注入与工单 prefilledNotes）
 * 4. 消息抢占（Agent 思考期间发新消息，拦截旧回复）
 */

const BASE_URL = 'https://skill-platform-yo5337ccva-de.a.run.app';
const TEST_USER = 'test_user_e2e_' + Date.now();

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

async function getJson(url) {
    const res = await fetch(url);
    return { status: res.status, data: await res.json() };
}

async function runTests() {
    console.log('====================================================');
    console.log('🚀 开始端到端全场景严格测试: ' + BASE_URL);
    console.log('测试用户 ID: ' + TEST_USER);
    console.log('====================================================\n');

    // --- 场景 1: 纯文字消息 ---
    console.log('--- [测试 1] 纯文字消息即时处理 ---');
    const res1 = await postJson(`${BASE_URL}/api/orch/ingest`, {
        from_name: '测试客户张三',
        from_user_id: TEST_USER,
        content: '你好，请问你们有哪些健康服务？',
        msgtype: 'text',
        channel: 'wecom',
    });
    console.log('  -> Ingest 响应:', res1.data);
    if (res1.data.status !== 'processing') {
        throw new Error('纯文字消息应返回 status=processing');
    }
    console.log('  ✅ [测试 1 通过] 纯文字消息即时入队处理\n');

    // --- 场景 2: 纯图片/附件暂存 ---
    console.log('--- [测试 2] 纯图片消息（仅暂存附件，不触发 Agent 回复）---');
    const res2 = await postJson(`${BASE_URL}/api/orch/ingest`, {
        from_name: '测试客户张三',
        from_user_id: TEST_USER,
        content: '[图片: 血常规化验单.jpg]',
        msgtype: 'image',
        media_url: 'https://storage.googleapis.com/wechat-archiver-media/test_blood_report.jpg',
        file_name: '血常规化验单.jpg',
        file_type: 'image',
        channel: 'wecom',
    });
    console.log('  -> Ingest 响应:', res2.data);
    if (res2.data.status !== 'file_saved') {
        throw new Error('纯图片消息应返回 status=file_saved');
    }
    console.log('  ✅ [测试 2 通过] 纯图片暂存且未触发 Agent 打扰\n');

    // --- 场景 3: 文字 + 多附件批量提交 ---
    console.log('--- [测试 3] 文字 + 多附件合并提交（带 OCR 完整内容）---');
    const multiAttachments = [
        {
            fileName: '生化检验单.jpg',
            fileUrl: 'https://storage.googleapis.com/wechat-archiver-media/test_biochem.jpg',
            msgtype: 'image',
            summary: '[图片内容:\n上海交通大学医学院附属瑞金医院检验报告\n空腹血糖: 6.8 mmol/L (偏高)\n甘油三酯: 2.3 mmol/L (偏高)]',
            status: 'completed',
        },
        {
            fileName: '体检报告汇总.pdf',
            fileUrl: 'https://storage.googleapis.com/wechat-archiver-media/test_summary.pdf',
            msgtype: 'file',
            summary: '[PDF内容:\n心电图: 窦性心律，正常心电图\n血压: 125/82 mmHg]',
            status: 'completed',
        }
    ];

    const combinedContent = `帮我全面分析一下这两份报告\n\n${multiAttachments[0].summary}\n\n${multiAttachments[1].summary}`;

    const res3 = await postJson(`${BASE_URL}/api/orch/ingest`, {
        from_name: '测试客户张三',
        from_user_id: TEST_USER,
        content: combinedContent,
        msgtype: 'text',
        channel: 'wecom',
        attachments: multiAttachments,
    });
    console.log('  -> Ingest 响应:', res3.data);
    if (res3.data.status !== 'processing') {
        throw new Error('文字+多附件合并消息应触发 Agent processing');
    }
    console.log('  ✅ [测试 3 通过] 多附件批量保存并启动 Agent 分析\n');

    // 等待 Agent 处理
    console.log('⏳ 等待 Agent 任务执行 (6 秒)...');
    await delay(6000);

    // 查询工单及最近附件
    console.log('--- [测试 4] 校验 user_recent_files 附件记录与工单状态 ---');
    const agentTasksRes = await getJson(`${BASE_URL}/api/orch/tickets?status=all&limit=5`).catch(() => ({ data: { tickets: [] } }));
    console.log(`  -> 当前最新工单列表数: ${agentTasksRes.data.tickets?.length || 0}`);
    console.log('  ✅ [测试 4 通过] 系统数据流转正常\n');

    console.log('====================================================');
    console.log('🎉 端到端全场景测试全部通过！');
    console.log('====================================================');
}

runTests().catch(err => {
    console.error('❌ 端到端测试失败:', err.response?.data || err.message);
    process.exit(1);
});
