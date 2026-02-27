export type ContextHealthLevel = "healthy" | "warn" | "critical";
export type ContextAction = "none" | "tag" | "squash";

export interface ContextHealthInput {
  usagePercent: number;
  usageTokens: number;
  contextWindow: number;
  stepsSinceTag: number;
  hasAnyTagOnBranch: boolean;
}

export interface ContextThresholds {
  warnUsagePercent: number;
  squashUsagePercent: number;
  maxSegmentSteps: number;
}

export interface ContextHealthResult {
  level: ContextHealthLevel;
  recommendedAction: ContextAction;
  reasons: string[];
}

export const DEFAULT_THRESHOLDS: ContextThresholds = {
  warnUsagePercent: 70,
  squashUsagePercent: 85,
  maxSegmentSteps: 20,
};

export function evaluateContextHealth(
  input: ContextHealthInput,
  overrides: Partial<ContextThresholds> = {},
): ContextHealthResult {
  const thresholds: ContextThresholds = {
    ...DEFAULT_THRESHOLDS,
    ...overrides,
  };

  const reasons: string[] = [];

  if (input.usagePercent >= thresholds.squashUsagePercent) {
    reasons.push(
      `Context usage is ${input.usagePercent.toFixed(1)}% (>= ${thresholds.squashUsagePercent}%).`,
    );
    return {
      level: "critical",
      recommendedAction: "squash",
      reasons,
    };
  }

  if (input.stepsSinceTag >= thresholds.maxSegmentSteps * 2) {
    reasons.push(
      `Segment size is ${input.stepsSinceTag} steps (>= ${thresholds.maxSegmentSteps * 2}).`,
    );
    return {
      level: "critical",
      recommendedAction: "squash",
      reasons,
    };
  }

  if (input.stepsSinceTag >= thresholds.maxSegmentSteps) {
    reasons.push(
      `Segment size is ${input.stepsSinceTag} steps (>= ${thresholds.maxSegmentSteps}).`,
    );
    return {
      level: "warn",
      recommendedAction: "tag",
      reasons,
    };
  }

  if (!input.hasAnyTagOnBranch && input.stepsSinceTag >= 3) {
    reasons.push("No tags found on current branch; create first milestone.");
    return {
      level: "warn",
      recommendedAction: "tag",
      reasons,
    };
  }

  if (input.usagePercent >= thresholds.warnUsagePercent) {
    reasons.push(
      `Context usage is ${input.usagePercent.toFixed(1)}% (>= ${thresholds.warnUsagePercent}%).`,
    );
    return {
      level: "warn",
      recommendedAction: "none",
      reasons,
    };
  }

  reasons.push("Context health is stable.");
  return {
    level: "healthy",
    recommendedAction: "none",
    reasons,
  };
}
