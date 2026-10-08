import assert from "node:assert/strict";
import test from "node:test";
import { AgentSession, SessionManager, convertToLlm } from "@earendil-works/pi-coding-agent";

import registerContext from "../dist/index.js";

const outputType = "pi-context-codemode-output";
const image = { type: "image", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB", mimeType: "image/png" };
const rawOutput = [
    { type: "text", text: "Script completed\nWall time: 0.02 seconds\n\n==> text 1/3 <==\nt1: before compact\n" },
    { type: "text", text: "==> text 2/3 <==\nt2: after compact; artifact: /tmp/result.png\n" },
    image,
    { type: "text", text: "==> text 3/3 <==\nvalidation passed\n<console_output>\ndone\n</console_output>" },
];

function usage(input, output, cost) {
    return {
        input, output, cacheRead: 3, cacheWrite: 2, totalTokens: input + output + 5,
        cost: { input: cost / 2, output: cost / 2, cacheRead: 0, cacheWrite: 0, total: cost },
    };
}

function assistant(content, billedUsage = usage(100, 20, 0.02)) {
    return {
        role: "assistant", content, api: "anthropic-messages", provider: "fixture",
        model: "offline", usage: billedUsage, stopReason: "toolUse", timestamp: 1,
    };
}

// SDK 0.85.1 predates codemode. Its SessionManager still accepts the newer
// persisted nestedCalls shape. We simulate that outer result, not a sandbox or
// a model call, and run the real extension plus public SDK navigation/context APIs.
function createHarness({ order = "t1;compact;t2", navigation = "ok", direct = false,
    extraOuterCall = false, pending = false } = {}) {
    const sm = SessionManager.inMemory(process.cwd());
    const rootId = sm.appendMessage({ role: "user", content: "Keep this original prefix.", timestamp: 1 });
    const prefixStore = { set: { keep: "prefix", remove: "obsolete", overwrite: "old" }, delete: [] };
    sm.appendCustomEntry("codemode-store", prefixStore);
    const targetId = sm.appendMessage(assistant([{ type: "text", text: "Stable checkpoint target." }]));
    sm.appendLabelChange(targetId, "output-start");
    const noiseId = sm.appendMessage({ role: "user", content: "NOISY folded investigation", timestamp: 2 });
    sm.appendMessage(assistant([{ type: "text", text: "NOISY prior analysis" }]));
    const priorStore = { set: { earlier: { cursor: 12 }, overwrite: "folded" }, delete: ["remove"] };
    const priorStoreId = sm.appendCustomEntry("codemode-store", priorStore);
    sm.appendCustomEntry("unrelated-extension", { private: "not carried" });

    const parentCallId = "provider/opaque/parent";
    const compactNumber = order.startsWith("compact") ? 1 : 2;
    const executeId = direct ? parentCallId : `${parentCallId}/${compactNumber}`;
    const script = order.startsWith("compact")
        ? "await tools.context_compact({target: 'output-start', summary: 'Next Step: run t1 and t2'}); text(await tools.t1({})); text(await tools.t2({}));"
        : "text(await tools.t1({})); await tools.context_compact({target: 'output-start', summary: 'Next Step: run t2'}); text(await tools.t2({}));";
    const outputContent = structuredClone(rawOutput);
    if (order.startsWith("compact")) {
        outputContent[0].text = outputContent[0].text.replace("t1: before compact", "t1: after compact");
    }
    const requestId = sm.appendMessage(assistant([
        { type: "toolCall", id: parentCallId, name: direct ? "context_compact" : "codemode",
            arguments: direct ? { target: "output-start", summary: "handoff" } : { code: script } },
        ...(extraOuterCall ? [{ type: "toolCall", id: "sibling", name: "read", arguments: { path: "x" } }] : []),
    ]));

    const commands = new Map();
    const tools = new Map();
    const events = new Map();
    const notifications = [];
    const sent = [];
    const navigations = [];
    let resolveCompletion;
    const host = {
        sessionManager: sm,
        isStreaming: false,
        agent: { state: { messages: sm.buildSessionContext().messages } },
        _extensionRunner: {
            hasHandlers: (name) => name === "session_before_tree" && navigation !== "ok",
            emit: async (event) => {
                if (event.type === "session_before_tree") {
                    if (navigation === "throw") throw new Error("fixture navigation failed");
                    if (navigation === "cancel") return { cancel: true };
                }
            },
        },
        _resolveIdleWaitIfIdle: () => {},
        sessionFile: sm.getSessionFile(),
        sessionId: sm.getSessionId(),
        getContextUsage: () => undefined,
    };
    const ctx = {
        sessionManager: sm,
        getContextUsage: () => undefined,
        hasPendingMessages: () => pending,
        abort: () => {},
        ui: {
            notify: (...args) => notifications.push(args),
            getEditorText: () => assert.fail("compaction must not read the editor"),
            setEditorText: () => assert.fail("compaction must not overwrite the editor"),
        },
    };
    const commandCtx = {
        ...ctx,
        waitForIdle: async () => {},
        navigateTree: async (target, options) => {
            const before = sm.getLeafId();
            const result = await AgentSession.prototype.navigateTree.call(host, target, options);
            navigations.push({ target, before, options, result });
            assert.equal(result.editorText, undefined, "extension must navigate the summary, never the custom output");
            return result;
        },
    };
    registerContext({
        registerCommand: (name, definition) => commands.set(name, definition),
        registerTool: (definition) => tools.set(definition.name, definition),
        on: (name, handler) => events.set(name, handler),
        setLabel: (id, label) => sm.appendLabelChange(id, label),
        sendUserMessage: (content, options) => {
            assert.equal(content, "/acm");
            assert.equal(options.expandPromptTemplates, true);
            queueMicrotask(() => { void commands.get("acm").handler("", commandCtx); });
        },
        sendMessage: (message, options) => {
            sent.push({ message, options, leafAtSend: sm.getLeafId() });
            resolveCompletion(sent.at(-1));
        },
    });
    const calls = order.startsWith("compact") ? [
        { id: executeId, name: "context_compact", status: "ok" },
        { id: `${parentCallId}/2`, name: "t1", status: "ok" },
    ] : [
        { id: `${parentCallId}/1`, name: "t1", status: "ok" },
        { id: executeId, name: "context_compact", status: "ok" },
    ];
    calls.push({ id: `${parentCallId}/3`, name: "t2", status: "ok" });
    return {
        sm, host, targetId, rootId, noiseId, priorStoreId, priorStore, prefixStore,
        requestId, executeId, parentCallId, script, calls, outputContent, sent, notifications, navigations,
        compact: (params = {}, id = executeId) => tools.get("context_compact").execute(id, {
            target: "output-start", summary: "Stable handoff. Next Step: run t2.",
            ...params,
        }, undefined, undefined, ctx),
        appendResult: (overrides = {}) => sm.appendMessage({
            role: "toolResult", toolCallId: parentCallId,
            toolName: direct ? "context_compact" : "codemode",
            content: direct ? [{ type: "text", text: "compact start" }] : structuredClone(outputContent),
            usage: usage(40, 15, 0.01), isError: false, timestamp: 3,
            // Model calls appear only in codemode details, not nestedCalls.
            details: { calls: [...calls, { name: "models.generateImages", status: "ok" }] },
            ...(!direct ? { nestedCalls: { complete: true, calls } } : {}),
            ...overrides,
        }),
        finish: async () => {
            const completion = new Promise((resolve) => { resolveCompletion = resolve; });
            await events.get("turn_end")({}, ctx);
            await events.get("agent_end")({}, ctx);
            // sendMessage is the completion oracle for the deferred callback.
            // No sleep or fixed delay: node:test's timeout catches missing delivery.
            return completion;
        },
        stats: () => AgentSession.prototype.getSessionStats.call(host),
    };
}

function retainedOutput(h) {
    return h.sm.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === outputType);
}

function assertNotCompleted(h, delivery, originalLeaf) {
    assert.equal(delivery.leafAtSend, originalLeaf);
    assert.doesNotMatch(delivery.message.content, /context_compact complete/);
    assert.equal(h.notifications.some(([message]) => message.startsWith("Compacted to")), false);
}

for (const order of ["compact;t1;t2", "t1;compact;t2"]) {
    test(`${order}: retain full raw text/images before summary on the real SDK branch`, { timeout: 5000 }, async () => {
        const h = createHarness({ order });
        const requestSnapshot = structuredClone(h.sm.getEntry(h.requestId));
        assert.equal((await h.compact()).content[0].text, "compact start");
        const resultId = h.appendResult();
        const resultSnapshot = structuredClone(h.sm.getEntry(resultId));
        const originalLeaf = h.sm.getLeafId();
        const statsBefore = h.stats();
        const delivery = await h.finish();

        assert.match(delivery.message.content, /context_compact complete/);
        assert.match(delivery.message.content, /do not repeat/i);
        assert.deepEqual(delivery.options, { triggerTurn: true, deliverAs: "followUp" });
        const [output] = retainedOutput(h);
        assert.equal(retainedOutput(h).length, 1);
        assert.deepEqual(output.content.slice(1), resultSnapshot.message.content);
        assert.match(output.content[0].text, /already completed/i);
        assert.match(output.content[0].text, /do not rerun/i);
        assert.equal(output.display, false);
        assert.deepEqual(output.details, { requestEntryId: h.requestId, resultEntryId: resultId });
        assert.equal(output.parentId, h.targetId);
        assert.equal("usage" in output, false);
        assert.equal("message" in output, false);
        assert.equal(JSON.stringify(output).includes(h.script), false);

        const branch = h.sm.getBranch();
        const summary = branch.at(-1);
        assert.equal(summary.type, "branch_summary");
        assert.equal(summary.parentId, branch.at(-2).id);
        assert.equal(summary.fromId, originalLeaf, "source provenance must be the original leaf, not the output/store");
        assert.match(summary.summary, /Stable handoff/);
        assert.equal(branch.some((entry) => entry.id === h.rootId), true);
        assert.equal(branch.some((entry) => entry.id === h.targetId), true);
        assert.equal(branch.some((entry) => entry.id === h.noiseId || entry.id === h.requestId || entry.id === resultId), false);
        assert.equal(branch.some((entry) => entry.type === "message" && entry.message.role === "toolResult"), false);
        assert.deepEqual(h.navigations.map(({ target, before, options }) => ({ target, before, options })), [{
            target: summary.id, before: originalLeaf, options: { summarize: false },
        }]);

        const context = h.sm.buildSessionContext().messages;
        assert.deepEqual(h.host.agent.state.messages, context, "public navigateTree rebuilt model state");
        const outputIndex = context.findIndex((message) => message.role === "custom" && message.customType === outputType);
        const summaryIndex = context.findIndex((message) => message.role === "branchSummary");
        assert.ok(outputIndex >= 0 && outputIndex < summaryIndex);
        assert.deepEqual(context[outputIndex].content.slice(1), h.outputContent);
        const llmContext = convertToLlm(context);
        assert.deepEqual(llmContext[outputIndex].content.slice(1), h.outputContent);
        assert.equal(llmContext[outputIndex].role, "user", "retained output is context, not copied assistant/tool roles");
        assert.equal(JSON.stringify(llmContext).includes("NOISY"), false);
        assert.equal(llmContext.some((message) => message.role === "toolResult"), false);

        assert.deepEqual(h.stats(), statsBefore, "real billed usage, message counts and toolCalls must not be doubled");
        assert.deepEqual(h.sm.getEntry(h.requestId), requestSnapshot);
        assert.deepEqual(h.sm.getEntry(resultId), resultSnapshot);
        const compactedLeaf = h.sm.getLeafId();
        h.sm.branch(originalLeaf);
        assert.equal(h.sm.getBranch().some((entry) => entry.id === h.requestId), true);
        assert.deepEqual(h.sm.getLeafEntry(), resultSnapshot);
        h.sm.branch(compactedLeaf);
    });
}

test("folded codemode-store writes, deletes and current-script writes survive in order without model exposure", { timeout: 5000 }, async () => {
    const h = createHarness();
    await h.compact();
    const resultId = h.appendResult();
    const currentStore = { set: { current: ["artifact", 7], overwrite: "current" }, delete: ["earlier"] };
    h.sm.appendCustomEntry("codemode-store", currentStore);
    const statsBefore = h.stats();
    const originalLeaf = h.sm.getLeafId();
    await h.finish();
    const branch = h.sm.getBranch();
    const [output] = retainedOutput(h);
    const outputIndex = branch.findIndex((entry) => entry.id === output.id);
    const delta = { set: { overwrite: "current", current: ["artifact", 7] }, delete: ["remove"] };
    assert.deepEqual(branch.slice(outputIndex + 1, -1).map((entry) => [entry.type, entry.customType, entry.data]), [
        ["custom", "codemode-store", delta],
    ]);
    const stores = branch.filter((entry) => entry.type === "custom" && entry.customType === "codemode-store");
    assert.deepEqual(stores.map((entry) => entry.data), [h.prefixStore, delta]);
    // This is the newer SDK readCodemodeStore replay format ({set, delete});
    // local SDK 0.85.1 has no codemode runtime, so verify its persisted contract.
    const state = new Map();
    for (const entry of stores) {
        for (const key of entry.data.delete) state.delete(key);
        for (const [key, value] of Object.entries(entry.data.set)) state.set(key, value);
    }
    assert.deepEqual(Object.fromEntries(state), { keep: "prefix", overwrite: "current", current: ["artifact", 7] });
    assert.equal(h.sm.getLeafEntry().fromId, originalLeaf);
    assert.equal(output.details.resultEntryId, resultId);
    assert.equal(branch.some((entry) => entry.type === "custom" && entry.customType === "unrelated-extension"), false);
    assert.equal(JSON.stringify(h.sm.buildSessionContext().messages).includes('"overwrite"'), false);
    assert.deepEqual(h.stats(), statsBefore);
});

test("repeated old-target compacts keep store copies bounded and original states recoverable", { timeout: 5000 }, async () => {
    const h = createHarness();
    const rounds = 12, payload = "x".repeat(2048), originals = [], leaves = [];
    for (let round = 0; round < rounds; round++) {
        const parent = round ? `batch/${round}` : h.parentCallId;
        const id = round ? `${parent}/1` : h.executeId;
        if (round) h.sm.appendMessage(assistant([{ type: "toolCall", id: parent, name: "codemode", arguments: {} }]));
        await h.compact({}, id);
        originals.push(h.sm.appendCustomEntry("codemode-store", {
            set: { cursor: payload + round, overwrite: round, toggle: round }, delete: ["remove", "earlier", "toggle"],
        }));
        h.sm.appendCustomEntry("codemode-store", { set: {}, delete: ["toggle"] });
        h.appendResult({ toolCallId: parent, content: [{ type: "text", text: "batch done" }],
            nestedCalls: { calls: [{ id, name: "context_compact", status: "ok" }] } });
        leaves.push(h.sm.getLeafId());
        await h.finish();
        assert.equal(h.sm.getBranch().filter(entry => entry.type === "custom" && entry.customType === "codemode-store").length, 2);
    }
    const replay = () => {
        const state = new Map();
        for (const entry of h.sm.getBranch()) if (entry.type === "custom" && entry.customType === "codemode-store") {
            for (const key of entry.data.delete) state.delete(key);
            for (const [key, value] of Object.entries(entry.data.set)) state.set(key, value);
        }
        return Object.fromEntries(state);
    };
    const liveLeaf = h.sm.getLeafId();
    for (let round = 0; round < rounds; round++) {
        assert.equal(h.sm.getEntry(originals[round]).data.set.cursor, payload + round);
        h.sm.branch(leaves[round]);
        assert.deepEqual(replay(), { keep: "prefix", overwrite: round, cursor: payload + round });
    }
    h.sm.branch(liveLeaf);
    assert.deepEqual(replay(), { keep: "prefix", overwrite: rounds - 1, cursor: payload + (rounds - 1) });
    assert.equal(h.sm.getEntries().filter(entry => entry.type === "custom" && entry.customType === "codemode-store").length, 2 + 3 * rounds);
});

test("coalesced stores preserve delete-then-set semantics and special key names", { timeout: 5000 }, async () => {
    const h = createHarness();
    await h.compact();
    h.sm.appendCustomEntry("codemode-store", {
        set: { restored: "old", temporary: "gone" }, delete: [],
    });
    h.sm.appendCustomEntry("codemode-store", {
        set: Object.fromEntries([["__proto__", "own-value"], ["constructor", "ordinary"], ["restored", "again"]]),
        delete: ["restored", "__proto__", "temporary"],
    });
    h.appendResult();
    await h.finish();
    const stores = h.sm.getBranch().filter(entry => entry.type === "custom" && entry.customType === "codemode-store");
    assert.equal(stores.length, 2);
    const delta = stores[1].data;
    assert.equal(Object.hasOwn(delta.set, "__proto__"), true);
    assert.equal(delta.set.__proto__, "own-value");
    assert.equal(Object.getPrototypeOf(delta.set), Object.prototype);
    assert.equal(delta.set.constructor, "ordinary");
    assert.equal(delta.set.restored, "again");
    assert.equal(Object.hasOwn(delta.set, "temporary"), false);
    assert.ok(delta.delete.includes("remove"));
    assert.equal(delta.delete.includes("temporary"), false);
    assert.equal(delta.delete.includes("restored") || delta.delete.includes("__proto__"), false);
});

test("incomplete nested record with successful compact still retains complete output", { timeout: 5000 }, async () => {
    const h = createHarness();
    await h.compact();
    h.appendResult({ nestedCalls: { complete: false, calls: h.calls.map((call) => ({
        ...call, ...(call.name === "context_compact" ? { argumentsBytes: 8300 } : {}),
    })) } });
    await h.finish();
    assert.deepEqual(retainedOutput(h)[0].content.slice(1), rawOutput);
});

for (const navigation of ["cancel", "throw"]) {
    test(`${navigation} in public SDK navigation retains original leaf and never announces completion`, { timeout: 5000 }, async () => {
        const h = createHarness({ navigation });
        await h.compact();
        const resultId = h.appendResult();
        const originalLeaf = h.sm.getLeafId();
        const statsBefore = h.stats();
        const delivery = await h.finish();
        assertNotCompleted(h, delivery, originalLeaf);
        assert.match(delivery.message.content, /context_compact failed/);
        assert.equal(h.sm.getLeafId(), originalLeaf);
        assert.equal(retainedOutput(h).length, 0);
        const recoverableSummary = h.sm.getEntries().find((entry) => entry.type === "branch_summary");
        assert.equal(recoverableSummary.fromId, originalLeaf);
        assert.equal(h.sm.getEntry(resultId).message.toolName, "codemode");
        assert.deepEqual(h.stats(), statsBefore);
    });
}

const cancellationCases = [
    ["failed outer script", (h) => h.appendResult({ isError: true })],
    ["missing nested record", (h) => h.appendResult({ nestedCalls: undefined })],
    ["failed compact record", (h) => h.appendResult({ nestedCalls: { complete: true,
        calls: [{ id: h.executeId, name: "context_compact", status: "error" }] } })],
    ["duplicate compact record", (h) => h.appendResult({ nestedCalls: { complete: true,
        calls: [...h.calls, { id: `${h.parentCallId}/5`, name: "context_compact", status: "ok" }] } })],
    ["new user input", (h) => {
        h.appendResult();
        h.sm.appendMessage({ role: "user", content: "New instruction", timestamp: 4 });
    }],
    ["contextual hook before compact", (h) => h.appendResult(), (h) =>
        h.sm.appendCustomMessageEntry("hook", "New context", false)],
    ["contextual hook after compact", (h) => {
        h.appendResult();
        h.sm.appendCustomMessageEntry("hook", "New context", false);
    }],
    ["sibling outer tool call", (h) => h.appendResult(), undefined, { extraOuterCall: true }],
    ["pending input", (h) => h.appendResult(), undefined, { pending: true }],
];
for (const [name, append, before, options] of cancellationCases) {
    test(`${name} cancels before branching on actual SDK history`, { timeout: 5000 }, async () => {
        const h = createHarness(options);
        before?.(h);
        await h.compact();
        append(h);
        const originalLeaf = h.sm.getLeafId();
        const delivery = await h.finish();
        assertNotCompleted(h, delivery, originalLeaf);
        assert.match(delivery.message.content, /context_compact cancelled/);
        assert.equal(h.sm.getEntries().some((entry) => entry.type === "branch_summary"), false);
        assert.equal(h.sm.getEntries().some((entry) => entry.type === "custom_message" && entry.customType === outputType), false);
        assert.equal(h.navigations.length, 0);
    });
}

test("second compact execute invalidates even a caught error and otherwise successful parent", { timeout: 5000 }, async () => {
    const h = createHarness();
    await h.compact();
    await assert.rejects(h.compact({}, `${h.parentCallId}/5`), /only one compact request/);
    h.appendResult();
    const originalLeaf = h.sm.getLeafId();
    const delivery = await h.finish();
    assertNotCompleted(h, delivery, originalLeaf);
    assert.match(delivery.message.content, /more than one compact request/);
    assert.equal(h.sm.getEntries().some((entry) => entry.type === "branch_summary"), false);
});

test("codemode target cannot be its own request or a sibling branch", async () => {
    const h = createHarness();
    await assert.rejects(h.compact({ target: h.requestId }), /must precede the script on the active path/);
    h.sm.branch(h.targetId);
    const siblingId = h.sm.appendMessage(assistant([{ type: "text", text: "Sibling target" }]));
    h.sm.branch(h.requestId);
    await assert.rejects(h.compact({ target: siblingId }), /must precede the script on the active path/);
    assert.equal(h.sm.getLeafId(), h.requestId);
    assert.equal(h.sm.getEntries().some((entry) => entry.type === "branch_summary"), false);
});

test("public SDK custom-message navigation moves content to editor; summary navigation retains it", async () => {
    const h = createHarness();
    h.sm.branch(h.targetId);
    const outputId = h.sm.appendCustomMessageEntry(outputType, structuredClone(rawOutput), false);
    const summaryId = h.sm.branchWithSummary(outputId, "handoff");
    h.sm.branch(h.requestId);
    const customNavigation = await AgentSession.prototype.navigateTree.call(h.host, outputId, { summarize: false });
    assert.equal(h.sm.getLeafId(), h.targetId);
    assert.match(customNavigation.editorText, /t1: before compact/);
    assert.equal(h.host.agent.state.messages.some((message) => message.role === "custom"), false);
    h.sm.branch(h.requestId);
    const summaryNavigation = await AgentSession.prototype.navigateTree.call(h.host, summaryId, { summarize: false });
    assert.equal(summaryNavigation.editorText, undefined);
    assert.equal(h.sm.getLeafId(), summaryId);
    assert.deepEqual(h.host.agent.state.messages.at(-2).content, rawOutput);
    assert.equal(h.host.agent.state.messages.at(-1).role, "branchSummary");
});

test("direct compact keeps original summary-only behavior with no output or store copies", { timeout: 5000 }, async () => {
    const h = createHarness({ direct: true });
    await h.compact();
    h.appendResult();
    const originalLeaf = h.sm.getLeafId();
    await h.finish();
    assert.equal(retainedOutput(h).length, 0);
    assert.equal(h.sm.getLeafEntry().type, "branch_summary");
    assert.equal(h.sm.getLeafEntry().parentId, h.targetId);
    assert.equal(h.sm.getLeafEntry().fromId, originalLeaf);
    assert.equal(h.sm.getBranch().some((entry) => entry.id === h.priorStoreId), false);
});
