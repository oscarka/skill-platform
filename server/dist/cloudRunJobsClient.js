"use strict";
/**
 * cloudRunJobsClient.ts
 *
 * 调用 Cloud Run Jobs REST API（不依赖 @google-cloud/run npm 包）
 * 在 Cloud Run 上用 Workload Identity / metadata server 自动获取 token。
 * 本地开发（无 GCP_PROJECT_ID）：直接跳过，返回 mock。
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.USE_CLOUD_RUN = void 0;
exports.submitSandboxJob = submitSandboxJob;
exports.getExecutionStatus = getExecutionStatus;
exports.waitForExecution = waitForExecution;
const GCP_PROJECT = process.env.GCP_PROJECT_ID || '';
const GCP_REGION = process.env.GCP_REGION || 'asia-east1';
const JOB_NAME = 'skill-sandbox-job';
const SANDBOX_IMAGE = process.env.SANDBOX_JOB_IMAGE || '';
exports.USE_CLOUD_RUN = !!(GCP_PROJECT && SANDBOX_IMAGE);
// ─── 获取 Access Token（Cloud Run Workload Identity）──────────────────────────
async function getAccessToken() {
    // Cloud Run metadata server 有时在冷启动或高负载时短暂不可用，最多重试 3 次
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const res = await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(5000) });
            if (res.ok) {
                const data = await res.json();
                return data.access_token;
            }
        }
        catch {
            if (attempt < 3) {
                await new Promise(r => setTimeout(r, 1000 * attempt)); // 1s, 2s 退避
            }
        }
    }
    // 本地：尝试 gcloud 命令
    try {
        const { execSync } = await Promise.resolve().then(() => __importStar(require('child_process')));
        return execSync('gcloud auth print-access-token', { encoding: 'utf8' }).trim();
    }
    catch { }
    throw new Error('Cannot get GCP access token. Not running on GCP and gcloud not available.');
}
// ─── 提交一次 Cloud Run Job Execution ─────────────────────────────────────────
async function submitSandboxJob(opts) {
    if (!exports.USE_CLOUD_RUN) {
        console.warn('[CloudRunJobs] USE_CLOUD_RUN=false, skipping job submission');
        return { executionName: 'mock/executions/local', executionId: 'local' };
    }
    const token = await getAccessToken();
    const envVars = [
        { name: 'SKILL_ID', value: opts.skillId },
        // SKILL_MD 已废弃（runner.py 改从 DB 按 SKILL_ID 读取，参考 OpenClaw 文件系统理念）
        // 不再通过 env var 传递，彻底解决 Cloud Run Job 32KB 上限问题
        { name: 'SKILL_MD', value: '' }, // 保留 key 以防旧 runner.py 镜像仍需要它
        { name: 'USER_INPUTS', value: JSON.stringify(opts.userInputs) },
        { name: 'AI_MODEL', value: opts.model },
        { name: 'AI_API_KEY', value: opts.aiKey },
        { name: 'AI_BASE_URL', value: opts.aiBaseUrl || '' },
        // AI_CHAT_URL = AI_BASE_URL + /chat/completions，供 curl 直接用，防止 AI 自己拼错路径
        { name: 'AI_CHAT_URL', value: opts.aiBaseUrl ? `${opts.aiBaseUrl}/chat/completions` : '' },
        // Fallback provider（仿 OpenClaw FailoverError 多 provider 切换）
        { name: 'FALLBACK_AI_API_KEY', value: opts.fallbackAiKey || '' },
        { name: 'FALLBACK_AI_BASE_URL', value: opts.fallbackAiBase || '' },
        { name: 'FALLBACK_AI_MODEL', value: opts.fallbackModel || 'deepseek-chat' }, // L2 正确模型名
        { name: 'DATABASE_URL', value: opts.dbUrl || process.env.DATABASE_URL || '' },
        { name: 'DB_SCHEMA', value: opts.dbSchema || process.env.DB_SCHEMA || 'skill_platform' },
        { name: 'CALLBACK_URL', value: opts.callbackUrl || '' },
        { name: 'SANDBOX_SECRET', value: opts.sandboxSecret || '' },
        { name: 'MCP_CONFIGS', value: opts.mcpConfigs || '[]' },
        { name: 'OAUTH_TOKENS', value: opts.oauthTokens || '' },
        { name: 'CASE_COUNT', value: String(Math.max(1, Math.min(3, opts.caseCount || 1))) },
        { name: 'TAVILY_API_KEY', value: process.env.TAVILY_API_KEY || '' },
        { name: 'TICKET_MODE', value: opts.ticketMode ? '1' : '0' },
    ];
    const jobParent = `projects/${GCP_PROJECT}/locations/${GCP_REGION}/jobs/${JOB_NAME}`;
    const url = `https://run.googleapis.com/v2/${jobParent}:run`;
    const body = {
        overrides: {
            containerOverrides: [{ env: envVars }],
            taskCount: 1,
            // timeout 不设置，使用 Cloud Run Job 默认配置（2000s）
            // 之前设为 '600s' 会覆盖 --task-timeout=2000 的配置，导致 3 case 超时
        },
    };
    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Cloud Run Jobs API error ${res.status}: ${errText}`);
    }
    const data = await res.json();
    // data.metadata.name 或 data.name 是 operation name
    // execution name 在 response.metadata.name
    const executionName = data?.metadata?.name || data?.name || `${jobParent}/executions/unknown`;
    const executionId = executionName.split('/').pop() || 'unknown';
    console.log(`[CloudRunJobs] Submitted execution: ${executionId}`);
    return { executionName, executionId };
}
// ─── 查询 Execution 状态 ─────────────────────────────────────────────────────
async function getExecutionStatus(executionName) {
    if (!exports.USE_CLOUD_RUN || executionName.includes('local'))
        return 'SUCCEEDED';
    try {
        const token = await getAccessToken();
        const url = `https://run.googleapis.com/v2/${executionName}`;
        const res = await fetch(url, {
            headers: { 'Authorization': `Bearer ${token}` },
        });
        if (!res.ok)
            return 'RUNNING';
        const data = await res.json();
        const conditions = data.conditions || [];
        const ready = conditions.find((c) => c.type === 'Completed');
        if (!ready)
            return 'RUNNING';
        if (ready.state === 'CONDITION_SUCCEEDED')
            return 'SUCCEEDED';
        if (ready.state === 'CONDITION_FAILED')
            return 'FAILED';
        return 'RUNNING';
    }
    catch {
        return 'RUNNING';
    }
}
// ─── 等待完成（轮询）────────────────────────────────────────────────────────
async function waitForExecution(executionName, maxWaitMs = 600_000, intervalMs = 10_000) {
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
        const status = await getExecutionStatus(executionName);
        if (status === 'SUCCEEDED')
            return 'SUCCEEDED';
        if (status === 'FAILED')
            return 'FAILED';
        await new Promise(r => setTimeout(r, intervalMs));
    }
    return 'TIMEOUT';
}
