import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { loadEnvFile } from "../config/env.ts";

const { Client } = pg;

async function main(): Promise<void> {
  loadEnvFile();
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("缺少 DATABASE_URL");

  // 不能用 new URL() 往返，密码里的 % 会被重新编码。
  const match = databaseUrl.match(/^(.*\/)([^/?]+)(\?.*)?$/);
  if (!match) throw new Error("DATABASE_URL 格式不正确");
  const databaseName = match[2];
  if (!/^[a-zA-Z0-9_]+$/.test(databaseName)) {
    throw new Error(`库名不合法：${databaseName}`);
  }

  const adminUrl = `${match[1]}postgres${match[3] || ""}`;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    const exists = await admin.query("select 1 from pg_database where datname = $1", [databaseName]);
    if (!exists.rowCount) {
      await admin.query(`create database "${databaseName}"`);
      console.log(`已创建数据库：${databaseName}`);
    } else {
      console.log(`数据库已存在：${databaseName}`);
    }
  } finally {
    await admin.end();
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const schemaSql = fs.readFileSync(path.join(process.cwd(), "db/001_init.sql"), "utf8");
    await client.query(schemaSql);
    const counts = await client.query(
      `select
         (select count(*)::int from platforms) as platforms,
         (select count(*)::int from accounts) as accounts,
         (select count(*)::int from monitor_cycles) as cycles`,
    );
    console.log("schema 完成：", counts.rows[0]);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
