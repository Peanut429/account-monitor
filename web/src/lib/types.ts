export type CycleSummary = {
  id: string;
  status: "running" | "success" | "partial_failed" | "failed";
  windowStartTsMs: number;
  windowEndTsMs: number;
  startedTsMs: number;
  finishedTsMs: number | null;
  totalRuns: number;
  successRuns: number;
  failedRuns: number;
};

export type PlatformSummary = {
  code: string;
  name: string;
  accounts: number;
  posts72h: number;
};

export type Overview = {
  accounts: number;
  posts72h: number;
  snapshots72h: number;
  runs72h: number;
  failedRuns72h: number;
  latestCycle: CycleSummary | null;
  platforms: PlatformSummary[];
};

export type AccountListItem = {
  id: string;
  platformCode: string;
  platformName: string;
  handle: string;
  displayName: string | null;
  profileUrl: string;
  followers: number | null;
  following: number | null;
  postsCount: number | null;
  metricsCapturedTsMs: number | null;
  lastRunStatus: string | null;
  lastRunErrorCode: string | null;
  lastRunErrorMessage: string | null;
  lastRunFinishedTsMs: number | null;
  posts72h: number;
  snapshots72h: number;
};

export type AccountDetail = {
  id: string;
  platformCode: string;
  platformName: string;
  handle: string;
  displayName: string | null;
  profileUrl: string;
  accountType: string | null;
  followers: number | null;
  following: number | null;
  postsCount: number | null;
  metricsCapturedTsMs: number | null;
  lastRunStatus: string | null;
  lastRunErrorCode: string | null;
  lastRunErrorMessage: string | null;
  lastRunFinishedTsMs: number | null;
};

export type MetricSnapshot = {
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  reads: number | null;
};

export type PostListItem = {
  id: string;
  url: string;
  contentType: string | null;
  publishedTsMs: number | null;
  title: string | null;
  text: string | null;
  firstSeenTsMs: number;
  lastSeenTsMs: number;
  latestCapturedTsMs: number | null;
  snapshotCount: number;
  latest: MetricSnapshot;
  first: MetricSnapshot;
};

export type SnapshotRow = MetricSnapshot & {
  id: string;
  capturedTsMs: number;
  runStatus: string;
  runError: string | null;
  cycleId: string;
  cycleStatus: string;
  cycleStartedTsMs: number;
  rawJson: unknown;
};

export type PostDetail = {
  id: string;
  url: string;
  platformCode: string;
  platformName: string;
  accountId: string;
  handle: string;
  profileUrl: string;
  contentType: string | null;
  publishedTsMs: number | null;
  title: string | null;
  text: string | null;
  firstSeenTsMs: number;
  lastSeenTsMs: number;
  snapshots: SnapshotRow[];
};

export type ManagedAccount = {
  id: string;
  platformCode: string;
  platformName: string;
  handle: string;
  displayName: string | null;
  profileUrl: string;
  accountType: string | null;
  active: boolean;
  followers: number | null;
  lastRunStatus: string | null;
  lastRunErrorMessage: string | null;
  lastRunFinishedTsMs: number | null;
  posts72h: number;
  createdTsMs: number;
};

export type PlatformOption = {
  code: string;
  name: string;
};

export type AccountManagementData = {
  accounts: ManagedAccount[];
  platforms: PlatformOption[];
};
