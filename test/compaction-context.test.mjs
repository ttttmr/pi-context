import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import {
    filterCompactionMessages, filterNativeCompaction, getCompactionHiddenIds, getCompactionProjection,
} from "../dist/compaction-context.js";

function history() {
    const sm = SessionManager.inMemory("/work");
    let timestamp = 1000;
    const user = (content, time = timestamp++) => sm.appendMessage({ role: "user", content, timestamp: time });
    const assistant = (content, time = timestamp++) => sm.appendMessage({ ...fauxAssistantMessage(content), timestamp: time });
    const result = (toolCallId, toolName, text, extra = {}) => sm.appendMessage({
        role: "toolResult", toolCallId, toolName, content: [{ type: "text", text }], isError: false,
        timestamp: timestamp++, ...extra,
    });
    const range = (afterId, throughId, extra = {}) => sm.appendCustomMessageEntry(
        "pi-context-compaction", "SUMMARY", true, { range: { afterId, throughId, ...extra } },
    );
    return { sm, user, assistant, result, range };
}

const tool = (name, path, id) => fauxToolCall(name, { path }, { id });
const messages = (sm) => sm.buildSessionProjection().messages;
const projected = (sm, id) => getCompactionProjection(sm).find((entry) => entry.sourceEntry.id === id);
const sorted = (values) => [...values].sort();

test("overlapping ranges keep assistant results only until another range hides them", () => {
    const h = history();
    const first = h.user("FIRST");
    const target = h.assistant([tool("read", "/one.ts", "one"), tool("read", "/two.ts", "two")]);
    const one = h.result("one", "read", "ONE");
    const state = h.sm.appendCustomEntry("extension-state", { value: 1 });
    const system = h.sm.appendMessage({ role: "system", content: "SYSTEM", timestamp: 2000 });
    const noise = h.user("NOISE");
    const two = h.result("two", "read", "TWO");
    const shell = h.sm.appendMessage({ role: "bashExecution", command: "echo shell", output: "SHELL",
        exitCode: 0, cancelled: false, truncated: false, timestamp: 2001 });
    const custom = h.sm.appendCustomMessageEntry("other-extension", "CUSTOM_NOISE", true);
    const firstSummary = h.range(target, custom, { keepToolResultsOf: target });

    assert.deepEqual(sorted(getCompactionHiddenIds(h.sm.getBranch())), sorted([noise, custom]));
    assert.equal(projected(h.sm, one).messages[0].toolCallId, "one");
    assert.equal(projected(h.sm, two).messages[0].toolCallId, "two");
    assert.equal(projected(h.sm, target).messages.length, 1);

    h.range(null, firstSummary);
    // Repeating an exemption cannot undo the independent root range.
    const latestSummary = h.range(target, custom, { keepToolResultsOf: target });
    const hidden = getCompactionHiddenIds(h.sm.getBranch());
    assert.deepEqual(sorted(hidden), sorted([first, target, one, noise, two, custom, firstSummary]));
    for (const id of [one, two, firstSummary]) assert.deepEqual(projected(h.sm, id).messages, []);
    for (const id of [system, shell, latestSummary]) assert.equal(projected(h.sm, id).messages.length, 1);
    assert.equal(hidden.has(state), false, "extension state is never an editable context message");
});

for (const summarizeRange of [false, true]) {
    test(`native compaction ${summarizeRange ? "summarizes the range summary" : "keeps a hidden raw tail"} without losing range rules`, () => {
        const h = history();
        const anchor = h.user("ANCHOR");
        const old = h.user("OLD_HIDDEN");
        const tail = h.user("TAIL_HIDDEN");
        const summary = h.range(anchor, tail);
        const recent = h.user("RECENT_VISIBLE");
        const native = h.sm.appendCompaction("NATIVE_SUMMARY", summarizeRange ? recent : tail, 5000);
        const continuation = h.user("CONTINUATION");
        const rawIds = new Set(h.sm.buildSessionProjection().entries.map((entry) => entry.sourceEntry.id));
        const hidden = getCompactionHiddenIds(h.sm.getBranch());

        assert.deepEqual(sorted(hidden), sorted([old, tail]), "rules are read from raw ancestry, not the native projection");
        assert.equal(rawIds.has(summary), !summarizeRange);
        assert.equal(rawIds.has(tail), !summarizeRange);
        if (!summarizeRange) assert.deepEqual(projected(h.sm, tail).messages, []);
        assert.equal(projected(h.sm, native).messages[0].role, "compactionSummary");
        assert.equal(projected(h.sm, recent).messages[0].content, "RECENT_VISIBLE");
        assert.equal(projected(h.sm, continuation).messages[0].content, "CONTINUATION");
        assert.doesNotMatch(JSON.stringify(getCompactionProjection(h.sm).flatMap((entry) => entry.messages)), /OLD_HIDDEN|TAIL_HIDDEN/);
    });
}

test("range rules from another branch and ranges with off-branch endpoints do not hide active history", () => {
    const h = history();
    const anchor = h.user("ANCHOR");
    const sibling = h.user("SIBLING");
    h.range(anchor, sibling);
    h.sm.branch(anchor);
    const current = h.user("CURRENT");
    h.range(anchor, sibling);
    assert.deepEqual([...getCompactionHiddenIds(h.sm.getBranch())], []);
    assert.equal(projected(h.sm, current).messages[0].content, "CURRENT");
});

function sameTimestampHistory() {
    const h = history();
    const before = h.user("VISIBLE_BEFORE", 1);
    const hidden = h.user("HIDDEN", 1);
    h.range(before, hidden);
    h.user("VISIBLE_AFTER", 1);
    return h;
}

test("cloned messages sharing a timestamp retain their source identity in full requests and native subsets", () => {
    const { sm } = sameTimestampHistory();
    const raw = messages(sm);
    const clones = structuredClone(raw);
    assert.notEqual(clones[0], raw[0], "request cloning must not rely on source object identity");
    assert.deepEqual(filterCompactionMessages(sm, clones).filter((message) => message.role === "user")
        .map((message) => message.content), ["VISIBLE_BEFORE", "VISIBLE_AFTER"]);

    const after = clones.find((message) => message.content === "VISIBLE_AFTER");
    const hidden = clones.find((message) => message.content === "HIDDEN");
    assert.deepEqual(filterCompactionMessages(sm, [after]), [after], "native subset omits earlier same-timestamp messages");
    assert.deepEqual(filterCompactionMessages(sm, [hidden]), []);
    assert.deepEqual(filterCompactionMessages(sm, [after, hidden]), [after], "provenance does not depend on subset offsets");
});

test("an extension injection sharing a hidden message timestamp survives without resurrecting hidden content", () => {
    const h = history();
    const hidden = h.user("HIDDEN", 1);
    h.range(null, hidden);
    h.user("VISIBLE", 2);
    const injected = { role: "user", content: "EXTENSION_ADDED", timestamp: 1 };
    const request = [injected, ...structuredClone(messages(h.sm))];
    const filtered = filterCompactionMessages(h.sm, request);
    assert.ok(filtered.includes(injected), "injected messages must not consume the hidden source's provenance");
    assert.deepEqual(filtered.filter((message) => message.role === "user").map((message) => message.content),
        ["EXTENSION_ADDED", "VISIBLE"]);
});

test("unique source messages remain attributable after another extension transforms their content", () => {
    const h = history();
    const hidden = h.user("HIDDEN", 1);
    h.range(null, hidden);
    h.user("VISIBLE", 2);
    const modified = structuredClone(messages(h.sm)).map((message) => message.role === "user"
        ? { ...message, content: `TRANSFORMED:${message.content}` } : message);
    const injected = { role: "custom", customType: "other-extension", content: "EXTENSION_ADDED", display: false, timestamp: 1 };
    const filtered = filterCompactionMessages(h.sm, [injected, ...modified]);
    assert.ok(filtered.includes(injected));
    assert.deepEqual(filtered.filter((message) => message.role === "user").map((message) => message.content), ["TRANSFORMED:VISIBLE"]);
    // Native summarization may receive only one transformed message from the original request.
    assert.deepEqual(filterCompactionMessages(h.sm, [modified.find((message) => message.content === "TRANSFORMED:HIDDEN")]), []);
    const visible = modified.find((message) => message.content === "TRANSFORMED:VISIBLE");
    assert.deepEqual(filterCompactionMessages(h.sm, [visible]), [visible]);
});

for (const fromHook of [false, true]) {
    test(`native file operations rebuild visible direct and nested calls with ${fromHook ? "hook" : "default"} prior metadata`, () => {
        const h = history();
        h.user("ANCIENT");
        h.sm.appendCompaction("PRIOR_NATIVE", null, 5000, {
            readFiles: ["/prior-read.ts", "/shared-read.ts"], modifiedFiles: ["/prior-modified.ts"],
        }, fromHook);
        h.assistant([tool("read", "/shared-read.ts", "visible-read"), tool("write", "/shared-write.ts", "visible-write")]);
        h.result("visible-read", "read", "VISIBLE_READ");
        h.result("visible-write", "write", "VISIBLE_WRITE");
        h.assistant([fauxToolCall("codemode", { code: "visible script" }, { id: "visible-script" })]);
        h.result("visible-script", "codemode", "VISIBLE_SCRIPT", { nestedCalls: { complete: true, calls: [
            { id: "nr", name: "read", arguments: { path: "/nested-read.ts" }, status: "ok" },
            { id: "nw", name: "write", arguments: { path: "/nested-write.ts" }, status: "ok" },
            { id: "ne", name: "edit", arguments: { path: "/nested-edit.ts" }, status: "ok" },
        ] } });
        const anchor = h.user("ANCHOR");
        h.assistant([
            tool("read", "/hidden-read.ts", "hidden-read"), tool("read", "/shared-read.ts", "hidden-shared-read"),
            tool("write", "/shared-read.ts", "hidden-shared-write"), tool("edit", "/shared-write.ts", "hidden-shared-edit"),
            fauxToolCall("codemode", { code: "HIDDEN_SCRIPT" }, { id: "hidden-script" }),
        ]);
        h.result("hidden-read", "read", "HIDDEN_READ");
        h.result("hidden-shared-read", "read", "HIDDEN_SHARED_READ");
        h.result("hidden-shared-write", "write", "HIDDEN_SHARED_WRITE");
        h.result("hidden-shared-edit", "edit", "HIDDEN_SHARED_EDIT");
        const through = h.result("hidden-script", "codemode", "HIDDEN_SCRIPT_RESULT", { nestedCalls: { complete: true, calls: [
            { id: "hr", name: "read", arguments: { path: "/hidden-nested-read.ts" }, status: "ok" },
            { id: "hw", name: "write", arguments: { path: "/hidden-nested-write.ts" }, status: "ok" },
            { id: "he", name: "edit", arguments: { path: "/hidden-nested-edit.ts" }, status: "ok" },
        ] } });
        const summary = h.range(anchor, through);
        h.assistant([tool("read", "/prefix-read.ts", "prefix-read"), tool("edit", "/prefix-edit.ts", "prefix-edit")]);
        h.result("prefix-read", "read", "PREFIX_READ");
        h.result("prefix-edit", "edit", "PREFIX_EDIT");
        const raw = h.sm.buildSessionProjection().entries;
        const prefixStart = raw.findIndex((entry) => entry.sourceEntry.id === summary) + 1;
        const staleFileOps = {
            read: new Set(["/hidden-read.ts", "/shared-read.ts", "/hidden-nested-read.ts"]),
            written: new Set(["/shared-read.ts", "/hidden-nested-write.ts"]),
            edited: new Set(["/shared-write.ts", "/hidden-nested-edit.ts"]),
        };
        const event = { preparation: {
            messagesToSummarize: structuredClone(raw.slice(0, prefixStart).flatMap((entry) => entry.messages)
                .filter((message) => message.role !== "compactionSummary")),
            turnPrefixMessages: structuredClone(raw.slice(prefixStart).flatMap((entry) => entry.messages)),
            fileOps: staleFileOps,
        } };
        filterNativeCompaction(h.sm, event);
        const { preparation } = event;
        assert.notEqual(preparation.fileOps, staleFileOps, "metadata must be rebuilt rather than subtracting hidden paths");
        assert.doesNotMatch(JSON.stringify([...preparation.messagesToSummarize, ...preparation.turnPrefixMessages]), /HIDDEN_|hidden-/);
        assert.deepEqual(sorted(preparation.fileOps.read), sorted([
            "/shared-read.ts", "/nested-read.ts", "/prefix-read.ts", ...(fromHook ? [] : ["/prior-read.ts"]),
        ]));
        assert.deepEqual(sorted(preparation.fileOps.written), ["/nested-write.ts", "/shared-write.ts"]);
        assert.deepEqual(sorted(preparation.fileOps.edited), sorted([
            "/nested-edit.ts", "/prefix-edit.ts", ...(fromHook ? [] : ["/prior-modified.ts"]),
        ]));
    });
}
