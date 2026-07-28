# OpenClaw Transcript 系统 — 业务说明文档

> 本文档从业务角度解释我们移植的 OpenClaw 核心模块，每个功能配合具体场景示例说明。

---

## 目录

1. [为什么需要这套系统](#1-为什么需要这套系统)
2. [智能截断 — 不是简单砍掉，而是保留关键信息](#2-智能截断)
3. [上下文压缩 — AI 的记忆管理](#3-上下文压缩)
4. [敏感信息脱敏 — 自动保护用户隐私](#4-敏感信息脱敏)
5. [双份 Transcript — 完整版 vs 展示版](#5-双份-transcript)
6. [大文件落盘 — 不让巨型输出拖垮系统](#6-大文件落盘)
7. [Transcript 生命周期管理](#7-transcript-生命周期管理)
8. [完整流程：一次沙箱测试的全生命周期](#8-完整流程)

---

## 1. 为什么需要这套系统

### 问题背景

我们的沙箱测试流程是这样的：AI 拿到一个 Skill 定义，通过多轮工具调用来验证它是否能正常工作。一次完整的测试通常包含 6~12 轮对话，每轮可能调用 `curl`、`read_file`、`run_script` 等工具。

**没有这套系统前会遇到什么问题？**

**场景 1：AI 被自己的输出撑爆**

> 用户创建了一个"股票查询 Skill"。AI 在第 3 轮调用 `curl` 请求了一个股票 API，返回了 200KB 的 JSON 数据。到第 6 轮时，AI 需要记住之前所有对话内容，但 200KB 的 JSON 已经占满了 context window 的一半。AI 开始忘记最初的测试目标，输出质量严重下降。

**场景 2：敏感信息泄露到日志**

> Skill 定义里包含了一个第三方 API Key `sk-abc123xyz`。AI 在测试过程中多次引用这个 key，全部被记录到 transcript 里。运营人员查看测试日志时，能看到用户的完整 API Key。

**场景 3：测试结果回传超时**

> AI 完成了 10 轮测试，生成了一份完整的 transcript（包含大量工具输出），总计 500KB。通过 callback 回传给服务端时，请求体太大，导致超时失败。前端显示"测试完成"但看不到任何详细结果。

**场景 4：出了问题无法回溯**

> 一个 Skill 测试结果显示"失败"，但只有最终的 JSON 评分。运营人员想知道"到底哪一步出了问题"，却没有完整的过程记录可查。

**OpenClaw 的解决方案**就是针对这四个问题设计的一整套系统：智能截断、脱敏、双份 transcript、大文件落盘。

## 2. 智能截断

### 核心理念：不是砍掉，而是保留关键信息

普通截断就是"取前 N 个字符"，但这会丢失关键信息。OpenClaw 的做法是**同时保留头部和尾部**，因为：

- **头部**通常包含命令输出的开头、列标题、数据结构定义
- **尾部**通常包含错误信息、总结、JSON 的闭合括号、退出码

### 示例：curl 调用返回 50KB 的 JSON

**原始输出**（50KB）：
```
{"status": "ok", "data": [{"id": 1, "name": "Apple", "price": 150.23, ...},
{"id": 2, "name": "Google", "price": 2800.50, ...},
... 中间有 500 条记录 ...
{"id": 500, "name": "Tesla", "price": 890.12, ...}],
"total": 500, "has_more": false, "error": null}
```

**普通截断**（前 2000 字符）：
```
{"status": "ok", "data": [{"id": 1, "name": "Apple", "price": 150.23, ...},
{"id": 2, "name": "Google", "price": 2800.50, ...},
... 截到第 15 条就断了 ...
{"id": 15, "name": "Adobe", "price"
```
→ AI 看不到 `"total": 500` 和 `"error": null`，不知道请求是否成功

**我们的智能截断**（头 70% + 尾 30%）：
```
{"status": "ok", "data": [{"id": 1, "name": "Apple", "price": 150.23, ...},
{"id": 2, "name": "Google", "price": 2800.50, ...},
... 前 10 条 ...

[... 48000 chars truncated; rerun with narrower args if needed]

{"id": 499, "name": "Nvidia", "price": 450.00, ...},
{"id": 500, "name": "Tesla", "price": 890.12, ...}],
"total": 500, "has_more": false, "error": null}
```
→ AI 能看到 API 返回成功、共 500 条、没有后续页，可以正确评判 Skill 功能

### 尾部重要性检测

系统会自动检测尾部是否包含关键信息，决定保留多少。以下内容被视为"重要尾部"：

| 尾部包含 | 为什么重要 | 示例 |
|----------|-----------|------|
| 错误信息 | AI 需要知道工具是否出错 | `Error: Connection refused` |
| JSON 闭合 | 不保留就破坏数据结构 | `}, "total": 100}` |
| 退出码 | 判断命令是否成功 | `exit code: 1` |
| 总结/结论 | 包含最终结果 | `总计: 成功 5 / 失败 2` |

### 三档预算：根据 AI 的记忆大小自动调节

| AI 模型 Context | 单条工具输出上限 | 全部工具输出总预算 |
|-----------------|-----------------|------------------|
| ≤ 32K tokens | 16,000 字符 | 48,000 字符 |
| 32K~64K | 32,000 字符 | 96,000 字符 |
| > 64K | 64,000 字符 | 192,000 字符 |

### 聚合预算管理

除了单条截断，还有全局预算。想象 AI 在一次测试中调用了 8 次 curl，每次返回 20KB：

- 总量 = 160KB，远超 192KB 总预算 → 不超，不截断
- 但如果每次返回 40KB → 总量 320KB → 超了！
- 系统会**从最旧的开始截断**，优先保留最新的工具输出
- **最近一轮的工具结果受保护**，绝不会被聚合截断删掉

## 3. 上下文压缩

### 核心理念：AI 的记忆有限，要帮它管理

AI 的 context window 就像一个固定大小的白板。每次工具调用的输入输出都会写在上面。当白板快满的时候，要么 AI 开始"忘东西"（输出质量下降），要么直接报错（context overflow）。

上下文压缩就是在**每一轮 AI 调用之前**检查白板还剩多少空间，必要时擦掉旧内容。

### 三阶段策略

```
    白板使用率
    ├── < 60% ────→ 什么都不做，空间充足
    ├── 60%~85% ──→ 🟡 Soft Trim：把旧的工具输出缩短
    ├── 85%~90% ──→ 🟠 Hard Clear：把旧的工具输出完全替换为占位符
    └── > 90% ────→ 🔴 Recovery 模式：预算减半，激进截断
```

### 示例：一次 10 轮测试的压缩过程

| 轮次 | 白板使用率 | 系统动作 | 说明 |
|------|-----------|---------|------|
| 1 | 15% | ✅ 无 | system prompt + 第一轮工具调用 |
| 2 | 25% | ✅ 无 | — |
| 3 | 40% | ✅ 无 | curl 返回了 30KB JSON |
| 4 | 55% | ✅ 无 | 还在安全区 |
| 5 | **65%** | 🟡 Soft Trim | 第 1~2 轮的 curl 输出被缩短到 4KB |
| 6 | 58% | ✅ 无 | trim 后空间回来了 |
| 7 | 72% | 🟡 Soft Trim | 第 3 轮的 curl 输出也被缩短 |
| 8 | **88%** | 🟠 Hard Clear | 第 1~4 轮的工具输出全部替换为一行占位符 |
| 9 | 52% | ✅ 无 | 大量空间释放 |
| 10 | 60% | ✅ 无 | AI 输出最终评测结果 |

### 保护规则

系统不会无差别地删除旧内容，有三条保护规则：

**规则 1：保护 system prompt**
> 第一条消息（system prompt）永远不会被动，它包含了 AI 的角色定义和测试指令。

**规则 2：保护最近 3 轮的 assistant 回复及其工具结果**
> AI 最近做了什么、工具返回了什么，这些是当前推理的基础，不能删。

**规则 3：Bootstrap 保护**
> 第一条 user 消息之前的所有内容（比如 identity 设定、Skill 描述注入）不会被裁剪，因为这些是 AI 理解任务的基础。

### Recovery 模式

当压力超过 90% 时（通常是遇到了异常大的工具输出），系统进入紧急恢复模式：

- 截断预算减半（64KB → 32KB）
- 最小保留字符数降为 0（可以完全清空）
- 前端会收到压力告警通知

## 4. 敏感信息脱敏

### 核心理念：Transcript 是要给人看的，不能泄露用户的秘密

Transcript 会被存到 GCS、显示在管理后台、可能被运维人员查看。如果里面包含用户的 API Key、密码、Token，就是安全事故。

### 四层脱敏管线

脱敏不是一个正则就能搞定的，OpenClaw 用了**四层策略**逐层过滤：

**第 1 层：正则匹配 — 抓已知格式的敏感信息**

| 被检测的格式 | 示例 | 脱敏后 |
|------------|------|-------|
| API Key | `sk-abc123xyz789def456` | `***REDACTED***` |
| Bearer Token | `Bearer eyJhbGciOiJIUz...` | `Bearer ***REDACTED***` |
| JWT | `eyJhbGciOiJIUzI1NiIs...` | `***REDACTED***` |
| 密码参数 | `password=MyS3cret!` | `password=***REDACTED***` |
| 环境变量引用 | `AI_API_KEY=sk-xxx` | `AI_API_KEY=***REDACTED***` |

**第 2 层：字段名检测 — 根据 key 名判断**

> AI 调用了一个 Skill，返回了这样的 JSON：
> ```
> {"user": "张三", "api_key": "sk-live-12345", "balance": 100}
> ```
> 第 1 层正则可能匹配到 `sk-live-12345`。但如果 key 格式变了呢？
> ```
> {"user": "张三", "api_key": "my_custom_key_format", "balance": 100}
> ```
> 第 2 层看到字段名是 `api_key`，不管值的格式如何，直接脱敏：
> ```
> {"user": "张三", "api_key": "my_c***REDACTED***", "balance": 100}
> ```
> 注意保留了前 4 个字符 `my_c`，方便调试时识别这是哪个 key。

**第 3 层：Base64 图片数据**

> 有些 Skill 输出包含 Base64 编码的图片，一张图可能有几百 KB 的纯文本。
> ```
> data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAA... (300KB)
> ```
> 脱敏后：
> ```
> data:image/[redacted];base64,[307200 chars of base64 data]
> ```
> 既保护了数据，也保留了"这里有一张 PNG 图片"的信息。

**第 4 层：URL 凭证**

> 有些 Skill 配置了带凭证的数据库 URL：
> ```
> postgresql://admin:P@ssw0rd123@db.example.com:5432/mydb
> ```
> 脱敏后：
> ```
> postgresql://admin:***@db.example.com:5432/mydb
> ```

### 可配置的自定义模式

如果某个 Skill 有特殊的敏感格式（比如内部工号、患者 ID），可以通过 `RedactConfig` 添加自定义正则：

> 示例：一个医疗 Skill 返回了患者信息 `PatientID: P-2024-001234`
> 配置自定义 pattern `P-\d{4}-\d{6}` 后，所有匹配的内容都会被替换为 `***CUSTOM_REDACTED***`

## 5. 双份 Transcript

### 核心理念：给不同的人看不同的版本

一份 transcript 没法同时满足"前端快速展示"和"出问题时深度排查"两个需求。所以系统同时维护两份：

### 两份文件对比

| | 截断版 `transcript.json` | 完整版 `transcript_full.jsonl` |
|---|---|---|
| **用途** | 前端展示、callback 回传 | 故障排查、审计 |
| **大小** | 通常 < 50KB | 可能 > 1MB |
| **工具输出** | 截断到 4KB 以内 | 完整保留 |
| **存储** | 通过 callback POST 到服务端 → SQLite | 上传到 GCS bucket |
| **格式** | JSON 数组 | JSONL（每行一个 JSON） |
| **访问方式** | 前端直接读取 | 点击"📂 查看完整版"按钮 |

### 示例：同一个工具调用在两份文件里的区别

**截断版**（前端看到的）：
```
🔧 curl  14:23:05  ✂️ 已截断 (原 48.2KB)
输入：curl -s https://api.example.com/stocks
输出（截断版）：
{"status": "ok", "data": [{"id": 1, ...}, {"id": 2, ...}
[... 45000 chars truncated; rerun with narrower args if needed]
"total": 500, "has_more": false}
```

**完整版**（GCS 里的）：
```
🔧 curl  14:23:05
输入：curl -s https://api.example.com/stocks
输出：
{"status": "ok", "data": [{"id": 1, "name": "Apple", "price": 150.23, ...},
{"id": 2, "name": "Google", "price": 2800.50, ...},
... 完整的 500 条记录 ...
"total": 500, "has_more": false}
```

### 为什么用 JSONL 而不是 JSON？

完整版用 JSONL（每行一个独立 JSON）有两个好处：

1. **流式追加**：每完成一轮就追加一行，不用读取→修改→重写整个文件
2. **故障安全**：即使中途崩溃，已写入的行仍然有效，不会像 JSON 那样因为缺少闭合括号而整个损坏

## 6. 大文件落盘

### 核心理念：超大输出不存进 transcript，单独保存

有些工具输出实在太大（比如读取一整个源文件、下载一个大 JSON），即使截断后放进 transcript 也很浪费空间。OpenClaw 的做法是**把原始内容写到独立文件**，transcript 里只留一个指针。

### 触发条件

当单条工具输出超过 **50KB（SPILL_THRESHOLD）** 时自动触发。

### 示例：read_file 读取了一个 200KB 的配置文件

**没有落盘时**（transcript 里直接存 200KB）：

```
transcript_full.jsonl:  ████████████████████████ 250KB
                        ↑ 这一条就占了 200KB
```

**有落盘时**：

```
transcript_full.jsonl:  ████ 15KB
                        ↑ 只存了指针

spill/spill-a1b2c3d4.log:  ████████████████████████ 200KB
                           ↑ 原始内容在这里
```

### 前端怎么显示？

在 transcript viewer 里，落盘的条目会显示一个蓝色标记：

```
🔧 read_file  14:25:12  💾 大文件已落盘
输入：/app/config/full-schema.json
输出（截断版）：
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "definitions": {
    "User": {"type": "object", ...},
...
[... 195000 chars truncated; full output saved to spill file]
...
  }
}
```

用户如果需要看完整内容，可以通过 GCS 上传后的路径访问原始文件。

### 与截断的关系

落盘和截断是**互补的**，不是替代的：

```
原始 200KB 输出
    ├── 落盘 → spill/spill-xxx.log (200KB 完整保留)
    ├── 完整版 transcript → 截断到 64KB (头+尾保留)
    └── 展示版 transcript → 截断到 4KB (更短的摘要)
```

## 7. Transcript 生命周期管理

### 核心理念：Transcript 不是写完就不管了

随着测试越来越多，transcript 文件会积累。系统提供了三种后处理机制：

### 7.1 重写（Rewrite）

**场景**：一次测试已经完成，但 transcript_full.jsonl 太大（比如 2MB），想在不丢失结构的前提下缩小它。

**做法**：对已有条目原地重写——把旧的 tool output 缩短到 2KB，AI 回复缩短到 4KB。

**示例**：

| | 重写前 | 重写后 |
|---|---|---|
| 条目总数 | 45 条 | 45 条（不变） |
| 文件大小 | 2.1MB | 180KB |
| 第 3 轮 curl 输出 | 200KB 完整 JSON | 2KB 头+尾 |
| 第 7 轮 AI 回复 | 8KB 详细分析 | 4KB + `...[rewritten]` |

### 7.2 压缩（Compaction）

**场景**：一次超长测试产生了 100+ 条 transcript 条目，查看时信息量太大。

**做法**：保留最新的 50 条，把之前的所有条目合并成一条压缩摘要。

**示例**：

原始 transcript（120 条）：
```
[header] 测试开始
[msg] 🤖 AI 回复 轮 1
[msg] 🔧 curl 输出...
[msg] 🤖 AI 回复 轮 2
...
[msg] 🤖 AI 回复 轮 10
[msg] 🔧 read_file 输出...
...120 条
```

压缩后（52 条）：
```
[header] 测试开始
[event] ⚡ compaction: Compacted 70 entries (25 AI, 30 tool, 15 event)
         from 14:20:05 to 14:35:22
[msg] 🤖 AI 回复 轮 8        ← 最近 50 条保持完整
[msg] 🔧 curl 输出...
...
[msg] 🤖 AI 最终评测结果
```

### 7.3 统计（Stats）

系统可以对任意 transcript 生成统计报告：

```
┌─────────────────────────────────────┐
│ Transcript 统计                      │
├──────────────┬──────────────────────┤
│ 总条目数      │ 45                   │
│ AI 回复      │ 12                    │
│ 工具调用      │ 18                   │
│ 事件         │ 5                     │
│ 总字符数      │ 156,320              │
│ 最大单条输出   │ 48,200 字符          │
│ 被截断条目     │ 3                   │
│ 落盘文件      │ 1                    │
│ 总轮数        │ 10                   │
│ 持续时间      │ 45.2 秒              │
└──────────────┴──────────────────────┘
```

### 7.4 搜索（Search）

可以在 transcript 里搜索关键词，快速定位问题：

> 搜索 `"Connection refused"` →
> ```
> 结果 1: 条目 #23, 字段: output, 时间: 14:28:15
>   片段: ...trying to connect to localhost:3000... Connection refused
>         (error code: ECONNREFUSED)...
> ```

## 8. 完整流程：一次沙箱测试的全生命周期

下面用一个具体例子走完全流程。假设用户创建了一个"天气查询 Skill"，系统对它做沙箱测试。

### 阶段 1：初始化

```
用户点击 [🧪 沙箱测试]
    │
    ▼
服务端创建 Docker 容器，注入：
  - Skill 定义（包含 API Key: sk-weather-abc123）
  - 测试用例
  - AI 模型配置
    │
    ▼
TranscriptManager 初始化：
  - 创建 /tmp/transcripts/transcript_full.jsonl
  - 创建 /tmp/transcripts/spill/ 目录
  - 写入 header 条目
```

### 阶段 2：多轮 ReAct 循环

**第 1 轮**
```
┌─────────────────────────────────────────────────────────────┐
│ AI 决定：先测试基本功能，调用 curl 查询北京天气             │
│                                                             │
│ 1. AI → tool_call: curl https://api.weather.com/...         │
│ 2. 工具执行 → 返回 3KB JSON                                 │
│ 3. ⏱️ context pressure check: 18% → ✅ 安全                │
│ 4. 📝 写入 transcript (full + display 各一条)               │
│ 5. 🔒 脱敏：API Key sk-weather-abc123 → ***REDACTED***     │
└─────────────────────────────────────────────────────────────┘
```

**第 5 轮（开始有压力了）**
```
┌─────────────────────────────────────────────────────────────┐
│ AI 测试边界情况，调用 curl 请求 10 天预报                   │
│                                                             │
│ 1. 工具返回 → 80KB JSON（10天 × 24小时 × 多项数据）        │
│ 2. 💾 > 50KB → 触发 spill → 写入 spill/spill-e7f8a9.log  │
│ 3. ✂️ 智能截断：80KB → 64KB（头+尾保留）                   │
│ 4. ⏱️ context pressure check: 67% → 🟡 触发 Soft Trim     │
│    └── 第 1~2 轮的 curl 输出被缩短到 4KB                    │
│ 5. 📝 transcript display 版只存 4KB 摘要                    │
└─────────────────────────────────────────────────────────────┘
```

**第 8 轮（压力很大）**
```
┌─────────────────────────────────────────────────────────────┐
│ AI 做最后的验证                                             │
│                                                             │
│ 1. ⏱️ context pressure check: 89% → 🟠 Hard Clear         │
│    └── 第 1~5 轮工具输出全部替换为占位符                     │
│ 2. 压力降到 52%                                             │
│ 3. AI 成功输出最终评测 JSON                                 │
└─────────────────────────────────────────────────────────────┘
```

### 阶段 3：结果回传

```
测试完成
    │
    ├── 📤 callback POST → 服务端
    │   └── 发送 display transcript (45KB)
    │       ├── 最终评分 JSON
    │       ├── 逐用例结果
    │       └── 截断版对话记录（每条 ≤ 4KB）
    │
    ├── ☁️ GCS 上传
    │   ├── transcript_full.jsonl (380KB)
    │   └── spill/spill-e7f8a9.log (80KB)
    │
    └── 🧹 容器销毁
```

### 阶段 4：前端展示

运营人员在管理后台看到：

```
📊 沙箱测试结果
┌────────────────────────────────────────────┐
│ 综合评分：85/100                           │
│ 测试用例：✅ 成功 3 / ❌ 失败 1            │
├────────────────────────────────────────────┤
│ 📤 最终输出                                │
│ {"score": 85, "details": {...}}            │
├────────────────────────────────────────────┤
│ ▼ 查看对话记录（38 条）  📂 查看完整版(GCS)│
│                                            │
│ 🤖 AI 回复（轮 1）  14:20:05              │
│   我来测试这个天气查询 Skill...             │
│                                            │
│ 🔧 curl  14:20:08  ✂️ 已截断 (原 3.2KB)   │
│   输入：curl https://api.weather.com/...    │
│   输出（截断版）：{"temp": 25, ...}         │
│                                            │
│ 🔧 curl  14:21:15  💾 大文件已落盘          │
│   输入：curl .../forecast?days=10           │
│   输出（截断版）：{"forecast": [...]}       │
│                                            │
│ ⚡ recovery  14:22:30                       │
│   context pressure 0.89 — 触发 prune       │
│                                            │
│ 🤖 AI 回复（轮 10）  14:23:45              │
│   测试完成，最终评测结果如下...              │
└────────────────────────────────────────────┘
```

### 各模块协作关系

```
用户请求沙箱测试
    │
    ▼
┌─── runner.py (react_loop) ────────────────────────────────┐
│                                                           │
│   每一轮：                                                │
│   ① context_pressure_check() ─→ 决定是否裁剪             │
│   ② prune_context()         ─→ soft trim / hard clear    │
│   ③ AI 调用                  ─→ 获取下一步动作            │
│   ④ 工具执行                 ─→ 获取结果                  │
│   ⑤ truncate_tool_result()   ─→ 智能截断给 AI 看          │
│   ⑥ tm.append_tool_result() ─→ 写入 transcript            │
│      ├── redact_message_full() → 脱敏                     │
│      ├── spill_output()        → 大文件落盘（如需）       │
│      ├── → transcript_full.jsonl (完整+脱敏)              │
│      └── → transcript.json     (截断+脱敏)                │
│                                                           │
│   最后：                                                  │
│   ⑦ tm.upload_to_gcs()      ─→ 完整版上传到 GCS          │
│   ⑧ callback POST           ─→ 截断版回传给服务端        │
│                                                           │
└───────────────────────────────────────────────────────────┘
    │                              │
    ▼                              ▼
  SQLite (display)              GCS (full + spill)
    │                              │
    ▼                              ▼
  前端直接展示                  点击"查看完整版"时读取
```

---

> **一句话总结**：这套系统让 AI 在有限的记忆空间里高效工作，同时确保用户隐私安全、运营人员能快速查看结果、出问题时有完整的记录可以回溯。
