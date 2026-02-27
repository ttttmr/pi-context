import test from "node:test";
import assert from "node:assert/strict";

import { evaluateContextHealth } from "./self-manage.js";

test("returns critical+squash when usage is above squash threshold", () => {
  const result = evaluateContextHealth({
    usagePercent: 90,
    usageTokens: 90000,
    contextWindow: 100000,
    stepsSinceTag: 3,
    hasAnyTagOnBranch: true,
  });

  assert.equal(result.level, "critical");
  assert.equal(result.recommendedAction, "squash");
});

test("returns warn+tag when segment exceeds maxSegmentSteps", () => {
  const result = evaluateContextHealth(
    {
      usagePercent: 40,
      usageTokens: 4000,
      contextWindow: 10000,
      stepsSinceTag: 21,
      hasAnyTagOnBranch: true,
    },
    {
      maxSegmentSteps: 20,
    },
  );

  assert.equal(result.level, "warn");
  assert.equal(result.recommendedAction, "tag");
});

test("returns warn+tag when branch has no tags and drift starts", () => {
  const result = evaluateContextHealth({
    usagePercent: 35,
    usageTokens: 3500,
    contextWindow: 10000,
    stepsSinceTag: 3,
    hasAnyTagOnBranch: false,
  });

  assert.equal(result.level, "warn");
  assert.equal(result.recommendedAction, "tag");
});

test("returns healthy+none for stable context", () => {
  const result = evaluateContextHealth({
    usagePercent: 25,
    usageTokens: 2500,
    contextWindow: 10000,
    stepsSinceTag: 2,
    hasAnyTagOnBranch: true,
  });

  assert.equal(result.level, "healthy");
  assert.equal(result.recommendedAction, "none");
});
