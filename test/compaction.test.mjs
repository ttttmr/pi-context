import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
    buildSessionProjection, createAgentSession, createCodemodeExtension, DefaultResourceLoader,
    ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, Type } from "@earendil-works/pi-ai";
import { getKeybindings, KeybindingsManager, setKeybindings } from "@earendil-works/pi-tui";

import registerContext from "../dist/index.js";
import { getCompactionProjection } from "../dist/compaction-context.js";

// End-to-end on a real AgentSession: the faux provider records each request's
// provider-visible messages, so assertions cover what the model actually sees.
async function createHarness({ codemode = false, onEcho, settings = {}, persistent = false, sessionFile } = {}) {
    const dir = await mkdtemp(join(tmpdir(), "pi-context-test-"));
    const faux = fauxProvider();
    const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
    modelRuntime.registerNativeProvider(faux.provider);
    const requests = [];
    const errors = [];
    let session;
    const extension = (pi) => {
        registerContext(pi);
        pi.registerTool({
            name: "echo", label: "echo", description: "Echo text.", parameters: Type.Object({ s: Type.String() }),
            ...(codemode ? { exposure: "codemode" } : {}),
            async execute(_id, { s }) {
                await onEcho?.(s, session);
                return { content: [{ type: "text", text: `echo:${s}` }], details: undefined };
            },
        });
    };
    const loader = new DefaultResourceLoader({
        cwd: dir, agentDir: dir, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        extensionFactories: [extension, ...(codemode ? [createCodemodeExtension({ mode: "only" })] : [])],
    });
    await loader.reload();
    const sm = sessionFile ? SessionManager.open(sessionFile) :
        persistent ? SessionManager.create(dir, dir) : SessionManager.inMemory(dir);
    ({ session } = await createAgentSession({
        cwd: dir, agentDir: dir, model: faux.getModel(), modelRuntime, resourceLoader: loader, sessionManager: sm,
        settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, ...settings }),
        tools: [...(codemode ? ["codemode"] : []), "echo", "context_compact", "context_timeline", "context_checkpoint"],
    }));
    session.extensionRunner.onError((error) => errors.push(error));
    return {
        session, sm, faux, requests, errors,
        reply: (...blocks) => (context) => {
            requests.push(context.messages);
            return fauxAssistantMessage(blocks.length === 1 && typeof blocks[0] === "string" ? blocks[0] : blocks);
        },
        call: (name, args, id) => fauxToolCall(name, args, { id }),
        label: (name) => sm.appendLabelChange(sm.getLeafId(), name),
        async run(prompt, responses) {
            faux.setResponses(responses);
            await session.prompt(prompt);
            assert.equal(faux.getPendingResponseCount(), 0, "every scripted response was requested");
        },
        async dispose() {
            session.dispose();
            await rm(dir, { recursive: true, force: true });
        },
    };
}

const textOf = (content) => typeof content === "string" ? content
    : content.filter((block) => block.type === "text").map((block) => block.text).join("");

// Compact, provider-visible transcript without the leading system prompt.
const view = (messages) => messages.filter((message) => message.role !== "system").map((message) => {
    if (message.role === "assistant") {
        return `assistant:${textOf(message.content)}` +
            message.content.filter((block) => block.type === "toolCall").map((block) => ` call:${block.name}`).join("");
    }
    if (message.role === "toolResult") return `result:${message.toolName}:${textOf(message.content)}`;
    return `${message.role}:${textOf(message.content)}`;
});

const pairsAreClosed = (messages) => {
    const calls = new Set();
    for (const message of messages) {
        if (message.role === "assistant") for (const block of message.content) if (block.type === "toolCall") calls.add(block.id);
        if (message.role === "toolResult" && !calls.delete(message.toolCallId)) return false;
    }
    return calls.size === 0;
};

test("folds history after the target in the same run and keeps sibling outputs", { timeout: 10000 }, async () => {
    const h = await createHarness();
    try {
        await h.run("first", [h.reply("TARGET answer")]);
        h.label("phase-start");
        await h.run("noisy request", [
            h.reply(h.call("echo", { s: "noise" }, "n1")),
            h.reply(h.call("echo", { s: "sibling" }, "s1"), h.call("context_compact", {
                target: "phase-start", summary: "SUMMARY_CANARY. Next: finish.", backupCheckpoint: "phase-raw",
            }, "c1")),
            h.reply(h.call("context_timeline", {}, "t1")),
            h.reply("done"),
        ]);
        assert.deepEqual(h.errors, []);
        const afterCompact = h.requests[3];
        const visible = view(afterCompact);
        assert.equal(visible.length, 3, JSON.stringify(visible));
        assert.deepEqual(visible.slice(0, 2), ["user:first", "assistant:TARGET answer"]);
        assert.match(visible[2], /^user:context_compact complete\. Your previous conversation after phase-start was summarized \(backup checkpoint: phase-raw\)/s);
        assert.match(visible[2], /SUMMARY_CANARY/);
        assert.match(visible[2], /\[echo \{"s":"sibling"\}\]\necho:sibling/);
        assert.doesNotMatch(visible[2], /noise|compact start/);
        assert.ok(pairsAreClosed(afterCompact));
        const compact = h.sm.getBranch().find((entry) => entry.type === "custom_message" && entry.customType === "pi-context-compaction");
        assert.ok(compact.details.range.afterId && compact.details.range.throughId);

        // Raw history is untouched; the backup label restores the original context.
        const backupId = h.sm.getBranch().find((entry) => h.sm.getLabel(entry.id) === "phase-raw")?.id;
        assert.ok(backupId);
        const original = view(buildSessionProjection(h.sm.getEntries(), backupId).messages);
        assert.ok(original.includes("result:echo:echo:noise") && original.includes("result:echo:echo:sibling"));

        const timeline = textOf(h.requests[4].at(-1).content);
        assert.match(timeline, /checkpoint: phase-start/);
        assert.match(timeline, /compacted: 1 user messages · 2 assistant messages · 2 tool results/);
        assert.match(timeline, /\(compacted: not a compact target, checkpoint: phase-raw\)/);
        assert.match(timeline, /\[SUMMARY\] \(compacted 6 entries after phase-start · ~\d+ tokens\) SUMMARY_CANARY/);
        assert.doesNotMatch(timeline, /noisy request/);
    } finally { await h.dispose(); }
});

test("codemode keeps the whole script output and folded store state", { timeout: 10000 }, async () => {
    const h = await createHarness({ codemode: true });
    try {
        await h.run("first", [h.reply("TARGET answer")]);
        h.label("phase-start");
        await h.run("noisy request", [
            h.reply(h.call("codemode", { code: "store('folded', 1); text(await tools.echo({ s: 'noise' }));" }, "n1")),
            h.reply(h.call("codemode", { code: [
                "text(await tools.echo({ s: 'before' }));",
                "await tools.context_compact({ target: 'phase-start', summary: 'SUMMARY_CANARY' });",
                "text(await tools.echo({ s: 'after' })); store('after', 2);",
            ].join("\n") }, "cm1")),
            h.reply(h.call("codemode", { code: "text(JSON.stringify([load('folded'), load('after')]));" }, "cm2")),
            h.reply("done"),
        ]);
        assert.deepEqual(h.errors, []);
        const visible = view(h.requests[3]);
        assert.equal(visible.length, 3, JSON.stringify(visible));
        assert.match(visible[2], /SUMMARY_CANARY[\s\S]*\[codemode\]\nScript completed[\s\S]*echo:before[\s\S]*echo:after/);
        assert.doesNotMatch(visible[2], /noise/);
        assert.match(view(h.requests[4]).at(-1), /\[1,2\]/);
    } finally { await h.dispose(); }
});

test("steering sent while the compact step runs arrives after the summary", { timeout: 10000 }, async () => {
    const h = await createHarness({ onEcho: async (s, session) => { if (s === "steer") await session.steer("STEER_CANARY"); } });
    try {
        await h.run("first", [h.reply("TARGET answer")]);
        h.label("phase-start");
        await h.run("noisy request", [
            h.reply(h.call("echo", { s: "steer" }, "s1"), h.call("context_compact", { target: "phase-start", summary: "SUMMARY_CANARY" }, "c1")),
            h.reply("done"),
        ]);
        const visible = view(h.requests[2]);
        assert.match(visible.at(-2), /SUMMARY_CANARY/);
        assert.equal(visible.at(-1), "user:STEER_CANARY");
    } finally { await h.dispose(); }
});

test("two compact requests in one step fold nothing", { timeout: 10000 }, async () => {
    const h = await createHarness();
    try {
        await h.run("first", [h.reply("TARGET answer")]);
        h.label("phase-start");
        await h.run("noisy request", [
            h.reply(h.call("context_compact", { target: "phase-start", summary: "A" }, "c1"),
                h.call("context_compact", { target: "phase-start", summary: "B" }, "c2")),
            h.reply("done"),
        ]);
        const visible = view(h.requests[2]);
        assert.ok(visible.includes("user:noisy request"));
        assert.match(visible.at(-1), /context_compact cancelled: more than one compact request/);
    } finally { await h.dispose(); }
});

test("rejects targets that are not visible entries before the request", { timeout: 10000 }, async () => {
    const h = await createHarness();
    try {
        await h.run("first", [h.reply("TARGET answer")]);
        h.label("phase-start");
        await h.run("noisy", [h.reply(h.call("echo", { s: "noise" }, "n1")), h.reply("noted")]);
        h.label("inner-start");
        await h.run("compact", [
            h.reply(h.call("context_compact", { target: "missing-label", summary: "X" }, "c0")),
            h.reply(h.call("context_compact", { target: "phase-start", summary: "SUMMARY_ONE" }, "c1")),
            h.reply(h.call("context_compact", { target: "inner-start", summary: "SUMMARY_TWO" }, "c2")),
            h.reply("done"),
        ]);
        assert.match(view(h.requests[4]).at(-1), /result:context_compact:context_compact: target missing-label was not found/);
        assert.match(view(h.requests[6]).at(-1), /result:context_compact:.*inside history that was already compacted/);
        assert.ok(view(h.requests[6]).some((line) => line.includes("SUMMARY_ONE")));
    } finally { await h.dispose(); }
});

const toolResults = (sm, toolName) => Object.fromEntries(sm.getBranch()
    .filter((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === toolName)
    .map(({ message }) => [message.toolCallId, { isError: message.isError, text: textOf(message.content) }]));

const labeledIds = (sm, name) => sm.getEntries().filter((entry) => sm.getLabel(entry.id) === name).map((entry) => entry.id);

test("checkpoint names stay unique, resolvable, and never replace another checkpoint", { timeout: 10000 }, async () => {
    const h = await createHarness();
    try {
        await h.run("first", [h.reply("TARGET answer")]);
        await h.run("checkpoints", [
            h.reply(h.call("context_checkpoint", { name: "abcdef12" }, "k1")),
            h.reply(h.call("context_checkpoint", { name: "abcdef12" }, "k2")),
            h.reply(h.call("context_checkpoint", { name: "Root" }, "k3")),
            h.reply(h.call("context_checkpoint", { name: "other", target: "abcdef12" }, "k4")),
            h.reply(h.call("context_checkpoint", { name: "other", target: "missing" }, "k5")),
            h.reply(h.call("context_checkpoint", { name: " " }, "k6")),
            h.reply(h.call("echo", { s: "noise" }, "n1")),
            h.reply(h.call("context_compact", { target: "abcdef12", summary: "SUMMARY_CANARY" }, "c1")),
            h.reply("done"),
        ]);
        const results = toolResults(h.sm, "context_checkpoint");
        assert.equal(results.k1.isError, false);
        assert.match(results.k2.text, /Checkpoint 'abcdef12' already exists/);
        assert.match(results.k3.text, /reserved: root means the start of the current context/);
        assert.match(results.k4.text, /already has checkpoint 'abcdef12'/);
        assert.match(results.k5.text, /Target missing was not found/);
        assert.match(results.k6.text, /must not be empty/);
        for (const id of ["k2", "k3", "k4", "k5", "k6"]) assert.equal(results[id].isError, true, id);
        assert.equal(labeledIds(h.sm, "abcdef12").length, 1);
        assert.deepEqual(labeledIds(h.sm, "other"), []);
        // A hex-like checkpoint name resolves as a checkpoint, not as an entry ID.
        assert.equal(toolResults(h.sm, "context_compact").c1.isError, false);
        const visible = view(h.requests.at(-1));
        assert.ok(visible.some((line) => line.includes("SUMMARY_CANARY")));
        assert.ok(!visible.some((line) => line.includes("echo:noise")));
    } finally { await h.dispose(); }
});

test("backupCheckpoint must be a new checkpoint name", { timeout: 10000 }, async () => {
    const h = await createHarness();
    try {
        await h.run("first", [h.reply("TARGET answer")]);
        h.label("phase-start");
        await h.run("noisy", [
            h.reply(h.call("echo", { s: "noise" }, "n1")),
            h.reply(h.call("context_compact", { target: "phase-start", summary: "A", backupCheckpoint: "phase-start" }, "c1")),
            h.reply(h.call("context_compact", { target: "phase-start", summary: "B", backupCheckpoint: "phase-raw" }, "c2"),
                h.call("context_checkpoint", { name: "phase-raw" }, "k1")),
            h.reply("done"),
        ]);
        const compacts = toolResults(h.sm, "context_compact");
        assert.equal(compacts.c1.isError, true);
        assert.match(compacts.c1.text, /backupCheckpoint: Checkpoint 'phase-start' already exists/);
        assert.match(toolResults(h.sm, "context_checkpoint").k1.text, /reserved as the backup checkpoint of a pending compaction/);
        assert.equal(labeledIds(h.sm, "phase-start").length, 1);
        assert.equal(labeledIds(h.sm, "phase-raw").length, 1);
        assert.match(view(h.requests.at(-1)).at(-1), /summarized \(backup checkpoint: phase-raw\)/);
    } finally { await h.dispose(); }
});

test("duplicate labels set outside the tools resolve to the newest on the active path", { timeout: 10000 }, async () => {
    const h = await createHarness();
    try {
        await h.run("first", [h.reply("A")]);
        h.label("dup");
        await h.run("middle", [h.reply("B")]);
        h.label("dup");
        await h.run("compact", [
            h.reply(h.call("context_compact", { target: "dup", summary: "SUMMARY_CANARY" }, "c1")),
            h.reply("done"),
        ]);
        const visible = view(h.requests.at(-1));
        assert.deepEqual(visible.slice(0, 4), ["user:first", "assistant:A", "user:middle", "assistant:B"]);
        assert.ok(!visible.includes("user:compact"));
    } finally { await h.dispose(); }
});

test("a target assistant keeps its own tool results", { timeout: 10000 }, async () => {
    const h = await createHarness();
    try {
        await h.run("first", [h.reply(h.call("echo", { s: "kept" }, "k1")), h.reply("TARGET answer")]);
        const targetCall = h.sm.getBranch().find((entry) => entry.type === "message" && entry.message.role === "assistant");
        h.sm.appendLabelChange(targetCall.id, "call-start");
        await h.run("noisy", [
            h.reply(h.call("context_compact", { target: "call-start", summary: "SUMMARY_CANARY" }, "c1")),
            h.reply("done"),
        ]);
        const afterCompact = h.requests.at(-1);
        assert.deepEqual(view(afterCompact).slice(0, 3), ["user:first", "assistant: call:echo", "result:echo:echo:kept"]);
        assert.ok(pairsAreClosed(afterCompact));
    } finally { await h.dispose(); }
});

test("repeated compaction to root also folds the earlier summary", { timeout: 10000 }, async () => {
    const h = await createHarness();
    try {
        await h.run("first", [h.reply("TARGET answer")]);
        h.label("phase-start");
        await h.run("work", [
            h.reply(h.call("context_compact", { target: "phase-start", summary: "SUMMARY_ONE" }, "c1")),
            h.reply(h.call("context_compact", { target: "root", summary: "SUMMARY_TWO" }, "c2")),
            h.reply("done"),
        ]);
        const visible = view(h.requests.at(-1));
        assert.equal(visible.length, 1, JSON.stringify(visible));
        assert.match(visible[0], /conversation after root was summarized[\s\S]*SUMMARY_TWO/);
    } finally { await h.dispose(); }
});

test("after Pi native compaction, targets outside model context are rejected; later targets and root fold cleanly", { timeout: 10000 }, async () => {
    const h = await createHarness({ settings: { compaction: { enabled: false, keepRecentTokens: 20 } } });
    try {
        await h.run("first", [h.reply("OLD answer")]);
        h.label("old-start");
        await h.run("noise one", [h.reply(h.call("echo", { s: "old-noise " + "x".repeat(400) }, "n1")), h.reply("noted")]);
        await h.run("recent turn", [h.reply("RECENT answer")]);
        h.faux.appendResponses([h.reply("NATIVE_SUMMARY"), h.reply("NATIVE_SUMMARY")]);
        await h.session.compact();
        await h.run("after native", [h.reply("KEPT answer")]);
        h.label("late-start");
        await h.run("noise two", [h.reply(h.call("echo", { s: "late-noise" }, "n2")), h.reply("noted")]);
        await h.run("timeline", [h.reply(h.call("context_timeline", {}, "t0")), h.reply("seen")]);
        const timeline = textOf(h.requests.at(-1).at(-1).content);
        assert.match(timeline, /\(compacted: not a compact target, checkpoint: old-start, phase: start\)/);
        assert.doesNotMatch(timeline, /ROOT, compacted/);
        assert.match(timeline, /compacted: .*user messages/);
        assert.match(timeline, /checkpoint: late-start/);
        assert.doesNotMatch(timeline, /compacted: not a compact target, checkpoint: late-start/);
        assert.doesNotMatch(timeline, /noise one/);
        await h.run("compact", [
            h.reply(h.call("context_compact", { target: "old-start", summary: "X" }, "c0")),
            h.reply(h.call("context_compact", { target: "late-start", summary: "SUMMARY_LATE" }, "c1")),
            h.reply(h.call("context_compact", { target: "root", summary: "SUMMARY_ROOT" }, "c2")),
            h.reply("done"),
        ]);
        assert.deepEqual(h.errors, []);
        const rejected = view(h.requests.at(-3)).at(-1);
        assert.match(rejected, /old-start is inside history that was already compacted/);
        const late = view(h.requests.at(-2));
        assert.ok(late.some((line) => line.includes("NATIVE_SUMMARY")), "native summary still leads the context");
        assert.ok(late.includes("assistant:KEPT answer"));
        assert.ok(late.some((line) => line.includes("SUMMARY_LATE")));
        assert.ok(!late.some((line) => line.includes("late-noise")));
        assert.ok(pairsAreClosed(h.requests.at(-2)));
        // Root folds every editable entry of the current context; the native summary cannot be omitted.
        const root = view(h.requests.at(-1));
        assert.ok(root.some((line) => line.includes("SUMMARY_ROOT")));
        assert.ok(!root.some((line) => /KEPT answer|SUMMARY_LATE|late-noise/.test(line)));
        assert.ok(pairsAreClosed(h.requests.at(-1)));
    } finally { await h.dispose(); }
});

test("a step interrupted by the user does not fold history", { timeout: 10000 }, async () => {
    const h = await createHarness({
        onEcho: async (s, session) => {
            if (s !== "abort") return;
            setTimeout(() => void session.abort(), 0);
            await delay(50);
        },
    });
    try {
        await h.run("first", [h.reply("TARGET answer")]);
        h.label("phase-start");
        h.faux.setResponses([
            h.reply(h.call("echo", { s: "abort" }, "a1"), h.call("context_compact", { target: "phase-start", summary: "X" }, "c1")),
        ]);
        await h.session.prompt("noisy request");
        assert.ok(h.sm.getBranch().some((entry) => entry.type === "custom_message" &&
            textOf(entry.content).includes("context_compact cancelled: the request was interrupted.\nNo compaction was applied")));
    } finally { await h.dispose(); }
});

test("/acm remains a compatibility command", async () => {
    const commands = new Map();
    const sent = [];
    const notifications = [];
    registerContext({
        registerCommand: (name, definition) => commands.set(name, definition),
        registerTool: () => {}, registerMessageRenderer: () => {}, on: () => {},
        sendUserMessage: (content, options) => sent.push({ content, options }),
    });
    const ctx = { ui: { notify: (...args) => notifications.push(args) } };
    await commands.get("acm").handler("", ctx);
    await commands.get("acm").handler("continue the task", ctx);
    assert.match(notifications[0][0], /always enabled/);
    assert.deepEqual(sent, [{ content: "continue the task", options: { deliverAs: "followUp" } }]);
});

test("summary renderer collapses to the title and shows the summary and kept tool outputs when expanded", () => {
    let render;
    registerContext({
        registerCommand: () => {}, registerTool: () => {}, on: () => {},
        registerMessageRenderer: (type, renderer) => { if (type === "pi-context-compaction") render = renderer; },
    });
    const theme = { fg: (_color, text) => text, bg: (_color, text) => text, bold: (text) => text };
    const message = {
        role: "custom", customType: "pi-context-compaction", display: true, timestamp: 0,
        content: [{ type: "text", text: "Context compacted...\n\nSUMMARY_CANARY" }, { type: "text", text: "\n[read]\nOUTPUT_CANARY" }],
        details: { target: "phase-start", summary: "SUMMARY_CANARY", folded: 6, foldedTokens: 1200, retained: 1, backupCheckpoint: "raw" },
    };
    // Interactive mode installs the app keybindings that the expand hint reads.
    const previous = getKeybindings();
    setKeybindings(new KeybindingsManager({ "app.tools.expand": { defaultKeys: "ctrl+o" } }));
    try {
        const collapsed = render(message, { expanded: false, outputPad: 1 }, theme).render(120).join("\n");
        const expanded = render(message, { expanded: true, outputPad: 1 }, theme).render(120).join("\n");
        assert.match(collapsed, /Context compacted to phase-start · 6 entries \(~1k tokens\) · kept 1 tool outputs · backup: raw \(ctrl\+o to expand\)/);
        assert.doesNotMatch(collapsed, /SUMMARY_CANARY|OUTPUT_CANARY/);
        assert.match(expanded, /Context compacted to phase-start/);
        assert.match(expanded, /SUMMARY_CANARY/);
        assert.match(expanded, /OUTPUT_CANARY/);
    } finally {
        setKeybindings(previous);
    }
});

for (const historySize of [10, 2000]) {
    test(`compacting ${historySize} history entries stores one range and no edits`, { timeout: 10000 }, async () => {
        const h = await createHarness();
        try {
            await h.run("first", [h.reply("TARGET answer")]);
            h.label("phase-start");
            for (let i = 0; i < historySize; i++) {
                h.sm.appendMessage({ role: "user", content: `HISTORY_CANARY_${i}`, timestamp: i });
            }
            const before = h.sm.getEntries().length;
            await h.run("compact", [
                h.reply(h.call("context_compact", { target: "phase-start", summary: "STATE_ONLY" }, "c1")),
                h.reply("done"),
            ]);
            const added = h.sm.getEntries().slice(before);
            assert.equal(added.length, 5, "prompt, call, result, one summary, continuation");
            assert.equal(added.filter((entry) => entry.type === "custom_message").length, 1);
            const summary = added.find((entry) => entry.type === "custom_message");
            assert.ok(JSON.stringify(summary.details.range).length < 160, "range size is independent of history length");
            assert.doesNotMatch(JSON.stringify(h.requests.at(-1)), /HISTORY_CANARY/);
            assert.ok(h.sm.getBranch().some((entry) => entry.type === "message" && entry.message.content === "HISTORY_CANARY_0"));
        } finally { await h.dispose(); }
    });
}

test("saved range survives reopening, restores at backup, and does not affect a sibling branch", { timeout: 10000 }, async () => {
    const h = await createHarness({ persistent: true });
    let resumed;
    try {
        await h.run("first", [h.reply("TARGET answer")]);
        h.label("phase-start");
        const targetId = h.sm.getLeafId();
        await h.run("SAVED_RAW_CANARY", [
            h.reply(h.call("context_compact", { target: "phase-start", summary: "SAVED_STATE", backupCheckpoint: "raw" }, "c1")),
            h.reply("done"),
        ]);
        resumed = await createHarness({ sessionFile: h.sm.getSessionFile() });
        await resumed.run("continue", [resumed.reply("resumed")]);
        assert.match(JSON.stringify(resumed.requests.at(-1)), /SAVED_STATE/);
        assert.doesNotMatch(JSON.stringify(resumed.requests.at(-1)), /SAVED_RAW_CANARY/);
        const backupId = resumed.sm.getBranch().find((entry) => resumed.sm.getLabel(entry.id) === "raw").id;
        resumed.sm.branch(backupId);
        assert.match(JSON.stringify(getCompactionProjection(resumed.sm)), /SAVED_RAW_CANARY/);
        resumed.sm.branch(targetId);
        resumed.sm.appendMessage({ role: "user", content: "SIBLING_CANARY", timestamp: Date.now() });
        const sibling = getCompactionProjection(resumed.sm).flatMap((entry) => entry.messages);
        assert.match(JSON.stringify(sibling), /SIBLING_CANARY/);
        assert.doesNotMatch(JSON.stringify(sibling), /SAVED_STATE/);
    } finally { await resumed?.dispose(); await h.dispose(); }
});

for (const reason of ["manual", "threshold", "overflow"]) {
    test(`${reason} native compaction excludes hidden text and file operations while using Pi's generator`, { timeout: 10000 }, async () => {
        const h = await createHarness({ settings: { compaction: {
            enabled: false, reserveTokens: reason === "threshold" ? 118000 : 16384, keepRecentTokens: 20,
        } } });
        try {
            await h.run("first", [h.reply("TARGET answer")]);
            h.sm.appendMessage(fauxAssistantMessage([h.call("read", { path: "/shared-file.ts" }, "kept-read")]));
            h.sm.appendMessage({ role: "toolResult", toolName: "read", toolCallId: "kept-read",
                content: [{ type: "text", text: "KEEP_READ" }], timestamp: Date.now() });
            h.sm.appendMessage(fauxAssistantMessage("KEPT read result"));
            h.label("phase-start");
            h.sm.appendMessage({ role: "user", content: "HIDDEN_BODY_CANARY " + "x".repeat(100000), timestamp: Date.now() });
            h.sm.appendMessage(fauxAssistantMessage([
                h.call("read", { path: "/hidden-file-canary.ts" }, "hidden-read"),
                h.call("edit", { path: "/hidden-edit-canary.ts" }, "hidden-edit"),
                h.call("read", { path: "/shared-file.ts" }, "hidden-shared-read"),
            ]));
            for (const [toolCallId, toolName] of [["hidden-read", "read"], ["hidden-edit", "edit"], ["hidden-shared-read", "read"]]) {
                h.sm.appendMessage({ role: "toolResult", toolName, toolCallId,
                    content: [{ type: "text", text: "HIDDEN_RESULT_CANARY" }], timestamp: Date.now() });
            }
            await h.run("compact noisy work", [
                h.reply(h.call("context_compact", { target: "phase-start", summary: "VISIBLE_STATE_CANARY" }, "c1")),
                h.reply("continue"),
            ]);
            // A recent long user-message span exercises the separate turn-prefix summarizer.
            h.sm.appendMessage({ role: "user", content: "RECENT_WORK " + "r".repeat(400), timestamp: Date.now() });
            h.sm.appendMessage(fauxAssistantMessage("RECENT_RESULT " + "a".repeat(400)));
            const reasons = [];
            h.session.subscribe((event) => { if (event.type === "compaction_start") reasons.push(event.reason); });
            const summaryRequests = [];
            let sentOverflow = false;
            h.faux.setResponses(Array.from({ length: 10 }, () => (context) => {
                const summarizing = context.messages.some((message) => message.role === "system" &&
                    textOf(message.content).includes("You are a context summarization assistant."));
                if (summarizing) {
                    summaryRequests.push(context.messages);
                    return fauxAssistantMessage("NATIVE_CLEAN_SUMMARY");
                }
                if (reason === "overflow" && !sentOverflow) {
                    sentOverflow = true;
                    return { ...fauxAssistantMessage(""), stopReason: "error", errorMessage: "maximum context length exceeded" };
                }
                return fauxAssistantMessage("finished");
            }));
            if (reason === "manual") await h.session.compact();
            else {
                h.session.setAutoCompactionEnabled(true);
                await h.session.prompt("continue after compaction" + (reason === "threshold" ? "p".repeat(50000) : ""));
            }
            assert.deepEqual(h.errors, []);
            assert.ok(reasons.includes(reason), JSON.stringify(reasons));
            assert.ok(summaryRequests.length >= 1);
            assert.match(JSON.stringify(summaryRequests), /VISIBLE_STATE_CANARY/);
            assert.doesNotMatch(JSON.stringify(summaryRequests), /HIDDEN_BODY_CANARY|HIDDEN_RESULT_CANARY|hidden-file-canary|hidden-edit-canary/);
            const native = h.sm.getBranch().filter((entry) => entry.type === "compaction").at(-1);
            assert.equal(native.fromHook, false, "default prompts, routing, retries and generation remain Pi's");
            assert.doesNotMatch(native.summary, /hidden-file-canary|hidden-edit-canary/);
            assert.ok(native.details.readFiles.includes("/shared-file.ts"), "a visible read of the same path must remain");
        } finally { await h.dispose(); }
    });
}
