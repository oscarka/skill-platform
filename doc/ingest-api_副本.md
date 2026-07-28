# CUA Console — Ingest API 接口文档

**版本**: v1  
**基础地址**: `https://<your-tunnel>.trycloudflare.com` 或 `http://<tailscale-ip>:8080`  
**后端直连**: `http://<tailscale-ip>:8765`

---

## 概述

Ingest API 是 CUA Console 的**消息输入层**，负责接收来自各渠道的消息，
转发给 Agent（豆包/自定义 Agent）处理，再由 CUA 自动发送回复。

```
外部渠道 → POST /api/ingest → Agent 处理 → CUA 在 Mac 上操作界面 → 消息发出
```

支持任意来源，通过 `source` 字段区分渠道，`meta` 携带来源元数据。

---

## 端点列表

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/ingest` | **主接入端点**，接收任意来源消息 |
| `POST` | `/api/ingest/mock/{case_name}` | 触发预设测试案例 |
| `GET` | `/api/ingest/cases` | 列出所有可用测试案例 |
| `GET` | `/api/status` | 查询服务状态 |

---

## POST /api/ingest

接收外部消息并启动完整处理流程（Agent 回复 → CUA 发送）。

### 请求

**Headers**
```
Content-Type: application/json
```

**Body**

```json
{
  "content":    "string（必填）消息内容",
  "source":     "string（必填）来源标识，见下方来源类型表",
  "session_id": "string（可选）会话ID，默认 default",
  "meta":       "object（可选）来源元数据，见下方字段说明"
}
```

**`source` 来源类型**

| 值 | 说明 |
|----|------|
| `wecom` | 企业微信 |
| `wechat` | 个人微信 |
| `webhook` | 通用外部 Webhook |
| `system` | 系统触发（自动跟进等） |
| `ui` | 控制台手动输入 |

**`meta` 常用字段**（可自由扩展）

| 字段 | 类型 | 说明 |
|------|------|------|
| `from_name` | string | 发件人名称 |
| `company` | string | 发件人所在公司 |
| `channel` | string | 子渠道标识 |
| `user_id` | string | 用户唯一 ID |
| `priority` | string | 优先级 `high/normal/low` |
| `trigger` | string | 触发原因（系统消息用） |

### 请求示例

**企业微信客户咨询**
```bash
curl -X POST https://your-tunnel.trycloudflare.com/api/ingest \
  -H "Content-Type: application/json" \
  -d '{
    "content": "你好，我想了解你们产品的定价",
    "source": "wecom",
    "meta": {
      "from_name": "张三",
      "company": "XX科技",
      "user_id": "wecom_u_12345"
    }
  }'
```

**个人微信**
```bash
curl -X POST https://your-tunnel.trycloudflare.com/api/ingest \
  -H "Content-Type: application/json" \
  -d '{
    "content": "有代理合作政策吗？",
    "source": "wechat",
    "meta": {
      "from_name": "王五",
      "channel": "朋友圈引流"
    }
  }'
```

**系统自动触发**
```bash
curl -X POST https://your-tunnel.trycloudflare.com/api/ingest \
  -H "Content-Type: application/json" \
  -d '{
    "content": "请对客户张三做一个24小时跟进回复",
    "source": "system",
    "meta": {
      "trigger": "auto_followup",
      "user_id": "wecom_u_12345",
      "priority": "high"
    }
  }'
```

---

### 响应

返回 **Server-Sent Events（SSE）** 流，`Content-Type: text/event-stream`。

每条事件格式：
```
data: {json_object}\n\n
```

**事件类型总览**

| `type` | 阶段 | 说明 |
|--------|------|------|
| `task_start` | 开始 | 任务创建，包含 task_id |
| `phase` | 切换 | 阶段变化（thinking / executing）|
| `text` | thinking | Agent 生成回复的文字片段（流式） |
| `agent_reply_ready` | thinking→executing | Agent 回复完成，含完整 reply 和 delivery 指令 |
| `tool_call` | executing | CUA 调用了某个工具 |
| `tool_result` | executing | 工具调用返回结果 |
| `task_done` | 结束 | 任务完成，消息已发送 |
| `task_failed` | 结束 | 任务失败，含 error 原因 |
| `error` | 任意 | 局部错误（不一定终止任务）|
| `stream_end` | 结束 | SSE 流关闭标记 |

**事件详细结构**

```jsonc
// task_start
{ "type": "task_start", "task_id": "abc12345", "source": "wecom", "content": "你好..." }

// phase
{ "type": "phase", "phase": "thinking", "task_id": "abc12345" }

// text（Agent 流式输出片段）
{ "type": "text", "content": "您好！我们有针对", "task_id": "abc12345", "phase": "thinking" }

// agent_reply_ready
{
  "type": "agent_reply_ready",
  "task_id": "abc12345",
  "reply": "您好！我们有针对中小企业的...",
  "delivery": {
    "app": "企业微信",
    "recipient": "oscar",
    "action": "type_and_send"
  }
}

// tool_call（CUA 执行阶段）
{
  "type": "tool_call",
  "name": "type_text",
  "args": { "text": "您好！...", "element_index": 31 },
  "task_id": "abc12345",
  "phase": "executing"
}

// task_done（成功）
{
  "type": "task_done",
  "task_id": "abc12345",
  "reply": "您好！我们有针对中小企业的...",
  "recipient": "oscar"
}

// task_failed（失败）
{ "type": "task_failed", "task_id": "abc12345", "error": "cua-driver 未连接" }
```

---

## POST /api/ingest/mock/{case_name}

触发预设测试案例，无需传 Body。

**可用案例**

| case_name | source | 场景描述 |
|-----------|--------|----------|
| `wecom_price` | wecom | 企业微信客户询价（张三 / XX科技）|
| `wecom_complaint` | wecom | 企业微信客户投诉（李四 / YY贸易）|
| `wechat_inquiry` | wechat | 个人微信代理合作意向（王五）|
| `system_followup` | system | 系统触发客户跟进（高优先级）|

**示例**
```bash
curl -X POST https://your-tunnel.trycloudflare.com/api/ingest/mock/wecom_complaint
```

---

## GET /api/ingest/cases

列出所有可用测试案例。

**响应**
```json
{
  "cases": [
    {
      "name": "wecom_price",
      "source": "wecom",
      "preview": "你好，我想了解一下你们的产品价格...",
      "meta": { "from_name": "张三", "company": "XX科技", "channel": "企业微信" }
    }
  ]
}
```

---

## GET /api/status

查询服务整体状态。

**响应**
```json
{
  "driver_available": true,
  "model": "gemini-3.6-flash",
  "tools_count": 49,
  "history_length": 0,
  "agent_provider": "doubao"
}
```

---

## 多渠道集成示例

### Python — 接收企业微信 Webhook 后转发

```python
import httpx, json

async def handle_wecom_message(payload: dict):
    """企业微信 Webhook → CUA Console"""
    async with httpx.AsyncClient(timeout=120) as client:
        async with client.stream(
            "POST",
            "https://your-tunnel.trycloudflare.com/api/ingest",
            json={
                "content": payload["text"]["content"],
                "source": "wecom",
                "meta": {
                    "from_name": payload["from"]["name"],
                    "user_id": payload["from"]["userId"],
                }
            }
        ) as resp:
            async for line in resp.aiter_lines():
                if not line.startswith("data:"): continue
                event = json.loads(line[5:])
                if event["type"] == "task_done":
                    print(f"✅ 消息已发给 {event['recipient']}: {event['reply'][:30]}")
                elif event["type"] == "task_failed":
                    print(f"❌ 失败: {event['error']}")
```

### curl — 最简单的触发方式

```bash
# 发一条消息并等待完成
curl -X POST https://your-tunnel.trycloudflare.com/api/ingest \
  -H "Content-Type: application/json" \
  -d '{
    "content": "你们服务几点开始？",
    "source": "wechat",
    "meta": {"from_name": "客户B"}
  }'
```

---

## 注意事项

**SSE 超时设置**  
完整流程（Agent + CUA）通常 15~60 秒，HTTP 客户端超时建议设置 120s+。

**并发限制**  
当前使用单锁，同一时间只处理一个任务。
多任务支持需移除 `dispatch_lock` 并确保 CUA 操作不互相干扰。

**CUA 依赖本地屏幕**  
`driver_available: false` 时 Agent 回复仍会生成，但 CUA 交付会失败。  
调用前建议先检查 `/api/status`。

**Delivery 目标目前为固定值**  
`recipient` 和 `app` 由 `.env` 统一配置（`DOUBAO_DEFAULT_RECIPIENT`、`DOUBAO_DEFAULT_APP`）。  
未来 Agent 将在响应中动态指定发送目标。
