# 架构改造计划：路由 × 守卫 × Agent 重构

## 背景

当前系统存在以下问题：
1. `routeMessage`（chat/health分类）和 `routeSkill`（技能匹配）是两次独立AI调用，职责重叠
2. 守卫在 confirm=unclear 时直接发模板回复，绕过了 Agent
3. `skill_suggest` 在路由层直接回复用户（不走 Agent），且不检查已有守卫/工单
4. 路由AI在做决策时不知道当前用户的守卫状态和工单状态
5. 守卫和路由输出合并规则不清晰，优先级未定义

## 目标架构

```
消息到达
  ↓
【代码】预查询：守卫状态 + 工单状态（路由前准备好）
  ↓
【路由AI - 1次调用】判断：需要哪个skill + 置信度
  ↓
【代码】守卫生命周期管理（创建/关闭/路由到已有）
  ↓
【守卫AI - 条件调用】判断：yes/no/unclear（仅有活跃守卫且非new_created时）
  ↓
【代码】建单逻辑（守卫confirm=yes时）
  ↓
【代码】组装 Agent 上下文包（标准化）
  ↓
【Agent AI - 1次调用】生成回复（含 function call）
  ↓
发送用户
```

---

## 改造文件

### 1. `server/src/agentService.ts` — 核心重构

#### 1.1 新增：`routeDecision()` 替代 `routeMessage()` + `routeSkill()`

**删除**：`routeMessage()`, `routeSkill()`

**新增**：`routeDecision(content, history, notes, skills, apiKey)`

输入：用户消息、对话历史、备注、可用skill列表（含id, name, description）

输出（JSON）：
```json
{
  "skill_id": "xxx 或 null",
  "skill_name": "AI营养师 或 null",
  "confidence": "high | low | none",
  "reason": "一句话理由"
}
```

Prompt 设计要点：
- 包含完整skill列表（含描述）
- `confidence=high`：用户明确表达要用这个服务
- `confidence=low`：健康问题但无明确技能意图，直接AI回答
- `confidence=none`：普通聊天，无健康/技能意图

日志事件：`route_decided`（含skill_id, confidence, reason, model, durationMs）

---

#### 1.2 重构：守卫生命周期管理（代码层，不依赖AI）

```
规则1 - 路由后守卫处理：
  routeDecision 输出 confidence=high + skill_id
    → 查DB：该用户是否有该skill的活跃守卫？
      有 → 不新建，标记 guardMode="existing"
      无 → 关闭该用户所有其他skill的活跃守卫（closed_by_new_skill）
           新建守卫，标记 guardMode="new_created"

  routeDecision 输出 confidence=low/none
    → 不新建守卫，guardMode 从已有守卫中获取（若有则="existing"，若无则="none"）

规则2 - 跨skill守卫切换：
  新建守卫时，先 UPDATE 所有该用户的 active 守卫为 closed_by_new_skill

规则3 - 守卫超轮次：
  保留现有 MAX_GUARD_ROUNDS=10 机制
```

日志事件：`guard_lifecycle`（含action: new_created/existing/none/closed_by_new_skill, guardId, skillName）

---

#### 1.3 重构：守卫AI判断

仅在有活跃守卫（guardMode="existing"）时运行，new_created 跳过。

守卫AI输出：
```json
{ "judgment": "yes | no | unclear", "confidence": "high | low" }
```

守卫AI失败兜底：默认 `{ judgment: "unclear", confidence: "low" }`

日志事件：`guard_judgment`（含judgment, confidence, durationMs, raw）

---

#### 1.4 重构：建单逻辑

**触发条件**：守卫AI输出 judgment=yes

执行流程：
1. 代码调用 `createTicketForSkill()`（保留现有逻辑）
2. 守卫状态更新为 closed_confirmed
3. 记录：`guard_ticket_created`事件（含ticketId, ticketUrl, skillName）

日志事件：`guard_ticket_created`，`guard_closed`（含reason: confirmed/declined）

---

#### 1.5 新增：预查询步骤（路由前）

在路由AI调用前，代码一次性查好：

```typescript
interface ContextSnapshot {
  activeGuard: GuardRow | null;     // 该用户活跃守卫
  recentTicket: TicketRow | null;   // 该用户最近工单（7天内，任意skill）
}
```

日志事件：`context_snapshot`（含hasGuard, guardSkill, hasTicket, ticketStatus, ticketSkill）

---

#### 1.6 新增：Agent 上下文包 + directive 生成（代码层）

代码根据所有步骤输出拼装 Agent 上下文，核心是 directive 字段：

```
guardStatus=new_created：
  "用户表达了对「{skillName}」服务的意向，守卫已创建。
   请向用户介绍该服务，并询问是否确认使用。服务描述：{skillDesc}"

guardStatus=confirmed_ticket：
  "用户已确认使用「{skillName}」，工单已建立。
   工单链接：{ticketUrl}
   请告知用户工单已创建，引导填写问卷。直接使用上面的链接，不要自己生成。"

guardStatus=declined：
  "用户明确拒绝了「{skillName}」服务，守卫已关闭。请正常回答用户的问题。"

guardStatus=pending_unclear（守卫等待确认中）：
  "用户对「{skillName}」服务有意向但尚未确认。
   先回答用户的问题，如对话场景合适，自然引导确认是否要使用该服务。"

guardStatus=none + ticket.status=processing/submitted：
  "用户有一个进行中的「{skillName}」工单。
   如用户在询问进度，告知「正在分析，完成后通知您」。"

guardStatus=none + ticket.status=done：
  "用户有一份已完成的「{skillName}」分析报告（报告内容见下方）。
   如用户询问报告细节，结合报告内容回答。"

guardStatus=none + ticket.status=waiting_input：
  "用户有一个未填写的「{skillName}」工单。
   提示用户点击链接完成填写：{h5url}"

guardStatus=none + 无工单：
  （空，Agent 正常回答）
```

日志事件：`agent_context_assembled`（含guardStatus, directive前150字, hasTicket, hasReport）

---

#### 1.7 新增：`handleAgentReply()` 合并 Chat + Health Agent

删除 `handleChatReply()` / `handleHealthDirect()` 的区分。

新的 `handleAgentReply()` 接收 AgentContextPackage，构建单一系统提示，包含：
- 角色定义（来自 profile）
- 用户 wiki 和档案
- directive（来自上下文包）
- 报告内容（若有）
- query_ticket function call 定义

日志事件：`agent_reply`（含model, durationMs, replyLen, usedFunctionCall: bool）

---

#### 1.8 新增：`query_ticket` function call

```json
{
  "name": "query_ticket",
  "description": "查询该用户的工单状态和分析报告。当用户询问进度、结果、咋样了等时使用。",
  "parameters": {
    "type": "object",
    "properties": {
      "skill_name": { "type": "string", "description": "技能名称，不确定时传空字符串" }
    }
  }
}
```

返回内容：status, skill_name, created_at, 报告全文（status=done时）, 报告链接, H5链接（status=waiting_input时）

日志事件：`tool_query_ticket`（含skillName, foundStatus, reportLen）

---

### 2. `server/src/db-postgres.ts` — DB 变更

```sql
ALTER TABLE skill_confirm_guards
  ADD COLUMN IF NOT EXISTS guard_mode TEXT DEFAULT 'existing',
  ADD COLUMN IF NOT EXISTS closed_reason TEXT;
```

---

### 3. `web/src/pages/AgentLogs.tsx` — 新事件渲染

| 事件 | 图标 | 标签 |
|---|---|---|
| `context_snapshot` | 📸 | 上下文快照 |
| `route_decided`（新格式） | 🗺️ | 路由决策 |
| `guard_lifecycle` | 🔄 | 守卫生命周期 |
| `guard_judgment` | 🤔 | 守卫判断 |
| `guard_ticket_created` | 📋 | 守卫建单 |
| `guard_closed` | 🔒 | 守卫关闭 |
| `agent_context_assembled` | 📦 | 上下文组装 |
| `tool_query_ticket` | 🔍 | 工单查询工具 |

---

## 实施顺序

1. DB migration（skill_confirm_guards 加字段）
2. `queryContextSnapshot()` 新增
3. `routeDecision()` 新增（旧 routeMessage/routeSkill 暂不删）
4. `manageGuardLifecycle()` 新增
5. `runGuardJudgment()` 重构（标准化输出）
6. `assembleAgentContext()` + directive 生成
7. `query_ticket` function call 实现
8. `handleAgentReply()` 新增（合并 chat + health）
9. `processAgentChat()` 主流程重写
10. 删除旧函数（routeMessage, routeSkill, handleChatReply, handleHealthDirect, skill_suggest分支）
11. 前端日志新事件渲染
12. TSC 编译验证
13. 部署 + 按测试计划验证

---

## 关键约束

- 每个步骤必须 `appendTaskEvent`，日志可见每个环节
- 守卫AI失败兜底为 unclear（绝不误建单/误关闭）
- 报告内容全量注入（Gemini 100万 token 窗口，无需向量搜索）
- 旧事件名称（skill_guard_check 等）保留，不改前端已有渲染
- 守卫 new_created 时不运行守卫AI判断（用户还没被问，谈不上确认）
