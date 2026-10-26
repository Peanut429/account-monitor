import type { DateRangePosition } from "../core/time.ts";

export function nextFacebookDateBoundaryState(
  state: { seenInsideRange: boolean; consecutiveBeforeRange: number },
  input: { position: DateRangePosition; isPinned: boolean },
) {
  if (input.isPinned) return state;
  if (input.position === "inside") {
    return { seenInsideRange: true, consecutiveBeforeRange: 0 };
  }
  if (input.position === "before") {
    return {
      seenInsideRange: state.seenInsideRange,
      consecutiveBeforeRange: state.consecutiveBeforeRange + 1,
    };
  }
  if (input.position === "after") {
    return {
      seenInsideRange: state.seenInsideRange,
      consecutiveBeforeRange: 0,
    };
  }
  return state;
}

export function shouldStopFacebookDateBoundary({
  sinceTime,
  stopAfterBeforeRange,
  seenInsideRange,
  consecutiveBeforeRange,
}: {
  sinceTime: number | null | undefined;
  stopAfterBeforeRange: number;
  seenInsideRange: boolean;
  consecutiveBeforeRange: number;
}) {
  if (sinceTime == null) return false;
  if (stopAfterBeforeRange <= 0) return false;
  return consecutiveBeforeRange >= stopAfterBeforeRange;
}

export function facebookDateBoundaryContext(seenInsideRange: boolean) {
  return seenInsideRange ? "已越过筛选周期边界" : "未发现筛选周期内内容";
}
