import type { Page } from "playwright";

export type AccountRow = {
  id: string;
  platformCode: string;
  handle: string;
  displayName?: string | null;
  profileUrl: string;
};

export type MetricSet = {
  views?: number | null;
  likes?: number | null;
  comments?: number | null;
  shares?: number | null;
  saves?: number | null;
  reads?: number | null;
};

export type PostRow = {
  externalId: string;
  url: string;
  contentType?: string | null;
  publishedTsMs?: number | null;
  publishedPrecision?: "second" | "minute" | "day" | "relative" | "unknown" | null;
  title?: string | null;
  text?: string | null;
  metrics: MetricSet;
  raw?: unknown;
};

export type AccountMetrics = {
  followers?: number | null;
  following?: number | null;
  postsCount?: number | null;
  raw?: unknown;
};

export type ScrapeLogExtra = {
  pageUrl?: string;
  errorCode?: string;
  context?: Record<string, unknown>;
};

export type ScrapeLog = (
  level: "debug" | "info" | "warn" | "error",
  step: string,
  message: string,
  extra?: ScrapeLogExtra,
) => Promise<void>;

export type ScrapeContext = {
  page: Page | null;
  account: AccountRow;
  sinceTsMs: number;
  untilTsMs: number;
  log: ScrapeLog;
};

export type ScrapeResult = {
  accountMetrics: AccountMetrics;
  posts: PostRow[];
};

export type PlatformAdapter = {
  code: string;
  name: string;
  loginUrl: string;
  needsPage?: boolean;
  scrapeAccount(ctx: ScrapeContext): Promise<ScrapeResult>;
};
