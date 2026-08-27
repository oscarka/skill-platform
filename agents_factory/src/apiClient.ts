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

import * as fs from 'fs';
import * as path from 'path';

const PLATFORM_BASE = process.env.PLATFORM_BASE_URL || 'https://skill-platform-yo5337ccva-de.a.run.app';
const PLATFORM_API_KEY = process.env.PLATFORM_API_KEY || '';
const TIMEOUT_MS = 30_000;

// ── 通用 Wiki 记忆库访问（llmwiki 服务，与 skill-platform 独立部署）──
// 不需要单独 Cloud Run，llmwiki 已有自己的服务
const WIKI_BASE = process.env.WIKI_BASE_URL || 'https://llmwiki-yo5337ccva-an.a.run.app';

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
  spec?: any;
}): Promise<{ reply: string; request_id: string; skill_route?: string; ticket_created?: boolean }> {
  assertSandboxUser(params.userId);

  // ── 纯净沙箱模式：直接使用候选员工 Spec 组装 Prompt 并调用火山模型（不侵入生产 agentService）──
  if (params.spec) {
    const spec = params.spec;
    const arkKey = process.env.DOUBAO_API_KEY || process.env.ARK_API_KEY;
    const arkBase = process.env.DOUBAO_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3';
    const model = process.env.ARK_MODEL || process.env.DEFAULT_MODEL || 'deepseek-v4-flash-ga-260731';

    const taboosText = Array.isArray(spec.taboos) && spec.taboos.length
      ? `\n\n【严禁触碰的红线与禁忌】：\n${spec.taboos.map((t: string) => `- ${t}`).join('\n')}`
      : '';

    let knowledgeText = '';
    const knowledgeDir = path.join(__dirname, '..', 'knowledge');
    if (fs.existsSync(knowledgeDir)) {
      const files = fs.readdirSync(knowledgeDir).filter(f => f.endsWith('.md'));
      // 优先匹配包含产品名称或领域的 manual
      const specDesc = `${spec.name || ''} ${spec.role_desc || ''} ${spec.intent_prompt || ''}`;
      let matchedFile = files.find(f => {
        if (specDesc.includes('益生菌') || specDesc.includes('轻体') || specDesc.includes('冻干粉')) {
          return f.includes('probiotics');
        }
        if (specDesc.includes('胶原') || specDesc.includes('护肤') || specDesc.includes('抗老')) {
          return f.includes('collagen');
        }
        return false;
      }) || files[files.length - 1];

      if (matchedFile) {
        try {
          const manualContent = fs.readFileSync(path.join(knowledgeDir, matchedFile), 'utf-8');
          knowledgeText = `\n\n【已掌握的爆款产品实战手册（核心武器库）】：\n${manualContent.slice(0, 4000)}`;
        } catch {}
      }
    }

    const systemPrompt = `你是${spec.name || '服务助理'}，${spec.role_desc || ''}。

回复风格：${spec.reply_style || '亲切自然，简明扼要，有温度'}
${spec.service_flow ? `\n服务流程：\n${spec.service_flow}` : ''}${taboosText}${knowledgeText}

【核心原则】：
- 绝对不要使用 Markdown 语法（不要**加粗**，不要#标题，不要列表符号-）
- 绝对不要在回复中输出任何 URL 或 http 链接
- 面对用户的致谢（如'谢谢'、'好的'）只回一句话（简短不超过20字）
- 严格遵循你的角色定位，亲切热情、专业地回复用户`;

    const messages = [
      { role: 'system', content: systemPrompt },
      ...(params.history || []).map(h => ({ role: h.role, content: h.content })),
      { role: 'user', content: params.content !== undefined && params.content !== null ? String(params.content) : ' ' },
    ];

    if (arkKey) {
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const res = await fetch(`${arkBase}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${arkKey}` },
            body: JSON.stringify({
              model,
              messages,
              temperature: 0.3,
              max_tokens: 512,
            }),
            signal: AbortSignal.timeout(TIMEOUT_MS),
          });
          if (res.ok) {
            const data = await res.json() as any;
            const reply = data.choices?.[0]?.message?.content || '';
            return { reply: reply.trim(), request_id: `sandbox_${Date.now()}` };
          }
        } catch (err: any) {
          if (attempt === 3) {
            console.warn(`[SandboxRunner] Ark call failed after 3 attempts: ${err.message}`);
            return { reply: `[ERROR: AI 模型响应超时，请重试]`, request_id: `sandbox_err_${Date.now()}` };
          }
          await new Promise(r => setTimeout(r, 1000 * attempt));
        }
      }
    }
    return { reply: `[ERROR: 未配置可用模型 API Key]`, request_id: `sandbox_err_${Date.now()}` };
  }

  try {
    const res = await fetch(`${PLATFORM_BASE}/api/v1/agent/chat`, {
    method: 'POST',
    headers: defaultHeaders,
    body: JSON.stringify({
      content: params.content !== undefined && params.content !== null ? String(params.content) : ' ',
      source: 'eval_sandbox',
      agent_id: params.agentId,
      session_id: params.sessionId || params.userId,
      history: params.history || [],
      context: {
        available_apps: ['企业微信'],
        current_recipient: 'EvalMockUser',
      },
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
  } catch (err: any) {
    return { reply: `[ERROR: 远程平台连接失败: ${err.message}]`, request_id: `sandbox_err_${Date.now()}` };
  }
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
  delivery_config?: any;
  knowledge_domain?: string;
  intent_prompt?: string;
}): Promise<{ id: string }> {
  // 先尝试 PUT 更新
  const putRes = await fetch(`${PLATFORM_BASE}/api/v1/meta/agents/${spec.id}`, {
    method: 'PUT',
    headers: defaultHeaders,
    body: JSON.stringify(spec),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (putRes.ok) {
    return putRes.json() as any;
  }

  // 404 说明尚未创建，执行 POST 创建
  if (putRes.status === 404) {
    const postRes = await fetch(`${PLATFORM_BASE}/api/v1/meta/agents`, {
      method: 'POST',
      headers: defaultHeaders,
      body: JSON.stringify(spec),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!postRes.ok) {
      throw new Error(`[API] Upsert agent failed (POST): HTTP ${postRes.status} ${await postRes.text()}`);
    }
    return postRes.json() as any;
  }

  throw new Error(`[API] Upsert agent failed (PUT): HTTP ${putRes.status} ${await putRes.text()}`);
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
  const res = await fetch(`${PLATFORM_BASE}/api/v1/meta/agents/sandbox/${userId}`, {
    method: 'DELETE',
    headers: defaultHeaders,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok && res.status !== 404) {
    console.warn(`[API] Cleanup sandbox user ${userId} failed: HTTP ${res.status}`);
  }
}

// ─── Generic Wiki 记忆库 API（调用 llmwiki 服务）────────────────────────────

/**
 * 获取实体的记忆摘要（供 Agent System Prompt 注入）
 * @param domain  - 领域标识（social_ops / sales / hr_recruiting / health）
 * @param entityId - 实体 ID（用户 ID 或客户 ID）
 * @param maxTokens - 最大字符数近似限制（默认 2000）
 * @returns 格式化的记忆摘要字符串，供直接拼入 system prompt
 */
export async function getMemorySummary(
  domain: string,
  entityId: string,
  maxTokens = 2000,
): Promise<string> {
  try {
    const res = await fetch(
      `${WIKI_BASE}/api/generic-wiki/${domain}/${entityId}/summary?max_tokens=${maxTokens}`,
      { signal: AbortSignal.timeout(TIMEOUT_MS) },
    );
    if (res.status === 404) return ''; // 实体尚无记忆档案，正常返回空
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json() as any;
    return data.summary || '';
  } catch (err: any) {
    console.warn(`[Wiki] getMemorySummary failed for ${domain}/${entityId}: ${err.message}`);
    return ''; // 记忆库不可用时降级：不中断 Agent 运行
  }
}

/**
 * 初始化实体的 Wiki（建档）
 * @param domain    - 领域标识
 * @param entityId  - 实体 ID
 * @param entityInfo - 实体基本信息（name、id 等，用于填充模板）
 */
export async function initEntityWiki(
  domain: string,
  entityId: string,
  entityInfo: Record<string, string> = {},
): Promise<{ pages_created: string[] }> {
  const res = await fetch(`${WIKI_BASE}/api/generic-wiki/${domain}/${entityId}/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(entityInfo),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`[Wiki] Init entity wiki failed: HTTP ${res.status} ${await res.text()}`);
  return res.json() as any;
}

/**
 * 更新实体 Wiki 的单个页面内容
 */
export async function updateWikiPage(
  domain: string,
  entityId: string,
  pageName: string,
  content: string,
): Promise<void> {
  const res = await fetch(`${WIKI_BASE}/api/generic-wiki/${domain}/${entityId}/${pageName}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`[Wiki] Update wiki page failed: HTTP ${res.status}`);
}
