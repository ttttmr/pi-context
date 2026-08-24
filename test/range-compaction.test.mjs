import assert from "node:assert/strict";
import test from "node:test";

import {
    addRangeCompactionAdvisory,
    assignMessageReferences,
    calculateToolCleanup,
    createRangeCompactionState,
    prepareRanges,
    projectRangeCompactions,
    registerRangeCompaction,
    restoreRangeCompactionState,
} from "../dist/range-compaction.js";

const user = (text, timestamp) => ({ role: "user", content: [{ type: "text", text }], timestamp });
const assistant = (text, timestamp) => ({
    role: "assistant",
    content: [{ type: "text", text }],
    provider: "faux",
    model: "test",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp,
});
const toolAssistant = (id, timestamp, name = "read", args = { path: "x.ts" }) => ({
    ...assistant("", timestamp),
    content: [{ type: "toolCall", id, name, arguments: args }],
});
const toolResult = (id, text, timestamp, isError = false, name = "read") => ({
    role: "toolResult",
    toolCallId: id,
    toolName: name,
    content: [{ type: "text", text }],
    isError,
    timestamp,
});

const refsFor = (state, messages) => assignMessageReferences(state, messages).refs;

function addBlock(state, messages, startIndex, endIndex, overrides = {}) {
    const { keys } = assignMessageReferences(state, messages);
    const block = {
        id: `b${state.nextBlockId++}`,
        topic: "investigation",
        startKey: keys[startIndex],
        endKey: keys[endIndex],
        summary: "Investigation completed with decision X.",
        active: true,
        consumedBlockIds: [],
        ...overrides,
    };
    state.blocks.push(block);
    return block;
}

test("replaces a middle range and preserves later messages", () => {
    const state = createRangeCompactionState();
    const messages = [user("goal", 1), assistant("investigate", 2), assistant("decision", 3), user("later constraint", 4)];
    addBlock(state, messages, 1, 2);

    const projected = projectRangeCompactions(state, messages);
    assert.equal(projected.length, 3);
    assert.match(projected[1].content[0].text, /Compacted range b1/);
    assert.match(projected[2].content[0].text, /later constraint/);
});

test("does not inject internal references into normal model context", () => {
    const state = createRangeCompactionState();
    const messages = [user("goal", 1), assistant("plain response", 2), user("continue", 3)];

    const projected = projectRangeCompactions(state, messages);
    assert.deepEqual(projected, messages);
    assert.doesNotMatch(JSON.stringify(projected), /pi-context-message-id/);
});

test("expands a selected tool result to include its assistant tool call", () => {
    const state = createRangeCompactionState();
    const messages = [user("goal", 1), toolAssistant("call-1", 2), toolResult("call-1", "large output", 3), user("continue", 4)];
    const refs = refsFor(state, messages);
    const [range] = prepareRanges(state, messages, [{ start: refs[2], end: refs[2], summary: "Read x.ts." }]);

    assert.equal(range.startIndex, 1);
    assert.equal(range.endIndex, 2);
});

test("rejects overlapping ranges after atomic expansion", () => {
    const state = createRangeCompactionState();
    const messages = [user("goal", 1), toolAssistant("call-1", 2), toolResult("call-1", "output", 3), assistant("done", 4), user("continue", 5)];
    const refs = refsFor(state, messages);

    assert.throws(
        () => prepareRanges(state, messages, [
            { start: refs[1], end: refs[1], summary: "Call summary." },
            { start: refs[2], end: refs[3], summary: "Result summary." },
        ]),
        /overlap/,
    );
});

test("protects the most recent user turn", () => {
    const state = createRangeCompactionState();
    const messages = [user("old", 1), assistant("old reply", 2), user("current", 3), assistant("current reply", 4)];
    const refs = refsFor(state, messages);

    assert.throws(
        () => prepareRanges(state, messages, [{ start: refs[2], end: refs[3], summary: "Current state." }]),
        /protected recent turn/,
    );
});

test("rejects hidden raw message boundaries after compaction", () => {
    const state = createRangeCompactionState();
    const messages = [user("goal", 1), assistant("phase one", 2), assistant("phase two", 3), user("current", 4)];
    addBlock(state, messages, 1, 1);
    const refs = refsFor(state, messages);
    assert.throws(
        () => prepareRanges(state, messages, [{ start: refs[1], end: refs[2], summary: "Combined phases." }]),
        /not visible/,
    );
});

test("supports hierarchical compaction using a block boundary", () => {
    const state = createRangeCompactionState();
    const messages = [user("goal", 1), assistant("phase one", 2), assistant("phase two", 3), user("current", 4)];
    const block = addBlock(state, messages, 1, 1);
    const refs = refsFor(state, messages);
    const [range] = prepareRanges(state, messages, [{ start: block.id, end: refs[2], summary: "Combined phases." }]);

    assert.deepEqual(range.consumedBlockIds, [block.id]);
    assert.match(range.summary, /Previous compacted range b1/);
    assert.equal(range.startIndex, 1);
    assert.equal(range.endIndex, 2);
});

test("deduplicates identical tool calls and prunes operations before a later write", () => {
    const messages = [
        user("old", 1),
        toolAssistant("read-1", 2), toolResult("read-1", "old", 3),
        toolAssistant("write-1", 4, "write", { path: "x.ts", content: "new" }), toolResult("write-1", "ok", 5, false, "write"),
        toolAssistant("bash-1", 6, "bash", { command: "pwd" }), toolResult("bash-1", "a", 7, false, "bash"),
        toolAssistant("bash-2", 8, "bash", { command: "pwd" }), toolResult("bash-2", "b", 9, false, "bash"),
        user("current", 10),
    ];
    const cleanup = calculateToolCleanup(messages);
    assert.deepEqual(new Set(cleanup.prunedToolIds), new Set(["read-1", "bash-1"]));
});

test("does not prune distinct reads because file contents may change externally", () => {
    const messages = [
        user("old", 1),
        toolAssistant("read-1", 2), toolResult("read-1", "old", 3),
        toolAssistant("read-2", 4, "read", { path: "x.ts", offset: 2 }), toolResult("read-2", "new", 5),
        user("current", 6),
    ];
    assert.deepEqual(calculateToolCleanup(messages).prunedToolIds, []);
});

test("purges stale failed inputs but preserves the error result", () => {
    const messages = [
        user("turn one", 1),
        toolAssistant("failed", 2, "bash", { command: "large command" }),
        toolResult("failed", "diagnostic", 3, true, "bash"),
        user("two", 4), user("three", 5), user("four", 6), user("five", 7),
    ];
    const state = createRangeCompactionState();
    state.purgedErrorToolIds = calculateToolCleanup(messages).purgedErrorToolIds;
    const projected = projectRangeCompactions(state, messages);
    const call = projected[1].content.find((part) => part.type === "toolCall");
    assert.match(call.arguments.pruned, /Historical failed tool input/);
    assert.match(projected[2].content[0].text, /diagnostic/);
});

test("adds the range advisory above the usage threshold without requiring ACM", () => {
    const messages = [user("old", 1), assistant("old reply", 2), user("current", 3)];

    assert.equal(addRangeCompactionAdvisory(messages, 84.9, 85), messages);

    const projected = addRangeCompactionAdvisory(messages, 85, 85);
    assert.notEqual(projected, messages);
    assert.match(projected[2].content.at(-1).text, /context_compact_range/);
    assert.match(projected[2].content.at(-1).text, /85\.0%/);
    assert.equal(projected[0], messages[0]);
});

test("automatically prunes and requests compaction at 85 percent", async () => {
    const handlers = new Map();
    const appended = [];
    let compactOptions;
    registerRangeCompaction({
        on(name, handler) { handlers.set(name, handler); },
        registerCommand() {},
        registerTool() {},
        appendEntry(type, data) { appended.push({ type, data: structuredClone(data) }); },
    }, { triggerPercent: 85 });

    const messages = [user("old", 1), assistant("old reply", 2), user("current", 3)];
    await handlers.get("session_start")({}, { sessionManager: { getBranch: () => [] } });
    await handlers.get("context")({ messages }, { getContextUsage: () => ({ percent: 85 }) });
    handlers.get("agent_settled")({}, { compact(options) { compactOptions = options; } });

    assert.equal(appended.length, 1);
    assert.match(compactOptions.customInstructions, /Preserve current task state/);
});

test("registers a model tool that persists and applies ranged compaction", async () => {
    const handlers = new Map();
    const commands = new Map();
    const tools = new Map();
    const appended = [];
    const pi = {
        on(name, handler) { handlers.set(name, handler); },
        registerCommand(name, command) { commands.set(name, command); },
        registerTool(tool) { tools.set(tool.name, tool); },
        appendEntry(type, data) { appended.push({ type, data: structuredClone(data) }); },
    };
    registerRangeCompaction(pi, { triggerPercent: 85 });
    assert.ok(commands.has("context-ranges"));
    assert.ok(tools.has("context_range_inspect"));
    assert.ok(tools.has("context_compact_range"));

    const messages = [user("old goal", 1), assistant("old investigation", 2), user("current task", 3)];
    await handlers.get("session_start")({}, { sessionManager: { getBranch: () => [] } });
    const context = { getContextUsage: () => ({ percent: 85 }) };
    const firstProjection = await handlers.get("context")({ messages }, context);
    assert.doesNotMatch(JSON.stringify(firstProjection.messages), /pi-context-message-id/);

    const inspection = await tools.get("context_range_inspect").execute("inspect", {});
    assert.match(inspection.content[0].text, /m0001 \[user\] old goal/);
    assert.match(inspection.content[0].text, /m0002 \[assistant\] old investigation/);
    assert.doesNotMatch(inspection.content[0].text, /\s{2,}/);

    const result = await tools.get("context_compact_range").execute("call", {
        topic: "old investigation",
        ranges: [{ start: "m0001", end: "m0002", summary: "Old investigation concluded." }],
    });
    assert.match(result.content[0].text, /Compacted 1 range/);
    assert.equal(appended.length, 2);

    const hiddenInspection = await tools.get("context_range_inspect").execute("inspect", {});
    assert.match(hiddenInspection.content[0].text, /b1 \[compacted\] old investigation/);
    assert.doesNotMatch(hiddenInspection.content[0].text, /m0001|m0002/);

    const secondProjection = await handlers.get("context")({ messages }, context);
    assert.equal(secondProjection.messages.length, 2);
    assert.match(secondProjection.messages[0].content[0].text, /Old investigation concluded/);
    assert.match(secondProjection.messages[1].content[0].text, /current task/);
});

test("restores the latest state entry on the active branch", () => {
    const first = createRangeCompactionState();
    first.nextBlockId = 2;
    const second = structuredClone(first);
    second.nextBlockId = 3;
    const restored = restoreRangeCompactionState([
        { type: "custom", customType: "pi-context-range-compaction", data: first },
        { type: "custom", customType: "other", data: {} },
        { type: "custom", customType: "pi-context-range-compaction", data: second },
    ]);
    assert.equal(restored.nextBlockId, 3);
});
