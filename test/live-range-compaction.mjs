import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import { loadLiveConfig, root, startPi, text } from "./live-rpc.mjs";

// Opt-in adversarial live chains. Real models execute tools and Pi's default native summarizer.
// Long-history cases seed explicitly synthetic session messages, then use real model requests.
const { model, extensions } = await loadLiveConfig();
const artifacts = await mkdtemp(resolve(tmpdir(), "pi-context-range-live-"));
const selected = process.env.PI_CONTEXT_SCENARIOS?.split(",").filter(Boolean);
const concurrency = Number(process.env.PI_CONTEXT_SCENARIO_CONCURRENCY || 2);
console.log(JSON.stringify({ artifacts, model, selected, concurrency }));

const summaryType = "pi-context-compaction";
const controls = resolve(root, "test/live-range-controls-extension.ts");
const contents = (messages) => JSON.stringify(messages);
const storedSummaries = (entries) => entries.filter((entry) => entry.type === "custom_message" && entry.customType === summaryType);
const labelTarget = (entries, name) => entries.findLast((entry) => entry.type === "label" && entry.label === name)?.targetId;
const visibleText = (pi) => contents(pi.getContextMessages());

function assertClosedPairs(messages) {
    const calls = new Set();
    for (const message of messages) {
        if (message.role === "assistant") for (const block of message.content) if (block.type === "toolCall") calls.add(block.id);
        if (message.role === "toolResult") assert.ok(calls.delete(message.toolCallId), `orphan result: ${message.toolCallId}`);
    }
    assert.equal(calls.size, 0, "every retained call has its result");
}

async function promptChecked(pi, message, expected) {
    const events = await pi.prompt(message, { retries: 0, timeoutMs: 240000 });
    const failures = events.filter((event) => event.type === "extension_error" ||
        (event.type === "tool_execution_end" && event.isError) ||
        (event.type === "message_end" && ["error", "aborted"].includes(event.message.stopReason)));
    assert.deepEqual(failures, [], contents(failures).slice(0, 600));
    if (expected) assert.ok(events.some((event) => event.type === "message_end" && event.message.role === "assistant" &&
        text(event.message).trim() === expected), `missing continuation ${expected}`);
    assertClosedPairs(pi.getContextMessages());
    return events;
}

async function callTool(pi, name, args, expected = "TOOL_DONE") {
    const invocation = pi.rangeCodemode
        ? `Call codemode exactly once with this unchanged script: text(await tools.${name}(${JSON.stringify(args)}));`
        : `Call ${name} exactly once with exactly ${JSON.stringify(args)}.`;
    return promptChecked(pi, `${invocation} Then reply exactly ${expected}.`, expected);
}

async function checkpoint(pi, name) {
    const { entries } = await pi.request("get_entries");
    const target = entries.findLast((entry) => entry.type === "message" && entry.message.role === "assistant").id;
    await callTool(pi, "context_checkpoint", { name, target });
    assert.equal(labelTarget((await pi.request("get_entries")).entries, name), target);
    return target;
}

async function compactRange(pi, target, marker, backupCheckpoint) {
    const args = { target, summary: `Useful task state is preserved as ${marker}. Next step: reply exactly ${marker} without tools.`,
        ...(backupCheckpoint ? { backupCheckpoint } : {}) };
    const events = await callTool(pi, "context_compact", args, marker);
    assert.equal(events.filter((event) => event.type === "tool_execution_end" && event.toolName === "context_compact").length, 1);
    const { entries } = await pi.request("get_entries");
    const latest = storedSummaries(entries).at(-1);
    assert.ok(latest.details.range && JSON.stringify(latest.details.range).length < 160);
    assert.equal(entries.filter((entry) => entry.type === "context_edit").length, 0);
    return latest;
}

async function startCase(name, sessionFile, codemode = false, compaction = {}) {
    const pi = await startPi({ name, artifacts, model, extensions, sessionFile,
        tools: ["read", "bash", "context_checkpoint", "context_compact", ...(codemode ? ["codemode"] : [])],
        settings: { compaction: { enabled: false, keepRecentTokens: 80, ...compaction },
            ...(codemode ? { codemode: { mode: "only" } } : {}) },
        extraArgs: [...(codemode ? ["-e", "builtin:codemode"] : []), "-e", controls],
    });
    pi.rangeCodemode = codemode;
    await pi.request("set_auto_retry", { enabled: false });
    return pi;
}

async function nativeCompact(pi, hiddenMarker, hiddenPath, reason = "manual") {
    const offset = pi.events.length;
    const native = await pi.request("compact", {}, 240000);
    const done = await pi.waitFor(offset, (event) => event.type === "range_test_native_done");
    const inputs = pi.events.slice(offset).filter((event) => event.type === "range_test_native_input");
    const requests = pi.events.slice(offset).filter((event) => event.type === "range_test_native_request");
    assert.equal(inputs.length, 1);
    assert.equal(inputs[0].reason, reason);
    assert.equal(done.entry.fromHook, false, "Pi's default generator remains in use");
    assert.ok(requests.length > 0, "actual native provider request was captured");
    for (const value of [contents(inputs), contents(requests), native.summary, contents(done.entry.details)]) {
        assert.ok(!value.includes(hiddenMarker), "hidden text must not reach native summary input or output");
        if (hiddenPath) assert.ok(!value.includes(hiddenPath), "hidden file paths must not reach native summary input or output");
    }
    return { native, input: inputs[0], providerRequests: requests.length, entry: done.entry };
}

async function readSetup(pi, id) {
    const token = randomBytes(8).toString("hex");
    const dir = resolve(artifacts, `${id}-files`);
    await mkdir(dir);
    const visiblePath = resolve(dir, "visible.txt");
    const hiddenPath = resolve(dir, `hidden-${token}.txt`);
    const hiddenMarker = `RAW_SECRET_${token}`;
    await writeFile(visiblePath, "VISIBLE_FILE_STATE\n" + "visible diagnostic notes ".repeat(100));
    await writeFile(hiddenPath, hiddenMarker + "\n");
    await promptChecked(pi, "Reply exactly START_READY without tools.", "START_READY");
    await callTool(pi, "read", { path: visiblePath });
    const anchor = await checkpoint(pi, `anchor-${id}`);
    await callTool(pi, "read", { path: hiddenPath });
    await callTool(pi, "read", { path: visiblePath });
    assert.ok(visibleText(pi).includes(hiddenMarker), "positive control: original request sees the read result");
    const summary = await compactRange(pi, `anchor-${id}`, `STATE_${id}`, `backup-${id}`);
    assert.ok(!visibleText(pi).includes(hiddenMarker));
    assert.ok(!visibleText(pi).includes(hiddenPath));
    const { entries, leafId } = await pi.request("get_entries");
    assert.ok(contents(entries).includes(hiddenMarker), "raw persisted history retains the canary");
    return { token, anchor, summary, leafId, hiddenMarker, hiddenPath, visiblePath,
        backup: labelTarget(entries, `backup-${id}`) };
}

async function nativeReadChain(id, codemode) {
    let pi = await startCase(id, undefined, codemode);
    try {
        const setup = await readSetup(pi, id);
        // A large tool result makes Pi split this user-message span at the read call.
        await callTool(pi, "read", { path: setup.visiblePath }, "RECENT_READY");
        const result = await nativeCompact(pi, setup.hiddenMarker, setup.hiddenPath);
        assert.ok(contents(result.input).includes(`STATE_${id}`), "native generator sees the useful range summary");
        assert.ok(result.input.files.read.includes(setup.visiblePath), "visible shared-path read remains tracked");
        assert.ok(result.entry.details.readFiles.includes(setup.visiblePath));
        assert.ok(result.input.split, "separate long-turn prefix summary is exercised");
        await promptChecked(pi, "Reply exactly AFTER_NATIVE without tools.", "AFTER_NATIVE");
        assert.ok(!visibleText(pi).includes(setup.hiddenMarker));
        const sessionFile = (await pi.request("get_state")).sessionFile;
        await pi.close(artifacts);
        pi = await startCase(`${id}-resumed`, sessionFile, codemode);
        await promptChecked(pi, "Reply exactly REOPENED_NATIVE without tools.", "REOPENED_NATIVE");
        assert.ok(!visibleText(pi).includes(setup.hiddenMarker));
        // Advance the native kept boundary with new work; a short acknowledgement alone
        // can leave the entire current tail inside keepRecentTokens and cannot compact.
        await callTool(pi, "bash", { command: "printf 'visible-repeat-note %.0s' {1..100}", timeout: 30 }, "REPEAT_NATIVE_READY");
        const second = await nativeCompact(pi, setup.hiddenMarker, setup.hiddenPath);
        assert.ok(second.entry.details.readFiles.includes(setup.visiblePath), "file tracking survives repeated native compaction");
        return { nativeRequests: result.providerRequests + second.providerRequests, split: result.input.split };
    } finally { await pi.close(artifacts); }
}

async function longHistoryChain(id, count) {
    const keepRecentTokens = count >= 1000 ? 2400 : 400;
    let pi = await startCase(id, undefined, false, { keepRecentTokens });
    try {
        await promptChecked(pi, "Reply exactly LONG_START without tools.", "LONG_START");
        await checkpoint(pi, `anchor-${id}`);
        const sessionFile = (await pi.request("get_state")).sessionFile;
        await pi.close(artifacts);
        const sm = SessionManager.open(sessionFile);
        const marker = `LONG_HIDDEN_${randomBytes(8).toString("hex")}`;
        for (let index = 0; index < count; index++) sm.appendCustomMessageEntry("range-live-history",
            `${marker} ${index}: synthetic historical diagnostic output. ${"noise ".repeat(6)}`, true);
        const before = (await stat(sessionFile)).size;
        pi = await startCase(`${id}-seeded`, sessionFile, false, { keepRecentTokens });
        await compactRange(pi, `anchor-${id}`, `LONG_STATE_${id}`);
        const after = await pi.request("get_entries");
        assert.equal(storedSummaries(after.entries).length, 1);
        assert.equal(after.entries.filter((entry) => entry.type === "context_edit").length, 0);
        assert.ok(contents(after.entries).includes(marker));
        assert.ok(!visibleText(pi).includes(marker));
        const range = storedSummaries(after.entries)[0].details.range;
        const ids = new Map(after.entries.map((entry, index) => [entry.id, index]));
        const first = await nativeCompact(pi, marker);
        if (count >= 1000) {
            const kept = ids.get(first.entry.firstKeptEntryId);
            assert.ok(kept > ids.get(range.afterId) && kept <= ids.get(range.throughId), "native kept boundary falls inside hidden history");
        }
        await promptChecked(pi, "Reply exactly TAIL_FILTERED without tools.", "TAIL_FILTERED");
        assert.ok(!visibleText(pi).includes(marker), "native retained raw tail stays hidden");
        const canonical = (await pi.request("get_messages")).messages;
        if (count >= 1000) assert.ok(contents(canonical).includes(marker), "positive control: Pi retained a hidden raw tail");
        const growthBytes = (await stat(sessionFile)).size - before;
        await pi.close(artifacts);
        pi = await startCase(`${id}-small-tail`, sessionFile);
        await promptChecked(pi, `Reply exactly TRIM_READY. ${"recent visible notes ".repeat(70)}`, "TRIM_READY");
        const second = await nativeCompact(pi, marker);
        const current = SessionManager.open(sessionFile).buildSessionProjection().messages;
        assert.ok(!current.some((message) => message.role === "custom" && message.customType === summaryType),
            "native compaction summarized the range-bearing summary itself");
        await pi.close(artifacts);
        pi = await startCase(`${id}-reopened`, sessionFile);
        await promptChecked(pi, "Reply exactly RULE_RESTORED without tools.", "RULE_RESTORED");
        assert.ok(!visibleText(pi).includes(marker));
        await compactRange(pi, "root", `FINAL_STATE_${id}`);
        assert.equal(pi.getContextMessages().filter((message) => message.role === "custom" && message.customType === summaryType).length, 1);
        return { syntheticEntries: count, rangeBytes: Buffer.byteLength(JSON.stringify(range)),
            persistedBytesThroughFirstNative: growthBytes, nativeRequests: first.providerRequests + second.providerRequests };
    } finally { await pi.close(artifacts); }
}

async function navigate(pi, targetId) {
    const offset = pi.events.length;
    await pi.request("prompt", { message: `/range-test-navigate ${targetId}` });
    const result = await pi.waitFor(offset, (event) => event.type === "range_test_navigated" && event.targetId === targetId);
    assert.equal(result.cancelled, false);
}

async function branchChain(id) {
    const pi = await startCase(id);
    try {
        const setup = await readSetup(pi, id);
        await navigate(pi, setup.backup);
        await promptChecked(pi, "Reply exactly RAW_RESTORED without tools.", "RAW_RESTORED");
        assert.ok(visibleText(pi).includes(setup.hiddenMarker), "actual navigation to backup restores raw context");
        assert.ok(!pi.getContextMessages().some((message) => message.role === "custom" && message.customType === summaryType),
            "backup restores the requesting call, whose arguments can mention the summary, but not the later summary node");
        await navigate(pi, setup.anchor);
        await promptChecked(pi, "Reply exactly SIBLING_BRANCH without tools.", "SIBLING_BRANCH");
        assert.ok(!visibleText(pi).includes(setup.hiddenMarker));
        assert.ok(!pi.getContextMessages().some((message) => message.role === "custom" && message.customType === summaryType),
            "abandoned-branch rules and summary do not enter sibling context");
        await navigate(pi, setup.leafId);
        await promptChecked(pi, "Reply exactly COMPACT_BRANCH_RESTORED without tools.", "COMPACT_BRANCH_RESTORED");
        assert.ok(!visibleText(pi).includes(setup.hiddenMarker));
        assert.ok(visibleText(pi).includes(`STATE_${id}`));
        return { navigations: 3 };
    } finally { await pi.close(artifacts); }
}

async function automaticNativeChain(id) {
    let pi = await startCase(id);
    try {
        const setup = await readSetup(pi, id);
        const state = await pi.request("get_state");
        assert.ok(state.model.contextWindow > 8000);
        await pi.close(artifacts);
        pi = await startCase(`${id}-automatic`, state.sessionFile, false, {
            enabled: true, reserveTokens: state.model.contextWindow - 8000,
        });
        const offset = pi.events.length;
        await promptChecked(pi, `Reply exactly AUTO_DONE without tools. Current visible workload:\n${"visible-work ".repeat(16000)}`, "AUTO_DONE");
        const done = await pi.waitFor(offset, (event) => event.type === "range_test_native_done" && event.reason === "threshold");
        const events = pi.events.slice(offset);
        const inputs = events.filter((event) => event.type === "range_test_native_input");
        const requests = events.filter((event) => event.type === "range_test_native_request");
        assert.ok(inputs.length > 0 && requests.length > 0, "real threshold compaction must generate a summary");
        assert.equal(done.entry.fromHook, false);
        for (const value of [contents(inputs), contents(requests), done.entry.summary, contents(done.entry.details)]) {
            assert.ok(!value.includes(setup.hiddenMarker));
            assert.ok(!value.includes(setup.hiddenPath));
        }
        assert.ok(done.entry.details.readFiles.includes(setup.visiblePath));
        await promptChecked(pi, "Reply exactly AUTO_CONTINUED without tools.", "AUTO_CONTINUED");
        assert.ok(!visibleText(pi).includes(setup.hiddenMarker));
        return { reason: done.reason, nativeRequests: requests.length };
    } finally { await pi.close(artifacts); }
}

const cases = [
    { id: "R1", title: "direct reads → range → native split → reopen → native again", run: () => nativeReadChain("R1", false) },
    { id: "R2", title: "codemode reads → range → native split → reopen → native again", run: () => nativeReadChain("R2", true) },
    { id: "R3", title: "20 seeded entries → range → native → summarized rule → reopen → root", run: () => longHistoryChain("R3", 20) },
    { id: "R4", title: "2000 seeded entries → range → native hidden tail → summarized rule → reopen → root", run: () => longHistoryChain("R4", 2000) },
    { id: "R5", title: "real backup navigation → sibling branch → compacted branch", run: () => branchChain("R5") },
    { id: "R6", title: "range → restart → automatic threshold compaction → continuation", run: () => automaticNativeChain("R6") },
].filter((item) => !selected || selected.includes(item.id));
assert.ok(cases.length, "no matching live range cases");
const queue = [...cases], results = [];
await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (let item = queue.shift(); item; item = queue.shift()) {
        const start = Date.now();
        try {
            const evidence = await item.run();
            results.push({ id: item.id, title: item.title, ok: true, evidence, ms: Date.now() - start });
            console.log(`PASS ${item.id} ${item.title} ${JSON.stringify(evidence)}`);
        } catch (error) {
            results.push({ id: item.id, title: item.title, ok: false, error: error.stack, ms: Date.now() - start });
            console.error(`FAIL ${item.id} ${item.title}\n${error.stack}`);
        }
    }
}));
await writeFile(resolve(artifacts, "results.json"), JSON.stringify(results, null, 2));
const failed = results.filter((item) => !item.ok);
console.log(`${results.length - failed.length}/${results.length} range chains passed; artifacts: ${artifacts}`);
process.exitCode = failed.length ? 1 : 0;
