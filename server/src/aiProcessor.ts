import fs from 'fs';
import path from 'path';
import * as db from './db';
import { runAI } from './aiRunner';
import { v4 as uuidv4 } from 'uuid';
import { submitSandboxJob } from './cloudRunJobsClient';
import { submitToSandboxService } from './sandboxServiceClient';
import { Storage } from '@google-cloud/storage';

const GCS_BUCKET = process.env.BUNDLE_BUCKET || 'skill-platform-bundles-0884226164';

/**
 * Upload a local file to GCS and return the gs:// path.
 * Used to pass ticket attachments to Cloud Run Job via __attachments__.
 */
async function uploadFileToGcs(localPath: string, ticketId: string): Promise<string | null> {
  try {
    const storage = new Storage();
    const filename = path.basename(localPath);
    const destPath = `ticket-attachments/${ticketId}/${uuidv4()}-${filename}`;
    await storage.bucket(GCS_BUCKET).upload(localPath, { destination: destPath });
    const gcsUri = `gs://${GCS_BUCKET}/${destPath}`;
    console.log(`[TicketAgent] Uploaded attachment to GCS: ${gcsUri}`);
    return gcsUri;
  } catch (err: any) {
    console.error(`[TicketAgent] GCS upload failed for ${localPath}:`, err.message);
    return null;
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────
interface TicketInput {
  id: string;
  field_key: string;
  field_type: 'text' | 'file';
  value?: string;
  file_path?: string;
  file_name?: string;
  mime_type?: string;
}

interface Skill {
  id: string;
  name: string;
  skill_type: 'prompt' | 'code' | 'plugin';
  status?: string;   // 'pending' | 'approved' | 'rejected' | 'published'
  prompt_template?: string;
  code?: string;
  preferred_model?: string;
  fallback_model?: string;
  h5_config?: string;
}

// ─── File reader (used only for prompt-type skills running inline, not plugin/agent mode) ───
function readFileAsText(filePath: string, mimeType: string): string {
  if (!fs.existsSync(filePath)) return '[文件不存在]';
  if (mimeType === 'application/pdf') {
    // PDF 在工单 Agent 模式下通过 GCS __attachments__ 传递，由 sandbox runner 用 pdfplumber 提取
    // 此处仅用于 prompt-type 内联模式的降级显示
    const stats = fs.statSync(filePath);
    return `[PDF文件: ${path.basename(filePath)}, 大小: ${(stats.size / 1024).toFixed(1)}KB]`;
  }
  if (mimeType?.startsWith('text/')) {
    return fs.readFileSync(filePath, 'utf-8').slice(0, 8000);
  }
  if (mimeType?.startsWith('image/')) {
    return `[图片文件: ${path.basename(filePath)}]`;
  }
  return `[文件: ${path.basename(filePath)}]`;
}

// ─── Build prompt for prompt-type skill ──────────────────────────────────────
function buildPromptFromTemplate(template: string, inputs: TicketInput[]): string {
  let result = template;
  const textInputs: Record<string, string> = {};
  const fileContents: string[] = [];

  for (const inp of inputs) {
    if (inp.field_type === 'text') {
      textInputs[inp.field_key] = inp.value || '';
    } else if (inp.field_type === 'file' && inp.file_path) {
      const text = readFileAsText(inp.file_path, inp.mime_type || '');
      fileContents.push(`【${inp.file_name || inp.field_key}】\n${text}`);
    }
  }

  // Replace {{fieldKey}} placeholders
  for (const [key, value] of Object.entries(textInputs)) {
    result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
  }

  // Append file content
  if (fileContents.length > 0) {
    result += '\n\n---\n**上传文件内容：**\n\n' + fileContents.join('\n\n---\n');
  }

  return result;
}

// ─── Build user message for plugin-type skill (SKILL.md 无占位符，用输入构建 user message)───────────────
// 这种情况下 SKILL.md 作为 system prompt，客户填写的表单字段作为 user message
// 文件附件通过 GCS __attachments__ 单独传递，不在此处内联（sandbox runner 负责提取内容）
function buildUserMessageFromInputs(inputs: TicketInput[]): string {
  const lines: string[] = ['以下是客户提交的信息，请根据这些信息完成任务：'];
  for (const inp of inputs) {
    if (inp.field_type === 'text' && inp.value) {
      lines.push(`《${inp.field_key}》: ${inp.value}`);
    } else if (inp.field_type === 'file' && inp.file_path) {
      // 文件名在 user message 里做说明，实际内容由 sandbox 通过 GCS 路径提取
      lines.push(`《${inp.file_name || inp.field_key}》: [附件已上传，Agent 可通过附件内容读取]`);
    }
  }
  return lines.join('\n');
}

// ─── Sandboxed code runner ────────────────────────────────────────────────────
async function runCodeSkill(
  code: string,
  inputs: TicketInput[],
  skill: Skill
): Promise<string> {
  // Build a safe execution context using Function constructor
  // Provides: inputs (text values), files (file content), api.callAI
  const textInputs: Record<string, string> = {};
  const fileData: { name: string; text: string; mime: string }[] = [];

  for (const inp of inputs) {
    if (inp.field_type === 'text') {
      textInputs[inp.field_key] = inp.value || '';
    } else if (inp.field_type === 'file' && inp.file_path) {
      fileData.push({
        name: inp.file_name || inp.field_key,
        text: readFileAsText(inp.file_path, inp.mime_type || ''),
        mime: inp.mime_type || '',
      });
    }
  }

  const apiCtx = {
    callAI: async (prompt: string) => {
      const res = await runAI(prompt, {
        model: skill.preferred_model || undefined,
        fallback: skill.fallback_model || undefined,
      });
      return res.text;
    },
  };

  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function('inputs', 'files', 'api', `
      "use strict";
      return (async () => {
        ${code}
        return await invoke(inputs, files, api);
      })();
    `);
    const result = await fn(textInputs, fileData, apiCtx);
    return typeof result === 'string' ? result : JSON.stringify(result, null, 2);
  } catch (err: any) {
    throw new Error(`代码执行失败: ${err.message}`);
  }
}

// ─── Main processor ───────────────────────────────────────────────────────────
export async function processTicket(ticketId: string, opts?: { overrideModel?: string }): Promise<void> {
  const ticket = await db.getAsync<any>('SELECT * FROM tickets WHERE id=?', [ticketId]);
  if (!ticket) throw new Error('Ticket not found');

  const skill = await db.getAsync<Skill>('SELECT * FROM skills WHERE id=?', [ticket.skill_id]);
  if (!skill) throw new Error('Skill not found');

  const inputs = await db.allAsync<TicketInput>('SELECT * FROM ticket_inputs WHERE ticket_id=? ORDER BY created_at', [ticketId]);

  // Mark as processing
  const now = Date.now();
  await db.runAsync(`UPDATE tickets SET status='processing', ai_started_at=?, updated_at=? WHERE id=?`, [now, now, ticketId]);

  try {
    let rawResult: string;
    let aiLog: string = ''; // 用于记录实际发送给 AI 的内容（日志显示）

    if (skill.skill_type === 'prompt') {
      // prompt 类型：模板有 {{field}} 占位符，替换后直接调 LLM
      if (!skill.prompt_template) throw new Error('Skill has no prompt template');
      const finalPrompt = buildPromptFromTemplate(skill.prompt_template, inputs);
      aiLog = `[system]你是 Skill「${skill.name}」的 AI 助手。\n\n[user]\n${finalPrompt}`;
      const aiRes = await runAI(finalPrompt, {
        model: skill.preferred_model || undefined,
        fallback: skill.fallback_model || undefined,
        systemPrompt: `你是 Skill「${skill.name}」的 AI 助手，请认真完成任务并给出专业、完整的回答。`,
      });
      rawResult = aiRes.text;

    } else if (skill.skill_type === 'plugin' && skill.prompt_template) {
      // plugin 类型：走 Agent Runner
      // ── 路由策略 ────────────────────────────────────────────────────────
      // 审核通过的 skill（status='approved'）+ 配置了 SANDBOX_SERVICE_URL
      //   → 走持久沙箱 Service（热实例，冷启动 < 100ms）
      // 其他（pending/rejected 或未配置 Service URL）
      //   → 走 Cloud Run Job（原逻辑，保持不变）
      const sandboxServiceUrl = process.env.SANDBOX_SERVICE_URL || '';
      const isVerified = skill.status === 'approved' || skill.status === 'published';
      if (isVerified && sandboxServiceUrl) {
        console.log(`[TicketAgent] skill=${skill.id} status=${skill.status} → Sandbox Service (model=${opts?.overrideModel || 'default'})`);
        await submitTicketToSandboxService(ticketId, ticket.skill_id, skill, inputs, sandboxServiceUrl, opts?.overrideModel);
      } else {
        console.log(`[TicketAgent] skill=${skill.id} status=${skill.status} → Cloud Run Job (model=${opts?.overrideModel || 'default'})`);
        await submitTicketAgentJob(ticketId, ticket.skill_id, skill, inputs, opts?.overrideModel);
      }
      // Agent 异步运行，callback 会写回结果并更新工单状态
      // 此处早返回，ticket 状态保持 'processing'
      return;

    } else if (skill.skill_type === 'code') {
      if (!skill.code) throw new Error('Skill has no code');
      rawResult = await runCodeSkill(skill.code, inputs, skill);
      aiLog = `[code runner] executed`;
    } else {
      throw new Error(`Skill type '${skill.skill_type}' has no executable content`);
    }

    // Save result (with ai_log for transparency / log viewing)
    const resultId = uuidv4();
    const existing = await db.getAsync<any>('SELECT id FROM ticket_results WHERE ticket_id=?', [ticketId]);
    if (existing) {
      await db.runAsync(
        `UPDATE ticket_results SET raw_result=?, ai_log=?, updated_at=? WHERE ticket_id=?`,
        [rawResult, aiLog, Date.now(), ticketId]
      );
    } else {
      await db.runAsync(
        `INSERT INTO ticket_results (id, ticket_id, raw_result, ai_log, created_at, updated_at) VALUES (?,?,?,?,?,?)`,
        [resultId, ticketId, rawResult, aiLog, Date.now(), Date.now()]
      );
    }

    // Mark done
    await db.runAsync(
      `UPDATE tickets SET status='done', ai_completed_at=?, updated_at=? WHERE id=?`,
      [Date.now(), Date.now(), ticketId]
    );
  } catch (err: any) {
    // Mark error
    await db.runAsync(`UPDATE tickets SET status='error', updated_at=? WHERE id=?`, [Date.now(), ticketId]);
    // Store error in result
    const existing = await db.getAsync<any>('SELECT id FROM ticket_results WHERE ticket_id=?', [ticketId]);
    const errMsg = `AI 处理出错：${err.message}`;
    if (existing) {
      await db.runAsync(`UPDATE ticket_results SET raw_result=?, updated_at=? WHERE ticket_id=?`, [errMsg, Date.now(), ticketId]);
    } else {
      await db.runAsync(
        `INSERT INTO ticket_results (id, ticket_id, raw_result, created_at, updated_at) VALUES (?,?,?,?,?)`,
        [uuidv4(), ticketId, errMsg, Date.now(), Date.now()]
      );
    }
    throw err;
  }
}

// ─── Helper: DB settings ───────────────────────────────────────────────────────
async function getSetting(key: string): Promise<string> {
  const row = await db.getAsync<{ value: string }>('SELECT value FROM settings WHERE key=?', [key]);
  return row?.value || '';
}

// ─── Submit approved-skill ticket to Persistent Sandbox Service ───────────────
// 审核通过的 skill 走这条路径，调用常驻热实例 Service，消灭冷启动
async function submitTicketToSandboxService(
  ticketId: string,
  skillId: string,
  skill: Skill,
  inputs: TicketInput[],
  serviceUrl: string,
  overrideModel?: string
): Promise<void> {
  // 复用 submitTicketAgentJob 的 key/config 加载逻辑
  const [model, aiKey, aiBase, fallbackKey, fallbackBase] = await Promise.all([
    getSetting('ai_model'),
    getSetting('doubao_api_key').then(k => k || getSetting('deepseek_api_key')),
    getSetting('doubao_base_url').then(u => u || getSetting('deepseek_base_url')),
    getSetting('doubao_api_key').then(k => k ? getSetting('deepseek_api_key') : getSetting('doubao_api_key')),
    getSetting('doubao_base_url').then(u => u ? getSetting('deepseek_base_url') : getSetting('doubao_base_url')),
  ]);

  // 按 skill 的 mcp_names 过滤：只加载该 skill 声明需要的 MCP
  // 空数组 [] 或 null = 不加载任何 MCP（runner.py 跳过 discover，省 60s 超时）
  let mcpConfigsJson = '[]';
  try {
    const skillMcpNames: string[] = JSON.parse((skill as any).mcp_names || 'null') ?? [];
    if (skillMcpNames.length > 0) {
      const placeholders = skillMcpNames.map(() => '?').join(',');
      const mcpRows = await db.allAsync<any>(
        `SELECT name, command, args FROM mcp_configs WHERE name IN (${placeholders})`,
        skillMcpNames
      );
      if (mcpRows.length > 0) mcpConfigsJson = JSON.stringify(mcpRows);
      console.log(`[MCP] skill ${skill.id} mcp_names=${JSON.stringify(skillMcpNames)} → loaded ${mcpRows.length} configs`);
    } else {
      console.log(`[MCP] skill ${skill.id} mcp_names=[] → no MCP loaded (skip 60s discover)`);
    }
  } catch { /* ignore */ }

  let oauthTokens = '';
  try {
    const storedTokens = await db.allAsync<any>(
      `SELECT provider, mcp_name, access_token, token_data, expires_at
       FROM mcp_oauth_tokens WHERE expires_at = 0 OR expires_at > ?`, [Date.now()]
    );
    if (storedTokens.length > 0) {
      const tokenMap: Record<string, any> = {};
      for (const t of storedTokens) {
        let tokenObj: Record<string, any> = { access_token: t.access_token };
        if (t.token_data) { try { tokenObj = { ...JSON.parse(t.token_data), access_token: t.access_token }; } catch {} }
        if (!tokenObj.expiry_date && t.expires_at) tokenObj.expiry_date = parseInt(t.expires_at);
        tokenMap[t.provider] = tokenObj;
        if (t.mcp_name) tokenMap[t.mcp_name] = tokenObj;
      }
      oauthTokens = JSON.stringify(tokenMap);
    }
  } catch { /* ignore */ }

  const userMessage = buildUserMessageFromInputs(inputs);
  const testInputs: Record<string, any> = { ticket: userMessage };

  // 附件处理（和 Job 路径完全一致）
  const fileInputs = inputs.filter(i => i.field_type === 'file' && i.file_path && fs.existsSync(i.file_path));
  if (fileInputs.length > 0) {
    const gcsPaths: string[] = [];
    for (const fi of fileInputs) {
      const gcsPath = await uploadFileToGcs(fi.file_path!, ticketId);
      if (gcsPath) gcsPaths.push(gcsPath);
    }
    if (gcsPaths.length > 0) {
      testInputs['__attachments__'] = gcsPaths;
      console.log(`[SandboxService] Injecting ${gcsPaths.length} GCS attachment(s) for ticket ${ticketId}`);
    }
  }

  const svcUrl = process.env.SERVICE_URL || '';
  const callbackUrl = svcUrl ? `${svcUrl}/api/tickets/${ticketId}/agent-callback` : '';
  const sandboxSecret = process.env.SANDBOX_SECRET || 'sandbox-secret-2024';

  const effectiveModel = overrideModel || skill.preferred_model || model || 'doubao-1-5-pro-32k-250115';
  console.log(`[SandboxService] model resolution: override=${overrideModel} preferred=${skill.preferred_model} setting=${model} → effective=${effectiveModel}`);

  const { jobId } = await submitToSandboxService(serviceUrl, {
    skillId,
    userInputs:     testInputs,
    model:          effectiveModel,
    aiKey,
    aiBaseUrl:      aiBase,
    fallbackAiKey:  fallbackKey,
    fallbackAiBase: fallbackBase,
    callbackUrl,
    sandboxSecret,
    mcpConfigs:     mcpConfigsJson,
    oauthTokens,
    caseCount:      1,
    ticketMode:     true,
  });

  console.log(`[SandboxService] Job submitted for ticket ${ticketId}: ${jobId}`);
}

// ─── Submit plugin-type ticket to Cloud Run Job (Agent Runner) ─────────────────

// Mirrors runSandboxTest() in sandboxService.ts but uses ticket-specific callback URL
async function submitTicketAgentJob(
  ticketId: string,
  skillId: string,
  skill: Skill,
  inputs: TicketInput[],
  overrideModel?: string
): Promise<void> {
  // Load AI keys from settings (same as sandboxService)
  const [model, aiKey, aiBase, fallbackKey, fallbackBase] = await Promise.all([
    getSetting('ai_model'),
    getSetting('doubao_api_key').then(k => k || getSetting('deepseek_api_key')),
    getSetting('doubao_base_url').then(u => u || getSetting('deepseek_base_url')),
    getSetting('doubao_api_key').then(k => k
      ? getSetting('deepseek_api_key')
      : getSetting('doubao_api_key')),
    getSetting('doubao_base_url').then(u => u
      ? getSetting('deepseek_base_url')
      : getSetting('doubao_base_url')),
  ]);

  // 按 skill 的 mcp_names 过滤：只加载该 skill 声明需要的 MCP
  let mcpConfigsJson = '[]';
  try {
    const skillMcpNames: string[] = JSON.parse((skill as any).mcp_names || 'null') ?? [];
    if (skillMcpNames.length > 0) {
      const placeholders = skillMcpNames.map(() => '?').join(',');
      const mcpRows = await db.allAsync<any>(
        `SELECT name, command, args FROM mcp_configs WHERE name IN (${placeholders})`,
        skillMcpNames
      );
      if (mcpRows.length > 0) mcpConfigsJson = JSON.stringify(mcpRows);
      console.log(`[MCP] skill ${skill.id} mcp_names=${JSON.stringify(skillMcpNames)} → loaded ${mcpRows.length} configs`);
    } else {
      console.log(`[MCP] skill ${skill.id} mcp_names=[] → no MCP loaded (skip 60s discover)`);
    }
  } catch { /* ignore */ }

  // Load OAuth tokens
  let oauthTokens = '';
  try {
    const storedTokens = await db.allAsync<any>(
      `SELECT provider, mcp_name, access_token, token_data, expires_at
       FROM mcp_oauth_tokens WHERE expires_at = 0 OR expires_at > ?`, [Date.now()]
    );
    if (storedTokens.length > 0) {
      const tokenMap: Record<string, any> = {};
      for (const t of storedTokens) {
        let tokenObj: Record<string, any> = { access_token: t.access_token };
        if (t.token_data) {
          try { tokenObj = { ...JSON.parse(t.token_data), access_token: t.access_token }; } catch {}
        }
        if (!tokenObj.expiry_date && t.expires_at) tokenObj.expiry_date = parseInt(t.expires_at);
        tokenMap[t.provider] = tokenObj;
        if (t.mcp_name) tokenMap[t.mcp_name] = tokenObj;
      }
      oauthTokens = JSON.stringify(tokenMap);
    }
  } catch { /* ignore */ }

  // Build customer data as single test case
  const userMessage = buildUserMessageFromInputs(inputs);
  const testInputs: Record<string, any> = { ticket: userMessage };  // CASE_COUNT=1, one case

  // ── 上传文件附件到 GCS，通过 __attachments__ 传给 sandbox runner ──────────
  // sandbox runner.py 会从 GCS 下载文件并用 pdfplumber 等工具提取内容，注入 Agent 上下文
  const fileInputs = inputs.filter(i => i.field_type === 'file' && i.file_path && fs.existsSync(i.file_path));
  if (fileInputs.length > 0) {
    const gcsPaths: string[] = [];
    for (const fi of fileInputs) {
      const gcsPath = await uploadFileToGcs(fi.file_path!, ticketId);
      if (gcsPath) gcsPaths.push(gcsPath);
    }
    if (gcsPaths.length > 0) {
      testInputs['__attachments__'] = gcsPaths;
      console.log(`[TicketAgent] Injecting ${gcsPaths.length} GCS attachment(s) for ticket ${ticketId}`);
    }
  }

  // Ticket-specific callback URL
  const serviceUrl = process.env.SERVICE_URL || '';
  const callbackUrl = serviceUrl
    ? `${serviceUrl}/api/tickets/${ticketId}/agent-callback`
    : '';
  const sandboxSecret = process.env.SANDBOX_SECRET || 'sandbox-secret-2024';

  // skillMdB64 已废弃：runner.py 改从 DB 按 SKILL_ID 读取 prompt_template

  const effectiveModel = overrideModel || skill.preferred_model || model || 'doubao-1-5-pro-32k-250115';
  console.log(`[TicketAgent] model resolution: override=${overrideModel} preferred=${skill.preferred_model} setting=${model} → effective=${effectiveModel}`);

  const { executionId } = await submitSandboxJob({
    skillId,
    // skillMd 已废弃，runner.py 从 DB 读
    userInputs:       testInputs,
    model:            effectiveModel,
    aiKey,
    aiBaseUrl:        aiBase,
    fallbackAiKey:    fallbackKey,
    fallbackAiBase:   fallbackBase,
    callbackUrl,
    sandboxSecret,
    mcpConfigs:       mcpConfigsJson,
    oauthTokens,
    caseCount:        1,
    ticketMode:       true,   // 工单模式：runner.py 跳过 Evaluator，返回 Executor 实际输出
  });

  console.log(`[TicketAgent] Cloud Run Job submitted for ticket ${ticketId}: ${executionId}`);
}
