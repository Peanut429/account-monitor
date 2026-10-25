import pg from "pg";
import { loadEnvFile } from "../config/env.ts";

loadEnvFile();

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error("缺少 DATABASE_URL 环境变量");
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.DB_POOL_MAX || 5),
  idleTimeoutMillis: 60_000,
  connectionTimeoutMillis: 30_000,
  allowExitOnIdle: true,
});

pool.on("error", (error) => {
  console.error("PG pool error:", error.message);
});

export async function closeDb(): Promise<void> {
  await pool.end();
}
