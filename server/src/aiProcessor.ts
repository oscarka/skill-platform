import fs from 'fs';
import path from 'path';
import * as db from './db';
import { runAI } from './aiRunner';
import { v4 as uuidv4 } from 'uuid';
import { submitSandboxJob } from './cloudRunJobsClient';

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
  prompt_template?: string;
  code?: string;
  preferred_model?: string;
  fallback_model?: string;
  h5_config?: string;
}

// ─── File reader ─────────────────────────────────────────────────────────────
function readFileAsText(filePath: string, mimeType: string): string {
  if (!fs.existsSync(filePath)) return '[文件不存在]';
  if (mimeType === 'application/pdf') {
    // For PDF: return a note (Phase 4 will add real PDF parsing)
    const stats = fs.statSync(filePath);
    return `[PDF文件: ${path.basename(filePath)}, 大小: ${(stats.size / 1024).toFixed(1)}KB - 二进制文件，请参考文件名处理]`;
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
function buildUserMessageFromInputs(inputs: TicketInput[]): string {
  const lines: string[] = ['以下是客户提交的信息，请根据这些信息完成任务：'];
  for (const inp of inputs) {
    if (inp.field_type === 'text' && inp.value) {
      lines.push(`《${inp.field_key}》: ${inp.value}`);
    } else if (inp.field_type === 'file' && inp.file_path) {
      const text = readFileAsText(inp.file_path, inp.mime_type || '');
      lines.push(`《${inp.file_name || inp.field_key}》:\n${text}`);
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
export async function processTicket(ticketId: string): Promise<void> {
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
      // plugin 类型：走 Agent Runner（Cloud Run Job，和沙箱测试完全一样）
      // 客户填写的表单数据作为唯一 test case，SKILL.md 作为 Agent 指令
      await submitTicketAgentJob(ticketId, ticket.skill_id, skill, inputs);
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

// ─── Submit plugin-type ticket to Cloud Run Job (Agent Runner) ─────────────────
// Mirrors runSandboxTest() in sandboxService.ts but uses ticket-specific callback URL
async function submitTicketAgentJob(
  ticketId: string,
  skillId: string,
  skill: Skill,
  inputs: TicketInput[]
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

  // Load MCP configs
  let mcpConfigsJson = '[]';
  try {
    const mcpRows = await db.allAsync<any>('SELECT name, command, args FROM mcp_configs', []);
    if (mcpRows.length > 0) mcpConfigsJson = JSON.stringify(mcpRows);
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
  const testInputs = { ticket: userMessage };  // CASE_COUNT=1, one case

  // Ticket-specific callback URL
  const serviceUrl = process.env.SERVICE_URL || '';
  const callbackUrl = serviceUrl
    ? `${serviceUrl}/api/tickets/${ticketId}/agent-callback`
    : '';
  const sandboxSecret = process.env.SANDBOX_SECRET || 'sandbox-secret-2024';

  // Base64-encode SKILL.md for runner.py
  const skillMdB64 = Buffer.from(skill.prompt_template || '').toString('base64');

  const { executionId } = await submitSandboxJob({
    skillId,
    skillMd:          skillMdB64,
    userInputs:       testInputs,
    model:            model || 'doubao-1-5-pro-32k-250115',
    aiKey,
    aiBaseUrl:        aiBase,
    fallbackAiKey:    fallbackKey,
    fallbackAiBase:   fallbackBase,
    callbackUrl,
    sandboxSecret,
    mcpConfigs:       mcpConfigsJson,
    oauthTokens,
    caseCount:        1,
  });

  console.log(`[TicketAgent] Cloud Run Job submitted for ticket ${ticketId}: ${executionId}`);
}
