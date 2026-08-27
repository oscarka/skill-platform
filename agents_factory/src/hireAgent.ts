/**
 * agents_factory/src/hireAgent.ts
 *
 * Phase 4 — Meta-Agent 招募 CLI 主入口
 *
 * 使用方式：
 *   # 交互模式（推荐）
 *   npx ts-node src/hireAgent.ts
 *
 *   # 命令行模式（传入意图）
 *   npx ts-node src/hireAgent.ts "招一个私域群运营员工，负责护肤品社群的活跃与复购引导"
 *
 *   # 带额外选项
 *   EXTRA_TABOOS="泄露价格政策,私下收款" npx ts-node src/hireAgent.ts "..."
 *
 * 输出：
 *   - 控制台预览生成的 Spec
 *   - 保存至 agents_factory/drafts/{agentId}.json
 *   - 询问是否提交到平台（POST /api/v1/meta/agents）
 *   - 可选：直接启动 Ralph 评测飞轮
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { generateSpec, MetaAgentSpec, SpecGenResult } from './specGenerator';
import { generateEvalSuite, saveEvalSuite, EvalSuite } from './evalSuiteGenerator';
import { upsertAgentProfile, initEntityWiki } from './apiClient';

// ─── 工具函数 ─────────────────────────────────────────────────────────────────

function bold(s: string) { return `\x1b[1m${s}\x1b[0m`; }
function green(s: string) { return `\x1b[32m${s}\x1b[0m`; }
function yellow(s: string) { return `\x1b[33m${s}\x1b[0m`; }
function cyan(s: string) { return `\x1b[36m${s}\x1b[0m`; }
function red(s: string) { return `\x1b[31m${s}\x1b[0m`; }
function dim(s: string) { return `\x1b[2m${s}\x1b[0m`; }

async function prompt(rl: readline.Interface, question: string): Promise<string> {
  return new Promise(resolve => rl.question(question, resolve));
}

function printSeparator(char = '─', width = 60) {
  console.log(dim(char.repeat(width)));
}

// ─── Spec 预览展示 ────────────────────────────────────────────────────────────

function printSpecPreview(result: SpecGenResult) {
  const { spec, confidence, clarification_needed, generation_notes } = result;

  console.log('\n');
  printSeparator('═');
  console.log(bold(`  📋 候选员工画像预览`));
  printSeparator('═');

  console.log(`\n${bold('【基本信息】')}`);
  console.log(`  岗位名称: ${cyan(spec.name)}`);
  console.log(`  Agent ID: ${dim(spec.id)}`);
  console.log(`  知识领域: ${spec.knowledge_domain}`);
  console.log(`  置信度:   ${confidence >= 0.8 ? green(`${(confidence * 100).toFixed(0)}%`) : yellow(`${(confidence * 100).toFixed(0)}%`)}`);

  console.log(`\n${bold('【核心职责与人设概括】')}`);
  console.log(`  ${spec.role_desc}`);

  if (spec.persona_lore) {
    console.log(`\n${bold('【3D 立体人设生活背景】')}`);
    if (spec.persona_lore.identity_and_background) {
      console.log(`  生活背景: ${spec.persona_lore.identity_and_background}`);
    }
    if (spec.persona_lore.vulnerable_origin_story) {
      console.log(`  踩坑血泪史: ${spec.persona_lore.vulnerable_origin_story}`);
    }
    if (spec.persona_lore.lifestyle_habits?.length) {
      console.log(`  生活锚点: ${spec.persona_lore.lifestyle_habits.join(' | ')}`);
    }
  }

  if (spec.personal_stories?.length) {
    console.log(`\n${bold('【自我举例故事库】')}`);
    spec.personal_stories.forEach((s, idx) => console.log(`  📖 故事${idx + 1}: ${s}`));
  }

  if (spec.small_talk_anchors?.length) {
    console.log(`\n${bold('【日常闲聊唠嗑谈资库】')}`);
    spec.small_talk_anchors.forEach((a, idx) => console.log(`  ☕ 话题${idx + 1}: ${a}`));
  }

  console.log(`\n${bold('【回复风格】')}`);
  console.log(`  ${spec.reply_style}`);

  console.log(`\n${bold('【服务流程】')}`);
  console.log(`  ${spec.service_flow}`);

  console.log(`\n${bold('【零容忍禁忌】')}`);
  spec.taboos.forEach(t => console.log(`  ❌ ${t}`));

  console.log(`\n${bold('【安抚话术】')}`);
  console.log(`  "${spec.reassurance_tpl}"`);

  if (spec.skill_ids.length > 0) {
    console.log(`\n${bold('【关联技能】')}`);
    spec.skill_ids.forEach(id => console.log(`  • ${id}`));
  }

  if (spec.routing_examples.length > 0) {
    console.log(`\n${bold('【路由示例】')}`);
    spec.routing_examples.forEach(ex => {
      console.log(`  用户: "${ex.user_says}"`);
      console.log(`  → ${cyan(ex.route_to)} ${dim('(' + ex.reason + ')')}`);
    });
  }

  console.log(`\n${bold('【交付配置】')}`);
  const dc = spec.delivery_config;
  console.log(`  最大回复长度: ${dc.max_reply_length}字 | Emoji: ${dc.use_emoji ? '✅' : '❌'} | 语气: ${dc.greeting_style} / ${dc.response_tone}`);

  if (generation_notes.length > 0) {
    console.log(`\n${bold('【生成备注】')}`);
    generation_notes.forEach(n => console.log(`  ℹ️  ${n}`));
  }

  if (clarification_needed) {
    console.log(`\n${yellow('⚠️  需要澄清: ' + clarification_needed)}`);
  }

  printSeparator('═');
}

// ─── 保存草稿 ────────────────────────────────────────────────────────────────

function saveDraft(result: SpecGenResult): string {
  const draftsDir = path.join(__dirname, '..', 'drafts');
  fs.mkdirSync(draftsDir, { recursive: true });
  const filePath = path.join(draftsDir, `${result.spec.id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(result, null, 2), 'utf-8');
  return filePath;
}

// ─── 提交到平台 ──────────────────────────────────────────────────────────────

async function submitToPlatform(spec: MetaAgentSpec): Promise<void> {
  console.log('\n正在提交到平台...');
  await upsertAgentProfile({
    id: spec.id,
    name: spec.name,
    role_desc: spec.role_desc,
    reply_style: spec.reply_style,
    service_flow: spec.service_flow,
    taboos: spec.taboos,
    reassurance_tpl: spec.reassurance_tpl,
    skill_ids: spec.skill_ids,
    routing_examples: spec.routing_examples,
    delivery_config: spec.delivery_config,
    knowledge_domain: spec.knowledge_domain,
    intent_prompt: spec.intent_prompt,
  });
  console.log(green(`✅ 候选员工已登记到平台！`));

  // 同时初始化 Wiki 记忆库
  try {
    await initEntityWiki(spec.knowledge_domain, spec.id, {
      name: spec.name,
      id: spec.id,
    });
    console.log(green(`✅ Wiki 记忆库已初始化（${spec.knowledge_domain} Domain）`));
  } catch (err: any) {
    console.warn(yellow(`⚠️  Wiki 初始化失败（不影响主流程）: ${err.message}`));
  }
}

// ─── 主流程 ──────────────────────────────────────────────────────────────────

async function main() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.clear();
  console.log(bold('\n🏢 AI 员工招募系统 — agents_factory Phase 4'));
  console.log(dim('  将自然语言招聘需求转化为结构化 Agent 画像配置\n'));

  let intent = process.argv[2]?.trim() || '';

  // ── 交互模式：获取招聘意图 ────────────────────────────────────────────────
  if (!intent) {
    printSeparator();
    console.log('请描述您想招聘的员工类型（可以口语化描述）：');
    console.log(dim('示例: "招一个私域群运营员工，负责护肤品社群的活跃与复购引导"'));
    printSeparator();
    intent = await prompt(rl, '\n📝 招聘需求: ');
    intent = intent.trim();

    if (!intent) {
      console.log(red('❌ 招聘需求不能为空'));
      rl.close();
      process.exit(1);
    }
  }

  // ── 额外选项 ──────────────────────────────────────────────────────────────
  const extraTaboos = process.env.EXTRA_TABOOS
    ? process.env.EXTRA_TABOOS.split(',').map(t => t.trim()).filter(Boolean)
    : [];

  const extraContext = process.env.EXTRA_CONTEXT || '';

  // ── 生成 Spec ─────────────────────────────────────────────────────────────
  let result: SpecGenResult;
  let evalSuite: EvalSuite | null = null;
  try {
    console.log(dim('\n⏳ 正在生成员工画像...（调用 AI，约 10-20 秒）\n'));
    result = await generateSpec(intent, { extraTaboos, extraContext });
  } catch (err: any) {
    console.error(red(`\n❌ 生成失败: ${err.message}`));
    rl.close();
    process.exit(1);
  }

  // ── 生成测试集 ─────────────────────────────────────────────────────────────
  console.log(dim('\n📋 正在生成专属测试集...\n'));
  try {
    evalSuite = await generateEvalSuite(result.spec);
    const evalPath = saveEvalSuite(evalSuite);
    const fallbackCount = evalSuite.cases.filter(c => c.fallback_used).length;
    console.log(green(`✅ 测试集生成完成: ${evalSuite.cases.length} 道题`));
    Object.entries(evalSuite.coverage_summary).forEach(([cat, count]) => {
      console.log(dim(`   ${cat}: ${count} 题`));
    });
    if (fallbackCount > 0) {
      console.log(yellow(`   ⚠️  ${fallbackCount} 道题使用了兜底生成（routing_examples 不足）`));
    }
    console.log(dim(`   已保存: ${evalPath}`));
  } catch (err: any) {
    console.warn(yellow(`⚠️  测试集生成失败（不影响主流程）: ${err.message}`));
  }

  // ── 展示预览 ──────────────────────────────────────────────────────────────
  printSpecPreview(result);

  // ── 澄清追问（低置信度时）────────────────────────────────────────────────
  if (result.clarification_needed && result.confidence < 0.75) {
    const answer = await prompt(rl, `\n${yellow('❓ ')}${result.clarification_needed}\n   请补充（回车跳过）: `);
    if (answer.trim()) {
      console.log(dim('\n🔄 根据补充信息重新生成...\n'));
      try {
        result = await generateSpec(intent, {
          extraTaboos,
          extraContext: `${extraContext}\n补充信息: ${answer}`.trim(),
        });
        printSpecPreview(result);
      } catch (err: any) {
        console.warn(yellow(`⚠️  重新生成失败，使用原版本: ${err.message}`));
      }
    }
  }

  // ── 保存草稿（含测试集引用）─────────────────────────────────────────────────
  const draftPayload = {
    ...result,
    ...(evalSuite ? { eval_suite_id: evalSuite.suite_id, eval_case_count: evalSuite.cases.length } : {}),
  } as any;
  const draftPath = saveDraft(draftPayload);
  console.log(`\n💾 草稿已保存: ${dim(draftPath)}`);
  if (evalSuite) {
    console.log(`   测试集: ${dim(evalSuite.suite_id)} (${evalSuite.cases.length} 题)`);
  }

  // ── 确认提交 ──────────────────────────────────────────────────────────────
  const submit = await prompt(rl, `\n${bold('是否提交到平台并开始试用期？')} [y/N]: `);

  if (submit.toLowerCase() === 'y' || submit.toLowerCase() === 'yes') {
    try {
      await submitToPlatform(result.spec);

      // 询问是否立即启动 Ralph 飞轮
      const startRalph = await prompt(rl, `\n${bold('是否立即启动 Ralph 评测飞轮？')} [y/N]: `);
      if (startRalph.toLowerCase() === 'y' || startRalph.toLowerCase() === 'yes') {
        console.log(dim('\n🚀 启动 Ralph 评测飞轮...'));
        console.log(dim('   运行命令: npx ts-node src/ralphLoop.ts ' + result.spec.id));
        console.log(dim('\n（Ralph 飞轮将在独立进程中运行，评测日志见 eval_logs/ 目录）\n'));

        // 使用 child_process 启动飞轮，不阻塞当前进程
        const { spawn } = await import('child_process');
        const ralphProcess = spawn('npx', ['ts-node', 'src/ralphLoop.ts', result.spec.id], {
          cwd: path.join(__dirname, '..'),
          stdio: 'inherit',
          detached: false,
          env: { ...process.env },
        });
        ralphProcess.on('exit', (code) => {
          console.log(`\nRalph 飞轮退出，退出码: ${code}`);
        });
      } else {
        console.log(`\n稍后可运行: ${cyan(`npx ts-node src/ralphLoop.ts ${result.spec.id}`)}`);
      }
    } catch (err: any) {
      console.error(red(`\n❌ 提交失败: ${err.message}`));
    }
  } else {
    console.log(`\n草稿已保存，稍后可重新加载并提交：`);
    console.log(cyan(`  cat ${draftPath}`));
    console.log(`稍后手动提交命令：`);
    console.log(cyan(`  AGENT_ID=${result.spec.id} npx ts-node src/ralphLoop.ts ${result.spec.id}`));
  }

  console.log('\n');
  rl.close();
}

main().catch(err => {
  console.error(red(`\n❌ 未预期错误: ${err.message}`));
  process.exit(1);
});
