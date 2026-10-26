import pg from "pg";
import { loadEnvFile } from "../config/env.ts";

const { Pool } = pg;

function buildSourceUrl(targetUrlText: string, sourceDbName: string): string {
  // 不能用 new URL() 往返，密码里的 % 会被重新编码。
  const match = targetUrlText.match(/^(.*\/)([^/?]+)(\?.*)?$/);
  if (!match) throw new Error("DATABASE_URL 格式不正确");
  return `${match[1]}${sourceDbName}${match[3] || ""}`;
}

async function main(): Promise<void> {
  loadEnvFile();
  const targetUrlText = process.env.DATABASE_URL;
  if (!targetUrlText) throw new Error("缺少 DATABASE_URL");

  const sourceDbName = process.env.SOURCE_DB_NAME || "changan_social_data";
  // 只影响从参考库导入哪一类账号；不影响新库里的监控选择。
  const accountType = process.env.SYNC_ACCOUNT_TYPE || process.env.MONITOR_ACCOUNT_TYPE || "欧洲";

  const source = new Pool({ connectionString: buildSourceUrl(targetUrlText, sourceDbName) });
  const target = new Pool({ connectionString: targetUrlText });

  try {
    const rows = (await source.query(
      `select p.code, p.name, a.handle, a.display_name, a.profile_url
       from social_accounts a
       join platforms p on p.id = a.platform_id
       where a.account_type = $1 and a.active = true
       order by p.code, a.handle`,
      [accountType],
    )).rows;

    if (!rows.length) {
      throw new Error(`源库没有 account_type=${accountType} 的启用账号`);
    }

    const client = await target.connect();
    try {
      await client.query("begin");

      for (const row of rows) {
        await client.query(
          `insert into platforms (code, name, enabled)
           values ($1, $2, true)
           on conflict (code) do update set name = excluded.name, enabled = true`,
          [row.code, row.name],
        );
      }

      const now = Date.now();
      for (const row of rows) {
        await client.query(
          `insert into accounts
             (id, platform_code, handle, display_name, profile_url, account_type, active, created_ts_ms, updated_ts_ms)
           values ('acc-' || md5($1 || ':' || $2), $1, $2, $3, $4, $5, true, $6, $6)
           on conflict (platform_code, handle) do update set
             display_name = excluded.display_name,
             profile_url = excluded.profile_url,
             account_type = excluded.account_type,
             updated_ts_ms = excluded.updated_ts_ms`,
          [row.code, row.handle, row.display_name, row.profile_url, accountType, now],
        );
      }

      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    } finally {
      client.release();
    }

    const counts = await target.query(
      `select platform_code, count(*)::int as accounts
       from accounts
       where active = true and account_type = $1
       group by platform_code
       order by platform_code`,
      [accountType],
    );
    console.log(`已同步 ${rows.length} 个账号（account_type=${accountType}）`);
    console.table(counts.rows);
  } finally {
    await source.end();
    await target.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
