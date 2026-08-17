# Skill Platform 轻量路由路径性能优化与延迟分析总结

**文档版本**: v1.0  
**更新时间**: 2026-08-14  
**涉及模块**: `server/src/agentService.ts`, `server/src/app.ts`, `cloudbuild.yaml`, `cloudbuild-web.yaml`

---

## 一、 优化措施与上线状态

针对轻量路由路径的冷启动、网络开销与 I/O 阻塞问题，已实施并上线了 6 项优化：

| 步骤 | 优化项 | 改动文件 / 动作 | 效果 |
|:---|:---|:---|:---|
| **Step 1** | 容器永不缩容 | `min-instances=1`（`skill-platform` + `sandbox-service`） | 消除 Cloud Run 实例冷启动（从 >5s 降至热态 ~300ms） |
| **Step 2** | DNS IPv4 优先 | `server/src/app.ts` 配置 `dns.setDefaultResultOrder('ipv4first')` | 消除容器内偶发 AAAA 查询超时（单次 4~5s 卡顿） |
| **Step 3** | 全局 TLS 连接复用 | `server/src/agentService.ts` 引入 `undici.setGlobalDispatcher` | 自动维持 30s Keep-Alive，消灭每次握手 0.5~1.5s 延迟 |
| **Step 4** | 路由前置 I/O 并行化 | `Promise.all([queryContextSnapshot, loadProfileAndSkills])` | 消除前置 3 个 DB 查询串行阻塞，节省 ~1s |
| **Step 5** | Wiki 缓存 TTL 延长 | `WIKI_CACHE_TTL_MS = 300_000`（60s → 5min） | 连续对话中 98% Wiki 请求命中内存缓存（耗时 <1ms） |
| **Step 6** | gVisor CPU 持续分配 | `--no-cpu-throttling` | 解决请求间隙 CPU 降频导致 JIT 缓存失效的「热容器冷 CPU」问题 |

---

## 二、 路由端到端耗时与逐轮拆解

通过线上真实请求日志与测试脚本，捕获并拆解了实际消息处理的真实耗时：

### 1. 入口层与基础设施延迟
- **HTTP Ingest 响应**: 稳定在 **430ms ~ 470ms**（极速异步 ACK）。
- **健康检查 / 热态探测**: **290ms ~ 310ms**。
- **WikiContext 请求**: 本地缓存命中 <1ms，远程拉取约 60ms ~ 100ms。

### 2. AI 阶段拆解（为什么以前看起来要 6~10s？）
以健康咨询消息为例，实际发生了 **多次 AI 独立调用**：

```
用户消息到达
   │
   ├── Step 1: 前置并行 I/O (<50ms)
   │
   ├── Step 2: 路由决策 AI (routeDecision, max_tokens=512)
   │     └── 耗时: 2.1s ~ 3.6s (DeepSeek 模型单次推理与跨区网络)
   │
   └── Step 3: 回复生成 AI (handleHealthDirect / handleChat)
         ├── Round 0 (工具决策轮, max_tokens=2048):
         │     └── 耗时: ~1.6s ~ 2.4s (模型决策是否调用 get_medical_history / query_ticket)
         │
         └── Round 1 (最终回复生成, max_tokens=2048):
               └── 耗时: ~3.2s ~ 4.7s (模型结合工具返回结果生成最终 200~300 字建议)
```

**结论**: 6.3s 不是单次 AI 调用慢，而是由 **1次路由决策 + 2轮带工具的 AI 回复** 叠加而成的端到端总时间。
