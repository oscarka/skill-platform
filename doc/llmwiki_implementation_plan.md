# LLMWiki × Agent 集成实施方案

> 这是执行文档，不是分析文档。告诉你具体要改什么、加什么、怎么接。
> 分析文档见：llmwiki_dual_use_proposal.md

---

## 一、目标架构总览

```
你的Health Agent 每轮对话流程：

┌─────────────────────────────────────────────────────────────────┐
│                       System Prompt                             │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ [Block 1] 固定指令（角色定义、行为规范、禁止语言）          │   │
│  │           ~500 tokens，每次对话不变                       │   │
│  ├──────────────────────────────────────────────────────────┤   │
│  │ [Block 2] user_profile.md（用户画像/注意点）              │   │
│  │           ~500-1000 tokens，全量注入                      │   │
│  │           AI自动维护，由LLMWiki Pipeline写入               │   │
│  ├──────────────────────────────────────────────────────────┤   │
│  │ [Block 3] 健康档案 Wiki MD（attention过滤）                │   │
│  │           ~1500-2000 tokens，高权重内容优先注入            │   │
│  │           = index.md + medical_history.md 的精华          │   │
│  ├──────────────────────────────────────────────────────────┤   │
│  │ [Block 4] 最近30轮对话历史                                 │   │
│  │           ~10000-15000 tokens，滚动窗口                   │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
总计：~12k-18k tokens / 每次请求，对 128k context 占比约 14%

┌──────────────────────────────────────────────────────────────────┐
│                    后台数据流（不阻塞对话）                        │
│                                                                  │
│  每轮对话结束                                                     │
│      → 后台静默 POST /logs（存原文，无LLM调用）                   │
│      → 计数器 +1                                                 │
│                                                                  │
│  触发条件（任一满足就执行sync）：                                   │
│      A. Skill完成 → 立即sync + 计数器清零                         │
│      B. 计数器满30轮 → sync + 计数器清零                          │
│      C. 当次请求估算超80k tokens → 安全sync（边界保护）            │
│                                                                  │
│  sync执行（异步，不等结果）：                                      │
│      POST /sync → Stage1提取 → Stage2评分 → Stage3写MD           │
└──────────────────────────────────────────────────────────────────┘
```

---

## 二、LLMWiki侧：需要新增的内容

> LLMWiki现有的3阶段Pipeline、REST API、日志存储等不需要改动。
> 需要新增的是：**user_profile.md的支持**和**一个专用的读取API**。

### 2.1 新增 user_profile.md 页面类型

**现状**：LLMWiki的4个默认页面是 `index.md`、`medical_history.md`、`medication_plan.md`、`communication_timeline.md`，没有 `user_profile.md`。

**要做的**：在 `server.cjs` 的 `createDefaultWiki()` 中新增第5个页面 `user_profile.md`。

```javascript
// 在 createDefaultWiki() 里新增：
'user_profile.md': `# 用户画像与沟通注意点

## 基本背景
<!-- 年龄段、性别、职业背景等有助于沟通的信息 -->

## 沟通偏好
<!-- 用户惯用语言（普通话/方言/专业术语程度）、偏好简洁还是详细 -->

## 必须注意事项
<!-- 对AI不能说的内容、禁忌话题、特殊敏感点 -->

## 个人属性
<!-- 家庭状况、照护者情况、经济考量等影响建议的背景 -->
`
```

**Stage1的提取类型**需要新增 `user_profile` 类型（或在现有type系统里加 `subtype: "profile_note"`）：

```javascript
// 在Stage1的Prompt里新增提取类型说明：
// type: "user_profile" → 用户画像信息（沟通风格、禁忌、个人属性）
// 与健康事实分开存储，走单独的Pipeline目标页面
```

### 2.2 新增「上下文注入专用API」

**新增接口**：`GET /api/clients/:id/context-inject`

这个接口是专门给Agent调用的，返回格式化好的System Prompt注入内容：

```javascript
// 新增路由：GET /api/clients/:id/context-inject
// 返回格式：
{
  "user_profile": "# 用户画像...\n...",          // user_profile.md 全文
  "health_wiki": "# 客户健康首页...\n...",      // 健康档案各页MD，按优先级拼接
  "token_estimate": {
    "user_profile": 650,
    "health_wiki": 2800,
    "total": 3450
  }
}
```

**health_wiki的注入逻辑**：

Wiki文件本身已是提炼后的结果，不需要二次过滤。具体的注入逻辑在【四》节详述：

- **常规：**只注入 `index.md` ，并备注工具可用
- **按需：**Agent工具调用 `get_medical_history` / `get_medication_plan`
- **长期用户（>30轮）：**prefetch向量检索自动补充

### 2.3 新增「批量日志写入API」（可选优化）

**现状**：`POST /api/clients/:id/logs` 每次只接受一条日志。

**要做的**：新增 `POST /api/clients/:id/logs/batch`，接受日志数组，一次写入多条。这样Agent可以把30轮对话一次性打包写入，减少HTTP请求次数。

```javascript
// 请求体：
{
  "logs": [
    { "type": "wechat", "content": "用户：我最近血压有点高...", "title": "第1轮" },
    { "type": "wechat", "content": "AI：建议您...", "title": "第1轮AI回复" },
    // ...30轮的所有内容
  ]
}
// 响应：{ "success": true, "inserted": 30, "ids": ["log_xxx", ...] }
```

**多用户并发问题**：不必担心。每个用户的 `WikiSyncTrigger` 是独立实例（以userId为key），它们各自维护自己的计数器。并发触发时就是并发的HTTP请求打到同一个server，这是Express本来就支持的。**文件写冲突风险**：两个不同用户同时sync操作的是各自 `data/wiki/{userId}/` 目录，路径不同，系统层面不会冲突。如果同一用户的两个设备同时触发sync，才需要加文件锁（Phase 3优化内容）。

---

## 三、Agent侧：需要实现的集成层

这部分在你的Agent代码里实现（不在LLMWiki项目里）。

### 3.1 System Prompt构建器

**每次对话开始时**调用：

```javascript
async function buildSystemPrompt(userId) {
  // 1. 读取固定指令（本地文件或硬编码）
  const fixedInstruction = loadFixedInstruction();

  // 2. 从LLMWiki读取注入内容
  const response = await fetch(`${LLMWIKI_BASE}/api/clients/${userId}/context-inject`);
  const { user_profile, health_summary } = await response.json();

  // 3. 拼装System Prompt
  return `${fixedInstruction}

---
## 用户画像与沟通注意点
${user_profile}

---
## 用户健康档案摘要（按重要性排序）
${health_summary}
`;
}
```

### 3.2 对话历史管理器（30轮滚动窗口）

```javascript
class ConversationWindow {
  constructor(maxRounds = 30) {
    this.maxRounds = maxRounds;
    this.history = [];  // [{role: "user", content: "..."}, {role: "assistant", content: "..."}]
  }

  addRound(userMsg, assistantMsg) {
    this.history.push({ role: "user", content: userMsg });
    this.history.push({ role: "assistant", content: assistantMsg });

    // 保持30轮（60条消息）上限
    while (this.history.length > this.maxRounds * 2) {
      this.history.splice(0, 2);  // 移除最早的一轮（2条）
    }
  }

  getHistory() {
    return this.history;
  }

  estimateTokens() {
    // 粗估：每个字符约0.4 token（中文）
    const totalChars = this.history.reduce((sum, m) => sum + m.content.length, 0);
    return Math.ceil(totalChars * 0.4);
  }
}
```

### 3.3 同步触发器（核心逻辑）

```javascript
class WikiSyncTrigger {
  constructor(userId, llmwikiBase) {
    this.userId = userId;
    this.llmwikiBase = llmwikiBase;
    this.counter = 0;
    this.COUNTER_LIMIT = 30;
    this.TOKEN_SAFETY_LIMIT = 80000;
    this.pendingBuffer = [];  // 待写入的对话轮次
  }

  // 每轮对话结束后调用
  async onTurnEnd(userMsg, assistantMsg, currentTokenEstimate) {
    // 1. 加入缓冲区
    this.pendingBuffer.push({ user: userMsg, assistant: assistantMsg });
    this.counter++;

    // 2. 后台静默写入日志（不调LLM，成本极低）
    this._backgroundPostLogs(userMsg, assistantMsg);

    // 3. 检查是否需要触发sync
    if (currentTokenEstimate > this.TOKEN_SAFETY_LIMIT) {
      console.log('[WikiSync] Token安全阈值触发');
      await this._triggerSync('token_safety');
    } else if (this.counter >= this.COUNTER_LIMIT) {
      console.log('[WikiSync] 30轮计数器触发');
      await this._triggerSync('counter');
    }
    // 注意：Skill完成触发由外部调用 onSkillComplete()
  }

  // Skill完成时由Agent代码主动调用
  async onSkillComplete(skillName) {
    console.log(`[WikiSync] Skill完成触发: ${skillName}`);
    // 方案A：直接await sync，保证完成后的刷新一定拿到新wiki
    await this._backgroundSync([], 'skill_complete');
    this.counter = 0;  // 清零计数器
  }

  // 后台异步sync（不阻塞对话）
  async _triggerSync(reason) {
    const logsToSync = [...this.pendingBuffer];
    this.pendingBuffer = [];

    // 异步执行，不等待结果
    this._backgroundSync(logsToSync, reason).catch(err => {
      console.error('[WikiSync] 后台sync失败（不影响对话）:', err);
    });
  }

  // 后台写入日志原文（极低成本）
  _backgroundPostLogs(userMsg, assistantMsg) {
    const content = `用户：${userMsg}\nAI：${assistantMsg}`;
    fetch(`${this.llmwikiBase}/api/clients/${this.userId}/logs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'wechat',
        content,
        title: `对话记录 ${new Date().toLocaleString('zh-CN')}`
      })
    }).catch(() => {});  // 静默失败，不影响主流程
  }

  // 后台触发sync Pipeline
  async _backgroundSync(logs, reason) {
    // 1. 批量写入缓冲的日志（如果批量接口存在）
    // 这里简化为单独触发sync，日志已经在 _backgroundPostLogs 里写了
    
    const response = await fetch(
      `${this.llmwikiBase}/api/clients/${this.userId}/sync`,
      { method: 'POST' }
    );
    
    if (!response.ok) {
      throw new Error(`Sync失败: ${response.status}`);
    }
    
    console.log(`[WikiSync] sync完成 (reason: ${reason})`);
    // 下次对话开始时，重新调用 buildSystemPrompt() 即可拿到最新MD
  }
}
```

### 3.4 主对话循环（把所有组件连起来）

```javascript
// 伪代码，展示各组件如何协作
class HealthAgent {
  constructor(userId) {
    this.userId = userId;
    this.window = new ConversationWindow(30);
    this.syncTrigger = new WikiSyncTrigger(userId, LLMWIKI_BASE);
    this.systemPrompt = null;  // 对话开始时加载
  }

  async startSession() {
    // 每次新会话开始时，从LLMWiki拉最新档案
    this.systemPrompt = await buildSystemPrompt(this.userId);
  }

  async chat(userMessage) {
    // 1. 构建请求消息
    const messages = [
      { role: 'system', content: this.systemPrompt },
      ...this.window.getHistory(),
      { role: 'user', content: userMessage }
    ];

    // 2. 调用LLM
    const response = await callLLM(messages);
    const assistantMessage = response.content;

    // 3. 更新对话窗口
    this.window.addRound(userMessage, assistantMessage);

    // 4. 触发后台同步检查（不等待）
    const tokenEst = this.window.estimateTokens() + this.systemPrompt.length * 0.4;
    this.syncTrigger.onTurnEnd(userMessage, assistantMessage, tokenEst);

    return assistantMessage;
  }

  async completeSkill(skillName) {
    // Skill完成：先await sync跳完成，再刷新System Prompt
    // 采用方案A：如果用户在Skill完成后立刻问下一个问题，wiki一定是最新的
    await this.syncTrigger.onSkillComplete(skillName);  // 内部await sync完成
    this.systemPrompt = await buildSystemPrompt(this.userId);  // sync完成后刷新
  }
}
```

---

## 四、Wiki MD结构调整

### 4.1 周全展示：新的5个页面体系与LLMWiki原有能力的关系

**不影响任何现有能力。** LLMWiki的Pipeline对MD文件是开放的——Stage3不管你有几个页面，只要告诉它「这条信息写到哪个文件」即可。也不存在「更深化改造」的必要性，5个页面是在可用范围内最简单的扩展方式。

```
现有LLMWiki的管道（不变）：
    任意原始文本 → POST /logs → POST /sync
        → Stage1：提取结构化事实，带type/subtype/log_id
        → Stage2：本地计算attention_score
        → Stage3：选择目标页面并增量写入

加了5个页面后，Stage3只需知道「用户画像信息 → user_profile.md」，其他不变。
需要改的是：Stage1的Prompt中加一条提取规则。
```

**关于更深化改造**：目前不必要。如果未来想强化，可能的方向是“对单个页面配置专属的attention阈値”，但这是求精而非求完，就目前就不需要。

### 4.2 现有5个页面的职责分工

| 页面 | 内容 | 注入优先级 |
|------|------|-----------|
| `user_profile.md` | 用户画像、沟通注意点（**新增**） | Block 2，全量注入 |
| `index.md` | 当前主要关注、事件时间轴 | Block 3，attention过滤 |
| `medical_history.md` | 生理信号、化验结果、功能变化 | Block 3，attention过滤 |
| `medication_plan.md` | 当前干预措施 | Block 3，attention过滤 |
| `communication_timeline.md` | 监测目标、原始溯源证据 | Block 3，按需注入 |

### 4.2 健康档案的注入方案（更新版）

**你的思路是对的：常规只注入 `index.md`，其他页面按需取。**

先看一下 `index.md` 实际包含什么（以真实案例为例）：

```
index.md 实际内容：
- 红线警示和致命性风险提示 [!IMPORTANT][!WARNING]
- 当前主要关注（驇生理信号、骇影像确诊、功能变化）
- 局面概述和诊断摘要
- 事件时间轴（近期历史节点）
- 客户基本画像

结论： index.md 本身就是整个档案的摘要层，班前就应该看这一页。
       大多数轮对话，光有 index.md 已经足够。
```

#### 常规注入：只用 `index.md`

```javascript
// Block 3 默认只注入 index.mdï¼连同备注一起
const indexContent = wikiPages['index.md'] || '';
const hint = `
---
注：该用户还有以下健康档案可供查阅：
- 历史羅病/化验记录：调用工具 get_medical_history
- 当前用药方案/护理要程：调用工具 get_medication_plan
（注：最近30轮对话记录已在对话历史中，无需重复读取）
`;
return indexContent + hint;
```

#### `communication_timeline.md` 要不要注入？

**它不是多模态原始记录。** 它包含两部分：

```
第1节「监测目标」——有线上价値：
  目标收缩压 130-140 mmHg、SpO2 ≥ 95%、血糖 7.8-10.0 mmol/L
  → 这类「应该控制在什么范围内」的信息，对话时很有用
  → 但它通常会在 medication_plan.md 里重复，不是唯一乪源

第2节「原始溃源证据」——与30轮对话历史重叠：
  各渠道事件摘要（电话、急诊、ICU）
  → 这类「事情是怎么发展的」信息，已经在近期对话历史里，不需要再注入

多模态原始内容（语音、图片、OCR文本）存在哪里？
    → data/logs/{id}.json，欸远保留原文
    → 不在任何 MD 文件里
```

**结论**：`communication_timeline.md` 不需要注入到Block 3。如果用户集中询问监测目标，`get_medication_plan` 工具调用就会包含相关内容。

#### 按需取的工具接口（Agent工具定义）

```javascript
// 需要在Agent里注册以下工具：
tools: [
  {
    name: 'get_medical_history',
    description: '获取用户的详细历史病史、生理信号记录和化验结果',
    parameters: { userId: 'string' },
    handler: async (userId) => {
      const response = await fetch(`${LLMWIKI_BASE}/api/clients/${userId}/wiki`);
      const pages = await response.json();
      return pages['medical_history.md'] || '无记录';
    }
  },
  {
    name: 'get_medication_plan',
    description: '获取用户的当前用药方案、护理要程和监测目标',
    parameters: { userId: 'string' },
    handler: async (userId) => {
      const response = await fetch(`${LLMWIKI_BASE}/api/clients/${userId}/wiki`);
      const pages = await response.json();
      return pages['medication_plan.md'] || '无记录';
    }
  }
]
```

**两种按需取机制共存，适用不同场景**：

| 机制 | 触发方式 | 适合场景 | Phase |
|------|--------|---------|-------|
| **工具调用按需取** | Agent自己判断要不要拿 | 用户明确问化验、用药时、有明确意图 | Phase 2 |
| **prefetch向量检索** | 自动隐式进行 | 用户闲聨、问题模糊时也能掎到相关内容 | Phase 3 |

两者不冲突：工具调用返回完整页面，prefetch返回相关片段，可以并行开启。
```

### 4.3 user_profile.md 的Stage1提取规则

在Stage1的Prompt里需要新增提取规则：

```
当原始对话内容包含以下信息时，提取为 type: "user_profile"：
- 用户的沟通习惯（"请简短回答"、"我喜欢详细解释"）
- 用户的个人背景（"我老公是医生"、"我不懂医学术语"）
- 禁忌内容（"不要提住院"、"家人不知道病情"）
- 个人属性（主要照护者是谁、在哪个城市、医保情况）

这类信息写入 user_profile.md，不写入健康档案页面。
attention_score 统一设为 0.5（不用于过滤，只做记录）。
```

---

## 五、实施优先级与顺序

### Phase 1：最小可用版（优先做）

**目标**：跑通基础流程，用户信息能跨会话保留。

- [ ] **LLMWiki侧**：新增 `GET /api/clients/:id/context-inject` 接口
  - 读取 `user_profile.md`（不存在就返回空字符串）
  - 读取健康档案MD，按attention_score过滤后返回摘要
  - 返回token估算
- [ ] **Agent侧**：实现 `buildSystemPrompt(userId)`
  - 调用上述接口，拼接System Prompt的Block 2 + 3
- [ ] **Agent侧**：实现 `ConversationWindow(30轮)`
  - 替换现有的20轮或全量传入方式
- [ ] **Agent侧**：实现基础 `WikiSyncTrigger`
  - Skill完成时调用 `POST /sync`，计数器清零
  - 30轮时调用 `POST /sync`，计数器清零
  - 每轮后台静默调 `POST /logs`

### Phase 2：结构完善

- [ ] **LLMWiki侧**：`createDefaultWiki()` 新增 `user_profile.md`
- [ ] **LLMWiki侧**：Stage1 Prompt新增 `user_profile` 类型提取规则
- [ ] **LLMWiki侧**：新增 `POST /api/clients/:id/logs/batch` 批量写入
- [ ] **Agent侧**：注册 `get_medical_history` 和 `get_medication_plan` 工具
- [ ] **Agent侧**：改用批量写入，减少HTTP请求

### Phase 3：优化与边界处理

- [ ] **Agent侧**：实现token估算，超80k触发安全sync
- [ ] **LLMWiki侧**：`/context-inject` 接口返回精确token计数（用tiktoken或字符估算）
- [ ] **LLMWiki侧**：Stage3完成后异步回调重建向量索引（方案B）
  - Stage3写入MD完成后 emit事件
  - 后台任务重建对应userId的Wiki blocks索引
  - 不阻塞sync主流程
- [ ] **Agent侧**：用户历史超30轮后启用prefetch，逆取最相关的6个Wiki片段
- [ ] 同一用户两个设备同时sync的文件锁保护

---

## 六、关于prefetch(query)的决策

> 这个章节回答你问的「prefetch那个按需检索好不好用」

**Hermes的prefetch**是：每次用户发消息，去向量数据库里搜最相关的历史片段（约400字/片），取最相关的6片注入当轮Prompt。**动态、按需、精准**。

**你现在的方案（全量注入页面级Wiki）**是：每次全量注入健康档案的主要页面。**静态、固定、简单**。

| | prefetch动态检索 | 当前全量注入 |
|--|--|--|
| 相关性 | 高（每轮不同） | 中（和当前问题未必最相关） |
| 实现复杂度 | 高（需要向量数据库、embedding） | 低（直接读MD文件） |
| 延迟 | +50-100ms（向量搜索） | +10ms（读文件） |
| 依赖 | 需要embedding模型 | 无额外依赖 |
| 适合时机 | 用户历史对话超过30轮 | 历史对话小于30轮 |

**决策：以用户历史对话轮数为切换阈值（你的建议）**

```
第1-30轮：全量注入页面级Wiki（简单可靠，无外部依赖）

第31轮起：用户是长期用户，档案已有一定积累，此时启用prefetch
    → 对用户当前这句话做向量搜索
    → 取Block内已索引的Wiki内容片段中最相关的6片
    → 用动态检索结果替换Block 3的静态全量注入
```

**为什么30轮而不是文件大小？**
- 文件大小和对话轮次没有直接关系（一次上传大文件也能让文件很大）
- 30轮代表用户已经是「长期用户」，这时prefetch的收益（当前问题相关性）才大于它的成本（embedding延迟+复杂度）
- 小于30轮的用户，档案内容本来就少，全量注入足够且更简单

**引入prefetch需要做的事（Phase 3内容）**：
- 选一个本地可运行的embedding模型（如`bge-m3`）
- 用 `sqlite-vec` 或 `chromadb` 建Wiki blocks的向量索引
- 改造 `/context-inject` 接口：接收 `?query=用户当前这句话` 参数，按需返回6个相关片段
- Agent侧：每次调用 `/context-inject` 时把用户消息当作query传入

---


## 七、接口一览（改动总结）

### LLMWiki新增接口

```
GET  /api/clients/:id/context-inject
     → 返回user_profile + 过滤后健康档案 + token估算
     → 供Agent每次对话开始时调用

POST /api/clients/:id/logs/batch
     → 批量写入多条对话记录
     → 供Agent sync时打包写入（可选）
```

### LLMWiki现有接口（不变）

```
POST /api/clients/:id/logs          → 写入单条原始日志
POST /api/clients/:id/sync          → 触发3阶段Pipeline更新Wiki
GET  /api/clients/:id/wiki          → 读取所有Wiki MD全文
PUT  /api/clients/:id/wiki/:pageName → 直接写入某个MD页面
```

### Agent侧新增组件

```
buildSystemPrompt(userId)           → 构建完整System Prompt
ConversationWindow(30)              → 30轮滚动对话历史管理
WikiSyncTrigger                     → 同步触发器，含计数器逻辑
  .onTurnEnd(user, ai, tokenEst)   → 每轮结束调用
  .onSkillComplete(skillName)       → Skill完成时调用（会清零计数器）

工具（Phase 2添加）：
get_medical_history(userId)         → Agent按需调取 medical_history.md
get_medication_plan(userId)         → Agent按需调取 medication_plan.md
```

---

## 八、不需要改动的部分

以下现有能力完全不用动，直接复用：

- `POST /api/clients/:id/logs` — 日志存储接口
- `POST /api/clients/:id/sync` — 3阶段Pipeline（Stage1提取、Stage2评分、Stage3写入）
- `server.cjs` 的 `robustParseJson()`、增量合并逻辑
- `data/logs/{id}.json` 的原始日志存储（永远保留原文）
- attention_score的本地启发式计算（不耗token）
- 溯源引用格式 `[🔗 溯源](log_id)`
- 前端的Bento看板和WikiRenderer（那是独立的查看界面）
