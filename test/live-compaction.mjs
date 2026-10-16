import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { loadLiveConfig, root, startPi as startRpc, text } from "./live-rpc.mjs";

// Opt-in live test: invokes a real model, uses existing Pi auth, and costs tokens.
const { model, extensions } = await loadLiveConfig();
const artifacts = await mkdtemp(resolve(tmpdir(), "pi-context-live-"));
console.log(JSON.stringify({ artifacts, model, extensions }));

const startPi = (name, sessionFile, late = false) => startRpc({
    name, artifacts, model, sessionFile,
    extensions: [...extensions, ...(late ? [resolve(root, "test/live-late-message-extension.ts")] : [])],
});

async function compactPhase(pi, phase, expectedSummaries, late = false) {
    const marker = `LIVE_${phase}_OK`;
    const phaseEvents = await pi.prompt(`Integration test phase ${phase}. Call context_compact exactly once with target "root" and summary "Phase ${phase} compaction is complete. Next step: reply exactly ${marker} without calling any tools." Do not run slash commands. Do not reply with the marker before compaction. After the tool, follow the summary.`);
    // Compaction happens inside the run: no abort boundary, cancellation or error is expected.
    const failure = phaseEvents.find((event) => event.type === "extension_error" ||
        (event.type === "tool_execution_end" && event.isError) ||
        (event.type === "message_end" && ["error", "aborted"].includes(event.message.stopReason)));
    assert.equal(failure, undefined, JSON.stringify(failure));
    assert.ok(phaseEvents.some((event) => event.type === "message_end" && event.message.role === "assistant" &&
        text(event.message).trim() === marker), `Phase ${phase} did not continue to ${marker}`);
    const { entries, leafId } = await pi.request("get_entries");
    const { messages: canonicalMessages } = await pi.request("get_messages");
    const messages = pi.getContextMessages();
    const summaries = entries.filter((entry) => entry.type === "custom_message" && entry.customType === "pi-context-compaction");
    assert.equal(summaries.length, expectedSummaries);
    assert.match(summaries.at(-1).details.summary, new RegExp(marker));
    assert.equal(typeof summaries.at(-1).details.range?.throughId, "string", "summary stores the compaction range");
    assert.equal(summaries.at(-1).details.range.afterId, null, "root range starts at the beginning of context");
    assert.equal(entries.filter((entry) => entry.type === "context_edit").length, 0, "compaction writes no context edits");
    assert.equal(entries.filter((entry) => entry.type === "branch_summary").length, 0, "compaction does not branch");
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    const activeIds = [];
    for (let id = leafId; id; id = byId.get(id)?.parentId) activeIds.push(id);
    assert.ok(activeIds.includes(summaries.at(-1).id), "summary is on the active path");
    // Model context: folded prompts are gone, the latest summary is present, pairs stay closed.
    const visible = messages.map(text).join("\n");
    assert.ok(!visible.includes(`Integration test phase ${phase}.`), "folded prompt left model context");
    assert.ok(canonicalMessages.some((message) => text(message).includes(`Integration test phase ${phase}.`)),
        "canonical history keeps the folded prompt");
    assert.ok(messages.some((message) => message.role === "custom" && message.customType === "pi-context-compaction" &&
        text(message).includes(marker)), "summary is in model context");
    if (late) {
        const summaryIndex = messages.findIndex((message) => message.role === "custom" && message.customType === "pi-context-compaction");
        const canaryIndex = messages.findIndex((message) => message.role === "custom" && message.customType === "live-late-canary");
        assert.ok(canaryIndex > summaryIndex, "late contextual input is kept after the summary");
    }
    const calls = new Set();
    for (const message of messages) {
        if (message.role === "assistant") {
            for (const block of message.content) if (block.type === "toolCall") calls.add(block.id);
        }
        if (message.role === "toolResult") assert.ok(calls.has(message.toolCallId), "no orphan tool results");
    }
    assert.equal(phaseEvents.filter((event) => event.type === "tool_execution_end" && event.toolName === "context_compact").length, 1);
    assert.ok(!phaseEvents.some((event) => event.type === "extension_ui_request" && event.method === "set_editor_text"));
    const stats = await pi.request("get_session_stats");
    const state = await pi.request("get_state");
    assert.equal(`${state.model.provider}/${state.model.id}`, model);
    await writeFile(resolve(artifacts, `${phase}.verified.json`), JSON.stringify({
        phase, model, marker, summaries: summaries.length, sessionFile: state.sessionFile, activeIds, stats,
    }, null, 2));
    console.log(`PASS ${phase}: summaries=${summaries.length}, continuation=${marker}`);
    return state.sessionFile;
}

let pi;
try {
    pi = await startPi("initial");
    await pi.request("set_auto_retry", { enabled: false });
    await compactPhase(pi, "FIRST", 1);
    const sessionFile = await compactPhase(pi, "SECOND", 2);
    await pi.close(artifacts);
    pi = await startPi("resumed", sessionFile);
    await pi.request("set_auto_retry", { enabled: false });
    await compactPhase(pi, "RESUMED", 3);
    await pi.close(artifacts);
    pi = await startPi("late", undefined, true);
    await pi.request("set_auto_retry", { enabled: false });
    await compactPhase(pi, "LATE", 1, true);
    console.log(`PASS live compaction validation; artifacts: ${artifacts}`);
} finally {
    await pi?.close(artifacts);
}
