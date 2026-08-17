# 用户 ID 流转全链路文档

> 整理人：2026-08-15  
> 说明：描述从消息入站到 LLMWiki 档案写入，每个系统中用户的 ID 形式及其传递关系。

---

## 一、概览：四个系统的 ID 体系

| 系统 | 原始 ID 名称 | 示例 | 说明 |
|---|---|---|---|
| **企业微信** | `external_userid` | `ozynqskhZAcg4Cum...` | 企微分配的外部联系人 ID，全局唯一，OpenIM 格式 |
| **juhe-api** | `vid`（senderId） | `7881301632907931` | 聚合消息平台分配的访客 ID，数字格式 |
| **skill-platform** | `unified_id` | `ozynqskhZ...` 或 `juhe_7881...` | 统一用户 ID，由渠道 ID 映射而来 |
| **llmwiki** | `client_id` | 与 `unified_id` 相同 | skill-platform 用 `user_id` 直接作为 llmwiki client_id |

---

## 二、各渠道入站 ID 传递链路

### 2.1 企业微信渠道（wecom）

```
企业微信回调 (external_userid = ozynqskhZ...)
    ↓
wechat-archiver / cua_forwarder.js
    from_user_id = externalUserId（企微 external_userid）
    ↓ POST /api/orch/ingest
skill-platform / agentRoutes.ts — resolveIdentity()
    channel='wecom', channel_uid=externalUserId
    → 查 channel_identities WHERE channel='wecom' AND channel_uid=?
    → 已有记录 → 返回已存 unified_id
    → 新用户   → 创建 unified_id = 'wecom_${externalUserId}'
    ↓
agentService.ts
    req.meta.user_id      = unified_id   ← wiki / tickets 均用此 ID
    agent_tasks.user_id   = unified_id
    tickets.created_by    = unified_id
    llmwiki client_id     = unified_id
```

### 2.2 juhe 渠道

```
juhe 平台 (vid = 7881301632907931)
    ↓
juhe-api / forwarder.ts
    from_user_id     = vid
    channel          = 'juhe'
    conversation_id  = 'S:vid' 或 'R:roomid'
    ↓ POST /api/orch/ingest（skill-platform）
skill-platform / agentRoutes.ts — resolveIdentity()
    channel='juhe', channel_uid=vid
    → 查 channel_identities WHERE channel='juhe' AND channel_uid=?
    → 已有记录 → 返回已存 unified_id（若跨渠道关联，可能是企微 OpenIM uid）
    → 新用户   → 创建 unified_id = 'juhe_${vid}'
    ↓
agentService.ts
    req.meta.user_id      = unified_id   ← wiki / tickets 均用此 ID
    req.meta.channel_uid  = vid          ← 原始渠道 ID，存入 meta
    agent_tasks.user_id   = vid          ← ⚠️ 特殊：juhe 存 channel_uid 而非 unified_id
    tickets.created_by    = unified_id
    llmwiki client_id     = unified_id
```

> **⚠️ agent_tasks juhe 特殊处理：**  
> juhe channel 的 `agent_tasks.user_id` 存原始 `vid`，而非 `unified_id`。  
> 原因：`GET /api/v1/agent/tasks` 接口按 `user_id` 查询，juhe-api / 测试侧只知道 `vid`，  
> 若存 `unified_id`（OpenIM 格式）则外部无法匹配到任务。  
> **wiki / tickets 等业务逻辑不受影响，仍用 `unified_id`。**

---

## 三、channel_identities 表（skill-platform DB）

```sql
CREATE TABLE skill_platform.channel_identities (
  unified_id   TEXT,         -- 统一 ID
  channel      TEXT,         -- 'wecom' | 'juhe'
  channel_uid  TEXT,         -- 渠道原始 ID（企微 external_userid 或 juhe vid）
  display_name TEXT,
  conv_id      TEXT,         -- juhe 专用：S:vid 或 R:roomid
  created_at   TIMESTAMPTZ,
  updated_at   TIMESTAMPTZ,
  PRIMARY KEY (channel, channel_uid)
);
```

**跨渠道同一用户关联规则：**
- 同一人先通过 wecom 进入，再通过 juhe 进入 →
  `channel='juhe'` 找不到记录 → 新建 `juhe_${vid}`，与 wecom 的 `unified_id` **独立**
- wiki 档案也因此独立（llmwiki 只认 `client_id = unified_id`）
- 若需合并，需人工在 `channel_identities` 中将两条记录的 `unified_id` 改为同一值

---

## 四、skill-platform 内部 ID 流向总结

```
processAgentChat(req)
│
├─ req.meta.user_id     = unified_id     ← 核心业务 ID
├─ req.meta.channel_uid = vid（仅 juhe）  ← 原始渠道 ID
│
├─ createAgentTask()
│    agent_tasks.user_id = vid（juhe）| unified_id（wecom）
│    agent_tasks.session_id = unified_id
│
├─ handleHealthSkill() → createTicket()
│    tickets.created_by = unified_id
│
├─ backgroundPostLog(userId)
│    userId = unified_id
│    → POST LLMWIKI /api/clients/{unified_id}/logs
│
└─ fetchWikiContext(userId)
     userId = unified_id
     → GET LLMWIKI /api/clients/{unified_id}/context-inject
```

---

## 五、LLMWiki 端（纯 client_id，不感知渠道）

```
llmwiki / server.cjs
    client_id = skill-platform 传入的 user_id（= unified_id）

    /api/clients/{client_id}/logs           → 写对话日志
    /api/clients/{client_id}/wiki           → 读 / 写 wiki 档案页
    /api/clients/{client_id}/sync           → 触发 AI 同步（Doubao）
    /api/clients/{client_id}/context-inject → 读档案注入 Agent 上下文
```

---

## 六、消息回复中的 ID

```
sendReply()
    juhe_conv_id = 'S:vid' 或 'R:roomid'（identity.juhe_conv_id）
    → 优先 juhe: POST JUHE_SEND_URL { conversation_id: juhe_conv_id, content: reply }
    → 失败 fallback: CUA_SEND_URL（企微 CUA 控制台推送）
```

回复时用的是 `conversation_id`（juhe 会话 ID），不是用户 ID。

---

## 七、已知边界 & 注意事项

| 场景 | 行为 | 风险 |
|---|---|---|
| 用户仅通过 wecom 进入 | `unified_id = external_userid`（OpenIM 格式） | 正常 |
| 用户仅通过 juhe 首次进入 | `unified_id = juhe_${vid}` | 正常 |
| 同一人先 wecom 后 juhe | juhe 单独建档案，不自动合并 wiki | wiki 档案割裂 |
| `agent_tasks.user_id`（juhe） | 存 vid，不是 unified_id | 只影响 tasks API 查询，其他业务无影响 |
| juhe 渠道 channel_uid 已存 wecom 记录 | 同 vid 在 wecom 已有 unified_id，juhe 查 `channel='juhe'` 找不到，新建 `juhe_${vid}` | 档案独立 |
