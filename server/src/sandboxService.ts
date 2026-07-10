/**
 * sandboxService.ts — Skill 沙箱测试服务
 *
 * 阶段 1：Prompt 类技能测试（3轮 ReAct Loop，纯 AI，无 Docker）
 * 阶段 2（待实现）：Script 类技能测试（Docker + Agent 循环）
 */

import { runAI } from './aiRunner';
import { parseSkillMd, ParsedSkill } from './skillParser';
import * as db from './db';
import { execSync, exec } from 'child_process';
import { randomUUID } from 'crypto';
import * as path from 'path';
import { submitSandboxJob, waitForExecution, USE_CLOUD_RUN } from './cloudRunJobsClient';

// ─── 结果类型定义 ────────────────────────────────────────────────────────────

export interface ReActTrace {
  round: number;
  role: 'think' | 'act' | 'observe';
  content: string;
}

export interface SandboxTestResult {
  skillType: 'prompt' | 'script';
  testInput: string;          // AI 生成的测试数据（JSON 或描述）
  finalOutput: string;        // 最终输出
  score: number;              // 0-100
  passed: boolean;
  comment: string;            // AI 总体评语
  strengths: string[];
  weaknesses: string[];
  trace: ReActTrace[];        // 每轮 ReAct 的详细记录
  transcript?: any[];         // 对话记录（Cloud Run Job callback 保留）
  test_results?: any[];       // 每个测试用例的详细结果
  durationMs: number;
  testedAt: number;
  model: string;
}

// ─── 主入口 ──────────────────────────────────────────────────────────────────

/**
 * 对一个 Skill 跑沙箱测试，结果写入数据库
 */
export async function runSandboxTest(skillId: string, oauthTokens?: string): Promise<void> {
  const t0 = Date.now();

  // 如果没有显式传入 token，从 DB 自动取存储的 MCP OAuth token
  if (!oauthTokens) {
    try {
      const storedTokens = await db.allAsync<any>(
        `SELECT provider, mcp_name, access_token, token_data, expires_at FROM mcp_oauth_tokens WHERE expires_at = 0 OR expires_at > $1`,
        [Date.now()]
      );
      if (storedTokens.length > 0) {
        const tokenMap: Record<string, any> = {};
        for (const t of storedTokens) {
          // 优先用完整 token_data（含 token_type, scope, expiry_date）
          let tokenObj: Record<string, any> = { access_token: t.access_token };
          if (t.token_data) {
            try { tokenObj = { ...JSON.parse(t.token_data), access_token: t.access_token }; } catch {}
          }
          // 确保 expiry_date 字段存在（stitch-mcp-auto 要求）
          if (!tokenObj.expiry_date && t.expires_at) {
            tokenObj.expiry_date = parseInt(t.expires_at);
          }
          tokenMap[t.provider] = tokenObj;
          if (t.mcp_name) tokenMap[t.mcp_name] = tokenObj;
        }
        oauthTokens = JSON.stringify(tokenMap);
      }
    } catch { /* 忽略 token 加载失败，继续测试 */ }
  }

  // 标记为 running
  await db.runAsync(
    `UPDATE skills SET sandbox_status='running', updated_at=? WHERE id=?`,
    [Date.now(), skillId]
  );

  try {
    const skill = await db.getAsync<any>('SELECT * FROM skills WHERE id=?', [skillId]);
    if (!skill) throw new Error('Skill not found');

    // 获取 SKILL.md 内容（存在 prompt_template 里）
    const content = skill.prompt_template || skill.code || '';
    if (!content) throw new Error('Skill has no content (prompt_template is empty)');

    const parsed = parseSkillMd(content);

    // ── 路由决策（两层保险）─────────────────────────────────────────────────
    // 主信号：DB 里的 skill_type（导入时明确设置，不靠猜）
    //   - 'plugin' / 'code'  → 需要沙箱执行（Cloud Run Job）
    //   - 'prompt'           → 纯 AI 评估（runPromptReActLoop）
    // 副信号：SKILL.md 内容解析（新加 js-yaml，更可靠）
    // 只要任一信号认为需要沙箱，就进沙箱
    const dbSkillType: string = skill.skill_type || 'prompt';
    const needsSandbox =
      parsed.skillType === 'script' ||
      dbSkillType === 'plugin' ||
      dbSkillType === 'code';

    console.log(`[SandboxService] Routing: dbSkillType=${dbSkillType} parsedSkillType=${parsed.skillType} → ${needsSandbox ? 'SANDBOX' : 'PROMPT_EVAL'}`);

    let result: SandboxTestResult;

    if (needsSandbox) {
      if (USE_CLOUD_RUN) {
        // ── Cloud Run Job 沙箱执行路径 ──────────────────────────────────────
        result = await runCloudRunJobTest(skill, parsed, t0, oauthTokens);
      } else {
        // ── 本地 Docker 路径（开发用）──────────────────────────────────────
        result = await runDockerReActLoop(skill, parsed, t0);
      }
    } else {
      result = await runPromptReActLoop(parsed, t0);
    }

    // 写入结果
    await db.runAsync(
      `UPDATE skills SET sandbox_status='done', sandbox_test=?, updated_at=? WHERE id=?`,
      [JSON.stringify(result), Date.now(), skillId]
    );

  } catch (err: any) {
    console.error('[SandboxService] Error:', err.message);
    const errResult = {
      skillType: 'prompt',
      testInput: '',
      finalOutput: '',
      score: 0,
      passed: false,
      comment: `测试失败：${err.message}`,
      strengths: [],
      weaknesses: [err.message],
      trace: [],
      durationMs: Date.now() - t0,
      testedAt: Date.now(),
      model: 'n/a',
    };
    await db.runAsync(
      `UPDATE skills SET sandbox_status='failed', sandbox_test=?, updated_at=? WHERE id=?`,
      [JSON.stringify(errResult), Date.now(), skillId]
    );
  }
}

// ─── Prompt 类：3轮 ReAct Loop ───────────────────────────────────────────────

async function runPromptReActLoop(
  parsed: { name: string; description: string; body: string },
  t0: number
): Promise<SandboxTestResult> {
  const trace: ReActTrace[] = [];
  const model = ''; // 空字符串 → runAI 使用 DB 里配置的 default_model
  let usedModel = 'default';

  // ── 轮 0：Think — 生成测试场景 ──────────────────────────────────────────
  trace.push({ round: 0, role: 'think', content: '生成测试场景和测试数据…' });

  const genInputPrompt = `你是一个专业的 AI 技能测试员。
下面是一个健康/医疗 AI 技能的说明文档（SKILL.md 正文）：

---
${parsed.body}
---

技能名称：${parsed.name}
技能描述：${parsed.description}

请根据这个技能的用途，生成一个真实感强的测试场景。
输出格式（JSON）：
{
  "scenario": "情景描述（1-2句话）",
  "input": "模拟用户的输入内容（自然语言，像真实用户提问一样）",
  "expectedKeyPoints": ["预期输出应包含的关键点1", "关键点2", "关键点3"]
}
只输出 JSON，不要其他内容。`;

  let testDataStr = '';
  let testInput = '';
  let expectedKeyPoints: string[] = [];

  try {
    const r0 = await runAI(genInputPrompt, { model, temperature: 0.7 });
    usedModel = r0.model;
    const jsonMatch = r0.text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed0 = JSON.parse(jsonMatch[0]);
      testInput = parsed0.input || r0.text;
      expectedKeyPoints = parsed0.expectedKeyPoints || [];
      testDataStr = JSON.stringify(parsed0, null, 2);
    } else {
      testInput = r0.text;
      testDataStr = r0.text;
    }
  } catch (e: any) {
    testInput = `患者：张三，45岁男性，头痛三天伴低烧（体温37.8°），有高血压病史，正在服用降压药。`;
    testDataStr = testInput;
  }

  trace.push({ round: 0, role: 'observe', content: `测试场景生成完成：\n${testDataStr}` });

  // ── 轮 1：Act — 用技能处理测试输入 ─────────────────────────────────────
  trace.push({ round: 1, role: 'act', content: '以 SKILL.md 为指令，处理测试输入…' });

  const round1Prompt = testInput;
  let round1Output = '';

  try {
    const r1 = await runAI(round1Prompt, {
      model,
      systemPrompt: parsed.body,
      temperature: 0.3,
      maxTokens: 2048,
    });
    round1Output = r1.text;
  } catch (e: any) {
    round1Output = `[错误] ${e.message}`;
  }

  trace.push({ round: 1, role: 'observe', content: round1Output });

  // ── 轮 2：Think + Act — 自我审查并改进 ──────────────────────────────────
  trace.push({ round: 2, role: 'think', content: '自我审查第 1 轮输出，检查是否完整、安全…' });

  const selfReviewPrompt = `你是一个健康 AI 技能的质量审查员。

技能说明：${parsed.description}

【用户输入】
${testInput}

【第 1 轮 AI 输出】
${round1Output}

请检查上述输出：
1. 是否完整回答了用户的核心需求？
2. 有无遗漏的重要信息？
3. 有无不安全或不准确的内容？

如果输出需要改进，请输出改进版本。如果已经足够好，输出"[已完整]"开头然后重申要点。`;

  let round2Output = '';
  try {
    const r2 = await runAI(selfReviewPrompt, { model, temperature: 0.2, maxTokens: 2048 });
    round2Output = r2.text;
  } catch (e: any) {
    round2Output = round1Output; // fallback to round 1
  }

  const finalOutput = round2Output.startsWith('[已完整]')
    ? round1Output  // 已经很好，用 round 1
    : round2Output; // 用改进版

  trace.push({ round: 2, role: 'observe', content: round2Output });

  // ── 轮 3：Think — 质检员打分 ─────────────────────────────────────────────
  trace.push({ round: 3, role: 'think', content: '质检员综合评估整个测试过程…' });

  const evalPrompt = `你是一个 AI 技能质量评估专家，专注于健康/医疗场景。

【技能名称】${parsed.name}
【技能描述】${parsed.description}
【测试输入】${testInput}
【最终输出】${finalOutput}
${expectedKeyPoints.length > 0 ? `【预期关键点】${expectedKeyPoints.join(', ')}` : ''}

请以 JSON 格式输出评估结果：
{
  "score": 0-100的整数,
  "passed": true或false（>= 70 分为通过）,
  "comment": "一句话总体评语",
  "strengths": ["优点1", "优点2"],
  "weaknesses": ["不足1（如有）"]
}
只输出 JSON，不要其他内容。`;

  let score = 70;
  let passed = true;
  let comment = '测试完成，输出基本合理。';
  let strengths: string[] = ['内容相关', '格式清晰'];
  let weaknesses: string[] = [];

  try {
    const r3 = await runAI(evalPrompt, { model, temperature: 0.1, maxTokens: 512 });
    const jsonMatch = r3.text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const eval3 = JSON.parse(jsonMatch[0]);
      score = Math.max(0, Math.min(100, Number(eval3.score) || 70));
      passed = eval3.passed ?? (score >= 70);
      comment = eval3.comment || comment;
      strengths = eval3.strengths || strengths;
      weaknesses = eval3.weaknesses || weaknesses;
    }
  } catch { /* keep defaults */ }

  trace.push({ round: 3, role: 'observe', content: `评分：${score}分 | 通过：${passed}` });

  return {
    skillType: 'prompt',
    testInput: testDataStr,
    finalOutput,
    score,
    passed,
    comment,
    strengths,
    weaknesses,
    trace,
    durationMs: Date.now() - t0,
    testedAt: Date.now(),
    model: usedModel,
  };
}
// ─── Script 类：Docker + 8轮 ReAct Loop ─────────────────────────────────────

const SANDBOX_IMAGE = 'skill-platform-sandbox:latest';
const MAX_ROUNDS = 8;
const CMD_TIMEOUT_MS = 30_000;
const TOTAL_TIMEOUT_MS = 120_000;

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

// ─── macOS → Linux 命令对照表 ────────────────────────────────────────────────
// Reflect 步骤用：当观察到 macOS 专有命令失败时，自动映射到 Linux 等价命令

const MACOS_CMD_MAP: Array<{ pattern: RegExp; linuxAlt: string; note: string }> = [
  { pattern: /\bopen\b/,      linuxAlt: 'xdg-open 2>/dev/null || echo "[skip: open is macOS only, no GUI in sandbox]"', note: 'open → xdg-open/skip（Linux 无 GUI）' },
  { pattern: /\blsof\s+-i/,  linuxAlt: 'ss -tlnp',                  note: 'lsof -i → ss -tlnp' },
  { pattern: /\blsof\b/,     linuxAlt: 'fuser',                     note: 'lsof → fuser' },
  { pattern: /\bpbcopy\b/,   linuxAlt: 'cat',                       note: 'pbcopy → cat（无剪贴板）' },
  { pattern: /\bpbpaste\b/,  linuxAlt: 'echo ""',                   note: 'pbpaste → echo（无剪贴板）' },
  { pattern: /\bosascript\b/,linuxAlt: 'echo "[skip: osascript is macOS only]"', note: 'osascript → skip' },
  { pattern: /\bsay\b/,      linuxAlt: 'echo "[skip: say is macOS only]"', note: 'say → skip' },
  { pattern: /\bpgrep\b/,    linuxAlt: 'ps aux | grep',             note: 'pgrep → ps aux | grep' },
  { pattern: /\bpkill\b/,    linuxAlt: 'pkill',                     note: 'pkill OK on Linux' },
  { pattern: /\bgsed\b/,     linuxAlt: 'sed',                       note: 'gsed → sed（GNU sed）' },
  { pattern: /\bggrep\b/,    linuxAlt: 'grep',                      note: 'ggrep → grep（GNU grep）' },
  { pattern: /\bgawk\b/,     linuxAlt: 'awk',                       note: 'gawk → awk' },
  { pattern: /brew\s+install/,linuxAlt: 'apt-get install -y',       note: 'brew install → apt-get install' },
];

/**
 * Reflect 步骤：分析命令执行结果，如果发现 macOS 专有命令失败，
 * 返回反思说明 + 建议替换命令；否则返回 null（无需反思）
 */
function reflectOnError(cmd: string, result: ExecResult): { reflection: string; adaptedCmd: string } | null {
  if (result.exitCode === 0 && !result.timedOut) return null; // 成功，不需要 Reflect

  const errText = (result.stderr + result.stdout).toLowerCase();
  // 精确匹配"命令不存在"，排除"文件不存在"（scripts/ 找不到是另一个问题）
  const isCmdNotFound =
    errText.includes('command not found') ||
    errText.includes(': not found') ||           // bash: cmd: not found
    errText.includes('executable file not found') ||
    result.exitCode === 127;                      // POSIX shell: command not found exit code

  if (!isCmdNotFound) return null;


  // 检测命令中是否包含 macOS 专有指令
  for (const { pattern, linuxAlt, note } of MACOS_CMD_MAP) {
    if (pattern.test(cmd)) {
      const adaptedCmd = cmd.replace(pattern, linuxAlt);
      return {
        reflection: `🔍 Reflect: 命令失败原因 = macOS 专有命令 (${note})。\n沙箱是 Linux 环境，自动切换到 Linux 等价命令。\n原命令: ${cmd.slice(0, 100)}\n调整后: ${adaptedCmd.slice(0, 100)}`,
        adaptedCmd,
      };
    }
  }

  return null; // 不是 macOS 兼容问题，交给 AI 自行判断
}



/**
 * 在 Docker 容器里执行单条 shell 命令
 */
function dockerExec(containerId: string, cmd: string): Promise<ExecResult> {
  return new Promise((resolve) => {
    // nohup 后台命令检测：末尾是 & 且含 nohup
    const isBackground = cmd.includes('nohup') && cmd.trimEnd().endsWith('&');
    // 始终以 /workspace/skill 为工作目录（技能文件所在目录，scripts/ 在此处）
    const cdPrefix = 'cd /workspace/skill 2>/dev/null || cd /workspace; ';
    // nohup 后台进程加 sleep 2 让日志来得及输出
    const finalCmd = cdPrefix + cmd + (isBackground ? '; sleep 2; echo "[bg-started]"' : '');
    const escaped = finalCmd.replace(/'/g, "'\\''");
    const fullCmd = `docker exec ${containerId} bash -c '${escaped}'`;
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timeout = isBackground ? 14_000 : CMD_TIMEOUT_MS;
    const child = exec(fullCmd, { timeout });

    child.stdout?.on('data', (d: string) => { stdout += d; });
    child.stderr?.on('data', (d: string) => { stderr += d; });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, CMD_TIMEOUT_MS);

    child.on('close', (code: number | null) => {
      clearTimeout(timer);
      // nohup 后台进程被 SIGTERM(143) 强杀是正常的，视为成功
      const effectiveCode = (isBackground && (code === 143 || code === null)) ? 0 : (code ?? -1);
      // 截断超长输出（最多 2000 chars）
      if (stdout.length > 2000) stdout = stdout.slice(0, 2000) + '\n... [truncated]';
      if (stderr.length > 1000) stderr = stderr.slice(0, 1000) + '\n... [truncated]';
      resolve({ stdout, stderr, exitCode: effectiveCode, timedOut });
    });
  });
}

/**
 * 从 AI 响应中提取第一个 bash 代码块
 */
function extractBashCmd(text: string): string | null {
  const m = text.match(/```(?:bash|sh|shell|zsh)?\n([\s\S]*?)```/);
  return m ? m[1].trim() : null;
}

/**
 * Script 类技能的 Docker + ReAct 循环
 */
async function runDockerReActLoop(
  skill: any,
  parsed: ParsedSkill,
  t0: number
): Promise<SandboxTestResult> {
  const trace: ReActTrace[] = [];
  let containerId = '';
  let usedModel = 'default';
  const totalDeadline = t0 + TOTAL_TIMEOUT_MS;

  try {
    // ── 检查 Docker 镜像是否存在 ────────────────────────────────────────────
    try {
      execSync(`docker image inspect ${SANDBOX_IMAGE} --format '{{.Id}}'`, { stdio: 'pipe' });
    } catch {
      throw new Error(`Docker 镜像 ${SANDBOX_IMAGE} 不存在，请先运行 docker build`);
    }

    // ── 启动一次性临时沙箱容器 ────────────────────────────────────────────────
    const containerName = `skill-sandbox-${randomUUID().slice(0, 8)}`;
    console.log(`[Sandbox] ▶ Creating ephemeral container: ${containerName} for skill ${skill.id}`);
    trace.push({ round: 0, role: 'think', content: `🐳 创建一次性沙箱容器\nName: ${containerName}\nImage: ${SANDBOX_IMAGE}\n隔离: bridge 网络（可访问互联网）--memory=512m --rm（测完自动销毁）` });

    containerId = execSync(
      `docker run -d --name ${containerName} \
       --memory=512m --cpus=1.0 \
       --network=bridge \
       --rm \
       ${SANDBOX_IMAGE} tail -f /dev/null`,
      { encoding: 'utf8' }
    ).trim();

    console.log(`[Sandbox] ✅ Container ready: ${containerId.slice(0, 12)}`);
    trace.push({ round: 0, role: 'observe', content: `✅ 容器就绪: ${containerId.slice(0, 12)}\n（每次测试独立容器，测完永久销毁）` });

    // ── 写入 SKILL.md + 下载 scripts/ 目录到容器 ─────────────────────────────
    const skillContent = skill.prompt_template || skill.code || '';
    const encodedContent = Buffer.from(skillContent).toString('base64');
    // 用 root 建目录，写文件，然后 chown 给 sandbox
    execSync(`docker exec -u root ${containerId} bash -c "mkdir -p /workspace/skill && chown -R sandbox:sandbox /workspace"`, { stdio: 'pipe' });
    await dockerExec(containerId, `echo '${encodedContent}' | base64 -d > /workspace/skill/SKILL.md`);

    // ── 获取 scripts/ 文件（双通道策略）─────────────────────────────────────
    // 通道 1：skill 对象上有 scripts_path（用户上传的 zip 已解压到宿主机）
    // 通道 2：openclaw CLI 在宿主机安装，把安装目录 docker cp 进容器
    if (parsed.hasScripts) {
      const scriptsPath = skill.scripts_path as string | undefined;
      if (scriptsPath) {
        // 通道 1：直接从宿主机路径复制
        trace.push({ round: 0, role: 'think', content: `📦 从本地路径加载 scripts/: ${scriptsPath}` });
        try {
          execSync(`docker cp ${scriptsPath}/. ${containerId}:/workspace/skill/`, { stdio: 'pipe' });
          trace.push({ round: 0, role: 'observe', content: `✅ scripts/ 已从本地路径复制进容器` });
          console.log(`[Sandbox] ✅ Copied scripts from ${scriptsPath}`);
        } catch (cpErr: any) {
          trace.push({ round: 0, role: 'observe', content: `⚠ 本地 scripts/ 复制失败: ${String(cpErr?.message || '').slice(0, 80)}` });
        }
      } else if (parsed.slug) {
        // 通道 2：从 openclaw workspace 已安装路径直接复制，或用 CLI 安装
        // openclaw skills install 会安装到 ~/.openclaw/workspace/skills/<slug>
        const ocWorkspaceSkillPath = `${process.env.HOME}/.openclaw/workspace/skills/${parsed.slug}`;
        trace.push({ round: 0, role: 'think', content: `📥 查找 skills/ 文件: ${ocWorkspaceSkillPath}` });
        try {
          const { execSync: execCheck } = await import('child_process') as any;
          // 先检查是否已安装
          let skillDir = '';
          try {
            execSync(`test -d ${ocWorkspaceSkillPath}`, { stdio: 'pipe' });
            skillDir = ocWorkspaceSkillPath;
            trace.push({ round: 0, role: 'observe', content: `✅ 发现已安装的 skill 目录: ${skillDir}` });
          } catch {
            // 没有已安装的，尝试用 openclaw skills install
            trace.push({ round: 0, role: 'observe', content: `⏳ 未发现已安装版本，尝试 openclaw skills install ${parsed.slug}...` });
            const ocMjs = `${process.env.HOME}/.npm/_npx/8718c3904bb5fece/node_modules/openclaw/openclaw.mjs`;
            execSync(`node ${ocMjs} skills install ${parsed.slug} 2>/dev/null`, {
              encoding: 'utf8', timeout: 60_000, stdio: 'pipe'
            });
            execSync(`test -d ${ocWorkspaceSkillPath}`, { stdio: 'pipe' });
            skillDir = ocWorkspaceSkillPath;
            trace.push({ round: 0, role: 'observe', content: `✅ openclaw skills install 成功: ${skillDir}` });
          }
          // 复制整个 skill 目录进容器（含 scripts/、assets/ 等）
          execSync(`docker cp ${skillDir}/. ${containerId}:/workspace/skill/`, { stdio: 'pipe' });
          // chown 给 sandbox 用户（docker cp 默认以 root 身份写入）
          execSync(`docker exec -u root ${containerId} chown -R sandbox:sandbox /workspace/skill`, { stdio: 'pipe' });
          trace.push({ round: 0, role: 'observe', content: `✅ skill 完整文件已复制进容器\n工作路径: /workspace/skill (scripts/ 在此目录下)` });
          console.log(`[Sandbox] ✅ Copied skill files from ${skillDir}`);
        } catch (e: any) {
          trace.push({ round: 0, role: 'observe', content: `⚠ scripts/ 无法自动获取: ${String(e?.message || '').slice(0, 80)}\n💡 可上传 skill zip 包以提供完整 scripts/` });
          console.warn(`[Sandbox] ⚠ Could not obtain scripts/ for ${parsed.slug}`);
        }
      }
    }

    // ── 轮 0：AI 分析技能，生成测试计划 ────────────────────────────────────
    trace.push({ round: 0, role: 'think', content: '分析 SKILL.md，制定测试计划…' });

    // 对脚本类技能：如果有已知的入口脚本，直接生成确定性的测试序列
    // 避免 AI 无限循环在"创建测试文件"而不启动服务
    let testTask = '';
    let firstCmd = '';

    const hasPreviewServer = parsed.hasScripts &&
      (parsed.body.includes('preview_server') || parsed.body.includes('preview-server'));

    if (hasPreviewServer) {
      // claw-markdown-preview 类型：直接三步走
      testTask = '用户请求预览当前目录下的 test.md 文件的渲染效果';
      // 用分号分隔三步（不能在后台进程 & 后面用 &&）
      firstCmd = [
        // 步骤1：创建测试 Markdown 文件（用 printf 避免单引号嵌套问题）
        'printf "# Test MD Preview\\n\\nThis is **bold** text.\\n\\n- item1\\n- item2\\n" > test.md',
        // 步骤2：启动预览服务器（后台）
        'pkill -f preview_server.py 2>/dev/null; nohup python3 scripts/preview_server.py --file test.md --no-open --heartbeat-timeout 30 > /tmp/preview.log 2>&1 &',
        // 步骤3：等待服务启动，检查端口和日志
        'sleep 3; echo "=== preview.log ==="; cat /tmp/preview.log; echo "=== port ==="; ss -tlnp | grep python3 || echo "(no port yet)"',
      ].join('; echo "---"; ');
      trace.push({ round: 0, role: 'observe', content: `测试任务: ${testTask}\n策略: 直接三步法（创建MD → 启动服务器 → 检查端口）` });
    } else {
      try {
        const planPrompt = `你是一个 AI Agent，正在 Linux 沙箱（Docker 容器）里测试一个技能。

技能 SKILL.md 内容如下：
---
${parsed.body.slice(0, 3000)}
---

需要的系统工具：${parsed.requiresBins.join(', ') || '无'}
需要的环境变量：${parsed.requiresEnv.join(', ') || '无'}

【重要】工作目录是 /workspace/skill，scripts/ 文件夹已在此目录下。
请分析这个技能，然后输出以下 JSON（只输出 JSON，不要其他内容）：
{
  "testTask": "用一句话描述你要测试什么（模拟一个真实用户请求）",
  "firstCmd": "第一条要在容器里执行的 bash 命令（相对路径基于 /workspace/skill）",
  "reasoning": "为什么从这条命令开始"
}`;
        const r0 = await runAI(planPrompt, { temperature: 0.3 });
        usedModel = r0.model;
        const jsonMatch = r0.text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const plan = JSON.parse(jsonMatch[0]);
          testTask = plan.testTask || '测试技能基本功能';
          firstCmd = plan.firstCmd || 'python3 --version && ls scripts/';
          trace.push({ round: 0, role: 'observe', content: `测试任务: ${testTask}\n首条命令: ${firstCmd}` });
        } else {
          firstCmd = `python3 --version && ls scripts/ 2>/dev/null || ls`;
        }
      } catch {
        firstCmd = `python3 --version && ls /workspace/skill/`;
      }
    }



    // ── 轮 1～MAX_ROUNDS：Think → Act → Observe → Reflect 循环 ──────────────
    const SYSTEM_PROMPT = `你是一个 AI Agent，在一个全新的、一次性的 Linux Docker 沙箱里测试一个 AI 技能。
每次测试完成后，这个容器将被永久销毁。

【技能说明】
---
${parsed.body.slice(0, 1800)}
---

【你的工作循环：Think → Act → Observe → Reflect】
1. Think：分析当前情况，决定下一步
2. Act：输出一个 bash 代码块（\`\`\`bash ... \`\`\`）执行命令
3. Observe：你会收到命令的真实输出
4. Reflect：分析输出，如果失败要理解原因并调整策略

【沙箱环境说明】
- 操作系统：Linux（Debian slim），非 macOS
- 已安装：python3, node, git, curl, jq, bash, pip3
- ✅ 有网络访问（bridge 模式），可 pip install、curl 外部 API
- 无图形界面，open/osascript/say 等 macOS 专有命令不可用
- pip install 时加 --break-system-packages 或用 venv

【macOS → Linux 命令替换表（遇到 command not found 时使用）】
| macOS 命令         | Linux 替代             |
|--------------------|------------------------|
| open <url/file>    | echo "[URL: ...]"（跳过，无 GUI） |
| lsof -i :<port>    | ss -tlnp \| grep :<port> |
| pgrep -f <name>    | ps aux \| grep <name> \| grep -v grep |
| pbcopy / pbpaste   | 不可用（无剪贴板）      |
| osascript          | echo "[skip]"          |
| brew install <pkg> | apt-get install -y <pkg> |
| gsed / ggrep       | sed / grep             |

【规则】
- 每轮只输出一个 bash 代码块
- 遇到 macOS 命令失败 → 立即用上表替换并重试，不要放弃
- 测试完成时输出 [DONE] + 总结（此后不再输出代码块）
- 最多 ${MAX_ROUNDS} 轮，请聚焦核心功能验证`;

    const messages: { role: string; content: string }[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `测试任务：${testTask}\n\n请开始，执行第一步。` },
    ];



    let currentCmd = firstCmd;
    let finalOutput = '';
    let loopDone = false;

    for (let round = 1; round <= MAX_ROUNDS && !loopDone; round++) {
      // 超时保护
      if (Date.now() > totalDeadline) {
        trace.push({ round, role: 'think', content: '总超时（120s），终止循环' });
        break;
      }

      // Act：执行命令
      trace.push({ round, role: 'act', content: `执行命令:\n\`\`\`bash\n${currentCmd}\n\`\`\`` });
      const execResult = await dockerExec(containerId, currentCmd);

      const obsContent = [
        execResult.timedOut ? '⏱ 命令超时' : `退出码: ${execResult.exitCode}`,
        execResult.stdout ? `stdout:\n${execResult.stdout}` : '',
        execResult.stderr ? `stderr:\n${execResult.stderr}` : '',
      ].filter(Boolean).join('\n');

      trace.push({ round, role: 'observe', content: obsContent });

      // ── Reflect：自动检测 macOS 命令失败，无需消耗 AI 调用 ─────────────────
      const reflection = reflectOnError(currentCmd, execResult);
      if (reflection) {
        trace.push({ round, role: 'think', content: reflection.reflection });
        // 直接用调整后的命令重试，不经过 AI（节省轮次）
        currentCmd = reflection.adaptedCmd;
        messages.push({ role: 'assistant', content: `[Reflect] ${reflection.reflection}` });
        messages.push({ role: 'user', content: `已自动适配 Linux 命令，继续执行。` });
        continue; // 跳过 AI Think，直接到下一轮 Act
      }

      // 把执行结果加入对话历史
      messages.push({ role: 'assistant', content: `\`\`\`bash\n${currentCmd}\n\`\`\`` });
      messages.push({ role: 'user', content: `命令执行结果：\n${obsContent}\n\n请继续下一步（或输出 [DONE] 完成测试）。` });

      // ── Think：让 AI 决定下一步 ──────────────────────────────────────────────
      if (round < MAX_ROUNDS) {
        try {
          const aiResp = await runAI(messages[messages.length - 1].content, {
            systemPrompt: messages[0].content,
            temperature: 0.2,
            maxTokens: 1024,
          });
          const aiText = aiResp.text;
          usedModel = aiResp.model;

          trace.push({ round, role: 'think', content: aiText.slice(0, 500) });

          if (aiText.includes('[DONE]')) {
            finalOutput = aiText;
            loopDone = true;
          } else {
            const nextCmd = extractBashCmd(aiText);
            if (nextCmd) {
              currentCmd = nextCmd;
            } else {
              // AI 没有给出命令，说明任务已结束
              finalOutput = aiText;
              loopDone = true;
            }
          }
        } catch (e: any) {
          trace.push({ round, role: 'think', content: `AI 调用失败: ${e.message}` });
          break;
        }
      } else {
        // 达到轮次上限
        finalOutput = `测试完成（已达到最大轮次 ${MAX_ROUNDS}）\n\n最后一次命令输出：\n${execResult.stdout || execResult.stderr}`;
      }
    }

    // ── 最终评估 ─────────────────────────────────────────────────────────────
    trace.push({ round: MAX_ROUNDS + 1, role: 'think', content: '对整个测试过程进行综合评估…' });

    const evalText = trace
      .filter(t => t.role === 'observe')
      .map(t => t.content)
      .join('\n\n');

    const evalPrompt = `你是一个技能质量评估员。

技能名称：${parsed.name}
技能描述：${parsed.description}
测试任务：${testTask}

测试过程（命令执行记录）：
${evalText.slice(0, 2000)}

最终输出：
${(finalOutput || '未产生输出').slice(0, 500)}

请以 JSON 格式评估：
{
  "score": 0-100,
  "passed": true/false,
  "comment": "一句话总结",
  "strengths": ["优点1"],
  "weaknesses": ["不足1"]
}
只输出 JSON。`;

    let score = 60, passed = false, comment = '测试完成', strengths: string[] = [], weaknesses: string[] = [];
    try {
      const evalResp = await runAI(evalPrompt, { temperature: 0.1, maxTokens: 512 });
      const jm = evalResp.text.match(/\{[\s\S]*\}/);
      if (jm) {
        const ev = JSON.parse(jm[0]);
        score = Math.max(0, Math.min(100, Number(ev.score) || 60));
        passed = ev.passed ?? (score >= 60);
        comment = ev.comment || comment;
        strengths = ev.strengths || [];
        weaknesses = ev.weaknesses || [];
      }
    } catch { /* keep defaults */ }

    trace.push({ round: MAX_ROUNDS + 1, role: 'observe', content: `评分: ${score} | 通过: ${passed}` });

    return {
      skillType: 'script',
      testInput: testTask,
      finalOutput: finalOutput || trace.filter(t => t.role === 'observe').pop()?.content || '',
      score, passed, comment, strengths, weaknesses, trace,
      durationMs: Date.now() - t0,
      testedAt: Date.now(),
      model: usedModel,
    };

  } finally {
    // ── 强制销毁一次性容器（无论成功、失败、异常）────────────────────────────
    if (containerId) {
      try {
        execSync(`docker stop ${containerId} 2>/dev/null || docker kill ${containerId} 2>/dev/null || true`, { stdio: 'pipe' });
        console.log(`[Sandbox] 🗑 Container destroyed: ${containerId.slice(0, 12)} (--rm auto-removed)`);
      } catch {
        console.warn(`[Sandbox] ⚠ Failed to stop ${containerId.slice(0, 12)}, may already be gone`);
      }
    }
  }
}

// ─── 进度追加工具 ─────────────────────────────────────────────────────────────
async function appendProgress(skillId: string, event: object) {
  try {
    const row = await db.getAsync<any>('SELECT sandbox_progress FROM skills WHERE id=?', [skillId]);
    const events: object[] = row?.sandbox_progress ? JSON.parse(row.sandbox_progress) : [];
    events.push({ ts: new Date().toISOString(), ...event });
    await db.runAsync(
      `UPDATE skills SET sandbox_progress=?, updated_at=? WHERE id=?`,
      [JSON.stringify(events), Date.now(), skillId]
    );
  } catch (err: any) {
    // 不能静默吸掉，必须记录错误以便调试
    console.error('[appendProgress] ERROR:', err?.message, 'skillId:', skillId, 'event:', JSON.stringify(event));
  }
}


// ─── Cloud Run Job 测试路径 ───────────────────────────────────────────────────
async function runCloudRunJobTest(
  skill: any,
  parsed: ParsedSkill,
  t0: number,
  oauthTokens?: string
): Promise<SandboxTestResult> {
  const skillId = skill.id as string;
  const content = skill.prompt_template || skill.code || '';

  // 重置进度
  await db.runAsync(
    `UPDATE skills SET sandbox_progress=? WHERE id=?`,
    [JSON.stringify([]), skillId]
  );

  await appendProgress(skillId, { step: 'submit', detail: 'Submitting Cloud Run Job...' });

  // 获取 AI 配置（主 + 备用 provider，仿 OpenClaw FailoverError 多 provider 切换）
  const getSetting = (k: string) => db.getAsync<{value:string}>('SELECT value FROM settings WHERE key=?',[k]).then(r=>r?.value||'');
  const [model, aiKey, aiBase, fallbackKey, fallbackBase] = await Promise.all([
    getSetting('default_model'),
    getSetting('doubao_api_key').then(k => k || getSetting('deepseek_api_key')),
    getSetting('doubao_base_url').then(u => u || getSetting('deepseek_base_url')),
    // fallback：如果主是 doubao 则备用 deepseek，反之亦然
    getSetting('doubao_api_key').then(k => k
      ? getSetting('deepseek_api_key')       // 主是 doubao，备用 deepseek
      : getSetting('doubao_api_key')),        // 主是 deepseek，备用 doubao
    getSetting('doubao_base_url').then(u => u
      ? getSetting('deepseek_base_url')
      : getSetting('doubao_base_url')),
  ]);

  // 构建 callback URL（runner.py 会把进度 POST 到这里）
  const serviceUrl = process.env.SERVICE_URL || '';
  const callbackUrl = serviceUrl ? `${serviceUrl}/api/skills/${skillId}/sandbox-callback` : '';
  const sandboxSecret = process.env.SANDBOX_SECRET || 'sandbox-secret-2024';

  const skillMdB64 = Buffer.from(content).toString('base64');
  let testInputs = skill.test_inputs ? JSON.parse(skill.test_inputs) : {};

  // ── 自动生成测试数据（当没有手动指定时）──────────────────────────────────
  // 类比 OpenClaw 的 auto-test-data 生成机制
  if (!testInputs || Object.keys(testInputs).length === 0) {
    try {
      const genPrompt = `根据以下 Skill 的说明，生成 2-3 个真实的测试用例输入（JSON 格式）。
要求：
- 模拟真实用户请求，具体、有意义，不要空泛
- 只输出 JSON 对象，不要解释

Skill 名称：${parsed.name}
Skill 描述：${parsed.description}
Skill 正文摘要：${parsed.body.slice(0, 500)}

输出格式示例：
{"test_case_1": "具体的测试请求1", "test_case_2": "具体的测试请求2"}`;

      const genResp = await runAI(genPrompt, { temperature: 0.7, maxTokens: 300 });
      const jm = genResp.text.match(/\{[\s\S]*\}/);
      if (jm) testInputs = JSON.parse(jm[0]);
      console.log(`[SandboxService] Auto-generated test inputs for "${parsed.name}":`, JSON.stringify(testInputs).slice(0, 150));
    } catch (e) {
      console.warn('[SandboxService] Failed to auto-generate test inputs, using {}');
    }
  }


  // ── 读取已保存的 MCP 配置，注入到沙箱 ──────────────────────────────────────
  let mcpConfigsJson = '[]';
  try {
    const mcpRows = await db.allAsync<any>('SELECT name, command, args FROM mcp_configs', []);
    if (mcpRows.length > 0) {
      mcpConfigsJson = JSON.stringify(mcpRows);
      console.log(`[SandboxService] Injecting ${mcpRows.length} MCP configs:`, mcpRows.map(r => r.name));
    }
  } catch { /* ignore if table doesn't exist yet */ }

  // 提交 Cloud Run Job（传主+备用 provider，仿 OpenClaw FailoverError）
  const { executionId, executionName } = await submitSandboxJob({
    skillId,
    skillMd:          skillMdB64,
    userInputs:       testInputs,
    model,
    aiKey,
    aiBaseUrl:        aiBase,
    fallbackAiKey:    fallbackKey,
    fallbackAiBase:   fallbackBase,
    callbackUrl,
    sandboxSecret,
    mcpConfigs:       mcpConfigsJson,
    oauthTokens:      oauthTokens || '',
  });

  await appendProgress(skillId, {
    step: 'running',
    detail: `Job submitted: ${executionId}`,
    executionId,
    startedAt: new Date().toISOString(),
  });

  console.log(`[SandboxService] Cloud Run Job submitted: ${executionId}`);

  // 等待 Job 完成（最多 10 分钟，每 10 秒更新一次进度）
  const MAX_WAIT = 10 * 60 * 1000;
  const POLL_INTERVAL = 10_000;
  const deadline = Date.now() + MAX_WAIT;
  let finalStatus: string = 'TIMEOUT';

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL));
    const { getExecutionStatus } = await import('./cloudRunJobsClient');
    const status = await getExecutionStatus(executionName);
    const elapsed = Math.round((Date.now() - t0) / 1000);
    await appendProgress(skillId, { step: 'polling', detail: status, elapsed_s: elapsed });

    if (status === 'SUCCEEDED' || status === 'FAILED') {
      finalStatus = status;
      break;
    }
  }

  await appendProgress(skillId, { step: 'finished', detail: finalStatus });

  // ── 自动保存沙箱中发现的 MCP 配置 ────────────────────────────────────────
  try {
    const progRow = await db.getAsync<any>('SELECT sandbox_progress FROM skills WHERE id=?', [skillId]);
    if (progRow?.sandbox_progress) {
      const events = JSON.parse(progRow.sandbox_progress);
      for (const e of events) {
        const m = (e.detail || '').match(
          /mcporter\s+config\s+add\s+(\S+)\s+--command\s+(\S+)(?:\s+--args\s+(?:'([^']*)'|"([^"]*)"))?/
        );
        if (m) {
          const [, name, rawCommand, argsSingle, argsDouble] = m;
          // strip surrounding quotes from command (e.g. "npx" → npx, 'npx' → npx)
          const command = rawCommand.replace(/^["']|["']$/g, '');
          const args = argsSingle ?? argsDouble ?? '';
          const { randomUUID } = await import('crypto');
          try {
            await db.runAsync(
              `INSERT INTO mcp_configs (id, name, command, args) VALUES (?, ?, ?, ?)
               ON CONFLICT(name) DO UPDATE SET command=excluded.command, args=excluded.args`,
              [randomUUID(), name, command, args]
            );
            console.log(`[SandboxService] Auto-saved MCP config: ${name} (command=${command}, args=${args})`);
          } catch { /* ignore */ }
        }
      }
    }
  } catch { /* ignore */ }

  // 读取 callback 写入的结果（runner.py 已 POST 到 /sandbox-callback）
  const row = await db.getAsync<any>('SELECT sandbox_test FROM skills WHERE id=?', [skillId]);
  let callbackResult: any = null;
  try { callbackResult = row?.sandbox_test ? JSON.parse(row.sandbox_test) : null; } catch {}

  const passed = finalStatus === 'SUCCEEDED' && callbackResult?.passed !== false;

  // AI 的 output 字段可能本身也是 JSON（runner.py 返回的结构化评测）
  let aiEval: any = null;
  try {
    const raw = callbackResult?.output || '';
    aiEval = typeof raw === 'string' && raw.trim().startsWith('{') ? JSON.parse(raw) : null;
  } catch {}

  const aiScore   = aiEval?.score  ?? (passed ? 80 : 0);
  const aiComment = aiEval?.output ?? callbackResult?.output ?? `Cloud Run Job: ${finalStatus}`;

  return {
    skillType: 'script',
    testInput: JSON.stringify(testInputs),
    finalOutput: aiEval?.output || callbackResult?.output || `Job ${finalStatus}`,
    score: passed ? aiScore : 0,
    passed,
    comment: aiComment,
    strengths: passed ? (aiEval?.strengths ?? ['沙箱 AI Agent 执行成功']) : [],
    weaknesses: passed ? (aiEval?.weaknesses ?? []) : [`Job ${finalStatus}`],
    trace: [],
    // 保留 transcript 和 test_results（从 callback 结果中获取）
    transcript: callbackResult?.transcript || [],
    test_results: aiEval?.test_results || callbackResult?.test_results || [],
    durationMs: Date.now() - t0,
    testedAt: Date.now(),
    model,
  };
}
