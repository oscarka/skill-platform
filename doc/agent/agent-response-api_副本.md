# CUA Console — Agent Response 接口文档

**适用对象**: 对接 CUA Console 的 Agent 开发者  
**关联文件**: `backend/agent_connector/base.py`、`backend/executor/cua_executor.py`

---

## 概述

这份文档定义了**外部 Agent 返回给 CUA Console 的响应格式**。

CUA Console 的执行层（CuaExecutor）会读取 Agent 的响应，提取其中的：
- **`reply`** — 要发给客户的文字内容
- **`delivery`** — 告诉 CUA "用哪个 App"、"找谁"、"做什么动作"

Agent 不需要了解 Mac 界面怎么操作，只需要按格式返回结构化 JSON，
CUA Console 会自动完成界面操控（打开 App、找联系人、输入、发送）。

```
Agent 返回 AgentResponse
    ↓
CuaExecutor 解析 delivery 字段
    ↓
Gemini 根据 app + recipient + action 操控 Mac 界面
    ↓
消息发出
```

---

## AgentResponse 完整结构

```json
{
  "reply": "string（必填）要发送给客户的消息内容",
  "delivery": {
    "app":       "string（必填）目标应用名称",
    "recipient": "string（必填）接收人名字或关键词",
    "action":    "string（必填）执行动作类型",
    "extra":     "object（可选）扩展参数"
  },
  "reasoning":  "string（可选）Agent 的思考过程，仅用于日志记录",
  "status":     "string（可选）done | processing，默认 done",
  "request_id": "string（可选）异步追踪 ID，status=processing 时必填"
}
```

> **【变更批注 - 新增字段】**
> 新增 `status` 和 `request_id` 两个可选字段，用于支持健康咨询等需要异步处理（1-3分钟）的场景。
> - `status: "done"` — 同原行为，reply 即最终回复，CUA 直接发送
> - `status: "processing"` — reply 为过渡占位语（如"正在为您分析中…"），CUA 先发该占位语；Agent 异步处理完成后通过 callback 将真实回复推回 CUA Console
> - `request_id` — 异步请求唯一追踪 ID，callback 时带回，便于 CUA Console 对应处理

---

## 字段详解

### `reply`（必填）

要发送给客户的**完整消息文本**。

- CUA 会将这段文字**原文**输入到目标 App 的对话框中
- 不要包含任何格式标记（Markdown、HTML 等）
- 不要在 reply 里写"我要发给 XXX"之类的说明，只写给客户看的内容

```json
"reply": "您好！非常抱歉给您带来了糟糕的体验。我们会立即核查服务问题，麻烦您提供订单号，我们会尽快跟进处理。"
```

---

### `delivery.app`（必填）

目标应用名称，告诉 CUA 在哪个 App 里发送消息。

| 值 | 说明 | 备注 |
|----|------|------|
| `企业微信` | 腾讯企业微信（WeCom）| 当前默认值 |
| `WeChat` | 腾讯个人微信 | |
| `current` | 使用当前屏幕最前窗口 | 不需要切换 App |
| `飞书` | 字节飞书（Lark）| |
| `钉钉` | 阿里钉钉 | |

> **当前版本**：`app` 由 `.env` 的 `DOUBAO_DEFAULT_APP` 统一配置，  
> Agent 返回的 `app` 字段已预留，当 Agent 能动态指定时直接生效。

---

### `delivery.recipient`（必填）

接收人名字或搜索关键词，CUA 会在 App 的搜索框输入这个值来定位联系人。

```json
"recipient": "oscar"        // 按名字搜索
"recipient": "张三"          // 中文名
"recipient": "13800138000"   // 手机号（部分 App 支持）
```

**注意**：
- CUA 会在搜索结果里找第一个匹配项，建议使用**能唯一定位的关键词**
- 如果 App 已在该联系人对话框内，可以配合 `app: "current"` 跳过搜索步骤

---

### `delivery.action`（必填）

CUA 需要执行的动作类型。

| 值 | 说明 | 适用场景 |
|----|------|----------|
| `type_and_send` | 在输入框输入 reply 内容并发送（按 Enter）| **最常用**，标准回复 |
| `type_only` | 只输入内容到输入框，不发送 | 需要人工确认后再发 |
| `screenshot_only` | 只截图，不做任何输入 | 查看当前状态 |

> **未来扩展**：计划支持 `click_button`（点击特定按钮）、`forward_message`（转发）等动作。

---

### `delivery.extra`（可选）

扩展参数字典，当前版本未使用，为未来能力预留。

```json
"extra": {
  "delay_seconds": 3,          // 延迟发送（预留）
  "window_hint": "主聊天窗口",  // 窗口定位提示（预留）
  "confirm_before_send": true   // 发送前截图确认（预留）
}
```

---

### `reasoning`（可选）

Agent 的思考过程或决策说明，**不会被发送给客户**，仅用于日志记录和调试。

```json
"reasoning": "客户询价，产品价格未知，回复引导留资"
```

---

## 完整示例

### 示例 1：企业微信客服回复

```json
{
  "reply": "您好，张三！我们有针对中小企业的专属套餐，价格会根据您的功能需求定制。您可以告诉我具体的业务场景，我为您推荐合适方案并报价。",
  "delivery": {
    "app": "企业微信",
    "recipient": "oscar",
    "action": "type_and_send"
  },
  "reasoning": "客户询价，提供引导性回复让客户补充需求信息"
}
```

### 示例 2：微信跟进消息

```json
{
  "reply": "王总您好，上次提到的合作事项，我们团队已经准备好了详细方案，方便今天安排个时间沟通吗？",
  "delivery": {
    "app": "WeChat",
    "recipient": "王五",
    "action": "type_and_send"
  },
  "reasoning": "system_followup 触发，针对代理合作意向客户跟进"
}
```

### 示例 3：只输入不发送（人工审核）

```json
{
  "reply": "感谢您的反馈，我们已将您的问题升级处理，预计 2 小时内给您回复。",
  "delivery": {
    "app": "企业微信",
    "recipient": "李四",
    "action": "type_only"
  },
  "reasoning": "投诉类问题，需要人工确认后发送"
}
```

### 示例 4：当前窗口发送（无需切换）

```json
{
  "reply": "好的，我马上为您处理！",
  "delivery": {
    "app": "current",
    "recipient": "",
    "action": "type_and_send"
  },
  "reasoning": "当前屏幕就是目标对话框，直接发送"
}
```

---

## HTTP Agent 接口约定（自定义 Agent 对接）

当你的 Agent 作为**独立 HTTP 服务**对接时，CUA Console 会通过以下方式调用：

### 请求（CUA Console → Agent）

> **【变更批注 - 字段扩展】**
> 原有字段保持不变；新增 `history`、`notes`、`health_profile`、`skill_id`、`callback_url` 五个字段。
> `callback_url` **强烈建议提供**，用于接收健康咨询类的异步回复（处理时间 1-3 分钟）。

```
POST https://skill-platform-yo5337ccva-de.a.run.app/api/v1/agent/chat
Content-Type: application/json

{
  "content": "来自客户的原始消息内容",
  "source": "wecom",
  "session_id": "abc123",
  "meta": {
    "from_name": "张三",
    "company": "XX科技",
    "user_id": "wecom_u_12345"
  },
  "context": {
    "available_apps": ["企业微信", "WeChat", "飞书"],
    "current_recipient": "oscar"
  },
  "history": [
    {"role": "user",      "content": "上条客户消息"},
    {"role": "assistant", "content": "上次 Agent 回复"}
  ],
  "notes": "高血压患者，偏好中医调理，不喜欢推销",
  "health_profile": "血压130/85，BMI 24.5，2型糖尿病史...",
  "skill_id": "",
  "callback_url": "https://your-cua-console/api/agent-callback"
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `content` | string | ✅ | 客户发来的消息 |
| `source` | string | ✅ | 来源渠道（wecom/wechat/webhook/system）|
| `session_id` | string | ✅ | 会话 ID，用于日志追踪 |
| `meta` | object | ✅ | 来源元数据（发件人、公司等）|
| `context.available_apps` | string[] | ✅ | 当前 Mac 上可用的 App 列表 |
| `context.current_recipient` | string | — | 当前屏幕上正在对话的联系人 |
| `history` | array | — | 近期对话历史（建议最多 20 条），由调用方自行准备传入 |
| `notes` | string | — | 客户重点备注（偏好、禁忌、身份标签等），由调用方准备 |
| `health_profile` | string | — | 客户健康档案，仅健康咨询时带入；不传则 Agent 不读健康数据 |
| `skill_id` | string | — | 强制指定执行某个 Skill（留空则 Agent 自动判断）|
| `callback_url` | string | — | 异步结果接收地址；健康咨询处理完成后 Agent POST 到此 URL |

### 响应（Agent → CUA Console）

**方式 A：流式 SSE（推荐，支持实时输出）**

```
Content-Type: text/event-stream

data: {"type": "thinking", "content": "客户询问价格，分析需求..."}

data: {"type": "text", "content": "您好！我们有"}

data: {"type": "text", "content": "针对中小企业的..."}

data: {"type": "done", "response": {
  "reply": "您好！我们有针对中小企业的专属套餐...",
  "delivery": {
    "app": "企业微信",
    "recipient": "oscar",
    "action": "type_and_send"
  },
  "reasoning": "引导客户补充需求"
}}
```

**方式 B：同步 JSON（简单场景）**

```json
{
  "reply": "您好！我们有针对中小企业的专属套餐...",
  "delivery": {
    "app": "企业微信",
    "recipient": "oscar",
    "action": "type_and_send"
  },
  "reasoning": "引导客户补充需求"
}
```

**方式 C：异步确认（健康咨询场景）【新增】**

> **【变更批注 - 新增方式 C】**
> 健康咨询类请求（如个性化饮食方案、血压指标解读等）需调用专业 Skill，处理时间 1-3 分钟。
> Agent 立即同步返回占位 reply，CUA 先发给用户；处理完成后 Agent 异步 POST 到 `callback_url`，CUA 收到后执行真实发送。

第一步：Agent 立即同步返回（< 3 秒）

```json
{
  "reply": "正在为您分析健康情况，请稍等片刻，我很快回复您～",
  "delivery": {
    "app": "企业微信",
    "recipient": "张三",
    "action": "type_and_send"
  },
  "status": "processing",
  "request_id": "req_abc123",
  "reasoning": "健康咨询，已提交专业分析，1-3分钟后回调"
}
```

第二步：处理完成后 Agent POST 到 `callback_url`

```json
{
  "request_id": "req_abc123",
  "session_id": "abc123",
  "reply": "根据您的血压数据（130/85），结合中医调理偏好，建议...",
  "delivery": {
    "app": "企业微信",
    "recipient": "张三",
    "action": "type_and_send"
  },
  "status": "done",
  "reasoning": "健康 Skill 执行完成"
}
```

> **【CUA Console 侧需配合实现】**
> 需新增一个接收 callback 的 HTTP 端点（如 `POST /api/agent-callback`）。
> 收到 `status: "done"` 后，执行与普通同步响应相同的 CUA 操作（发送消息给用户）。
> 该端点 URL 即为调用 Agent 时传入的 `callback_url` 字段值。

---

## CUA 执行流程（Agent 返回后发生什么）

Agent 返回 `AgentResponse` 后，CuaExecutor 会生成如下提示词交给 Gemini 执行：

```
执行消息发送任务。

目标:
- 应用: {app}
- 接收人: {recipient}
- 发送内容(原文不改):
{reply}

执行步骤:
1. 截图查看当前屏幕
2. 如果{app}已开启 → 直接找"{recipient}"对话框
3. 如果{app}未开启 → 在Dock找{app}图标启动
4. 在搜索框输入"{recipient}"找到联系人，点击对话
5. 点击底部输入框
6. 输入消息内容（完整原文）
7. 按Enter发送
8. 截图确认发送成功
```

Gemini 使用 cua-driver 的 49 个工具（`list_apps`、`type_text`、`press_key` 等）完成界面操作，整个过程约 10~30 秒。

---

## 错误处理

如果 CUA 执行失败，Dispatcher 会返回：

```json
{
  "type": "task_failed",
  "task_id": "abc12345",
  "error": "具体错误原因"
}
```

常见失败原因：

| 错误 | 原因 | 建议 |
|------|------|------|
| `cua-driver 未连接` | Mac mini 的 cua-driver 服务异常 | 检查 `/api/status` 的 `driver_available` |
| `超过最大工具调用轮次` | App 操作步骤过多或 UI 复杂 | 确认 App 已登录、recipient 能被搜到 |
| `找不到联系人` | recipient 关键词无法定位 | 使用更精确的名字或拼音 |

---

## 版本演进计划

| 阶段 | 能力 |
|------|------|
| **当前（v1）** | `reply` + `delivery` 固定结构，recipient/app 由 .env 配置兜底 |
| **v1.5（本次新增）** | 异步支持：`status` + `request_id` + `callback_url`；inbound 新增 history/notes/health_profile |
| **v2（近期）** | Agent 动态指定 recipient、app，CUA 据此操作 |
| **v3（未来）** | Agent 可返回多条 delivery（一次处理多个渠道的回复）|
| **v4（远期）** | Agent 可返回 CUA 工具调用序列（完全控制执行细节）|
