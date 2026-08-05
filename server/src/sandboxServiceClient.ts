/**
 * sandboxServiceClient.ts — Persistent Sandbox Service HTTP 客户端
 *
 * 调用 Cloud Run Service（常驻热实例）而不是 Cloud Run Job。
 * 接口参数和 cloudRunJobsClient.ts 的 JobSubmitOptions 完全一致，
 * 方便 aiProcessor.ts 无缝切换。
 */

export interface SandboxServiceOptions {
  skillId:          string;
  userInputs:       Record<string, any>;
  model:            string;
  aiKey:            string;
  aiBaseUrl?:       string;
  fallbackAiKey?:   string;
  fallbackAiBase?:  string;
  fallbackModel?:   string;
  dbUrl?:           string;
  dbSchema?:        string;
  callbackUrl?:     string;
  sandboxSecret?:   string;
  mcpConfigs?:      string;
  oauthTokens?:     string;
  caseCount?:       number;
  ticketMode?:      boolean;
}

export interface SandboxServiceJob {
  jobId: string;
  pid?:  number;
}

/**
 * 获取 Cloud Run Identity Token（用于调用 no-allow-unauthenticated 的 Service）
 * 在 Cloud Run 环境下从 metadata server 获取，本地降级跳过认证。
 */
async function getIdentityToken(audience: string): Promise<string> {
  try {
    const metaUrl = `http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=${encodeURIComponent(audience)}`;
    const res = await fetch(metaUrl, {
      headers: { 'Metadata-Flavor': 'Google' },
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) return await res.text();
  } catch {
    // 不在 GCP 环境，本地跳过
  }
  return '';
}

/**
 * 提交执行请求到持久沙箱 Service。
 * 立刻返回 jobId，不等待完成（和 Cloud Run Job 的 submitSandboxJob 行为一致）。
 */
export async function submitToSandboxService(
  serviceUrl: string,
  opts: SandboxServiceOptions
): Promise<SandboxServiceJob> {
  const secret = opts.sandboxSecret || process.env.SANDBOX_SECRET || 'sandbox-secret-2024';

  const body = {
    skill_id:          opts.skillId,
    user_inputs:       opts.userInputs,
    model:             opts.model,
    ai_key:            opts.aiKey,
    ai_base_url:       opts.aiBaseUrl || '',
    fallback_ai_key:   opts.fallbackAiKey || '',
    fallback_ai_base:  opts.fallbackAiBase || '',
    fallback_model:    opts.fallbackModel || 'deepseek-chat',
    database_url:      opts.dbUrl || process.env.DATABASE_URL || '',
    db_schema:         opts.dbSchema || process.env.DB_SCHEMA || 'skill_platform',
    callback_url:      opts.callbackUrl || '',
    sandbox_secret:    secret,
    mcp_configs:       opts.mcpConfigs || '[]',
    oauth_tokens:      opts.oauthTokens || '',
    case_count:        opts.caseCount ?? 1,
    ticket_mode:       opts.ticketMode ?? false,
    tavily_api_key:    process.env.TAVILY_API_KEY || '',
  };

  const url = `${serviceUrl.replace(/\/$/, '')}/run`;

  // Cloud Run Service 需要 Identity Token 认证
  const idToken = await getIdentityToken(serviceUrl);
  const headers: Record<string, string> = {
    'Content-Type':     'application/json',
    'X-Sandbox-Secret': secret,
  };
  if (idToken) headers['Authorization'] = `Bearer ${idToken}`;

  const res = await fetch(url, {
    method:  'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Sandbox Service error ${res.status}: ${errText}`);
  }

  const data = await res.json() as { job_id: string; pid?: number };
  console.log(`[SandboxService] Job submitted: ${data.job_id} (pid=${data.pid})`);
  return { jobId: data.job_id, pid: data.pid };
}
