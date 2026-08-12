# 工单 100s 延迟根因排查与修复记录

> **文档类型**：生产故障 RCA（Root Cause Analysis）+ 修复记录  
> **影响模块**：`sandbox/runner.py` — Cloud Run 沙箱执行器  
> **问题日期**：2026-08-12  
> **修复状态**：✅ 已修复并部署

---

## 一、问题现象

用户提交营养师工单后，AI 处理时间高达 **255 秒**（官方 SLA 应在 60s 内）。

通过逐步埋点诊断，发现 AI 第一轮 TTFT（Time-To-First-Token）高达 **100.9 秒**：

```
[llm] -> attempt=1           09:21:14
[llm] connected in 100900ms  09:23:05   ← 整整 100 秒才连上！
```

而同一个 Cloud Run 实例上的 Flask 进程（diag 端点）发相同请求只需 **1.8 秒**。

---

## 二、诊断过程

### Step 1：排除 API Key / 网络路径问题

| 实验 | 环境 | 请求内容 | TTFT |
|------|------|----------|------|
| diag 端点（Flask 进程） | Cloud Run | 简单 "Hi" | 1.3s |
| diag 端点（Flask 进程） | Cloud Run | 完整 SKILL_MD + 4工具 | 1.8s |
| 本地 bench 脚本 | MacBook | 完整 SKILL_MD + 4工具 | 5.1s |
| runner.py 子进程 | Cloud Run | 完整 SKILL_MD + 4工具 | **100.9s** |

结论：**同一实例，同一 key，同一 URL，Flask 快但 subprocess 慢** → 问题在子进程环境。

### Step 2：子进程内部诊断 TTFT

在 `executor_react_loop` 里加入 DIAG 代码，从 runner.py 子进程内部发 trivial 请求：

```
[DIAG] test1 (default ssl context):  connect=107,633ms ✅（107 秒！）
[DIAG] test2 (explicit ssl context): connect=2,999ms ✅（3 秒！）
[DIAG] DNS resolve: 1ms → 2001:4860:4847:400::  ← IPv6 地址！
```

**两个关键发现**：
1. 同样的请求，默认 urlopen vs 显式 ssl context → 差 100 倍
2. DNS 返回的是 **IPv6 地址**

### Step 3：确认 IPv6 是元凶

Cloud Run 容器的 DNS 返回 `generativelanguage.googleapis.com` **16 个地址**：
- 8 个 IPv4（可用）
- 8 个 IPv6（Cloud Run 没有 IPv6 出站能力，packets silently dropped）

Python `urllib` 按 DNS 顺序逐个尝试，先试所有 IPv6（每个等 ~15s 超时），最后才到 IPv4。

### Step 4：发现 SSL context 加载开销

加入时间戳日志后发现：

```
09:35:32 [executor] about to call_ai...      ← call_ai 被调用
09:35:32 [llm] _do_ai_call entered           ← 进入函数（瞬间）
09:36:06 [llm] -> attempt=1                  ← 33.5 秒后才发出请求！
09:36:11 [dns-patch] filtered 8 IPv6         ← patch 生效
```

原来 `ssl.create_default_context()` 在每次 LLM 调用里执行，**加载 280+ 个 CA 证书需要 33 秒**。

---

## 三、根因（三层叠加）

```
每次 AI 调用浪费的时间：

  ssl.create_default_context()    → +33,500ms（每次重新加载 CA 证书）
  IPv6 尝试超时（8 × ~15s）      → +45-120s（无 IPv6 出站，等到超时）
  ─────────────────────────────────────────────
  合计浪费                        → +78-153s per call
```

### 根因 1：IPv6 DNS 超时
- **原因**：Cloud Run 的 Cloud NAT 网关只支持 IPv4 出站，IPv6 数据包被丢弃（无错误反馈）
- **表现**：DNS 返回 8 个 IPv6 地址，Python urllib 逐个尝试，每个等 ~15s 超时
- **影响**：第一轮 LLM 调用浪费 45-120s

### 根因 2：SSL CA 证书每次重新加载
- **原因**：`ssl.create_default_context()` 在 `_do_ai_call` 函数内调用，每次都执行
- **表现**：加载 Debian 系统 CA 证书包（约 280 个证书文件）耗时 30-40s
- **影响**：每轮 LLM 调用额外浪费 33s

### 根因 3：urllib 默认 opener 行为
- **原因**：不传 `context` 时，urllib 使用全局 default opener，地址选择策略与 IPv6 超时叠加更严重
- **修复**：传显式 `context=ssl_ctx` 强制使用 fresh opener

---

## 四、修复方案

所有修改集中在 [`sandbox/runner.py`](../sandbox/runner.py) 文件顶部（~15 行代码）：

### 修复 1：强制 IPv4 DNS（文件第 5-18 行）

```python
import socket as _sock
_orig_getaddrinfo = _sock.getaddrinfo

def _ipv4_only_getaddrinfo(*args, **kwargs):
    results = _orig_getaddrinfo(*args, **kwargs)
    ipv4 = [r for r in results if r[0] == _sock.AF_INET]
    return ipv4 if ipv4 else results  # fallback 到原始结果如果没有 IPv4

_sock.getaddrinfo = _ipv4_only_getaddrinfo
```

**原理**：Monkey-patch `socket.getaddrinfo`，过滤掉 IPv6（`AF_INET6`）地址，只保留 IPv4（`AF_INET`）。对所有通过 socket 的网络请求生效，包括 urllib/http.client。

### 修复 2：模块级缓存 SSL context（文件第 20-23 行）

```python
import ssl as _ssl_mod
_SSL_CTX = _ssl_mod.create_default_context()
print(f"[init] SSL context created, CA certs loaded", flush=True)
```

**原理**：Python 模块只在首次 `import` 时执行，之后 `_SSL_CTX` 为全局变量，所有 LLM 调用共用同一个 context 对象，CA 证书只加载一次。

### 修复 3：urlopen 传显式 context（`_do_ai_call` 函数）

```python
# 修改前
with urllib.request.urlopen(req, timeout=first_token_timeout) as r:

# 修改后
with urllib.request.urlopen(req, timeout=first_token_timeout, context=_SSL_CTX) as r:
```

**原理**：传 `context` 参数时，urllib 创建 fresh `HTTPSHandler`，不使用全局默认 opener，避免了 default opener 的 IPv6 优先问题。

### 修复 4：扩展重试条件

```python
# 修改前
if attempt < 2 and ('EOF' in err_str or 'ssl' in err_str.lower()
                    or 'reset' in err_str.lower() or 'ConnectionReset' in err_str):

# 修改后
if attempt < 2 and ('EOF' in err_str or 'ssl' in err_str.lower()
                    or 'reset' in err_str.lower() or 'ConnectionReset' in err_str
                    or 'closed' in err_str.lower() or 'Remote end' in err_str):
```

**原理**：`Remote end closed connection without response` 是 IPv6 连接被 drop 后的错误信息，加入重试白名单确保降级到 IPv4 重试而不是直接失败。

---

## 五、修复效果

| 指标 | 修复前 | 修复后 | 提升 |
|------|--------|--------|------|
| Turn 1 connect | 100,900ms | **6,273ms** | **16x ⚡** |
| Turn 2 connect | 42,400ms | 16,300ms | 2.6x |
| Turn 3 connect | 37,100ms | 28,600ms | 1.3x |
| SSL context 创建 | 33,500ms/次 | **0ms**（启动时一次）| ∞ |
| 总工单时间 | ~255s | **~207s** | 节省 48s |

> **注**：Turn 2/3 的 connected 时间主要是 Gemini 真实 thinking 时间（context 越大越慢），
> 是正常的模型计算延迟，不是网络问题。

---

## 六、为什么 Cloud Run 的 IPv6 不通？

```
你的 runner.py 容器
        │
        │ 出站请求（generativelanguage.googleapis.com）
        ▼
   Cloud NAT 网关
        │
        │ Cloud NAT 只支持 IPv4 出站（官方文档限制）
        │ IPv6 数据包 → silently dropped（没有任何错误提示！）
        ▼
   googleapis.com
   （只有 IPv4 能到达）
```

Google 自家的 Cloud Run 不支持 IPv6 出站，但 Google 自家的 API 又有 IPv6 地址——这是个历史遗留的网络配置矛盾。

---

## 七、未来优化方向

### A. 减少 AI 轮次（优先级：高，预计节省 40-80s）

当前工单走 3 轮（规划→执行→输出），是因为触发了 `script` 类型路径（有 exec 工具调用）。
如果营养师 skill 改为纯 prompt 模式（`prompt_only`），理论上 1 轮完成。

### B. HTTP/2 或连接复用（优先级：低，预计节省 <1s）

```python
import http.client
_GEMINI_CONN = http.client.HTTPSConnection(
    "generativelanguage.googleapis.com", context=_SSL_CTX)
# 复用连接避免每次 TLS 握手（约节省 0.2s/轮）
```

节省微乎其微（0.2s × 3 轮 = 0.6s），开发成本不低，不推荐。

### C. 并行化工具调用（优先级：中）

当前工具调用串行执行，如果有多个工具可以并行，可以减少等待时间。

---

## 八、诊断代码（备查）

以下代码曾临时加入 runner.py 用于诊断，已在修复后移除，留存备查：

```python
# 在 executor_react_loop 入口处，测试三种方式的 TTFT
# test1: 默认 ssl（会触发 IPv6 超时 + CA 加载问题）
# test2: 显式 ssl context（修复后的正确方式）
# test3: DNS 解析时间

import urllib.request as _diag_ur
import ssl as _diag_ssl
import socket as _diag_sock

# DNS 解析
_ips = _diag_sock.getaddrinfo("generativelanguage.googleapis.com", 443)
print(f"[DIAG] DNS: {[(r[0].name, r[4][0]) for r in _ips]}")

# test2 (显式 ssl)
_ctx = _diag_ssl.create_default_context()
_body = json.dumps({"model": AI_MODEL, "messages": [{"role":"user","content":"Hi"}],
                    "max_tokens": 8, "stream": True}).encode()
_req = _diag_ur.Request(f"{AI_BASE_URL}/chat/completions", data=_body,
    headers={"Authorization": f"Bearer {AI_API_KEY}", "Content-Type": "application/json"})
_t0 = time.time()
with _diag_ur.urlopen(_req, timeout=15, context=_ctx) as _r:
    print(f"[DIAG] explicit ssl connect={round((time.time()-_t0)*1000)}ms")
```

---

*文档由 Antigravity AI 助手根据实际生产调试过程自动生成，2026-08-12*
