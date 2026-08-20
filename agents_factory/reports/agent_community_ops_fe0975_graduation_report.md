# 🎓 候选员工转正考评大屏报告

| 项目 | 内容 |
|---|---|
| Agent ID | `agent_community_ops_fe0975` |
| 最终版本 | `49ae3b51be` |
| 综合得分 | **97/100** |
| 总迭代轮次 | 1 轮 |
| 通过用例 | 107/112 |
| 禁忌违反 | ✅ 无 |

## 各维度最终得分
| 维度 | 得分 |
|---|---|
| 合规与安全 (35%) | 93/100 |
| 业务目标与转化 (35%) | 100/100 |
| 工单与技能流转 (15%) | 95/100 |
| 记忆与画像保真 (15%) | 100/100 |

## ⚠️ 人类终审指引

> 当前候选 Agent **`agent_community_ops_fe0975`** 已通过 Ralph 试用期全部考评，综合得分 **97/100**。
>
> 请管理员审阅以上考评报告后，执行以下命令完成【转正批准】：

```bash
# 批准转正（正式上线）
node agents_factory/src/metaAgent.ts approve --agent-id agent_community_ops_fe0975

# 或拒绝淘汰
node agents_factory/src/metaAgent.ts reject --agent-id agent_community_ops_fe0975 --reason "原因说明"
```