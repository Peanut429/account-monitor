import path from "node:path";
import { loadEnvFile } from "node:process";
import pg from "pg";

for (const file of [
  path.resolve(process.cwd(), ".env"),
  path.resolve(process.cwd(), "../.env"),
]) {
  try {
    loadEnvFile(file);
    break;
  } catch {
    // 继续尝试下一个位置
  }
}

if (!process.env.DATABASE_URL) {
  throw new Error("缺少 DATABASE_URL（放在 web/.env 或项目根 .env）");
}

const { Pool } = pg;

const globalForDb = globalThis as unknown as { __changanMonitorPool?: pg.Pool };

export const pool = globalForDb.__changanMonitorPool ?? new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 60_000,
  connectionTimeoutMillis: 30_000,
  allowExitOnIdle: true,
});

if (process.env.NODE_ENV !== "production") {
  globalForDb.__changanMonitorPool = pool;
}

export async function rows<T = any>(text: string, params: any[] = []): Promise<T[]> {
  const result = await pool.query(text, params);
  return result.rows as T[];
}
