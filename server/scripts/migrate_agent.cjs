const { Client } = require('pg');

async function getClient() {
  const connectionStrings = [
    'postgresql://postgres:lnZbMyimxpMYgUp5@db.feaeonavsqzewadgoqeh.supabase.co:5432/postgres',
    'postgresql://postgres.feaeonavsqzewadgoqeh:lnZbMyimxpMYgUp5@aws-0-us-west-2.pooler.supabase.com:5432/postgres',
    'postgresql://postgres.feaeonavsqzewadgoqeh:lnZbMyimxpMYgUp5@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres',
  ];

  for (const connStr of connectionStrings) {
    const client = new Client({
      connectionString: connStr,
      ssl: { rejectUnauthorized: false, checkServerIdentity: () => undefined },
      connectionTimeoutMillis: 5000,
    });
    try {
      await client.connect();
      console.log('✅ Successfully connected via:', connStr.split('@')[1]);
      return client;
    } catch (e) {
      console.warn('⚠️ Failed connecting via:', connStr.split('@')[1], 'error:', e.message);
    }
  }
  throw new Error('All connection attempts failed');
}

async function run() {
  const client = await getClient();

  // 1. 检查 health-advisor 是否已存在
  const existing = await client.query(
    "SELECT id, name, skill_mode, updated_at FROM skill_platform.agent_profiles WHERE id = 'health-advisor'"
  );

  if (existing.rows.length > 0) {
    console.log('⚠️ health-advisor 已存在:', existing.rows[0]);
  } else {
    // 2. 从 default 复制
    const result = await client.query(`
      INSERT INTO skill_platform.agent_profiles
        (id, name, role_desc, reply_style, service_flow, taboos,
         reassurance_mode, reassurance_tpl, skill_mode, skill_ids,
         routing_examples, knowledge_config, welcome_enabled, welcome_msg,
         created_at, updated_at)
      SELECT
        'health-advisor', name, role_desc, reply_style, service_flow, taboos,
        reassurance_mode, reassurance_tpl, skill_mode, skill_ids,
        routing_examples, knowledge_config, welcome_enabled, welcome_msg,
        EXTRACT(EPOCH FROM now())*1000, EXTRACT(EPOCH FROM now())*1000
      FROM skill_platform.agent_profiles
      WHERE id = 'default'
    `);
    console.log('✅ health-advisor 创建成功，插入行数:', result.rowCount);
  }

  // 3. 验证 T1：查询所有 agent profiles
  const { rows } = await client.query(
    `SELECT id, name, skill_mode,
       LEFT(role_desc, 30) AS role_desc_preview,
       welcome_enabled,
       created_at, updated_at
     FROM skill_platform.agent_profiles
     ORDER BY created_at`
  );
  console.log('\n📊 [T1 验证] 当前所有 agent profiles:');
  console.table(rows);

  await client.end();
}

run().catch(err => {
  console.error('❌ Migration error:', err);
  process.exit(1);
});
