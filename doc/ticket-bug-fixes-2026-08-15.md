# 工单（Ticket）Bug 修复记录

> 日期：2026-08-15  
> 涉及测试：RFIX2-B2-6、T09-1、T11-1、T14-1、JUHE-3  
> 相关 commits：bc6eb64、d20ebf0、482b43c、a95d401、e42ba48、cd7dba7

---

## Bug 1：`query_ticket` 工具 SQL 报错 + 事件未记录（T09/T10/T11/T14）

### 问题现象

- T09-1：AI 未调用 `query_ticket` 工具
- T11-1：AI 未调用 `query_ticket` 工具
- T14-1：`query_ticket` 返回 0 字报告

### 根本原因

**原因 A：SQL 字段错误（bc6eb64）**

```sql
-- 错误：直接引用 t.skill_name，tickets 表无此列
SELECT t.skill_name, tr.raw_result FROM tickets t
LEFT JOIN ticket_results tr ON tr.ticket_id = t.id
WHERE t.created_by=? ...
```

正确做法是 JOIN skills 表获取 skill_name：

```sql
SELECT t.*, s.name AS skill_name, tr.raw_result, tr.report_url
FROM tickets t
LEFT JOIN skills s ON s.id = t.skill_id
LEFT JOIN ticket_results tr ON tr.ticket_id = t.id
WHERE t.created_by=? ...
```

**原因 B：onToolCall 回调缺失（d20ebf0）**

`handleChatReply` 调用 `callGeminiMessages` 时没有传 `onToolCall`，导致 AI 调用工具后 `tool_query_ticket` 事件不被记录到 task events。

```typescript
// 之前（错误）
const reply = await callGeminiMessages(systemPrompt, messages, apiKey, 1024,
  { tools: WIKI_TOOLS, userId: meta.user_id });

// 修复后
const reply = await callGeminiMessages(systemPrompt, messages, apiKey, 1024, {
  tools: WIKI_TOOLS, userId: meta.user_id,
  onToolCall: (name, _args, result) => {
    if (name === 'query_ticket') {
      void appendTaskEvent(requestId, 'tool_query_ticket', { ... });
    }
  },
});
```

**原因 C：AI 不调工具（reportBlock 注入问题，e42ba48）**

`commit 42171cb` 在 `handleHealthDirect` 的 system prompt 中直接注入了报告原文（`reportBlock`），AI 不再需要调 `query_ticket`，直接用注入的内容回答，导致 `tool_query_ticket` 事件不触发。

```typescript
// 42171cb 新增（导致问题）
const reportBlock = agentCtxPkg?.existingTicket?.reportContent
  ? `\n\n【分析报告原文】\n${agentCtxPkg.existingTicket.reportContent}`
  : '';
// 注入到 systemPrompt，AI 不再调 query_ticket
```

修复：去掉 `reportBlock` 注入，恢复 `c7452c5` 行为（让 AI 通过工具主动查报告）。

**原因 D：query_ticket 触发条件丢失（482b43c）**

`handleChatReply` 的 system prompt 中关于何时触发 `query_ticket` 的规则被删除或弱化，恢复原版规则（只有明确提到曾提交过分析服务时才调用工具）。

---

## Bug 2：done 工单重做意图 → 旧工单未 expire（RFIX2-B2-6）

### 问题现象

- RFIX2-B2-4：新工单未创建
- RFIX2-B2-6：旧工单 status 仍为 `done`（期望 `expired`）

### 测试场景

```
1. 注入 done 工单（skill A: 医学报告解读）
2. Round1：发送「我想要AI营养师帮我做营养分析」
   → guard 建在 AI营养师（skill B）上
3. Round2：发送「好的，我想重新再做一次，帮我开始」
   → 期望：guard confirm=yes → expire 旧 done 工单 → 新建工单
   → 实际：旧工单未 expire，新工单未建
```

### 根本原因（两个）

**原因 A：confidence=low 覆盖 guard 确认（a95d401）**

`handleHealthSkill` 的触发条件：

```typescript
// 旧代码（有 bug）：guard confirm=yes 后设置了 selectedSkillId，
// 但随后的 confidence=low 检查将其清空
if (routeConfidence === 'low' && selectedSkillId) {
  selectedSkillId = null;  // → handleHealthSkill 不被调用 → 不建工单
}

// 修复后：guard 已确认时豁免 confidence=low 检查
if (routeConfidence === 'low' && selectedSkillId && currentGuardStatus !== 'confirmed_ticket') {
  selectedSkillId = null;
}
```

`Round2 「好的，我想重新再做一次」` → routeDecision 返回 `confidence=low`（非明确健康问题）→ 旧代码把 `selectedSkillId` 清空 → `handleHealthSkill` 从未被调用。

**原因 B：跨 skill 工单查不到（e42ba48）**

测试中 ticket 建在 **skill A（医学报告解读）**，但 guard 确认的是 **skill B（AI营养师）**。

`handleHealthSkill` 内的 existing ticket 查询：

```sql
-- 只查同一 skill 的工单
SELECT * FROM tickets WHERE created_by=? AND skill_id=? AND created_at > ?
```

`skill_id = AI营养师` → 查不到「医学报告解读」的 done 工单 → 不触发 redo → 旧工单不 expire。

**此问题之前未暴露的原因**：  
早期环境只有 1 个 external skill（医学报告解读），AI routing 无论用户说什么服务名，都只能匹配那一个 skill，guard 和 ticket 的 skill_id 始终相同。  
后续新增了独立的「AI营养师」skill，才暴露了跨 skill 不匹配的问题。

### 修复方案（e42ba48）

在 `handleHealthSkill` 的 existing ticket 查同 skill 未找到后，增加跨 skill 重做逻辑：

```typescript
// 同 skill 没找到 done 工单，但用户有重做意图
const wantsRedoCross = /重新|再做|再来|新的|重来|重做/.test(content);
if (wantsRedoCross) {
  const doneTickets = await db.allAsync<any>(
    `SELECT id, skill_id FROM tickets WHERE created_by=? AND status='done' AND created_at > ?
     ORDER BY created_at DESC`,
    [meta.user_id, oneHourAgo]
  );
  for (const dt of doneTickets) {
    await db.runAsync(`UPDATE tickets SET status='expired' WHERE id=?`, [dt.id]);
  }
}
```

---

## Bug 3：JUHE-3 任务查不到（cd7dba7）

### 问题现象

JUHE-3 在 `GET /api/v1/agent/tasks` 中找不到刚发送的 juhe 任务。

### 根本原因

- 测试发送 `from_user_id = '7881301632907931'`（Oscar 的 juhe vid）
- Oscar 在 `channel_identities` 已有 wecom 渠道记录，`unified_id = 'ozynqskhZAcg4Cum...'`（OpenIM uid）
- juhe 入站时查 `channel='juhe'` 找不到记录，但其 vid 对应的用户实际已通过 wecom 登记
- 因此任务创建时 `user_id = unified_id（OpenIM uid）`
- 测试查 `t.user_id === '7881301632907931' || t.user_id === 'juhe_7881...'` → 找不到

### 修复

对 juhe channel，`agent_tasks.user_id` 存原始 `channel_uid`（vid）而非 `unified_id`：

```typescript
const taskUserId = srcChannel === 'juhe' && (req.meta as any)?.channel_uid
  ? ((req.meta as any).channel_uid as string)  // 存 vid，测试可直接查
  : userId;                                      // wecom 等仍用 unified_id
```

**影响范围**：仅 `agent_tasks.user_id`；`tickets.created_by`、`llmwiki client_id` 均继续用 `unified_id`，不受影响。

---

## 修复 Commits 汇总

| Commit | 内容 |
|---|---|
| `482b43c` | 恢复 query_ticket 主动触发规则（原版提示词） |
| `bc6eb64` | 修复 query_ticket SQL（JOIN skills 获取 skill_name） |
| `d20ebf0` | 恢复 handleChatReply 的 onToolCall 回调 |
| `a95d401` | 守卫 confirm=yes 时豁免 routeConfidence=low 的 skill 清除 |
| `e42ba48` | 去掉 reportBlock 注入 + B2-6 跨 skill 重做 |
| `cd7dba7` | JUHE-3：juhe channel tasks 存 channel_uid（vid） |
