import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import registerContext from "../dist/index.js";

function createHarness({ dispatch = "immediate", idle = async () => {}, callName = "context_compact",
    callId = "call", executeId = callId, summary = "Stable result; continue with validation.",
    target = "bbbbbbbb", pending = false, navigation = "ok" } = {}) {
    const commands = new Map();
    const tools = new Map();
    const events = new Map();
    const sent = [];
    const notifications = [];
    const operations = [];
    const entries = [{ id: "bbbbbbbb", type: "message", message: { role: "user", content: "Earlier history" } },
        { id: "aaaaaaaa", type: "message", message: {
        role: "assistant", content: [{ type: "toolCall", id: callId, name: callName, arguments: {} }],
    } }];
    let leaf = "aaaaaaaa";
    const ctx = {
        sessionManager: {
            getLeafId: () => leaf,
            getLabel: () => undefined,
            getBranch: () => entries,
            getTree: () => entries.map(entry => ({ entry, children: [] })),
            branchWithSummary: (target, summary) => {
                operations.push(["summary", target, summary]);
                leaf = "cccccccc";
                return leaf;
            },
            branch: (target) => { leaf = target; },
            appendCustomMessageEntry: (customType, content, display, details) => {
                operations.push(["output", customType, content, details]);
                const id = `output-${entries.length}`;
                entries.push({ id, type: "custom_message", customType, content, display, details });
                leaf = id;
                return id;
            },
            appendCustomEntry: (customType, data) => {
                operations.push(["store", customType, data]);
                const id = `store-${entries.length}`;
                entries.push({ id, type: "custom", customType, data });
                leaf = id;
                return id;
            },
        },
        getContextUsage: () => undefined,
        hasPendingMessages: () => pending,
        abort: () => operations.push(["abort"]),
        ui: {
            notify: (...args) => notifications.push(args),
            getEditorText: () => assert.fail("must not read editor"),
            setEditorText: () => assert.fail("must not overwrite editor"),
        },
    };
    const commandCtx = {
        ...ctx,
        waitForIdle: async () => {
            operations.push(["idle"]);
            await idle();
        },
        navigateTree: async (target) => {
            operations.push(["navigate", target]);
            if (navigation === "throw") throw new Error("navigation failed");
            if (navigation === "ok") leaf = target;
            return { cancelled: navigation === "cancel" };
        },
    };
    const pi = {
        registerCommand: (name, definition) => commands.set(name, definition),
        registerTool: (definition) => tools.set(definition.name, definition),
        on: (name, handler) => events.set(name, handler),
        setLabel: () => {},
        sendMessage: (...args) => operations.push(["continue", ...args]),
        sendUserMessage: (content, options) => {
            sent.push({ content, options });
            if (content !== "/acm") return;
            assert.equal(options.expandPromptTemplates, true);
            if (dispatch === "throw") throw new Error("dispatch failed");
            if (dispatch === "immediate") void commands.get("acm").handler("", commandCtx);
            if (dispatch === "async") queueMicrotask(() => commands.get("acm").handler("", commandCtx));
        },
    };
    registerContext(pi);
    return {
        sent, notifications, operations, commandCtx, entries,
        getLeafId: () => leaf,
        append: (entry) => { entries.push(entry); leaf = entry.id; },
        manual: (args = "") => commands.get("acm").handler(args, commandCtx),
        emit: (name) => events.get(name)?.({}, ctx),
        compact: (signal, id = executeId) => tools.get("context_compact").execute(id, {
            target, summary,
        }, signal, undefined, ctx),
    };
}

for (const dispatch of ["immediate", "async"]) {
    test(`automatically acquires command ctx with ${dispatch} dispatch and reuses it`, async () => {
        const h = createHarness({ dispatch });
        assert.equal((await h.compact()).content[0].text, "compact start");
        await h.compact();
        assert.deepEqual(h.sent, [{
            content: "/acm",
            options: { deliverAs: "followUp", expandPromptTemplates: true },
        }]);
        assert.deepEqual(h.operations, []);
        assert.deepEqual(h.notifications, []);
    });
}

test("manual /acm remains compatible and avoids automatic dispatch", async () => {
    const h = createHarness();
    await h.manual("Continue the task");
    await h.compact();
    assert.deepEqual(h.sent, [{ content: "Continue the task", options: { deliverAs: "followUp" } }]);
    assert.equal(h.notifications.length, 1);
});

test("waits for idle before creating a summary and continuing", async () => {
    let releaseIdle;
    const idle = new Promise((resolve) => { releaseIdle = resolve; });
    const h = createHarness({ idle: () => idle });
    await h.compact();
    await h.emit("turn_end");
    await h.emit("agent_end");
    await delay(10);
    assert.deepEqual(h.operations.map(([name]) => name), ["abort", "idle"]);
    releaseIdle();
    await delay(10);
    assert.deepEqual(h.operations.map(([name]) => name), ["abort", "idle", "summary", "navigate", "continue"]);
});

test("dispatch failure does not schedule compaction or alter the editor", async () => {
    const h = createHarness({ dispatch: "throw" });
    await assert.rejects(h.compact(), /dispatch failed/);
    await h.emit("turn_end");
    await h.emit("agent_end");
    assert.deepEqual(h.operations, []);
});

test("missing command callback times out without scheduling compaction and permits retry", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = createHarness({ dispatch: "none" });
    const failed = assert.rejects(h.compact(), /command context acquisition timed out/);
    t.mock.timers.tick(5000);
    await failed;
    await h.emit("turn_end");
    assert.deepEqual(h.operations, []);
    await h.manual();
    assert.equal((await h.compact()).content[0].text, "compact start");
});

test("session shutdown rejects pending acquisition and a new instance acquires its own ctx", async () => {
    const h = createHarness({ dispatch: "none" });
    const failed = assert.rejects(h.compact(), /session closed/);
    await h.emit("session_shutdown");
    await failed;
    assert.deepEqual(h.operations, []);
    const next = createHarness();
    await next.compact();
    assert.equal(next.sent.length, 1);
});

test("session shutdown while idle is pending prevents stale navigation", async () => {
    let releaseIdle;
    const idle = new Promise((resolve) => { releaseIdle = resolve; });
    const h = createHarness({ idle: () => idle });
    await h.compact();
    await h.emit("agent_end");
    await delay(10);
    await h.emit("session_shutdown");
    releaseIdle();
    await delay(10);
    assert.deepEqual(h.operations.map(([name]) => name), ["idle"]);
});

for (const entry of [
    { id: "user-after-request", type: "message", message: { role: "user", content: "New instruction" } },
    { id: "sibling-result", type: "message", message: { role: "toolResult", toolCallId: "sibling", toolName: "bash", content: [] } },
    { id: "turn-end-message", type: "custom_message", customType: "other-extension", content: "New context" },
]) {
    test(`cancels when ${entry.id} arrives before agent_end`, async () => {
        const h = createHarness();
        await h.compact();
        h.append(entry);
        await h.emit("turn_end");
        await h.emit("agent_end");
        await delay(10);
        assert.equal(h.operations.some(([name]) => name === "summary"), false);
        assert.ok(h.notifications.some(([message]) => message.includes("cancelled")));
    });
}

test("cancels for contextual entries appended by hooks before compact execute", async () => {
    const h = createHarness();
    h.append({ id: "preflight-message", type: "custom_message", content: "New context" });
    await h.compact();
    await h.emit("agent_end");
    await delay(10);
    assert.equal(h.operations.some(([name]) => name === "summary"), false);
});

test("allows own compact result and the empty abort boundary before agent_end", async () => {
    const h = createHarness();
    await h.compact();
    h.append({ id: "own-result", type: "message", message: {
        role: "toolResult", toolCallId: "call", toolName: "context_compact", content: [], isError: false,
    } });
    h.append({ id: "abort-boundary", type: "message", message: {
        role: "assistant", stopReason: "error", errorMessage: "This operation was aborted", content: [],
    } });
    await h.emit("agent_end");
    await delay(10);
    assert.equal(h.operations.filter(([name]) => name === "summary").length, 1);
});

function codemodeResult(overrides = {}) {
    return { id: "codemode-result", type: "message", message: {
        role: "toolResult", toolCallId: "call", toolName: "codemode", content: [], isError: false,
        nestedCalls: { complete: true, calls: [{ id: "call/1", name: "context_compact", status: "ok" }] },
        ...overrides,
    } };
}

test("compacts from a codemode parent and waits for its successful result", async () => {
    const h = createHarness({ callName: "codemode", executeId: "call/1" });
    assert.equal((await h.compact()).content[0].text, "compact start");
    h.append(codemodeResult());
    h.append({ id: "nested-abort-boundary", type: "message", message: {
        role: "assistant", stopReason: "aborted", content: [],
    } });
    h.append({ id: "nested-passive-entry", type: "custom" });
    await h.emit("turn_end");
    await h.emit("agent_end");
    await delay(10);
    assert.deepEqual(h.operations.map(([name]) => name), ["abort", "idle", "output", "summary", "navigate", "continue"]);
});

test("codemode compaction allows long summary arguments omitted by Pi's recorder", async () => {
    const h = createHarness({ callName: "codemode", executeId: "call/1", summary: "x".repeat(8200) });
    await h.compact();
    h.append(codemodeResult({ nestedCalls: { complete: false, calls: [
        { id: "call/1", name: "context_compact", status: "ok", argumentsBytes: 8300 },
    ] } }));
    await h.emit("agent_end");
    await delay(10);
    assert.equal(h.operations.filter(([name]) => name === "summary").length, 1);
});

for (const nestedCalls of [
    undefined,
    { complete: true, calls: [] },
    { complete: true, calls: [{ id: "call/1", name: "context_compact", status: "error" }] },
    { complete: true, calls: [{ id: "call/1", name: "context_compact", status: "unfinished" }] },
    { complete: true, calls: [{ id: "call/2", name: "context_compact", status: "ok" }] },
    { complete: true, calls: [{ id: "call/1", name: "bash", status: "ok" }] },
    { complete: true, calls: [
        { id: "call/1", name: "context_compact", status: "ok" },
        { id: "call/2", name: "context_compact", status: "ok" },
    ] },
]) {
    test(`cancels codemode compaction for unsafe nested record ${JSON.stringify(nestedCalls)}`, async () => {
        const h = createHarness({ callName: "codemode", executeId: "call/1" });
        await h.compact();
        h.append(codemodeResult({ nestedCalls }));
        await h.emit("agent_end");
        await delay(10);
        assert.equal(h.operations.some(([name]) => name === "summary"), false);
        assert.ok(h.notifications.some(([message]) => message.includes("cancelled")));
    });
}

test("codemode compaction retains output even when unrelated nested calls overflow the recorder", async () => {
    const h = createHarness({ callName: "codemode", executeId: "call/1" });
    await h.compact();
    h.append(codemodeResult({ nestedCalls: { complete: false, calls: [
        { id: "call/1", name: "context_compact", status: "ok", argumentsBytes: 8300 },
        ...Array.from({ length: 255 }, (_, index) => ({ id: `call/${index + 2}`, name: "bash", status: "ok" })),
    ] } }));
    await h.emit("agent_end");
    await delay(10);
    assert.equal(h.operations.some(([name]) => name === "summary"), true);
});

for (const overrides of [{ isError: true }, { toolCallId: "other" }, { toolName: "other" }]) {
    test(`cancels codemode compaction for mismatched or failed parent ${JSON.stringify(overrides)}`, async () => {
        const h = createHarness({ callName: "codemode", executeId: "call/1" });
        await h.compact();
        h.append(codemodeResult(overrides));
        await h.emit("agent_end");
        await delay(10);
        assert.equal(h.operations.some(([name]) => name === "summary"), false);
    });
}

test("cancels codemode compaction without a parent result", async () => {
    const h = createHarness({ callName: "codemode", executeId: "call/1" });
    await h.compact();
    await h.emit("agent_end");
    await delay(10);
    assert.equal(h.operations.some(([name]) => name === "summary"), false);
});

test("codemode compaction still detects entries appended before nested execute", async () => {
    const h = createHarness({ callName: "codemode", executeId: "call/1" });
    h.append({ id: "preflight-message", type: "custom_message", content: "New context" });
    await h.compact();
    h.append(codemodeResult());
    await h.emit("agent_end");
    await delay(10);
    assert.equal(h.operations.some(([name]) => name === "summary"), false);
});

test("codemode compaction retains output from tools run before the compact call", async () => {
    const h = createHarness({ callName: "codemode", executeId: "call/2" });
    await h.compact();
    h.append(codemodeResult({ nestedCalls: { complete: true, calls: [
        { id: "call/1", name: "bash", status: "ok" },
        { id: "call/2", name: "context_compact", status: "ok" },
    ] } }));
    await h.emit("agent_end");
    await delay(10);
    assert.equal(h.operations.some(([name]) => name === "summary"), true);
});

test("codemode compaction still detects conversation advancing after the parent result", async () => {
    const h = createHarness({ callName: "codemode", executeId: "call/1" });
    await h.compact();
    h.append(codemodeResult());
    h.append({ id: "later-user", type: "message", message: { role: "user", content: "New instruction" } });
    await h.emit("agent_end");
    await delay(10);
    assert.equal(h.operations.some(([name]) => name === "summary"), false);
});

test("codemode parent IDs remain opaque, even when they contain slashes", async () => {
    const h = createHarness({ callName: "codemode", callId: "provider/opaque/1", executeId: "provider/opaque/1/1" });
    await h.compact();
    h.append(codemodeResult({ toolCallId: "provider/opaque/1", nestedCalls: { complete: true,
        calls: [{ id: "provider/opaque/1/1", name: "context_compact", status: "ok" }] } }));
    await h.emit("agent_end");
    await delay(10);
    assert.equal(h.operations.filter(([name]) => name === "summary").length, 1);
});

for (const options of [
    { callName: "bash", executeId: "call/1" },
    { callName: "codemode", executeId: "caller/1" },
    { callName: "codemode", executeId: "call/not-a-number" },
    { callName: "codemode", executeId: "call/1/1" },
]) {
    test(`does not guess a codemode parent for ${JSON.stringify(options)}`, async () => {
        const h = createHarness(options);
        await assert.rejects(h.compact(), /cannot locate the requesting tool call/);
        assert.deepEqual(h.sent, []);
    });
}

test("codemode retains output from additional tool and model calls after compact", async () => {
    const h = createHarness({ callName: "codemode", executeId: "call/1" });
    await h.compact();
    const content = [{ type: "text", text: "Validation result" }, { type: "image", data: "aW1hZ2U=", mimeType: "image/png" }];
    h.append(codemodeResult({
        content,
        details: { calls: [{ name: "context_compact" }, { name: "models.classify" }] },
        nestedCalls: { complete: true, calls: [
            { id: "call/1", name: "context_compact", status: "ok" },
            { id: "call/2", name: "bash", status: "ok" },
        ] },
    }));
    await h.emit("agent_end");
    await delay(10);
    const output = h.operations.find(([name]) => name === "output");
    assert.ok(output);
    assert.deepEqual(output[2].slice(1), content);
    assert.ok(h.operations.findIndex(([name]) => name === "output") < h.operations.findIndex(([name]) => name === "summary"));
});

test("a truncated record with a known compact result is safe because all parent output is retained", async () => {
    const h = createHarness({ callName: "codemode", executeId: "call/1" });
    await h.compact();
    h.append(codemodeResult({ nestedCalls: { complete: false, calls: [{ id: "call/1", name: "context_compact", status: "ok" }] } }));
    await h.emit("agent_end");
    await delay(10);
    assert.equal(h.operations.some(([name]) => name === "output"), true);
});

test("a second compact request invalidates the first even when the script catches the error", async () => {
    const h = createHarness({ callName: "codemode", executeId: "call/1" });
    await h.compact();
    await assert.rejects(h.compact(undefined, "call/2"), /only one compact request/);
    h.append(codemodeResult());
    await h.emit("agent_end");
    await delay(10);
    assert.equal(h.operations.some(([name]) => name === "output"), false);
    assert.equal(h.operations.some(([name]) => name === "summary"), false);
    assert.ok(h.notifications.some(([message]) => message.includes("more than one compact request")));
});

test("concurrent compact requests cannot overwrite the pending codemode summary", async () => {
    const h = createHarness({ callName: "codemode", executeId: "call/1" });
    const results = await Promise.allSettled([h.compact(), h.compact(undefined, "call/2")]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(results.filter(result => result.status === "rejected").length, 1);
    h.append(codemodeResult());
    await h.emit("agent_end");
    await delay(10);
    assert.equal(h.operations.some(([name]) => name === "summary"), false);
});

for (const target of ["aaaaaaaa", "unknown-target", "dddddddd"]) {
    test(`codemode rejects target ${target} that is not before its request on the active path`, async () => {
        const h = createHarness({ callName: "codemode", executeId: "call/1", target });
        h.append({ id: "dddddddd", type: "custom", customType: "codemode-store" });
        await assert.rejects(h.compact(), /target must precede the script/);
        await h.emit("agent_end");
        assert.deepEqual(h.operations, []);
    });
}

test("codemode compaction rejects parallel outer calls even if their result has not arrived", async () => {
    const h = createHarness({ callName: "codemode", executeId: "call/1" });
    h.entries.find(entry => entry.id === "aaaaaaaa").message.content.push({
        type: "toolCall", name: "codemode", id: "sibling", arguments: {},
    });
    await h.compact();
    h.append(codemodeResult());
    await h.emit("agent_end");
    await delay(10);
    assert.equal(h.operations.some(([name]) => name === "summary"), false);
});

test("duplicate parent results are ambiguous and cancel compaction", async () => {
    const h = createHarness({ callName: "codemode", executeId: "call/1" });
    await h.compact();
    h.append(codemodeResult());
    h.append({ ...codemodeResult(), id: "duplicate-parent-result" });
    await h.emit("agent_end");
    await delay(10);
    assert.equal(h.operations.some(([name]) => name === "summary"), false);
});

test("queued user input cancels compaction before history changes", async () => {
    const h = createHarness({ pending: true });
    await h.compact();
    await h.emit("agent_end");
    await delay(10);
    assert.equal(h.operations.some(([name]) => name === "summary"), false);
});

for (const navigation of ["cancel", "throw"]) {
    test(`navigation ${navigation} keeps the original leaf and never reports completion`, async () => {
        const h = createHarness({ navigation });
        await h.compact();
        await h.emit("agent_end");
        await delay(10);
        assert.equal(h.getLeafId(), "aaaaaaaa");
        assert.ok(h.notifications.some(([message]) => message.includes("failed")));
        assert.ok(!h.operations.some(([name, message]) => name === "continue" && message.content.includes("context_compact complete")));
    });
}

test("aborted tool does not start compaction after acquiring ctx", async () => {
    const h = createHarness();
    await assert.rejects(h.compact(AbortSignal.abort()), /cancelled before compaction started/);
    await h.emit("turn_end");
    assert.deepEqual(h.operations, []);
});
