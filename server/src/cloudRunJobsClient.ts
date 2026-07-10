/**
 * cloudRunJobsClient.ts
 *
 * 调用 Cloud Run Jobs REST API（不依赖 @google-cloud/run npm 包）
 * 在 Cloud Run 上用 Workload Identity / metadata server 自动获取 token。
 * 本地开发（无 GCP_PROJECT_ID）：直接跳过，返回 mock。
 */

const GCP_PROJECT = process.env.GCP_PROJECT_ID || '';
const GCP_REGION  = process.env.GCP_REGION || 'asia-east1';
const JOB_NAME    = 'skill-sandbox-job';
const SANDBOX_IMAGE = process.env.SANDBOX_JOB_IMAGE || '';

export const USE_CLOUD_RUN = !!(GCP_PROJECT && SANDBOX_IMAGE);

export interface JobSubmitOptions {
  skillId:          string;
  skillMd:          string;   // base64 编码的 SKILL.md
  userInputs:       Record<string, any>;
  model:            string;
  aiKey:            string;
  aiBaseUrl?:       string;
  fallbackAiKey?:   string;   // 仿 OpenClaw FailoverError：备用 provider key
  fallbackAiBase?:  string;   // 仿 OpenClaw FailoverError：备用 provider base URL
  dbUrl?:           string;
  dbSchema?:        string;
  callbackUrl?:     string;
  sandboxSecret?:   string;
}

export interface JobExecution {
  executionName: string;
  executionId:   string;
}

// ─── 获取 Access Token（Cloud Run Workload Identity）──────────────────────────
async function getAccessToken(): Promise<string> {
  // Cloud Run metadata server 有时在冷启动或高负载时短暂不可用，最多重试 3 次
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(
        'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
        { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(5000) }
      );
      if (res.ok) {
        const data = await res.json() as { access_token: string };
        return data.access_token;
      }
    } catch {
      if (attempt < 3) {
        await new Promise(r => setTimeout(r, 1000 * attempt)); // 1s, 2s 退避
      }
    }
  }

  // 本地：尝试 gcloud 命令
  try {
    const { execSync } = await import('child_process');
    return execSync('gcloud auth print-access-token', { encoding: 'utf8' }).trim();
  } catch {}

  throw new Error('Cannot get GCP access token. Not running on GCP and gcloud not available.');
}

// ─── 提交一次 Cloud Run Job Execution ─────────────────────────────────────────
export async function submitSandboxJob(opts: JobSubmitOptions): Promise<JobExecution> {
  if (!USE_CLOUD_RUN) {
    console.warn('[CloudRunJobs] USE_CLOUD_RUN=false, skipping job submission');
    return { executionName: 'mock/executions/local', executionId: 'local' };
  }

  const token = await getAccessToken();

  const envVars = [
    { name: 'SKILL_ID',            value: opts.skillId },
    { name: 'SKILL_MD',            value: opts.skillMd },
    { name: 'USER_INPUTS',         value: JSON.stringify(opts.userInputs) },
    { name: 'AI_MODEL',            value: opts.model },
    { name: 'AI_API_KEY',          value: opts.aiKey },
    { name: 'AI_BASE_URL',         value: opts.aiBaseUrl || '' },
    // Fallback provider（仿 OpenClaw FailoverError 多 provider 切换）
    { name: 'FALLBACK_AI_API_KEY', value: opts.fallbackAiKey || '' },
    { name: 'FALLBACK_AI_BASE_URL',value: opts.fallbackAiBase || '' },
    { name: 'DATABASE_URL',        value: opts.dbUrl || process.env.DATABASE_URL || '' },
    { name: 'DB_SCHEMA',           value: opts.dbSchema || process.env.DB_SCHEMA || 'skill_platform' },
    { name: 'CALLBACK_URL',        value: opts.callbackUrl || '' },
    { name: 'SANDBOX_SECRET',      value: opts.sandboxSecret || '' },
  ];

  const jobParent = `projects/${GCP_PROJECT}/locations/${GCP_REGION}/jobs/${JOB_NAME}`;
  const url = `https://run.googleapis.com/v2/${jobParent}:run`;

  const body = {
    overrides: {
      containerOverrides: [{ env: envVars }],
      taskCount: 1,
      timeout: '600s',
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

  const data = await res.json() as any;
  // data.metadata.name 或 data.name 是 operation name
  // execution name 在 response.metadata.name
  const executionName: string = data?.metadata?.name || data?.name || `${jobParent}/executions/unknown`;
  const executionId = executionName.split('/').pop() || 'unknown';

  console.log(`[CloudRunJobs] Submitted execution: ${executionId}`);
  return { executionName, executionId };
}

// ─── 查询 Execution 状态 ─────────────────────────────────────────────────────
export async function getExecutionStatus(executionName: string): Promise<string> {
  if (!USE_CLOUD_RUN || executionName.includes('local')) return 'SUCCEEDED';

  try {
    const token = await getAccessToken();
    const url = `https://run.googleapis.com/v2/${executionName}`;
    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token}` },
    });

    if (!res.ok) return 'RUNNING';

    const data = await res.json() as any;
    const conditions: any[] = data.conditions || [];
    const ready = conditions.find((c: any) => c.type === 'Completed');

    if (!ready) return 'RUNNING';
    if (ready.state === 'CONDITION_SUCCEEDED') return 'SUCCEEDED';
    if (ready.state === 'CONDITION_FAILED')    return 'FAILED';
    return 'RUNNING';
  } catch {
    return 'RUNNING';
  }
}

// ─── 等待完成（轮询）────────────────────────────────────────────────────────
export async function waitForExecution(
  executionName: string,
  maxWaitMs = 600_000,
  intervalMs = 10_000
): Promise<'SUCCEEDED' | 'FAILED' | 'TIMEOUT'> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const status = await getExecutionStatus(executionName);
    if (status === 'SUCCEEDED') return 'SUCCEEDED';
    if (status === 'FAILED')    return 'FAILED';
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return 'TIMEOUT';
}
