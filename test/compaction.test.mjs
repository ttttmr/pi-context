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

import registerContext from "../dist/index.js";

// End-to-end on a real AgentSession: the faux provider records each request's
// provider-visible messages, so assertions cover what the model actually sees.
async function createHarness({ codemode = false, onEcho, settings = {} } = {}) {
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
    const sm = SessionManager.inMemory(dir);
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

const contextEdits = (sm) => sm.getBranch().filter((entry) => entry.type === "context_edit");

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
        assert.deepEqual(contextEdits(h.sm), []);
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
        assert.deepEqual(contextEdits(h.sm), []);
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

test("summary renderer shows the summary collapsed and kept tool outputs when expanded", () => {
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
    const collapsed = render(message, { expanded: false, outputPad: 1 }, theme).render(120).join("\n");
    const expanded = render(message, { expanded: true, outputPad: 1 }, theme).render(120).join("\n");
    assert.match(collapsed, /Context compacted to phase-start · 6 entries \(~1k tokens\) · kept 1 tool outputs · backup: raw/);
    assert.match(collapsed, /SUMMARY_CANARY/);
    assert.doesNotMatch(collapsed, /OUTPUT_CANARY/);
    assert.match(expanded, /OUTPUT_CANARY/);
});
