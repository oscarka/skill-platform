# Supabase 连接指南 — skill-platform

## 基本信息

| 项目 | 值 |
|------|----|
| Project Ref | `feaeonavsqzewadgoqeh` |
| 直连主机 | `db.feaeonavsqzewadgoqeh.supabase.co:5432` |
| Pooler 主机（推荐） | `aws-0-us-west-2.pooler.supabase.com:5432` 或 `aws-0-ap-southeast-1.pooler.supabase.com:6543` |
| 数据库 | `postgres` |
| Schema | `skill_platform` |
| 用户名（直连） | `postgres` |
| 用户名（Pooler） | `postgres.feaeonavsqzewadgoqeh` |
| 密码 | 见 GCP Secret: `skill-platform-db-url` |

完整连接串（直连，存于 GCP Secret）：
```
postgresql://postgres:***@db.feaeonavsqzewadgoqeh.supabase.co:5432/postgres
```

Pooler 连接串（推荐本地脚本连接使用）：
```
postgresql://postgres.feaeonavsqzewadgoqeh:***@aws-0-us-west-2.pooler.supabase.com:5432/postgres
```

读取密码方式：
```bash
gcloud secrets versions access latest \
  --secret=skill-platform-db-url \
  --project=gen-lang-client-0884226164
```

---

## 连接方式对比

### ❌ 方式一：psql 直连（本地经常失败）

```bash
PGPASSWORD=<pwd> psql \
  "postgresql://postgres:<pwd>@db.feaeonavsqzewadgoqeh.supabase.co:5432/postgres?sslmode=require" \
  -c "SELECT ..."
```

**失败原因**：Clash 代理在 Global 模式下会拦截 5432 端口的 TCP 连接，导致：
```
server closed the connection unexpectedly
```

### ✅ 方式二：Node.js pg 库 + Pooler（推荐，本地可用）

```javascript
const { Client } = require('pg');
const client = new Client({
  connectionString: 'postgresql://postgres.feaeonavsqzewadgoqeh:<pwd>@aws-0-us-west-2.pooler.supabase.com:5432/postgres',
  ssl: { rejectUnauthorized: false, checkServerIdentity: () => undefined }
});
await client.connect();
const { rows } = await client.query(
  'SELECT * FROM skill_platform.agent_profiles WHERE id=$1',
  ['health-advisor']
);
console.log(rows[0]);
await client.end();
```

在 `/Users/cc/skill-platform/server/` 目录下运行（`pg` 已安装）：
```bash
cd /Users/cc/skill-platform/server
node -e '<上方代码>'
```

### ⚠️ Pooler 用户名格式陷阱

Pooler 要求用户名带项目 ref，否则报错：

| 错误 | 原因 |
|------|------|
| `no tenant identifier provided` | 用了 `postgres` 而不是 `postgres.feaeonavsqzewadgoqeh` |
| `tenant/user not found` | ref 写错，或者 Pooler 区域不对 |

**正确格式**：`postgres.feaeonavsqzewadgoqeh`（带项目 ref）

### ✅ 方式三：通过 Cloud Run API（最简单，无需数据库权限）

适用于读写 Agent 配置、工单等业务数据，不需要直连数据库：

```bash
# 读取
curl https://skill-platform-yo5337ccva-de.a.run.app/api/v1/agent/profile

# 写入（已支持读-合并-写保护，部分字段更新不会清除未传字段）
curl -X PUT https://skill-platform-yo5337ccva-de.a.run.app/api/v1/agent/profile \
  -H "Content-Type: application/json" \
  -d '{ "name": "服务助理", "welcome_enabled": true }'
```

---

## 常用查询

```javascript
// 查 agent_profiles
const { rows } = await client.query('SELECT * FROM skill_platform.agent_profiles ORDER BY created_at');

// 查最近任务
const { rows } = await client.query(
  'SELECT id, status, route_type, input_content FROM skill_platform.agent_tasks ORDER BY created_at DESC LIMIT 10'
);

// 查工单
const { rows } = await client.query(
  'SELECT id, status, skill_id, agent_id FROM skill_platform.tickets ORDER BY created_at DESC LIMIT 10'
);

// 查 channel_identities（用户身份映射）
const { rows } = await client.query(
  'SELECT * FROM skill_platform.channel_identities WHERE user_id=$1',
  ['<user_id>']
);
```

---

## 常见错误排查

| 错误信息 | 原因 | 解决方案 |
|---------|------|---------|
| `server closed the connection unexpectedly` | Clash 拦截了 5432 TCP | 改用 Pooler（方式二） |
| `no tenant identifier provided` | Pooler 用户名缺少 `.ref` | 改为 `postgres.feaeonavsqzewadgoqeh` |
| `tenant/user not found` | 用户名 ref 拼错或区域不对 | 检查 ref，优先用 `aws-0-us-west-2.pooler.supabase.com:5432` |
| `could not determine data type of parameter $N` | PostgreSQL 无法推断 null 参数类型 | JS 层 merge 后全量传值，避免传裸 null |
| Cloud Run curl 返回空 / SSL error | Clash Global 模式拦截 443 | 关 Clash 或换 Rule 模式再 curl |

---

## 注意事项

1. **schema 必须指定**：所有表都在 `skill_platform` schema 下，SQL 里用 `skill_platform.表名` 或设置 `search_path`。
2. **多 Agent 隔离**：业务助理使用 `id = 'health-advisor'`，`id = 'default'` 保留为系统模板。
3. **读-合并-写安全保护**：后端 `saveAgentProfile` 已实现读-合并-写逻辑，即使只传部分字段也会安全合并。
4. **Clash 代理**：本地直连 Supabase 需要关闭 Clash 的 Global 模式，或使用 Node.js pg 库连接 Pooler。
