import assert from "node:assert/strict";
import test from "node:test";

import { describeHistoryInterval, estimateHistoryTokens, parseCheckpointPhase } from "../dist/utils.js";

test("parseCheckpointPhase parses only agreed suffixes", () => {
    assert.deepEqual(parseCheckpointPhase("parser-investigation-start"), { scope: "parser-investigation", phase: "start" });
    assert.deepEqual(parseCheckpointPhase("parser-investigation-done"), { scope: "parser-investigation", phase: "done" });
    assert.deepEqual(parseCheckpointPhase("auth-retry-2-pivot"), { scope: "auth-retry-2", phase: "pivot" });
    assert.deepEqual(parseCheckpointPhase("deploy-pause"), { scope: "deploy", phase: "pause" });
    assert.deepEqual(parseCheckpointPhase("deploy-resume"), { scope: "deploy", phase: "resume" });
    assert.equal(parseCheckpointPhase("checkpoint-1"), undefined);
    assert.equal(parseCheckpointPhase("start"), undefined);
    assert.equal(parseCheckpointPhase("parser-startup"), undefined);
});

test("estimateHistoryTokens excludes internal context traffic", () => {
    const internalResult = { type: "message", message: { role: "toolResult", toolName: "context_timeline", content: [{ type: "text", text: "x".repeat(400) }] } };
    const publicResult = { type: "message", message: { role: "toolResult", toolName: "read", content: [{ type: "text", text: "x".repeat(400) }] } };
    assert.equal(estimateHistoryTokens(internalResult), 0);
    assert.ok(estimateHistoryTokens(publicResult) > 0);
    assert.equal(estimateHistoryTokens({ type: "custom_message", customType: "pi-context", content: "ignored" }), 0);
});

test("retained codemode output is counted as task context, including images", () => {
    const content = [{ type: "text", text: "x".repeat(400) }, { type: "image", data: "aW1hZ2U=", mimeType: "image/png" }];
    const entry = { type: "custom_message", customType: "pi-context-codemode-output", content };
    const message = { type: "message", message: { role: "custom", customType: entry.customType, content, display: false, timestamp: 0 } };
    assert.ok(estimateHistoryTokens(entry) > 100);
    assert.equal(estimateHistoryTokens(entry), estimateHistoryTokens(message));
    assert.equal(estimateHistoryTokens({ ...entry, customType: "pi-context-other-internal" }), 0);
});

test("describeHistoryInterval counts roles and estimates tokens", () => {
    const entries = [
        { type: "message", message: { role: "user", content: "please review this" } },
        { type: "message", message: { role: "assistant", content: [{ type: "text", text: "looking" }] } },
        { type: "message", message: { role: "toolResult", toolName: "read", content: [{ type: "text", text: "x".repeat(400) }] } },
    ];
    const description = describeHistoryInterval(entries);
    assert.match(description, /1 user messages/);
    assert.match(description, /1 assistant messages/);
    assert.match(description, /1 tool results/);
    assert.match(description, /~\d+ tokens/);
});
