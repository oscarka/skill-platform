# Skill Platform Agent — 消息传入接口文档（Inbound API）

**适用对象**: 向 Skill Platform Agent 发送客户消息的上游服务（如 CUA Console、自有消息网关）  
**关联文件**: `server/src/routes/agentRoutes.ts`、`server/src/agentService.ts`

---

## 概述

本文档定义了**上游服务调用 Skill Platform Agent 的请求格式**。

Agent 接收到消息后会：

1. 用 Gemini 3.6 Flash 做轻量路由判断（< 2 秒）
2. **普通聊天**：直接调 AI，结合历史和备注回复（< 10 秒，同步返回）
3. **健康咨询**：加载健康档案，调用专业 Skill，异步处理（1-3 分钟），结果 POST 到 `callback_url`

```
调用方 POST /api/v1/agent/chat
    ↓
Agent 路由判断（Gemini 3.6 Flash）
    ↓ 普通聊天              ↓ 健康咨询
直接 AI 回复              提交健康 Skill
同步返回 AgentResponse    先返回占位 reply
                          异步完成后 POST callback_url
```

---

## 接口地址

| 环境 | Base URL |
|------|----------|
| 本地开发 | `http://localhost:3100` |
| 生产（Cloud Run）| `https://skill-platform-yo5337ccva-de.a.run.app` |

```
POST {Base URL}/api/v1/agent/chat
Content-Type: application/json
```

> **认证**：当前版本无需 Authorization Header，服务部署在内网 Cloud Run 环境中。
> 如需对外暴露，建议在调用方通过 Cloud Run 的 OIDC Token 或自行约定 Header 鉴权。

---

## 请求体结构

```json
{
  "content":        "string（必填）客户当前发来的消息",
  "source":         "string（必填）来源渠道标识",
  "session_id":     "string（必填）会话 ID，用于日志追踪",
  "meta": {
    "from_name":    "string  客户姓名或昵称",
    "user_id":      "string  客户唯一标识",
    "company":      "string  客户公司（可选）"
  },
  "context": {
    "available_apps":    ["string"],
    "current_recipient": "string"
  },
  "history":        "array（可选）近期对话历史",
  "notes":          "string（可选）客户重点备注",
  "health_profile": "string（可选）客户健康档案",
  "skill_id":       "string（可选）强制指定 Skill",
  "callback_url":   "string（可选）异步结果接收地址"
}
```

---

## 字段详解

### `content`（必填）

客户当前发来的消息原文。

```json
"content": "我最近血压有点高，有什么饮食建议吗？"
```

---

### `source`（必填）

消息来源渠道标识，供日志记录和追踪使用。

| 值 | 说明 |
|----|------|
| `wecom` | 企业微信 |
| `wechat` | 个人微信 |
| `webhook` | 自定义 Webhook |
| `system` | 系统触发（定时任务等）|

---

### `session_id`（必填）

会话唯一标识，通常为客户的唯一 ID（企业微信 openid、手机号等）。  
Agent 本身不维护会话存储，`session_id` 仅用于日志和 callback 的对应关系。

```json
"session_id": "wecom_u_12345"
```

---

### `meta`（必填）

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `from_name` | string | ✅ | 客户姓名或昵称，用于 Agent 回复中的称呼 |
| `user_id` | string | ✅ | 客户唯一标识 |
| `company` | string | — | 客户公司，可选 |

---

### `context`（必填）

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `available_apps` | string[] | ✅ | 当前可用的 App 列表（如 `["企业微信"]`），Agent 据此填写 `delivery.app` |
| `current_recipient` | string | — | 当前屏幕正在对话的联系人；如果提供，Agent 可直接复用，无需重新指定 recipient |

---

### `history`（可选）

近期对话历史，由**调用方自行准备并传入**（Agent 不存储历史，每次调用需调用方提供）。

- 格式：`[{"role": "user"|"assistant", "content": "消息内容"}, ...]`
- 建议传入最近 **10-20 条**（太多会影响响应速度）
- 按时间升序排列，最新的消息在数组末尾

```json
"history": [
  {"role": "user",      "content": "我想减肥，有什么建议吗"},
  {"role": "assistant", "content": "建议您控制碳水摄入，每周有氧运动3次以上..."},
  {"role": "user",      "content": "我有高血压，运动时需要注意什么"}
]
```

---

### `notes`（可选）

客户重点备注，格式自由文本，由**调用方自行准备并传入**。

用于帮助 Agent 了解客户特征，在日常闲聊时也会参考备注进行个性化回复。

```json
"notes": "高血压患者（服用氨氯地平），偏好中医调理，不喜欢推销，预算有限，客户是VIP会员"
```

> **建议**：备注尽量精简，控制在 300 字以内，重点突出客户特征、禁忌和沟通偏好。

---

### `health_profile`（可选）

客户健康档案，由**调用方自行准备并传入**。

- 仅在 Agent 判断需要专业健康能力时使用（普通聊天路径不会读取）
- 如果不传，Agent 也可以正常回复，但健康建议将基于对话内容而非完整档案
- 格式自由文本，支持结构化描述

```json
"health_profile": "姓名：张三，年龄：45岁，性别：男\n血压：130/85 mmHg（高血压I期）\nBMI：26.2（超重）\n病史：2型糖尿病（2019年确诊），无手术史\n当前用药：二甲双胍500mg/日，氨氯地平5mg/日\n过敏：无\n运动习惯：每周步行3次，每次30分钟"
```

---

### `skill_id`（可选）

强制指定要使用的 Skill ID（跳过路由判断，直接执行该 Skill）。

- 留空或不传：Agent 自动路由判断（推荐）
- 指定时：如果该 Skill 不存在，Agent 会降级为普通聊天回复

```json
"skill_id": "4b413c5a-6475-410c-8778-7e31def03e2a"
```

---

### `callback_url`（可选，健康咨询场景强烈建议提供）

异步结果的接收地址。健康咨询处理完成后（1-3 分钟），Agent 会 POST 完整 AgentResponse 到此地址。

- 如果不提供：健康咨询将尝试同步等待（可能超时），**不推荐**
- 端点需支持 `POST application/json`，返回任意 2xx 表示接收成功

```json
"callback_url": "https://your-cua-console.example.com/api/agent-callback"
```

Callback body 格式见"异步 Callback 格式"章节。

---

## 同步响应

Agent 在 **3 秒内**同步返回以下格式：

```json
{
  "request_id": "req_abc123",
  "status":     "done | processing",
  "reply":      "Agent 回复内容（普通聊天直接是最终回复；健康咨询是占位语）",
  "delivery": {
    "app":       "企业微信",
    "recipient": "张三",
    "action":    "type_and_send"
  },
  "reasoning":  "Agent 内部决策说明（仅日志用）"
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `request_id` | string | 唯一请求 ID，异步场景用于对应 callback |
| `status` | string | `done`：reply 即最终内容；`processing`：等待 callback |
| `reply` | string | 要发给客户的消息；`processing` 时为占位语（如"正在分析中…"）|
| `delivery` | object | 告知 CUA 用哪个 App、找谁、做什么动作 |
| `reasoning` | string | Agent 的思考过程，仅日志记录，不发给客户 |

---

## 异步 Callback 格式

当 `status: "processing"` 时，Agent 处理完成后会 POST 到 `callback_url`：

```
POST {callback_url}
Content-Type: application/json
X-Agent-Secret: {AGENT_SECRET}

{
  "request_id": "req_abc123",
  "session_id": "wecom_u_12345",
  "status":     "done",
  "reply":      "根据您的血压数据（130/85）及中医调理偏好，建议以下饮食方案：...",
  "delivery": {
    "app":       "企业微信",
    "recipient": "张三",
    "action":    "type_and_send"
  },
  "reasoning":  "健康 Skill 执行完成，已生成个性化饮食方案"
}
```

> 接收方需在 **30 秒内** 返回 2xx，否则 Agent 会重试最多 2 次。

---

## 完整请求示例

### 示例 1：普通聊天（闲聊/非健康）

```json
{
  "content": "张总，最近生意怎么样啊",
  "source": "wecom",
  "session_id": "wecom_u_oscar_001",
  "meta": {
    "from_name": "Oscar",
    "user_id": "wecom_u_oscar_001",
    "company": "XX科技"
  },
  "context": {
    "available_apps": ["企业微信"],
    "current_recipient": "Oscar"
  },
  "history": [
    {"role": "user",      "content": "你们有没有适合中小企业的方案"},
    {"role": "assistant", "content": "有的，我们有专属套餐，您具体是做哪个行业？"}
  ],
  "notes": "科技公司老板，对价格敏感，已有2次意向沟通",
  "callback_url": "https://cua-console.example.com/api/agent-callback"
}
```

**同步返回（< 5 秒）：**

```json
{
  "request_id": "req_001",
  "status": "done",
  "reply": "Oscar 总，最近还不错！上次提到的方案您有没有时间详细看看？",
  "delivery": {
    "app": "企业微信",
    "recipient": "Oscar",
    "action": "type_and_send"
  },
  "reasoning": "普通跟进聊天，参考备注使用商务口吻"
}
```

---

### 示例 2：健康咨询（触发专业 Skill）

```json
{
  "content": "我最近血压有点高，你帮我看看我的饮食方案合不合适",
  "source": "wecom",
  "session_id": "wecom_u_zhangsan_002",
  "meta": {
    "from_name": "张三",
    "user_id": "wecom_u_zhangsan_002"
  },
  "context": {
    "available_apps": ["企业微信"],
    "current_recipient": "张三"
  },
  "history": [
    {"role": "user",      "content": "我有高血压，平时要注意什么"},
    {"role": "assistant", "content": "高血压患者建议低盐低脂饮食，每天盐分摄入不超过5g…"}
  ],
  "notes": "高血压I期，服用氨氯地平，偏好中医，不喜欢西医用语",
  "health_profile": "年龄45，性别男，血压130/85，BMI26.2，2型糖尿病，二甲双胍500mg/日",
  "callback_url": "https://cua-console.example.com/api/agent-callback"
}
```

**同步返回（< 3 秒，占位语）：**

```json
{
  "request_id": "req_002",
  "status": "processing",
  "reply": "好的张三，我马上为您分析健康档案，根据您的实际情况给出饮食建议，稍等约 2 分钟～",
  "delivery": {
    "app": "企业微信",
    "recipient": "张三",
    "action": "type_and_send"
  },
  "reasoning": "健康咨询，已提交分析，等待 Skill 执行完成"
}
```

**约 2 分钟后 Callback（POST 到 callback_url）：**

```json
{
  "request_id": "req_002",
  "session_id": "wecom_u_zhangsan_002",
  "status": "done",
  "reply": "张三您好，根据您的档案分析：血压130/85属于高血压I期，结合中医调养思路，建议以下饮食方案：\n\n【主食】以杂粮为主，糙米、燕麦搭配…\n【蔬菜】多选芹菜、菠菜、黑木耳…",
  "delivery": {
    "app": "企业微信",
    "recipient": "张三",
    "action": "type_and_send"
  },
  "reasoning": "营养师 Skill 执行完成，已生成个性化方案"
}
```

---

## 错误响应

```json
{
  "error":      "错误类型",
  "message":    "具体原因",
  "request_id": "req_abc123"
}
```

| HTTP 状态码 | 错误类型 | 说明 |
|-------------|----------|------|
| `400` | `invalid_request` | 缺少必填字段或格式错误 |
| `401` | `unauthorized` | API Key 缺失或无效 |
| `429` | `rate_limited` | 请求过于频繁 |
| `500` | `agent_error` | Agent 内部处理失败 |
| `503` | `skill_unavailable` | 指定 Skill 不存在或不可用 |

---

## 注意事项

1. **调用方负责准备上下文**：`history`、`notes`、`health_profile` 均由调用方自己存储和查询，传入时 Agent 直接使用，不做持久化
2. **callback_url 建议总是提供**：即使是普通聊天，有备无患（目前普通聊天不会触发 callback，但接口已预留）
3. **history 不要太长**：超过 20 条会增加 AI 处理时间；建议做滑动窗口，保留最近 10-20 条
4. **health_profile 不强制传入**：如果没有健康档案，Agent 会基于对话内容给出一般性建议而非个性化方案

---

## 版本

| 版本 | 说明 |
|------|------|
| **v1.0** | 初始版本，支持 content + session + history + notes + health_profile + callback_url |
