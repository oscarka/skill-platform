import fs from 'fs';
import path from 'path';
import * as db from './db';
import { runAI } from './aiRunner';
import { v4 as uuidv4 } from 'uuid';

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
  skill_type: 'prompt' | 'code';
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

    if (skill.skill_type === 'prompt') {
      if (!skill.prompt_template) throw new Error('Skill has no prompt template');
      const finalPrompt = buildPromptFromTemplate(skill.prompt_template, inputs);
      const aiRes = await runAI(finalPrompt, {
        model: skill.preferred_model || undefined,
        fallback: skill.fallback_model || undefined,
        systemPrompt: `你是 Skill「${skill.name}」的 AI 助手，请认真完成任务并给出专业、完整的回答。`,
      });
      rawResult = aiRes.text;
    } else {
      if (!skill.code) throw new Error('Skill has no code');
      rawResult = await runCodeSkill(skill.code, inputs, skill);
    }

    // Save result
    const resultId = uuidv4();
    const existing = await db.getAsync<any>('SELECT id FROM ticket_results WHERE ticket_id=?', [ticketId]);
    if (existing) {
      await db.runAsync(
        `UPDATE ticket_results SET raw_result=?, updated_at=? WHERE ticket_id=?`,
        [rawResult, Date.now(), ticketId]
      );
    } else {
      await db.runAsync(
        `INSERT INTO ticket_results (id, ticket_id, raw_result, created_at, updated_at) VALUES (?,?,?,?,?)`,
        [resultId, ticketId, rawResult, Date.now(), Date.now()]
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
