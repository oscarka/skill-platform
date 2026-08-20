# agents_factory — AI 员工招聘与试用期考评平台

> ⚠️ **核心安全约束（所有 AI Agent 与开发者必须严格遵守）**：
>
> 本目录是 **100% 独立隔离的沙箱工作区**。
>
> - **禁止**修改本目录以外的任何文件（尤其是 `../server/`, `../h5/`, `../sandbox/`）
> - **禁止**直接读写生产数据库表（`agent_tasks`, `tickets`, `sessions` 等）
> - **禁止**使用任何真实用户 ID 进行测试（必须使用 `eval_sandbox_mock_user_*`）
> - 对 Skill-Platform 生产系统的交互**仅允许通过标准 REST API** 进行（黑盒调用）

---

## 目录结构

```
agents_factory/
├── README.md                    # 本文件（安全约束与说明）
├── schemas/
│   └── agent_spec.schema.json   # 标准 Agent DSL 规范
├── agent_specs/                 # 候选员工档案库（每个 Agent 一个 YAML/JSON）
│   └── .gitkeep
├── eval_suites/                 # 考评题库
│   ├── base_universal.json      # 通用合规卷（所有 Agent 必测）
│   └── advanced_lifecycle.json  # 进阶工单与技能实战卷
├── eval_logs/                   # 实时测试审计日志（按 Agent ID 与 Run ID 归档）
│   └── .gitkeep
├── reports/                     # 转正考评报告与失败归因诊断书
│   └── .gitkeep
└── src/                         # 工厂核心代码
    ├── metaAgent.ts             # Meta-Agent (HR 招聘主管)
    ├── ralphLoop.ts             # Ralph 试用期考评飞轮
    ├── evalRunner.ts            # 评测题库运行器与 Mock User 通道
    ├── scoreEngine.ts           # 量化评分器 (LLM-as-a-Judge + 规则断言)
    └── apiClient.ts             # 封装对 Skill-Platform 的 REST API 调用
```

## 快速开始

```bash
# 安装依赖
cd agents_factory && npm install

# 创建一个新候选 Agent（员工招聘）
node src/metaAgent.ts create --intent "招聘一个私域社群运营员工"

# 启动 Ralph 试用期考评循环
node src/ralphLoop.ts run --agent-id <id> --max-rounds 10

# 查看实时评测日志
cat eval_logs/<agent-id>/<run-id>/run_summary.json
```
