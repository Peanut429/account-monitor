/**
 * 用 post_metrics.raw_json 里已经保存的 labels/countsText，
 * 回填历史上 LinkedIn 快照里能从 raw_json 解析出的点赞/评论/转发数。
 * 注意：不处理 "次展示"；它的语义未确认，不能当点赞，也不写进 reads。
 *
 * 只填空值，不覆盖已有非空值；可以重复执行。
 *
 *   pnpm run db:backfill-linkedin
 */
import { pool, closeDb } from "../src/db/client.ts";
import { parseLinkedInCounts } from "../src/platforms/linkedin.ts";

type Row = {
  id: string;
  likes: string | null;
  comments: string | null;
  shares: string | null;
  labels: unknown;
  counts_text: string | null;
};

const rows = await pool.query<Row>(`
  select pm.id, pm.likes, pm.comments, pm.shares,
    pm.raw_json->'labels' as labels,
    pm.raw_json->>'countsText' as counts_text
  from post_metrics pm
  join posts p on p.id = pm.post_id
  where p.platform_code = 'linkedin'
    and (pm.likes is null or pm.comments is null or pm.shares is null)
`);

let updated = 0;
for (const row of rows.rows) {
  const labels = Array.isArray(row.labels) ? row.labels.map(String) : [];
  const counts = parseLinkedInCounts(labels, row.counts_text || "");

  const next = {
    likes: row.likes == null ? counts.likes : null,
    comments: row.comments == null ? counts.comments : null,
    shares: row.shares == null ? counts.shares : null,
  };

  if (Object.values(next).every((value) => value == null)) continue;

  await pool.query(`
    update post_metrics
    set likes = coalesce(likes, $1),
        comments = coalesce(comments, $2),
        shares = coalesce(shares, $3)
    where id = $4
  `, [next.likes, next.comments, next.shares, row.id]);
  updated += 1;
}

console.log(`LinkedIn 快照扫描 ${rows.rowCount} 条，回填 ${updated} 条`);
await closeDb();
