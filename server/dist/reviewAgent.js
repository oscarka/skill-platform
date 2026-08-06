"use strict";
/**
 * reviewAgent.ts — OpenClaw-style Skill Review Agent
 *
 * 设计理念（对齐 OpenClaw）：
 *   - 评审 AI 不直接接收 Skill 内容，而是通过工具调用按需读取
 *   - 类比 OpenClaw：agent 用 read_file 工具读 SKILL.md → 内容以工具返回值进入 context
 *   - 彻底避免 57KB 内容直接拼入 prompt 字符串（skill_type bug 和大小问题同时解决）
 *
 * 流程：
 *   Turn 1 → AI 看 Skill 元数据，调用 read_skill_content(skill_id) 工具
 *   Tool  → 服务端从 DB 查 prompt_template（同沙箱 _fetch_skill_md_from_db 逻辑）
 *   Turn 2 → AI 拿到完整内容，返回 JSON 评审结果
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.runSkillReviewAgent = runSkillReviewAgent;
const openai_1 = __importDefault(require("openai"));
const db = __importStar(require("./db"));
// ─── 工具定义：read_skill_content ─────────────────────────────────────────────
const READ_SKILL_TOOL = {
    type: 'function',
    function: {
        name: 'read_skill_content',
        description: '读取指定 Skill 的完整内容（SKILL.md 全文，即 prompt_template）。' +
            '评审前必须先调用此工具获取内容，再进行评审。',
        parameters: {
            type: 'object',
            properties: {
                skill_id: {
                    type: 'string',
                    description: 'Skill 的唯一 ID，从任务描述中获取',
                },
            },
            required: ['skill_id'],
        },
    },
};
// ─── AI 配置 ────────────────────────────────────────────────────────────────
async function getSetting(key, fallbackEnv) {
    const row = await db.getAsync('SELECT value FROM settings WHERE key=?', [key]);
    if (row?.value)
        return row.value;
    return process.env[fallbackEnv] || '';
}
async function buildOpenAIClient(model) {
    const isDoubao = model.startsWith('doubao') || model.startsWith('ep-');
    const isDeepSeek = model.startsWith('deepseek');
    if (isDoubao) {
        const apiKey = await getSetting('doubao_api_key', 'DOUBAO_API_KEY');
        const baseURL = (await getSetting('doubao_base_url', 'DOUBAO_BASE_URL')) ||
            'https://ark.cn-beijing.volces.com/api/v3';
        if (!apiKey)
            throw new Error('Doubao API key not configured');
        return new openai_1.default({ apiKey, baseURL, timeout: 300_000 });
    }
    else if (isDeepSeek) {
        const apiKey = await getSetting('deepseek_api_key', 'DEEPSEEK_API_KEY');
        const baseURL = (await getSetting('deepseek_base_url', 'DEEPSEEK_BASE_URL')) ||
            'https://api.deepseek.com';
        if (!apiKey)
            throw new Error('DeepSeek API key not configured');
        return new openai_1.default({ apiKey, baseURL, timeout: 300_000 });
    }
    else {
        // Gemini 暂不支持工具调用走此路径，回退到 doubao 默认
        const apiKey = await getSetting('doubao_api_key', 'DOUBAO_API_KEY');
        const baseURL = (await getSetting('doubao_base_url', 'DOUBAO_BASE_URL')) ||
            'https://ark.cn-beijing.volces.com/api/v3';
        if (!apiKey)
            throw new Error('Doubao API key not configured (used as fallback for tool-call review)');
        return new openai_1.default({ apiKey, baseURL, timeout: 300_000 });
    }
}
// ─── 工具执行：从 DB 读 Skill 内容 ────────────────────────────────────────────
async function execReadSkillContent(skillId) {
    // 和 sandbox runner.py 的 _fetch_skill_md_from_db() 逻辑对齐
    // search_path 已设为 skill_platform，无需写 schema 前缀
    const row = await db.getAsync('SELECT prompt_template FROM skills WHERE id=?', [skillId]);
    if (!row)
        throw new Error(`Skill ${skillId} 不存在`);
    if (!row.prompt_template)
        throw new Error(`Skill ${skillId} 的 prompt_template 为空`);
    return row.prompt_template;
}
// ─── 主入口 ───────────────────────────────────────────────────────────────────
async function runSkillReviewAgent(params) {
    const startTime = Date.now();
    let turn = 0;
    const log = (step, detail) => {
        const p = { ts: new Date().toISOString(), step, detail };
        console.log(`[review] ${JSON.stringify(p)}`);
        params.onProgress?.(p);
    };
    // 选模型（支持回退）
    const defaultModel = (await getSetting('default_model', 'DEFAULT_MODEL')) || 'doubao-pro-128k';
    const useModel = params.model || defaultModel;
    log('启动', `开始评审 skill_id=${params.skillId} model=${useModel}`);
    const client = await buildOpenAIClient(useModel);
    // ─── System Prompt：评审者角色 ────────────────────────────────────────────
    const systemPrompt = [
        '你是 Skill 平台的 AI 评审专家，负责对提交的 Skill 进行全面评审。',
        '',
        '评审流程：',
        '1. 首先调用 read_skill_content 工具读取 Skill 的完整内容（SKILL.md 全文）',
        '2. 仔细阅读内容后，完成以下评审维度：',
        '   - 格式检查：内容是否完整，结构是否规范',
        '   - 逻辑评估：能否完成描述中所述的任务',
        '   - 质量打分：0-100分',
        '   - 优点：列举3-5条具体优点',
        '   - 不足：列举具体问题和改进建议',
        params.skillVisibility === 'external'
            ? '   - H5字段建议：分析需要收集哪些客户信息，给出建议的H5表单字段配置'
            : '',
        '',
        '3. 以合法 JSON 格式返回评审结果，结构如下：',
        '{',
        '  "score": 85,',
        '  "passed": true,',
        '  "strengths": ["优点1", "优点2"],',
        '  "weaknesses": ["不足1", "不足2"],',
        '  "suggestions": ["建议1", "建议2"],',
        '  "summary": "总体评述"' +
            (params.skillVisibility === 'external'
                ? ',\n  "h5_config_suggestion": {\n    "title": "...",\n    "description": "...",\n    "fields": [{ "key": "name", "label": "姓名", "type": "text", "required": true }],\n    "uploads": { "accept": ["application/pdf"], "maxFiles": 3, "maxSizeMB": 20, "label": "上传说明" }\n  }'
                : ''),
        '}',
        '',
        '规则：passed=true 要求 score>=60。只返回 JSON，不要有其他文字。',
    ].filter(Boolean).join('\n');
    // ─── Turn 1：初始用户消息（元数据，不含内容） ─────────────────────────────
    const userMessage = [
        `请评审以下 Skill：`,
        `- Skill ID：${params.skillId}`,
        `- 名称：${params.skillName}`,
        `- 类型：${params.skillVisibility === 'internal' ? '内部Skill（员工使用）' : '外部Skill（客户使用）'}`,
        params.skillDescription ? `- 描述：${params.skillDescription}` : '',
        params.testInputs && Object.keys(params.testInputs).length > 0
            ? `- 测试素材：\n${JSON.stringify(params.testInputs, null, 2)}`
            : '',
        '',
        '请先调用 read_skill_content 工具读取 Skill 完整内容，再开始评审。',
    ].filter(Boolean).join('\n');
    const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
    ];
    // ─── Agent Loop（最多 3 轮） ──────────────────────────────────────────────
    let finalContent = '';
    for (let i = 0; i < 3; i++) {
        turn++;
        log(`turn_${turn}`, `AI 思考中（上下文约 ${estimateTokens(messages)} 字符）`);
        const useStream = useModel.includes('seed');
        let responseMessage;
        if (useStream) {
            // seed 系列用流式防超时
            const stream = await client.chat.completions.create({
                model: useModel,
                messages,
                tools: [READ_SKILL_TOOL],
                tool_choice: i === 0 ? { type: 'function', function: { name: 'read_skill_content' } } : 'auto',
                max_tokens: 8000,
                stream: true,
            });
            // 组装 streaming response
            let content = '';
            const toolCallsMap = {};
            let finishReason = '';
            for await (const chunk of stream) {
                const delta = chunk.choices[0]?.delta;
                if (delta?.content)
                    content += delta.content;
                for (const tc of delta?.tool_calls ?? []) {
                    if (!toolCallsMap[tc.index]) {
                        toolCallsMap[tc.index] = { id: tc.id ?? '', name: tc.function?.name ?? '', arguments: '' };
                    }
                    if (tc.id)
                        toolCallsMap[tc.index].id = tc.id;
                    if (tc.function?.name)
                        toolCallsMap[tc.index].name = tc.function.name;
                    if (tc.function?.arguments)
                        toolCallsMap[tc.index].arguments += tc.function.arguments;
                }
                if (chunk.choices[0]?.finish_reason)
                    finishReason = chunk.choices[0].finish_reason;
            }
            const toolCalls = Object.values(toolCallsMap).map(tc => ({
                id: tc.id,
                type: 'function',
                function: { name: tc.name, arguments: tc.arguments },
            }));
            responseMessage = {
                role: 'assistant',
                content: content || null,
                tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
            };
        }
        else {
            const resp = await client.chat.completions.create({
                model: useModel,
                messages,
                tools: [READ_SKILL_TOOL],
                tool_choice: i === 0 ? { type: 'function', function: { name: 'read_skill_content' } } : 'auto',
                max_tokens: 8000,
            });
            responseMessage = resp.choices[0].message;
        }
        messages.push(responseMessage);
        // 检查是否有工具调用
        if (responseMessage.tool_calls && responseMessage.tool_calls.length > 0) {
            for (const tc of responseMessage.tool_calls) {
                const toolName = tc.function.name;
                log(`工具:${toolName}`, `skill_id=${params.skillId}`);
                let toolResult;
                try {
                    if (toolName === 'read_skill_content') {
                        const args = JSON.parse(tc.function.arguments);
                        const content = await execReadSkillContent(args.skill_id || params.skillId);
                        toolResult = content;
                        log('内容已加载', `${content.length} 字符`);
                    }
                    else {
                        toolResult = JSON.stringify({ error: `未知工具: ${toolName}` });
                    }
                }
                catch (e) {
                    toolResult = JSON.stringify({ error: e.message });
                    log('工具错误', e.message);
                }
                messages.push({
                    role: 'tool',
                    tool_call_id: tc.id,
                    content: toolResult,
                });
            }
            // 继续下一轮让 AI 生成评审结果
            continue;
        }
        // 没有工具调用 → AI 已生成最终内容
        finalContent = responseMessage.content || '';
        break;
    }
    log('完成', 'AI 已给出评审结论');
    // ─── 解析 JSON 结果 ────────────────────────────────────────────────────────
    let reviewResult;
    try {
        const jsonMatch = finalContent.match(/\{[\s\S]*\}/);
        if (!jsonMatch)
            throw new Error('AI 未返回合法 JSON');
        reviewResult = JSON.parse(jsonMatch[0]);
    }
    catch (e) {
        log('解析错误', `JSON 解析失败: ${e.message}，原始内容前200字: ${finalContent.slice(0, 200)}`);
        reviewResult = {
            score: 0,
            passed: false,
            strengths: [],
            weaknesses: ['AI 返回内容无法解析为 JSON'],
            suggestions: [],
            summary: `评审解析失败: ${e.message}`,
        };
    }
    const durationMs = Date.now() - startTime;
    return {
        score: Math.max(0, Math.min(100, Number(reviewResult.score) || 0)),
        passed: Boolean(reviewResult.passed),
        strengths: Array.isArray(reviewResult.strengths) ? reviewResult.strengths : [],
        weaknesses: Array.isArray(reviewResult.weaknesses) ? reviewResult.weaknesses : [],
        suggestions: Array.isArray(reviewResult.suggestions) ? reviewResult.suggestions : [],
        summary: reviewResult.summary || '',
        ...(reviewResult.h5_config_suggestion ? { h5_config_suggestion: reviewResult.h5_config_suggestion } : {}),
        turns: turn,
        durationMs,
    };
}
// ─── 工具函数 ─────────────────────────────────────────────────────────────────
function estimateTokens(messages) {
    return messages.reduce((sum, m) => {
        if (typeof m.content === 'string')
            return sum + m.content.length;
        if (Array.isArray(m.content))
            return sum + JSON.stringify(m.content).length;
        return sum;
    }, 0);
}
