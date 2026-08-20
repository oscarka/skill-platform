/**
 * agents_factory/src/apiClient.ts
 * 
 * 对 Skill-Platform 生产系统的唯一合法访问入口。
 * 所有与生产系统的交互必须通过本文件的函数进行（黑盒调用）。
 * 
 * ⚠️ 安全约束：
 * - 本文件只做 HTTP 调用，绝不直接 import 生产代码模块
 * - 测试用的 userId 必须以 eval_sandbox_ 开头，否则抛错
 * - 所有调用均有超时保护（默认 30s）
 */

const PLATFORM_BASE = process.env.PLATFORM_BASE_URL || 'https://skill-platform-yo5337ccva-de.a.run.app';
const PLATFORM_API_KEY = process.env.PLATFORM_API_KEY || '';
const TIMEOUT_MS = 30_000;

/** 安全守卫：防止用真实用户 ID 进行测试 */
function assertSandboxUser(userId: string) {
  if (!userId.startsWith('eval_sandbox_')) {
    throw new Error(
      `[SAFETY GUARD] 非法用户 ID: "${userId}"。` +
      `agents_factory 中的测试必须使用以 eval_sandbox_ 开头的虚拟用户 ID！`
    );
  }
}

const defaultHeaders = {
  'Content-Type': 'application/json',
  ...(PLATFORM_API_KEY ? { 'Authorization': `Bearer ${PLATFORM_API_KEY}` } : {}),
};

/** 向 Agent 发送一条对话消息（模拟虚拟用户） */
export async function sendChatMessage(params: {
  userId: string;
  agentId: string;
  content: string;
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  sessionId?: string;
}): Promise<{ reply: string; request_id: string; skill_route?: string; ticket_created?: boolean }> {
  assertSandboxUser(params.userId);

  const res = await fetch(`${PLATFORM_BASE}/api/v1/agent/chat`, {
    method: 'POST',
    headers: defaultHeaders,
    body: JSON.stringify({
      content: params.content,
      session_id: params.sessionId || params.userId,
      history: params.history || [],
      meta: {
        user_id: params.userId,
        from_name: 'EvalMockUser',
        agent_id: params.agentId,
      },
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!res.ok) throw new Error(`[API] Chat failed: HTTP ${res.status} ${await res.text()}`);
  return res.json() as any;
}

/** 读取 Agent Profile（只读查询，不做任何修改） */
export async function getAgentProfile(agentId: string): Promise<any> {
  const res = await fetch(`${PLATFORM_BASE}/api/agents/${agentId}`, {
    headers: defaultHeaders,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`[API] Get agent failed: HTTP ${res.status}`);
  return res.json();
}

/** 在生产系统中创建或更新候选 Agent 的 Profile（通过 Meta API） */
export async function upsertAgentProfile(spec: {
  id: string;
  name: string;
  role_desc: string;
  reply_style: string;
  service_flow?: string;
  taboos?: string[];
  reassurance_tpl?: string;
  skill_ids?: string[];
  routing_examples?: any[];
}): Promise<{ id: string }> {
  const res = await fetch(`${PLATFORM_BASE}/api/v1/meta/agents`, {
    method: 'POST',
    headers: defaultHeaders,
    body: JSON.stringify(spec),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`[API] Upsert agent failed: HTTP ${res.status} ${await res.text()}`);
  return res.json() as any;
}

/** 查询候选 Agent 状态（试用期状态、当前分数等） */
export async function getMetaAgentStatus(agentId: string): Promise<any> {
  const res = await fetch(`${PLATFORM_BASE}/api/v1/meta/agents/${agentId}`, {
    headers: defaultHeaders,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`[API] Get meta agent status failed: HTTP ${res.status}`);
  return res.json();
}

/** 列出平台所有可用 Skill（只读） */
export async function listAvailableSkills(): Promise<Array<{ id: string; name: string; type: string; description: string }>> {
  const res = await fetch(`${PLATFORM_BASE}/api/skills`, {
    headers: defaultHeaders,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`[API] List skills failed: HTTP ${res.status}`);
  const data = await res.json() as any;
  return data.skills || [];
}

/** 删除沙箱测试用户产生的数据（清理现场） */
export async function cleanupSandboxUser(userId: string): Promise<void> {
  assertSandboxUser(userId);
  // 通过 Meta API 清理虚拟用户数据
  const res = await fetch(`${PLATFORM_BASE}/api/v1/meta/sandbox/${userId}`, {
    method: 'DELETE',
    headers: defaultHeaders,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok && res.status !== 404) {
    console.warn(`[API] Cleanup sandbox user ${userId} failed: HTTP ${res.status}`);
  }
}
