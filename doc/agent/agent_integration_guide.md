# LLMWiki × Agent 接入指南

> 这份文档给 **Agent 侧开发者** 看。你不需要了解 LLMWiki 内部如何工作。
> 你只需要接入已经写好的模块，然后在正确的时机调用正确的方法。
> 
> LLMWiki 侧完整分析和设计文档见：`llmwiki_implementation_plan.md`

---

## 🌐 生产环境信息

| 项目 | 值 |
|------|----|
| **生产服务地址** | `https://llmwiki-339795034470.asia-northeast1.run.app` |
| **GitHub 仓库** | `https://github.com/oscarka/health-llmwiki` |
| **GCP 项目** | `gen-lang-client-0884226164` |
| **区域** | `asia-northeast1`（东京） |
| **平台** | Google Cloud Run（按需启动，无固定费用） |

> [!WARNING]
> **数据持久化注意**：当前版本数据（客户档案、Wiki 页面）存在容器内文件系统，Cloud Run 重启或新版本部署后**数据会重置**为镜像里的初始状态。生产正式使用前建议挂载 Cloud Storage 或 Firestore 持久化数据。测试和对接阶段可忽略此问题。

---

## 📋 Agent 侧需要提供给 LLMWiki 的信息

在开始接入之前，请告知 LLMWiki 侧以下信息，以便完成联调：

### 1. 用户 ID 格式
LLMWiki 用 `clientId` 标识每个用户，需要和 Agent 侧的 `userId` 一一对应。

**请告知**：
- Agent 侧 userId 的格式是什么？（例如：`user_12345`、UUID、手机号 hash 等）
- 是否有长度或字符限制？

LLMWiki 会直接用这个 ID 创建用户目录，无需额外映射。

---

### 2. 用户注册/创建时机

LLMWiki 需要在用户**首次使用 Agent** 时被通知，以便创建该用户的健康档案。

**请告知 / 请 Agent 侧在以下时机调用**：
```
POST https://llmwiki-339795034470.asia-northeast1.run.app/api/clients
Content-Type: application/json

{
  "id": "可选，不传则自动生成",   ← 如果你们的userId有固定格式，在这里传入
  "name": "用户姓名（必填）",
  "age": 45,                      ← 可选
  "gender": "男/女",              ← 可选
  "phone": "138xxxx",             ← 可选
  "allergies": "青霉素过敏"        ← 可选，建议注册时录入
}
```

> [!IMPORTANT]
> **如果 Agent 侧没有用户注册钩子**，请告知我们，我们可以在 `buildSystemPrompt()` 里加入「不存在则自动创建」的逻辑。

---

### 3. 对话历史存储方式

`ConversationWindow` 模块在内存中维护最近 30 轮对话。

**请告知**：
- Agent 侧是否已有自己的对话历史存储（如数据库/Redis）？
- 如果有，希望 LLMWiki 从你们的存储里读历史，还是让 `ConversationWindow` 独立维护？
- 会话中断恢复时（用户刷新/重连），历史从哪里取？

---

### 4. Skill 完成的信号

Agent 完成一个 Skill 时需要触发 LLMWiki 同步。

**请告知**：
- Agent 侧的 Skill 完成是同步还是异步的？
- Skill 完成后 Agent 是否立刻发起新一轮对话？（决定 `await sync` 的等待是否可接受）
- Skill 名称列表是什么？（便于 LLMWiki 侧日志记录）

---

### 5. 多实例/并发情况

**请告知**：
- Agent 服务是否多实例部署？（如果是，需要考虑 WikiSyncTrigger 的计数器状态问题）
- 同一用户是否可能同时在多个设备上对话？

---

## 一、前提条件

| 项目 | 说明 |
|------|------|
| LLMWiki 服务地址（生产） | `https://llmwiki-339795034470.asia-northeast1.run.app` |
| LLMWiki 服务地址（本地开发） | `http://localhost:5050` |
| 可直接使用的模块 | `scripts/wiki_sync_trigger.cjs`（[GitHub](https://github.com/oscarka/health-llmwiki/blob/main/scripts/wiki_sync_trigger.cjs)） |
| 用户 ID 来源 | 前端传入的 userId，直接作为 LLMWiki 的 clientId 使用 |
| 每个用户的 LLMWiki 客户端 | 首次接入前需确认该用户已在 LLMWiki 创建（`POST /api/clients`） |

---


## 二、直接可用的模块

```javascript
const {
  buildSystemPrompt,   // 从 LLMWiki 拉档案，构建 System Prompt
  ConversationWindow,  // 30 轮滚动对话历史管理器
  WikiSyncTrigger,     // 触发器：控制何时写日志、何时 sync wiki
  getWikiTools         // 生成 get_medical_history / get_medication_plan 工具定义
} = require('./wiki_sync_trigger.cjs'); // 从 GitHub 下载放到你的项目里

// 生产环境（Cloud Run）
process.env.LLMWIKI_BASE = 'https://llmwiki-339795034470.asia-northeast1.run.app';

// 本地开发
// process.env.LLMWIKI_BASE = 'http://localhost:5050';
```

---

## 三、System Prompt 结构（每次对话）

你的 System Prompt 由 **4 个 Block** 拼成，LLMWiki 负责 Block 2 和 Block 3 的内容：

```
┌──────────────────────────────────────────────────────┐
│ [Block 1] 你的固定角色指令                              │  ~500 tokens，你自己写
│           角色定义、行为规范、禁忌语言                    │
├──────────────────────────────────────────────────────┤
│ [Block 2] user_profile.md（用户画像/注意点）            │  ~100-500 tokens
│           沟通偏好、禁忌话题、个人背景                    │  LLMWiki 自动维护
├──────────────────────────────────────────────────────┤
│ [Block 3] index.md（健康档案摘要）                      │  ~300-800 tokens
│           当前主要关注、红线警示、近期时间轴               │  LLMWiki 自动维护
│           + 一行工具提示（按需调用 medical_history 等）    │
├──────────────────────────────────────────────────────┤
│ [Block 4] 最近 30 轮对话历史                            │  ~10000-15000 tokens
│           滚动窗口，你来管理                             │
└──────────────────────────────────────────────────────┘
总计：~12k-18k tokens / 每次请求（对 128k context 占约 14%）
```

---

## 四、接入方式（完整代码）

```javascript
const {
  buildSystemPrompt,
  ConversationWindow,
  WikiSyncTrigger,
  getWikiTools
} = require('/Users/cc/llmwiki/scripts/wiki_sync_trigger.cjs');

class YourHealthAgent {
  constructor(userId) {
    this.userId = userId;

    // 你的固定角色指令
    this.fixedInstruction = `你是一名专业的健康顾问，...（你自己的 prompt）`;

    // LLMWiki 集成组件
    this.systemPrompt = null;
    this.window = new ConversationWindow(30);    // 30 轮滚动窗口
    this.syncTrigger = new WikiSyncTrigger(userId);

    // 注册工具（给 LLM 调用框架）
    this.tools = getWikiTools(userId);
  }

  // ① 每次会话开始时调用 —— 从 LLMWiki 拉最新档案
  async startSession() {
    this.systemPrompt = await buildSystemPrompt(this.userId, this.fixedInstruction);
    // systemPrompt 已包含用户画像 + 健康档案摘要
  }

  // ② 每轮对话
  async chat(userMessage) {
    const messages = [
      { role: 'system', content: this.systemPrompt },
      ...this.window.getHistory(),
      { role: 'user', content: userMessage }
    ];

    // 调用你的 LLM（Gemini Flash 或其他）
    const assistantMessage = await this.callLLM(messages, this.tools);

    // 更新对话窗口
    this.window.addRound(userMessage, assistantMessage);

    // ⚡ 后台异步：存日志 + 检查是否需要触发 sync（不 await，不阻塞回复）
    const tokenEst = this.window.estimateTokens() + this.systemPrompt.length * 0.4;
    this.syncTrigger.onTurnEnd(userMessage, assistantMessage, tokenEst);

    return assistantMessage;
  }

  // ③ Skill 完成时调用（方案 A：await sync，保证下次对话档案最新）
  async completeSkill(skillName) {
    // 这里会等待 sync 完成（几秒），Skill 完成时用户通常有交互缓冲，可以等
    await this.syncTrigger.onSkillComplete(skillName);

    // sync 完成后立刻刷新 System Prompt，下一轮对话生效
    this.systemPrompt = await buildSystemPrompt(this.userId, this.fixedInstruction);
  }
}
```

---

## 五、注册工具（get_medical_history / get_medication_plan）

`getWikiTools(userId)` 返回两个工具的完整定义，按需适配你的 LLM 框架：

```javascript
const tools = getWikiTools(userId);

// tools[0] = get_medical_history
// tools[1] = get_medication_plan
// 每个工具有 name / description / parameters / handler

// 示例：适配 Gemini Function Calling 格式
const geminiTools = tools.map(t => ({
  name: t.name,
  description: t.description,
  parameters: t.parameters
}));

// 当 LLM 决定调用工具时，执行 handler：
const result = await tools.find(t => t.name === toolName).handler();
// handler 无参数，内部自动使用 userId 访问 LLMWiki
```

**两种工具的触发场景：**

| 工具 | 何时 LLM 会调用 |
|------|----------------|
| `get_medical_history` | 用户询问历史病史、化验结果、具体指标（血压史、血糖历史等） |
| `get_medication_plan` | 用户询问用药方案、护理流程、监测目标值（如"目标血压应该是多少"） |

> **注意**：`communication_timeline.md` 不需要暴露工具。它的「监测目标」部分在 `get_medication_plan` 里有重复，原始溯源内容已在30轮对话历史中覆盖。

---

## 六、触发时机（WikiSyncTrigger 行为说明）

你只需要在正确时机调用 `onTurnEnd()` 和 `onSkillComplete()`，触发器内部自动处理一切：

```
触发器内部逻辑（你不需要手动控制）：

每轮对话结束（onTurnEnd 被调用）：
  → 后台静默写入该轮对话原文到 LLMWiki（无 LLM 调用，成本极低）
  → 计数器 +1
  → 如果计数器 >= 30：触发 sync + 计数器清零（后台，不阻塞对话）
  → 如果 token 估算 > 80k：触发安全 sync + 计数器清零（后台）

Skill 完成（onSkillComplete 被调用）：
  → 触发 sync（await，等待完成）
  → 计数器清零
  → 返回后你再调 buildSystemPrompt() 刷新档案
```

**为什么 Skill 完成要 await 而日常不 await？**

Skill 完成后你通常会刷新 System Prompt（`buildSystemPrompt()`），如果不等 sync 结束就刷新，拿回来的还是旧档案。Skill 完成时用户有「技能完成确认」的交互缓冲，等几秒是可以接受的。

---

## 七、多用户并发

每个用户创建独立的 Agent 实例（各自的 `WikiSyncTrigger`、`ConversationWindow`）：

```javascript
// 在你的会话管理层，以 userId 为 key 维护实例
const agentMap = new Map();

function getOrCreateAgent(userId) {
  if (!agentMap.has(userId)) {
    agentMap.set(userId, new YourHealthAgent(userId));
  }
  return agentMap.get(userId);
}
```

不同用户的 sync 操作各自写入 `data/wiki/{userId}/` 目录，路径不同，不会产生冲突。

---

## 八、prefetch（Phase 3，目前不需要实现）

第 1-30 轮：全量注入 `index.md`（当前方案，已实现）

第 31 轮起：可以启用 prefetch 向量检索（Phase 3 内容，暂不实现）

```javascript
// 判断是否应该切换到 prefetch 模式
if (this.window.shouldUsePrefetch()) {
  // Phase 3：向 /context-inject?query=用户这句话 发起请求，拿相关片段
  // 暂时不做，window.shouldUsePrefetch() 留着判断用
}
```

---

## 九、关键注意事项

> [!IMPORTANT]
> **用户首次接入前**，需要确认该用户已在 LLMWiki 创建（前端注册时调用 `POST /api/clients`）。新用户创建时 LLMWiki 会自动生成5个空白 MD 文件（含 `user_profile.md`）。

> [!NOTE]
> **user_profile.md 冷启动**：新用户第一次对话时 `user_profile.md` 是空的（只有注释模板）。用户说过的偏好/禁忌信息在 30 轮或 Skill 完成后才会通过 sync 写入。这期间这些信息在对话历史里，不会丢失。

> [!NOTE]
> **日志写入幂等**：LLMWiki 以 `synced: false` 标记过滤，每条日志只会被 sync Pipeline 处理一次，不会重复提取。

> [!WARNING]
> **不要直接修改 LLMWiki 的 MD 文件**（除非是手动录入初始信息）。AI-generated 内容应该通过 `POST /logs` + `POST /sync` 的 Pipeline 写入，这样才有溯源记录。

---

## 十、LLMWiki API 速查

```
GET  /api/clients/:id/context-inject
     → 返回 { user_profile, health_wiki, token_estimate }
     → 每次会话开始时调用（buildSystemPrompt 内部已调用，你不需要直接用）

GET  /api/clients/:id/wiki
     → 返回所有 MD 页面的完整内容
     → get_medical_history / get_medication_plan 工具内部已调用

POST /api/clients/:id/logs
     → 写入单条原始日志（onTurnEnd 内部已调用，你不需要直接用）

POST /api/clients/:id/logs/batch
     → 批量写入多条日志（未来优化用，当前用单条）

POST /api/clients/:id/sync
     → 触发 3 阶段 Pipeline 更新 Wiki（onTurnEnd/onSkillComplete 内部已调用）

POST /api/clients
     → 创建新用户（你们的前端注册流程里调用）
```

---

*LLMWiki GitHub：https://github.com/oscarka/health-llmwiki*  
*生产服务：https://llmwiki-339795034470.asia-northeast1.run.app*  
*集成模块：https://github.com/oscarka/health-llmwiki/blob/main/scripts/wiki_sync_trigger.cjs*  
*完整设计文档：`llmwiki_implementation_plan.md`*
