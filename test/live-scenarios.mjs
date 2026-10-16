import { randomBytes } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { loadLiveConfig, startPi, text } from "./live-rpc.mjs";

// Opt-in live scenario matrix: real model, existing Pi auth, costs tokens.
// Each scenario runs in its own Pi process: checkpoint start-<id> → noisy step
// (NOISE_<token>, checkpoint inner-<id>) → the scenario's compaction. Checks use
// actual context hook output, canonical history, raw entries, tool executions and the reply.
const { model, extensions } = await loadLiveConfig();
const artifacts = await mkdtemp(resolve(tmpdir(), "pi-context-scenarios-"));
const only = process.env.PI_CONTEXT_SCENARIOS?.split(",").filter(Boolean);
// Each Pi RPC process uses ~200 MB; raise concurrency only when memory allows.
const concurrency = Number(process.env.PI_CONTEXT_SCENARIO_CONCURRENCY || 1);
console.log(JSON.stringify({ artifacts, model, extensions, only, concurrency }));

const CONFIGS = {
    direct: { tools: ["read", "bash", "context_checkpoint", "context_timeline", "context_compact"] },
    on: { tools: ["read", "bash", "codemode", "context_checkpoint", "context_timeline", "context_compact"],
        settings: { codemode: { mode: "on" } }, extraArgs: ["-e", "builtin:codemode"] },
    only: { tools: ["read", "bash", "codemode", "context_checkpoint", "context_timeline", "context_compact"],
        settings: { codemode: { mode: "only" } }, extraArgs: ["-e", "builtin:codemode"] },
};

const SYSTEM_PROMPT = "Execute the requested integration test exactly. When tool arguments are given, pass exactly those arguments and no other fields; when a script is given, run it unchanged. Keep output minimal. After compaction obey the summary's next step; never repeat completed tool calls.";
const script = (code) => `Call the codemode tool exactly once with exactly this script (raw JavaScript, no changes):\n\n${code}\n`;
const summary = (id, next = `reply exactly DONE_${id} without calling any tools.`) =>
    `Scenario ${id} setup history was compacted. Next step: ${next}`;
const compactArgs = (id, extra = {}) => JSON.stringify({ target: `start-${id}`, summary: summary(id), ...extra });
const cancelRule = (id) => `If you see that context_compact was cancelled or not applied, do not retry; reply exactly CANCELLED_${id}.`;

const scenarios = [
    // --- No codemode: direct (and parallel) tool calls ---
    { id: "D1", config: "direct", title: "compact alone", expect: "applied",
        prompt: (id) => `Call context_compact exactly once, as the only tool call, with arguments ${compactArgs(id)}.` },
    { id: "D2", config: "direct", title: "parallel bash + compact", expect: "applied", retained: ["SIB_"], once: ["SIB_"], shape: ["bash", "context_compact"],
        prompt: (id, t) => `In ONE assistant message, issue these two tool calls in parallel (both at once): bash with {"command":"echo SIB_${t}"} and context_compact with ${compactArgs(id)}.` },
    { id: "D3", config: "direct", title: "parallel timeline + checkpoint + compact", expect: "applied", absentInSummary: ["[context_timeline", "Context: "],
        shape: ["context_timeline", "context_checkpoint", "context_compact"],
        prompt: (id) => `In ONE assistant message, issue these three tool calls in parallel (all at once): context_timeline with {}, context_checkpoint with {"name":"mid-${id}"}, and context_compact with ${compactArgs(id)}.` },
    { id: "D4", config: "direct", title: "two parallel compacts", expect: "cancelled", notice: "more than one compact request",
        prompt: (id) => `In ONE assistant message, issue two context_compact tool calls in parallel (both at once), each with ${compactArgs(id)}. ${cancelRule(id)}` },
    { id: "D5", config: "direct", title: "invalid target, then valid", expect: "applied",
        prompt: (id) => `First call context_compact with {"target":"no-such-checkpoint-${id}","summary":"x"}; it will fail. After you see the error, call context_compact with ${compactArgs(id)}.` },
    { id: "D6", config: "direct", title: "backupCheckpoint recovery", expect: "applied", backup: true,
        prompt: (id) => `Call context_compact exactly once with ${compactArgs(id, { backupCheckpoint: `raw-${id}` })}.` },
    { id: "D7", config: "direct", title: "user steers during the compact step", expect: "applied", once: ["SLOW_"], steer: true,
        prompt: (id, t) => `In ONE assistant message, issue these two tool calls in parallel (both at once): bash with {"command":"sleep 6; echo SLOW_${t}"} and context_compact with ${compactArgs(id)}.` },
    { id: "D8", config: "direct", title: "user aborts the compact step", expect: "cancelled", notice: "the request was interrupted", abort: true,
        prompt: (id, t) => `In ONE assistant message, issue these two tool calls in parallel (both at once): bash with {"command":"sleep 8; echo SLOW_${t}"} and context_compact with ${compactArgs(id)}.` },
    { id: "D9", config: "direct", title: "follow-up queued during the compact step", expect: "applied", followUp: true,
        prompt: (id, t) => `In ONE assistant message, issue these two tool calls in parallel (both at once): bash with {"command":"sleep 6; echo SLOW_${t}"} and context_compact with ${compactArgs(id)}.` },
    { id: "D10", config: "direct", title: "repeat: folded target rejected, then root folds earlier summary", run: repeatedScenario },

    // A tiny keepRecentTokens lets Pi's native compaction run on a short session.
    { id: "N1", config: "direct", title: "after Pi native compaction: older target rejected, later target folds", run: nativeScenario,
        settings: { compaction: { keepRecentTokens: 100 } } },
    // --- codemode.mode = on: direct and script calls both available ---
    { id: "O1", config: "on", title: "codemode sibling + direct compact in one message", expect: "applied", retained: ["SIB_"], once: ["SIB_"], shape: ["codemode", "context_compact"],
        prompt: (id, t) => `In ONE assistant message, issue these two tool calls in parallel (both at once): a codemode call with the script \`text((await tools.bash({ command: "echo SIB_${t}" })).output);\` and a direct context_compact call with ${compactArgs(id)}.` },
    { id: "O2", config: "on", title: "compact inside a script with work before and after", expect: "applied", retained: ["BEFORE_", "AFTER_"], once: ["BEFORE_", "AFTER_"],
        prompt: (id, t) => script(`text((await tools.bash({ command: "echo BEFORE_${t}" })).output);\nawait tools.context_compact(${compactArgs(id)});\ntext((await tools.bash({ command: "echo AFTER_${t}" })).output);`) },
    { id: "O3", config: "on", title: "direct compact + script compact in one message", expect: "cancelled", notice: "more than one compact request",
        prompt: (id) => `In ONE assistant message, issue these two tool calls in parallel (both at once): a direct context_compact call with ${compactArgs(id)} and a codemode call with the script \`await tools.context_compact(${compactArgs(id)});\`. ${cancelRule(id)}` },

    // --- codemode.mode = only: everything through scripts ---
    { id: "S1", config: "only", title: "script: compact only", expect: "applied", retainedCount: 0,
        prompt: (id) => script(`await tools.context_compact(${compactArgs(id)});`) },
    { id: "S2", config: "only", title: "script: work, compact, work", expect: "applied", retained: ["BEFORE_", "AFTER_"], once: ["BEFORE_", "AFTER_"],
        prompt: (id, t) => script(`text((await tools.bash({ command: "echo BEFORE_${t}" })).output);\nawait tools.context_compact(${compactArgs(id)});\ntext((await tools.bash({ command: "echo AFTER_${t}" })).output);`) },
    { id: "S3", config: "only", title: "script: compact first, then work", expect: "applied", retained: ["AFTER_"], once: ["AFTER_"],
        prompt: (id, t) => script(`await tools.context_compact(${compactArgs(id)});\ntext((await tools.bash({ command: "echo AFTER_${t}" })).output);`) },
    { id: "S4", config: "only", title: "script: Promise.all([bash, compact])", expect: "applied", retained: ["PAR_"], once: ["PAR_"],
        prompt: (id, t) => script(`const [shell] = await Promise.all([\n  tools.bash({ command: "echo PAR_${t}" }),\n  tools.context_compact(${compactArgs(id)}),\n]);\ntext(shell.output);`) },
    { id: "S5", config: "only", title: "script: store before/after compact survives", expect: "applied", storeCheck: true,
        prompt: (id, t) => script(`store("before", "B_${t}");\nawait tools.context_compact(${JSON.stringify({ target: `start-${id}`, summary: summary(id, `call codemode with exactly the script: text(JSON.stringify([load("before"), load("after")])); then reply exactly DONE_${id}.`) })});\nstore("after", "A_${t}");`) },
    { id: "S6", config: "only", title: "script: throws after compact", expect: "applied", retained: ["AFTER_", "BOOM_"], once: ["AFTER_"],
        prompt: (id, t) => script(`await tools.context_compact(${compactArgs(id)});\ntext((await tools.bash({ command: "echo AFTER_${t}" })).output);\nthrow new Error("BOOM_${t}");`) },
    { id: "S7", config: "only", title: "script: second compact caught", expect: "cancelled", notice: "more than one compact request",
        prompt: (id) => `${script(`await tools.context_compact(${compactArgs(id)});\ntry { await tools.context_compact(${compactArgs(id)}); } catch (error) { text("second: " + error.message); }`)}\n${cancelRule(id)}` },
    { id: "S8", config: "only", title: "script: compact not awaited", expect: "observe",
        prompt: (id, t) => `${script(`tools.context_compact(${compactArgs(id)});\ntext("END_${t}");`)}\n${cancelRule(id)} If nothing indicates compaction, reply exactly NOTHING_${id}.` },
    { id: "S9", config: "only", title: "two scripts in one message: timeline + compact", expect: "applied", retainedCount: 0, shape: ["codemode", "codemode"],
        prompt: (id) => `In ONE assistant message, issue two codemode tool calls in parallel (both at once): one with the script \`text(await tools.context_timeline({}));\` and one with the script \`await tools.context_compact(${compactArgs(id)});\`.` },
    { id: "S10", config: "only", title: "script: prints the compact result", expect: "applied",
        prompt: (id) => script(`text(await tools.context_compact(${compactArgs(id)}));`) },
    { id: "S11", config: "only", title: "script: invalid compact caught, then valid", expect: "applied",
        prompt: (id) => script(`try { await tools.context_compact({ target: "no-such-checkpoint-${id}", summary: "x" }); } catch (error) { text("first: " + error.message); }\nawait tools.context_compact(${compactArgs(id)});`) },
    { id: "S12", config: "only", title: "script: Promise.allSettled of two compacts", expect: "cancelled", notice: "more than one compact request",
        prompt: (id) => `${script(`const results = await Promise.allSettled([\n  tools.context_compact(${compactArgs(id)}),\n  tools.context_compact(${compactArgs(id)}),\n]);\ntext(results.map((result) => result.status).join(","));`)}\n${cancelRule(id)}` },
    { id: "S13", config: "only", title: "script: backupCheckpoint recovery", expect: "applied", backup: true,
        prompt: (id) => script(`await tools.context_compact(${compactArgs(id, { backupCheckpoint: `raw-${id}` })});`) },
];

const labelFor = (entries, name) => entries.findLast((entry) => entry.type === "label" && entry.label === name);
/** A checkpoint resolves when it is still its target's latest label (a later label overwrites it). */
const checkpointResolves = (entries, name) => {
    const label = labelFor(entries, name);
    return Boolean(label) && entries.findLast((entry) => entry.type === "label" && entry.targetId === label.targetId).label === name;
};

async function setup(pi, scenario, token) {
    const { id, config } = scenario;
    const checkpoint = (name) => config === "only"
        ? script(`await tools.context_checkpoint({ name: "${name}" });`)
        : `Call context_checkpoint with exactly {"name":"${name}"} (no target field).`;
    // Models occasionally invent a checkpoint target; verify and retry setup steps.
    for (let attempt = 0; attempt < 2; attempt++) {
        await pi.prompt(`Scenario ${id} setup step 1. ${checkpoint(`start-${id}`)} Then reply exactly CHECK_OK.`);
        if (checkpointResolves((await pi.request("get_entries")).entries, `start-${id}`)) break;
    }
    const noise = config === "only"
        ? `${script(`text((await tools.bash({ command: "echo NOISE_${token}" })).output);`)}Then reply exactly NOISE_DONE.`
        : `Call bash with exactly {"command":"echo NOISE_${token}"}. Then reply exactly NOISE_DONE.`;
    await pi.prompt(noise);
    for (let attempt = 0; attempt < 2; attempt++) {
        await pi.prompt(`${checkpoint(`inner-${id}`)} Then reply exactly NOISE_OK.`);
        const { entries } = await pi.request("get_entries");
        if (checkpointResolves(entries, `inner-${id}`) && checkpointResolves(entries, `start-${id}`)) break;
    }
}

async function inspect(pi) {
    const { entries } = await pi.request("get_entries");
    const { messages: canonicalMessages } = await pi.request("get_messages");
    const messages = pi.getContextMessages();
    const summaries = messages.filter((message) => message.role === "custom" && message.customType === "pi-context-compaction");
    const calls = new Set();
    let pairsClosed = true;
    for (const message of messages) {
        if (message.role === "assistant") for (const block of message.content) if (block.type === "toolCall") calls.add(block.id);
        if (message.role === "toolResult" && !calls.delete(message.toolCallId)) pairsClosed = false;
    }
    return {
        entries, messages, canonicalMessages, summaries, pairsClosed: pairsClosed && calls.size === 0,
        visible: messages.map(text).join("\n"),
    };
}

const lastReply = (events) => text(events.filter((event) => event.type === "message_end" && event.message.role === "assistant").at(-1)?.message ?? { content: "" }).trim();
const executions = (events, marker) => events.filter((event) => event.type === "tool_execution_start" &&
    event.toolName === "bash" && JSON.stringify(event.args ?? {}).includes(marker)).length;
// A user abort leaves Pi's own empty aborted/errored assistant message; that is not a failure.
const runErrors = (events, aborted = false) => events.filter((event) => event.type === "extension_error" ||
    (event.type === "message_end" && event.message.role === "assistant" && event.message.stopReason === "error" &&
        !(aborted && event.message.content.length === 0)));

/** Shape of the assistant message that requested compaction: its outer tool names. */
function requestShape(entries) {
    const request = entries.findLast((entry) => entry.type === "message" && entry.message.role === "assistant" &&
        entry.message.content.some((block) => block.type === "toolCall" && (block.name === "context_compact" ||
            (block.name === "codemode" && JSON.stringify(block.arguments).includes("context_compact")))));
    return request?.message.content.filter((block) => block.type === "toolCall").map((block) => block.name).sort() ?? [];
}

async function runScenario(scenario) {
    const token = randomBytes(4).toString("hex");
    const { id } = scenario;
    const checks = [];
    const check = (name, ok, detail = "") => checks.push({ name, ok: Boolean(ok), detail });
    const config = CONFIGS[scenario.config];
    const pi = await startPi({ name: id, artifacts, model, extensions, systemPrompt: SYSTEM_PROMPT, ...config,
        settings: scenario.settings ? { ...config.settings, ...scenario.settings } : config.settings });
    let observation;
    try {
        await pi.request("set_auto_retry", { enabled: false });
        await setup(pi, scenario, token);
        const before = await inspect(pi);
        check("setup: noise visible before compaction", before.visible.includes(`NOISE_${token}`));
        check("setup: start and inner checkpoints resolve", checkpointResolves(before.entries, `start-${id}`) &&
            checkpointResolves(before.entries, `inner-${id}`));
        const offset = pi.events.length;
        if (scenario.run) {
            await scenario.run(pi, scenario, token, check);
        } else if (scenario.steer || scenario.abort || scenario.followUp) {
            await pi.request("prompt", { message: scenario.prompt(id, token) });
            await pi.waitFor(offset, (event) => event.type === "tool_execution_end" && event.toolName === "context_compact");
            if (scenario.steer) await pi.request("steer", { message: `STEER_${token}: a note sent while compaction ran; no action needed.` });
            else if (scenario.followUp) await pi.request("follow_up", { message: `FOLLOW_${token}: reply exactly FOLLOW_ACK.` });
            else await pi.request("abort");
            await pi.waitIdle(offset);
        } else {
            await pi.prompt(scenario.prompt(id, token));
        }
        const events = pi.events.slice(offset);
        const after = await inspect(pi);
        const reply = lastReply(events);
        const latest = after.summaries.at(-1);
        const errors = runErrors(events, scenario.abort);
        check("no extension or model errors", errors.length === 0, JSON.stringify(errors).slice(0, 300));
        check("tool calls and results stay paired", after.pairsClosed);
        if (scenario.shape) check(`request shape ${scenario.shape.join("+")}`, JSON.stringify(requestShape(after.entries)) === JSON.stringify([...scenario.shape].sort()), requestShape(after.entries).join("+"));
        if (scenario.expect === "applied") {
            check("summary in model context", latest && text(latest).includes(`Scenario ${id} setup history was compacted`));
            check("noise folded out of model context", !after.visible.includes(`NOISE_${token}`));
            check("canonical history retains noise", after.canonicalMessages.some((message) => text(message).includes(`NOISE_${token}`)));
            const stored = after.entries.filter((entry) => entry.type === "custom_message" && entry.customType === "pi-context-compaction");
            check("one summary stores the compaction range", stored.length === 1 && typeof stored[0].details?.range?.throughId === "string" &&
                (stored[0].details.range.afterId === null || typeof stored[0].details.range.afterId === "string"));
            check("prefix before target kept", after.visible.includes(`Scenario ${id} setup step 1`));
            const replies = events.filter((event) => event.type === "message_end" && event.message.role === "assistant").map((event) => text(event.message));
            check("model continued with the summary's next step", replies.some((value) => value.includes(`DONE_${id}`)), reply);
            for (const marker of scenario.retained ?? []) check(`kept step output ${marker}`, latest && text(latest).includes(`${marker}${token}`));
            for (const marker of scenario.absentInSummary ?? []) check(`management output ${marker} not kept`, latest && !text(latest).includes(marker));
            if (scenario.retainedCount !== undefined) check(`kept ${scenario.retainedCount} tool outputs`, latest?.details?.retained === scenario.retainedCount, String(latest?.details?.retained));
        }
        if (scenario.expect === "cancelled") {
            // Judge the requesting step at its end; the model may legitimately retry afterwards.
            const runEntries = after.entries.filter((entry) => !before.entries.some((old) => old.id === entry.id));
            const noticeIndex = runEntries.findIndex((entry) => entry.type === "custom_message" &&
                entry.customType === "pi-context" && text(entry).includes(scenario.notice));
            check(`step cancelled with notice: ${scenario.notice}`, noticeIndex >= 0);
            check("nothing folded or summarized by the cancelled step", noticeIndex >= 0 && !runEntries.slice(0, noticeIndex)
                .some((entry) => entry.customType === "pi-context-compaction"));
            const retried = after.summaries.length > 0;
            if (!retried) check("noise still visible", after.visible.includes(`NOISE_${token}`));
            observation = { retriedAfterCancel: retried, reply };
        }
        for (const marker of scenario.once ?? []) check(`${marker} ran once`, executions(pi.events, `${marker}${token}`) === 1, String(executions(pi.events, `${marker}${token}`)));
        if (scenario.steer || scenario.followUp) {
            const marker = scenario.steer ? `STEER_${token}` : `FOLLOW_${token}`;
            const summaryIndex = after.messages.findIndex((message) => message.role === "custom" && message.customType === "pi-context-compaction");
            const inputIndex = after.messages.findIndex((message) => message.role === "user" && text(message).includes(marker));
            check("queued input arrives after the summary", summaryIndex >= 0 && inputIndex > summaryIndex, `${summaryIndex}/${inputIndex}`);
            if (scenario.followUp) check("model answered the follow-up", reply.includes("FOLLOW_ACK"), reply);
        }
        if (scenario.backup) {
            const label = after.entries.findLast((entry) => entry.type === "label" && entry.label === `raw-${id}`);
            check("backup checkpoint labeled", label);
            // The path ending at the backup holds the raw history and not the later summary.
            const byId = new Map(after.entries.map((entry) => [entry.id, entry]));
            const path = [];
            for (let entry = label && byId.get(label.targetId); entry; entry = byId.get(entry.parentId)) path.push(entry);
            check("backup restores the original context", path.some((entry) => entry.type === "message" && text(entry.message).includes(`NOISE_${token}`)) &&
                !path.some((entry) => entry.customType === "pi-context-compaction"));
        }
        if (scenario.storeCheck) {
            const loaded = events.filter((event) => event.type === "tool_execution_end" && event.toolName === "codemode")
                .map((event) => JSON.stringify(event.result)).join("\n");
            check("store values written before and after compact load later", loaded.includes(`B_${token}`) && loaded.includes(`A_${token}`), loaded.slice(-300));
        }
        if (scenario.expect === "observe") {
            observation = { applied: after.summaries.length > 0, reply,
                notices: after.messages.filter((message) => message.role === "custom" && message.customType === "pi-context").map(text) };
        }
    } catch (error) {
        check("scenario completed", false, error.stack?.slice(0, 500));
    } finally {
        await pi.close(artifacts);
    }
    return { id: scenario.id, config: scenario.config, title: scenario.title, ok: checks.every((item) => item.ok), checks, observation };
}

async function repeatedScenario(pi, { id }, token, check) {
    let events = await pi.prompt(`Call context_compact exactly once with ${JSON.stringify({ target: `start-${id}`, summary: summary(id, `reply exactly FIRST_${id} without calling any tools.`) })}.`);
    check("first compaction continued", lastReply(events).includes(`FIRST_${id}`), lastReply(events));
    events = await pi.prompt(`Call context_compact exactly once with {"target":"inner-${id}","summary":"x"}. It should fail; do not retry. Then reply exactly REJECTED_${id}.`);
    const rejection = events.find((event) => event.type === "tool_execution_end" && event.toolName === "context_compact");
    check("folded target rejected", rejection?.isError && JSON.stringify(rejection.result).includes("already compacted"), JSON.stringify(rejection?.result).slice(0, 200));
    events = await pi.prompt(`Call context_compact exactly once with ${JSON.stringify({ target: "root", summary: `Scenario ${id} root compaction. Next step: reply exactly DONE_${id} without calling any tools.` })}.`);
    const after = await inspect(pi);
    check("root compaction continued", lastReply(events).includes(`DONE_${id}`), lastReply(events));
    check("only the latest summary is visible", after.summaries.length === 1 && text(after.summaries[0]).includes("root compaction"));
    check("everything before root folded", !after.visible.includes(`Scenario ${id} setup step 1`) && !after.visible.includes(`NOISE_${token}`));
    check("tool calls and results stay paired", after.pairsClosed);
}

async function nativeScenario(pi, { id }, token, check) {
    const native = await pi.request("compact", {}, 180000);
    check("native compaction ran", native?.summary, JSON.stringify(native).slice(0, 200));
    // The next model request exposes the context produced after native compaction.
    // An older target cannot keep "everything up to it": Pi's summary already replaced it.
    let events = await pi.prompt(`Call context_compact exactly once with ${compactArgs(id)}. If it fails, do not retry; reply exactly REJECTED_${id}.`);
    check("setup: start checkpoint is before the native kept range", !(await inspect(pi)).visible.includes(`Scenario ${id} setup step 1`));
    const rejection = events.find((event) => event.type === "tool_execution_end" && event.toolName === "context_compact");
    check("old target rejected", rejection?.isError && JSON.stringify(rejection.result).includes("already compacted"), JSON.stringify(rejection?.result).slice(0, 200));
    let after = await inspect(pi);
    check("rejection changed no context", after.summaries.length === 0);
    // A checkpoint after the native compaction still folds cleanly.
    await pi.prompt(`Call context_checkpoint with exactly {"name":"late-${id}"} (no target field). Then reply exactly LATE_OK.`);
    check("late checkpoint created", checkpointResolves((await pi.request("get_entries")).entries, `late-${id}`));
    await pi.prompt(`Call bash with exactly {"command":"echo LATE_${token}"}. Then reply exactly LATE_DONE.`);
    events = await pi.prompt(`Call context_compact exactly once with ${JSON.stringify({ target: `late-${id}`, summary: summary(id) })}.`);
    after = await inspect(pi);
    const latest = after.summaries.at(-1);
    check("no extension or model errors", runErrors(events).length === 0, JSON.stringify(runErrors(events)).slice(0, 300));
    check("summary in model context", latest && text(latest).includes(`Scenario ${id} setup history was compacted`));
    check("native compaction summary still leads the context", after.messages.some((message) => message.role === "compactionSummary"));
    check("work after the late target folded", !after.visible.includes(`LATE_${token}`));
    check("model continued with the summary's next step", lastReply(events).includes(`DONE_${id}`), lastReply(events));
    check("tool calls and results stay paired", after.pairsClosed);
}

const selected = scenarios.filter((scenario) => !only || only.includes(scenario.id));
const results = [];
const queue = [...selected];
await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (let scenario = queue.shift(); scenario; scenario = queue.shift()) {
        const result = await runScenario(scenario);
        results.push(result);
        console.log(`${result.ok ? "PASS" : "FAIL"} ${result.id} [${result.config}] ${result.title}` +
            (result.observation ? ` → ${JSON.stringify(result.observation)}` : ""));
        for (const item of result.checks.filter((entry) => !entry.ok)) console.log(`   ✖ ${item.name} ${item.detail}`);
    }
}));
const order = new Map(selected.map((scenario, index) => [scenario.id, index]));
results.sort((a, b) => order.get(a.id) - order.get(b.id));
await writeFile(resolve(artifacts, "results.json"), JSON.stringify(results, null, 2));
const failed = results.filter((result) => !result.ok);
console.log(`${results.length - failed.length}/${results.length} scenarios passed; artifacts: ${artifacts}`);
process.exitCode = failed.length ? 1 : 0;
