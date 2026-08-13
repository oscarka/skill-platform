# Sandbox Runner 性能优化全记录

**项目**：skill-platform / sandbox runner  
**时间**：2026-08-13  
**结果**：E2E 耗时从 406-554s 降到 **51s**（提速 8-11x）

---

## 背景

用户提交工单后，skill-platform 会启动一个 Cloud Run Job 运行 `sandbox/runner.py`。  
该 runner 是一个 AI Agent 循环：**LLM 思考 → 调用工具（exec/write_file）→ 拿结果 → 继续思考**，直到生成最终报告。

**初始问题**：整个流程需要 400-550 秒，用户等待接近 10 分钟。

---

## 问题一：SSL EOF 导致 LLM 调用重试

### 现象

日志中频繁出现类似：
```
[llm:diag:FAIL] SSL EOF: RemoteDisconnected: Remote end closed connection without response
```
每次触发后，runner 会做一系列诊断（DNS 查询、resolv.conf 检查、FD 统计、peer 信息）然后重试，共浪费 **10-20 秒**。

### 诊断方式

查 Cloud Logging：
```bash
gcloud logging read \
  'resource.labels.service_name="sandbox-service" AND textPayload:"SSL EOF"' \
  --limit=20 --format="value(timestamp,textPayload)"
```

### 根本原因

`_do_ai_call` 用 `urllib.request.urlopen` 发 LLM 请求。**每次调用都新建一个 TLS 连接**，而 Google LB 偶尔会在空闲时 reset 连接，导致 SSL EOF。

```python
# 问题代码：每次都新建 TLS 连接
req = urllib.request.Request(url, data=body, headers=headers)
r = urllib.request.urlopen(req, context=ssl_ctx, timeout=120)
```

### 修复

用 `http.client.HTTPSConnection` 持久连接，在模块级别维护连接池：

```python
# sandbox/runner.py
import http.client as _http_client

_PERSISTENT_CONNS: dict = {}  # host -> HTTPSConnection

def _get_persistent_conn(host, port=443):
    key = f"{host}:{port}"
    conn = _PERSISTENT_CONNS.get(key)
    if conn:
        return conn  # 直接复用，不做 HEAD 检查（无效）
    conn = _http_client.HTTPSConnection(host, port, context=_SSL_CTX, timeout=120)
    conn.connect()
    _PERSISTENT_CONNS[key] = conn
    print(f"[conn-pool] new connection to {key}", flush=True)
    return conn
```

SSE 流结束后 drain response，让连接可复用：
```python
# _parse_sse_stream 结束时
try:
    r.read()   # drain remaining bytes
    r.close()
except Exception:
    pass
```

### 验证

```
优化前：[init] TLS pre-warm connected (3883ms)
优化后：[init] TLS pre-warm connected (8ms)      ← 486x 提升，连接池生效
SSL EOF 不再出现
```

---

## 问题二：exec 命令耗时 16-50 秒

### 现象

日志看到：
```
[exec] $ ls -la scripts/
[exec:timing] exec=22910ms total=25710ms exit=2
```

`ls -la` 这种简单命令花了 23 秒！

### 初步诊断日志

在 `tool_exec` 函数加了计时：
```python
_t_pre_run = time.time()
stdout_str, stderr_str, exit_code = _shell_exec(command, workdir, effective)
_t_post_run = time.time()
print(f"[exec:timing] exec={round((_t_post_run-_t_pre_run)*1000)}ms "
      f"exit={exit_code} out={len(stdout_str)}b", flush=True)
```

### 分析：命令复杂度和耗时无关

```
ls -la            → 16-23s
echo hello        → 16s    ← 就是 echo！
cat << EOF > file → 50s
python3 -c "..."  → 30-50s
```

**所有命令一样慢**，说明不是命令本身的问题，而是**启动进程的开销**。

### 假设一：gVisor fork 惩罚

Cloud Run 默认用 **gen1 执行环境**，基于 [gVisor](https://gvisor.dev/)（用户态内核），`fork()` 系统调用比真实 Linux 慢 10-100 倍。

**验证**：直接切换到 gen2（microVM，完整 Linux 内核）：

```bash
gcloud run services update sandbox-service \
  --execution-environment=gen2 --region=asia-east1
gcloud run jobs update skill-sandbox-job \
  --execution-environment=gen2 --region=asia-east1
```

结果：
```
python3 -c "..." → 50s  变成  10s    ← 有改善
ls -la          → 16s  变成  12s    ← 还是慢
```

gen2 有帮助，但 `ls` 依然 12 秒，说明还有其他问题。

### 假设二：GIL 竞争

加 **`_PersistentShell` 细粒度计时**，把 exec 拆成多个阶段：

```python
# sandbox/runner.py PersistentShell.exec()
_t0 = time.time()
# ... 写 stdin ...
_t_write = time.time()
# ... readline 循环 ...
_t_first_line = time.time()  # 第一行到达时记录
# ... 读完所有行 ...
_t_read_done = time.time()

print(f"[shell:detail] cmd={command[:60]} "
      f"lock={lock_ms}ms write={write_ms}ms "
      f"first_line={first_ms}ms read={read_ms}ms "
      f"total={total_ms}ms", flush=True)
```

日志结果（GIL 竞争时）：
```
[shell:detail] cmd=ls -la scripts/
  lock=0ms  write=0ms  first_line=11299ms  read=3400ms  total=14700ms
```

**`first_line=11299ms`** — shell 收到命令是瞬间的（write=0ms），但 Python 主线程等了 **11.3 秒才读到第一行输出**！

对比启动时的 benchmark（无其他线程竞争）：
```
[benchmark] cmd=ls /tmp    fork=11ms  shell=3ms
```

同样的 `ls`，启动时只要 **3ms**，运行中要 **11299ms**。**差距 3700 倍**。

### 根本原因确认：daemon 线程 SSL 握手抢 GIL

每次 `tm.append_assistant()` 调用 `_append_raw()`，后者启动一个 daemon 线程做 `urlopen`（新建 SSL 连接）。SSL 握手是 CPU 密集操作，**daemon 线程持有 GIL 时，主线程无法执行 `readline()`**，即使 pipe 数据早已就绪。

```python
# transcript.py — 问题代码（已修复）
def _append_raw(self, full_entry, display_entry):
    # ... 写文件 ...
    
    # ❌ 每次 append 都启动新线程做 SSL 连接
    def _send():
        urlopen(req, timeout=5)  # SSL 握手 → 抢 GIL
    threading.Thread(target=_send, daemon=True).start()
```

**证据：`executor:gap` 日志对比**

| 状态 | transcript 耗时 | total gap |
|---|---|---|
| 回调开启 | 4400ms | 20800ms |
| 回调关闭 | **1ms** | **2ms** |

4400ms → 1ms，降低了 4400 倍。

---

## 问题三：Cloud Run Job 资源不足

### 发现过程

查看 Job 配置：
```bash
gcloud run jobs describe skill-sandbox-job --region=asia-east1
```

输出：`Memory: 1Gi  CPU: 1`

而 `deploy-sandbox.sh` 调用 `cloudbuild-sandbox.yaml`，里面**从未设置 Job 的 CPU 和 Memory**！每次 deploy 都重置回默认值，导致手动升级也被覆盖。

### 修复

在 [cloudbuild-sandbox.yaml](file:///Users/cc/skill-platform/cloudbuild-sandbox.yaml) 的 Job 更新步骤加上：

```yaml
- --cpu=2
- --memory=2Gi
- --execution-environment=gen2
```

---

## 所有修复汇总

### 修复 1：SSL 持久连接（sandbox/runner.py）

**改动**：`_do_ai_call` 中用 `http.client.HTTPSConnection` 替代 `urlopen`，模块级维护连接池

**效果**：消除 SSL EOF 重试浪费的 10-20s；TLS 预热从 3883ms → 8ms

---

### 修复 2：切换 gen2 执行环境

**改动**：`cloudbuild-sandbox.yaml` 加 `--execution-environment=gen2`；手动更新 service 和 job

**效果**：exec 时间减少约 50-70%（gen1 gVisor fork 惩罚消除）

---

### 修复 3：持久 shell worker（sandbox/runner.py）

**改动**：模块加载时预 fork 一个 `/bin/sh`，后续 exec 通过 stdin/stdout 通信

```python
class _PersistentShell:
    def __init__(self):
        self._proc = subprocess.Popen(["/bin/sh"], 
            stdin=PIPE, stdout=PIPE, stderr=PIPE)
    
    def exec(self, command, workdir, timeout):
        # 写 script 到 stdin，读 marker 分隔的输出
        ...

_SHELL_WORKER = _PersistentShell()  # 模块加载时预 fork
```

**效果**：进一步减少 exec 的进程创建开销；配合 gen2 效果更明显

---

### 修复 4：transcript 实时回调关闭（sandbox/transcript.py）

**改动**：在 `_append_raw` 的 HTTP 回调前加环境变量守卫（**最小改动，5 行**）

```python
# 默认关闭：daemon thread 的 urlopen SSL 握手会争夺 GIL
# 导致主线程 readline() 阻塞 10+ 秒
# 需要时设 TRANSCRIPT_REALTIME=1 恢复
if not os.getenv("TRANSCRIPT_REALTIME"):
    return
```

**效果**：
- exec `ls` 从 14700ms → **2499ms**
- exec `cat > file` 从 50000ms → **4300ms**
- Turn gap 从 20800ms → **2ms**

---

### 修复 5：Cloud Run Job 资源配置（cloudbuild-sandbox.yaml）

**改动**：补全之前从未设置的 Job 资源配置

**效果**：CPU 1→2，内存 1Gi→2Gi，配合 gen2 整体运行更稳定

---

### 修复 6：DeepSeek 持久连接统一（sandbox/runner.py）

**背景**：最初加入 DeepSeek 时，代码错误地认为 ARK 端点不兼容持久连接，用 `if _is_gemini_model` 把 DeepSeek 排除在 TLS pre-warm 和连接池之外。

**问题现象**：
```
Gemini:   TLS pre-warm 7ms,   benchmark echo fork=1ms   （快）
DeepSeek: TLS pre-warm 516ms, benchmark echo fork=100-500ms （慢 100x）
```

**根因**：`_is_gemini_model` 守卫导致 DeepSeek 跳过了 `conn.connect()` 预热，每次 job 都要重新建立 TLS 连接。

**修复**：删除 `if _is_gemini_model` 判断，所有模型统一走 `_get_persistent_conn`：
```python
# 之前（错误）：
if _dns_warm_host and _is_gemini_model:
    _warm_conn = _get_persistent_conn(_dns_warm_host)

# 修复后：
if _dns_warm_host:
    _warm_conn = _get_persistent_conn(_dns_warm_host)  # 所有模型都预热
```

**效果**：DeepSeek TLS pre-warm 与 Gemini 一致，连接复用生效。

---

### 修复 7：关闭 CPU Throttling（Cloud Run Service 配置）

**背景**：这是导致「DeepSeek 每次都像冷启动」的真正根因。

**现象**：
- 同一热容器，Gemini 刚跑完立刻跑 DeepSeek → `benchmark echo fork=100-500ms`（本应 1ms）
- 关闭 CPU throttling 后 → `benchmark echo fork=1ms`，与 Gemini 完全一致

**根因**：Cloud Run 默认 `cpu-throttling=true`，即 **CPU 只在处理请求时分配**。两次请求之间 CPU 被降到接近 0。下一个请求来时 gVisor JIT 缓存失效，每次 job 都像「热容器冷 CPU」。

**误判过程**：最初以为 Gemini 的 benchmark 3ms 是因为 TLS pre-warm 触发了 gVisor 预热，实际上是因为 Gemini 测试恰好紧跟另一个 job，CPU 尚未被节流。

**修复**：
```bash
gcloud run services update sandbox-service \
  --region=asia-east1 \
  --no-cpu-throttling
```

> **注意**：`--no-cpu-throttling` 需配合 `min-instances: 1` 才有意义（保证始终有热容器 + 热 CPU）。

**效果**：
```
DeepSeek E2E（CPU throttling 开启）:   126s
DeepSeek E2E（no-cpu-throttling）:      51s   ← 提速 2.5x
benchmark echo fork:  100-500ms → 1ms   ← 和 Gemini 一致
benchmark python3:   2899ms → 18ms     ← 和 Gemini 一致
web_search 首次：     22s → 2s          ← gVisor 网络 syscall 已热
```

**成本**：1 实例 × 2 CPU × always-on ≈ $30-40/月（Cloud Run CPU-秒计费）。

---

### 修复 8：Fallback 模型名修复（server/src/aiProcessor.ts）

**问题**：ARK 调用失败时，L2 fallback 切换到 Gemini，但 `FALLBACK_AI_MODEL` 默认是 `deepseek-chat`。用 Gemini key + `deepseek-chat` 调 Gemini API → 404。

**修复**：`resolveApiCreds()` 根据主模型决定 fallback 模型名：
```typescript
// ARK primary → fallback 是 Gemini，必须用 Gemini 模型名
return { ..., fallbackModel: 'gemini-3.6-flash' };

// Gemini primary → fallback 是 ARK
return { ..., fallbackModel: 'deepseek-v4-flash-ga-260731' };
```

**效果**：Fallback 链路完整：ARK 404 → L2 → Gemini 接管 → `status=done`（73s 完成）。

---

## 诊断日志添加位置总览

| 日志标签 | 位置 | 作用 |
|---|---|---|
| `[init] SSL context` | runner.py 模块级 | 记录 SSL 预热耗时 |
| `[init] DNS pre-warm` | runner.py 模块级 | 记录 DNS 预热耗时 |
| `[init] TLS pre-warm` | runner.py 模块级 | 记录 TLS 连接预热耗时 |
| `[conn-pool]` | `_get_persistent_conn` | 记录连接池命中/新建 |
| `[llm] ->` | `_do_ai_call` | 记录每次 LLM 调用开始 |
| `[llm] connected` | `_do_ai_call` | 记录连接建立耗时 |
| `[llm] first_token` | `_parse_sse_stream` | 记录 TTFT |
| `[llm] stream_done` | `_parse_sse_stream` | 记录流式完成耗时 |
| `[exec] $` | `tool_exec` | 记录执行的命令 |
| `[exec:timing]` | `tool_exec` | 记录 exec 各阶段耗时 |
| `[executor:gap]` | executor loop | 记录 LLM 完成到下一次调用的间隔 |
| `[shell-worker]` | `_PersistentShell` | 记录 shell 进程启动/重启 |
| `[shell:detail]` | `_PersistentShell.exec` | 记录 stdin write / first_line / read 分段耗时 |
| `[benchmark]` | 模块级启动时 | 对比 fork vs 持久 shell 的耗时 |
| `[progress:ok]` | `_post_progress` | 记录进度上报成功 |

---

## 步骤和结果时间线

```
基线测试        406-554s    问题：SSL EOF + gVisor + GIL 竞争 + 资源不足

修复 SSL 持久连接
              → 331s       -25%，SSL EOF 消除，TLS 预热 3883ms→8ms

加持久 shell worker
              → 278s       -35%，exec 进程创建开销降低

切换 gen2（手动）
              → 195s       -52%，gVisor fork 惩罚消除

提交所有代码 + gen2 写入 cloudbuild
              → 109s       -73%，代码+配置全部生效

关闭 transcript 实时回调
              → 110s       稳定在 ~110s（exec 从 14.7s→2.5s，LLM thinking 为主）

DeepSeek 持久连接统一（删除 _is_gemini_model 守卫）
              → 98s        DeepSeek 开始复用 TLS 连接

关闭 CPU Throttling（--no-cpu-throttling）
              → 51s        -54%，gVisor/CPU 保持热态，web_search 从 22s→2s
                           Gemini: 67s，DeepSeek: 51s
```

> **注**：DeepSeek (51s) 比 Gemini (67s) 快是因为 DeepSeek 偏好用 `web_search`（Tavily ~2s/次），Gemini 用 `exec`（本地命令，但有 fork 开销）。这是模型行为差异，不是配置问题。

---

## 经验总结

1. **gVisor 的 fork 很慢**：Cloud Run 默认 gen1 用 gVisor，`fork()` 慢 10-100x。需要频繁启动子进程的应用**必须用 gen2**。

2. **GIL 竞争是隐蔽杀手**：daemon 线程做 SSL 握手会抢 GIL，即使用了 `fire-and-forget` 模式，主线程的 I/O（pipe readline）也会被严重阻塞。

3. **诊断要分段**：`exec:timing` 告诉你总耗时，但要定位到底卡在哪（fork？ write？ read？），需要在 pipe 通信的每一步都加时间戳。

4. **deploy 脚本要完整**：Cloud Run Job 的 CPU/Memory 没有默认继承上次部署，每次 update 都要显式指定，否则会被重置为平台默认值。

5. **最小化改动高风险文件**：transcript.py 是非核心关键文件，用环境变量 flag（5 行代码）代替删除逻辑，保留恢复能力（`TRANSCRIPT_REALTIME=1`）。

6. **CPU Throttling 是「隐形冷启动」**：`min-instances=1` 只保证容器不被销毁，但 CPU 仍被节流到 ~0。**对于 AI agent（频繁 fork/exec）必须加 `--no-cpu-throttling`**，否则每次请求都要等 CPU 热身，gVisor JIT 缓存也会失效。

7. **新模型接入必须检查所有优化路径**：加入 DeepSeek 时漏掉了 `_is_gemini_model` 守卫，导致 TLS pre-warm 和持久连接都没走。`benchmark` 数字（fork 时间）是最直接的诊断信号，1ms 是热态，500ms+ 是冷态。

8. **Fallback 链路要端到端验证**：fallback key 有了，fallback model 名不对也会失败（`deepseek-chat` 传给 Gemini API → 404）。要用真实错误场景（broken model name）测试完整链路。
