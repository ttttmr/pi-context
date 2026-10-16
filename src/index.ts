import {
    type ExtensionAPI,
    type ExtensionContext,
    type SessionBoundaryDraft,
    type SessionEntry,
    type SessionTreeNode,
    type TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import {
    Type,
    type Static,
    type TextContent,
    type ImageContent,
    type ToolCall,
    type ToolResultMessage,
} from "@earendil-works/pi-ai";
import { Box, Text } from "@earendil-works/pi-tui";
import { CompactionSummaryType, estimateHistoryTokens, formatTokens, formatContextUsage, isContextTool as isInternal, isFoldableEntry } from "./utils.js";
import { filterCompactionMessages, filterNativeCompaction, getCompactionContextUsage, getCompactionProjection, isFoldedEntry, type CompactionDetails } from "./compaction-context.js";
import { registerContextTimeline } from "./timeline.js";

export type { CompactionDetails } from "./compaction-context.js";

type ReadonlySessionManager = ExtensionContext["sessionManager"];

const PiContextCustomMessageType = "pi-context";

// Locate the assistant message whose tool call requested compaction. Nested calls
// (codemode scripts or other tools using ctx.executeTool) get Pi-assigned IDs of
// the form <parent id>/<n>; parent IDs are opaque and may contain slashes.
const findCompactRequest = (branch: readonly SessionEntry[], toolCallId: string): string | undefined => {
    for (let i = branch.length - 1; i >= 0; i--) {
        const entry = branch[i];
        if (entry.type !== "message" || entry.message.role !== "assistant") continue;
        for (const block of entry.message.content) {
            if (block.type !== "toolCall") continue;
            if (block.id === toolCallId && block.name === "context_compact") return entry.id;
            if (toolCallId.startsWith(`${block.id}/`) &&
                /^\d+(\/\d+)*$/.test(toolCallId.slice(block.id.length + 1))) return entry.id;
        }
    }
};

const isRootTarget = (target: string) => target.toLowerCase() === "root";

/**
 * Find the entry carrying a checkpoint name. Pi keeps one label per entry but not one
 * entry per label (users can also label in /tree), so prefer the newest match on the
 * active path, then any other branch. Iterative DFS avoids stack overflows on deep histories.
 */
const findCheckpoint = (sm: ReadonlySessionManager, name: string): string | undefined => {
    const branch = sm.getBranch();
    for (let i = branch.length - 1; i >= 0; i--) {
        if (sm.getLabel(branch[i].id) === name) return branch[i].id;
    }
    const stack: SessionTreeNode[] = [...sm.getTree()];
    while (stack.length > 0) {
        const n = stack.pop()!;
        if (sm.getLabel(n.entry.id) === name) return n.entry.id;
        stack.push(...n.children);
    }
};

/** Checkpoint names win over entry IDs; unresolved targets are validated by the caller. */
const resolveTargetId = (sm: ReadonlySessionManager, target: string): string => {
    if (isRootTarget(target)) {
        const tree = sm.getTree();
        return tree.length > 0 ? tree[0].entry.id : target;
    }
    return findCheckpoint(sm, target) ?? target;
};

/** Reject names that a later target could not resolve to exactly this checkpoint. */
const checkpointNameError = (sm: ReadonlySessionManager, name: string, pendingName?: string): string | undefined => {
    if (!name.trim()) return "Checkpoint name must not be empty.";
    if (isRootTarget(name)) return `Checkpoint name '${name}' is reserved: root means the start of the current context. Use a different name.`;
    if (sm.getEntry(name)) return `Checkpoint name '${name}' is already an entry ID. Use a different name.`;
    const existing = findCheckpoint(sm, name);
    if (existing) return `Checkpoint '${name}' already exists at ${existing}. Checkpoint names must be unique. Use a different name or remove the existing one first.`;
    if (name === pendingName) return `Checkpoint '${name}' is already reserved as the backup checkpoint of a pending compaction. Use a different name.`;
};

/**
 * Locate a compaction target in the current model context. Pi's native compaction
 * has already summarized history before its kept range, so a target there cannot
 * preserve its original prefix. Root means the start of the current context.
 * Returns the context-ordered projection and index.
 */
const locateContextTarget = (sm: ReadonlySessionManager, targetId: string, root: boolean) => {
    const projection = getCompactionProjection(sm);
    if (root) return { projection, index: -1 };
    const index = projection.findIndex((entry) => entry.sourceEntry.id === targetId);
    if (index < 0) return { projection, index, reason: "outside" as const };
    if (isFoldedEntry(projection[index])) return { projection, index, reason: "folded" as const };
    return { projection, index };
};

const ContextCompactDescription = "Compact the conversation after an earlier checkpoint or history node into a summarized continuation. The selected target is where the continuation starts; the summary must restore the useful state from the compacted path after that target. This changes conversation history only; it does not modify or roll back disk files or external systems.";
const ContextCompactParams = Type.Object({
    target: Type.String({ description: "Checkpoint name, history node ID, or root to use as the starting point for the summarized continuation." }),
    summary: Type.String({ description: "Handoff summary injected into the summarized continuation. Restore current task/state, decisions/constraints, important external side effects (changed files, processes, browser/tickets/remote state), validation status, source anchors/evidence/open questions likely needed soon, and explicit next step. Do not rely on backupCheckpoint for details needed in the next phase." }),
    backupCheckpoint: Type.Optional(Type.String({ description: "Optional checkpoint name to label the current conversation state before compacting. This is only a recovery pointer; the summary must still contain the state needed to continue." })),
});

const ContextCheckpointDescription = "Create a named anchor by labeling a conversation history node. This does not branch, summarize, or affect external state; it only makes the point easy to find later in timeline or compact target selection.";
const ContextCheckpointParams = Type.Object({
    name: Type.String({ description: "Unique <scope>-<phase> name; phase suffixes: start, done (stable result), pivot (change approach), pause, resume. Keep scope consistent within a phase's lifecycle; other names remain ordinary anchors." }),
    target: Type.Optional(Type.String({ description: "Optional history node ID or checkpoint name to label. Defaults to the current meaningful position near the conversation head." })),
});

interface PendingCompactRequest extends Static<typeof ContextCompactParams> {
    targetId: string;
    /** Root folds the whole current context. */
    root: boolean;
    requestEntryId: string;
    invalidated?: boolean;
}

// Context tool results describe pre-fold state; a script whose recorded calls were
// all context tools is management traffic too. Anything else is kept as task output.
const isManagementResult = (result: ToolResultMessage) => {
    if (isInternal(result.toolName)) return true;
    const record = result.nestedCalls;
    return record?.complete === true && record.calls.length > 0 &&
        record.calls.every((call) => isInternal(call.name));
};

const truncate = (text: string, max: number) => text.length > max ? `${text.slice(0, max)}…` : text;

/**
 * Record one compact range at the end of the requesting step. turn_end runs after
 * every result is persisted and before steering or the next request. The context
 * hook applies the range on each request, keeping tool calls and results paired.
 */
const planCompaction = (
    sm: ReadonlySessionManager,
    request: PendingCompactRequest,
    event: Pick<TurnEndEvent, "message" | "toolResults">,
): { entries: SessionBoundaryDraft[]; details: CompactionDetails } | { error: string } => {
    const { projection, index: targetIndex, reason } = locateContextTarget(sm, request.targetId, request.root);
    if (reason) return { error: "the target is no longer in the current conversation." };

    // Keep results answering calls of the last assistant message at or before the target.
    const keptCalls = new Set<string>();
    let keepToolResultsOf: string | undefined;
    for (let i = targetIndex; i >= 0; i--) {
        const entry = projection[i].sourceEntry;
        if (entry.type !== "message" || entry.message.role !== "assistant") continue;
        keepToolResultsOf = entry.id;
        for (const block of entry.message.content) if (block.type === "toolCall") keptCalls.add(block.id);
        break;
    }
    // Context order, not raw order: a native compaction summary leads the context.
    // Non-foldable entries (system loadout, user bash, branch summaries, native
    // compaction) stay visible to preserve required state and existing behavior.
    const folded = projection.slice(targetIndex + 1).flatMap(({ sourceEntry, messages }) => {
        if (!messages.length || !isFoldableEntry(sourceEntry)) return [];
        if (sourceEntry.type === "message" && sourceEntry.message.role === "toolResult" &&
            keptCalls.has(sourceEntry.message.toolCallId)) return [];
        return [sourceEntry];
    });

    const calls = new Map<string, ToolCall>();
    if (event.message.role === "assistant") {
        for (const block of event.message.content) if (block.type === "toolCall") calls.set(block.id, block);
    }
    const retained = event.toolResults.filter((result) => !isManagementResult(result));
    const label = (result: ToolResultMessage) => {
        const call = calls.get(result.toolCallId);
        // Script source is not output; other calls need their arguments to be interpretable.
        const args = call && result.toolName !== "codemode" ? ` ${truncate(JSON.stringify(call.arguments), 300)}` : "";
        return `[${result.toolName}${args}]${result.isError ? " (error)" : ""}`;
    };
    const backup = request.backupCheckpoint ? ` (backup checkpoint: ${request.backupCheckpoint})` : "";
    const content: (TextContent | ImageContent)[] = [{
        type: "text",
        text: `context_compact complete. Your previous conversation after ${request.target} was summarized${backup}. Read the handoff summary to understand your new state.\n\n${request.summary}`,
    }];
    if (retained.length) {
        content.push({ type: "text", text: "\n\nOutput from tool calls that already completed together with context_compact. Do not rerun their completed operations. The handoff summary above covers earlier history, not this output." });
        for (const result of retained) {
            content.push({ type: "text", text: `\n${label(result)}\n` }, ...result.content);
        }
    }
    content.push({ type: "text", text: "\n\nExecute the Next Step from the summary." });

    const details: CompactionDetails = {
        target: request.target, targetId: request.targetId, requestEntryId: request.requestEntryId,
        summary: request.summary, folded: folded.length,
        foldedTokens: folded.reduce((sum, entry) => sum + estimateHistoryTokens(entry), 0),
        retained: retained.length, backupCheckpoint: request.backupCheckpoint,
        range: {
            afterId: request.root ? null : request.targetId,
            throughId: sm.getLeafId()!,
            ...(keepToolResultsOf && keptCalls.size ? { keepToolResultsOf } : {}),
        },
    };
    return {
        entries: [
            { type: "custom_message", customType: CompactionSummaryType, content, display: true, details },
        ],
        details,
    };
};

export default function (pi: ExtensionAPI) {
    let pendingCompact: PendingCompactRequest | null = null;

    const notice = (text: string): SessionBoundaryDraft => ({
        type: "custom_message", customType: PiContextCustomMessageType, content: text, display: false,
    });

    pi.on("session_shutdown", () => {
        pendingCompact = null;
    });

    pi.on("context", (event, ctx) => ({ messages: filterCompactionMessages(ctx.sessionManager, event.messages) }));
    pi.on("session_before_compact", (event, ctx) => {
        filterNativeCompaction(ctx.sessionManager, event);
    });

    pi.registerCommand("acm", {
        description: "Compatibility command: agentic context management is always enabled",
        handler: async (args, ctx) => {
            if (args) pi.sendUserMessage(args, { deliverAs: "followUp" });
            else ctx.ui.notify("Agentic Context Management is always enabled.", "info");
        }
    });

    pi.registerMessageRenderer<CompactionDetails>(CompactionSummaryType, (message, { expanded, outputPad }, theme) => {
        const details = message.details;
        const title = theme.fg("accent", theme.bold("Context compacted")) + (details
            ? theme.fg("muted", ` to ${details.target} · ${details.folded} entries (~${formatTokens(details.foldedTokens)} tokens)` +
                (details.retained ? ` · kept ${details.retained} tool outputs` : "") +
                (details.backupCheckpoint ? ` · backup: ${details.backupCheckpoint}` : ""))
            : "");
        const body = expanded || !details
            ? (typeof message.content === "string" ? message.content
                : message.content.map((block) => block.type === "text" ? block.text : "[image]").join(""))
            : details.summary;
        const box = new Box(outputPad, 1, (text) => theme.bg("customMessageBg", text));
        box.addChild(new Text(`${title}\n${body}`, 0, 0));
        return box;
    });

    pi.registerTool({
        name: "context_checkpoint",
        label: "Context Checkpoint",
        description: ContextCheckpointDescription,
        parameters: ContextCheckpointParams,
        async execute(_id, params: Static<typeof ContextCheckpointParams>, _signal, _onUpdate, ctx) {
            const sm = ctx.sessionManager;
            const nameError = checkpointNameError(sm, params.name, pendingCompact?.backupCheckpoint);
            if (nameError) throw new Error(nameError);

            let id = params.target ? resolveTargetId(sm, params.target) : undefined;
            if (!id) {
                // Default to the newest entry, usually the requesting assistant message.
                // Results of context tools describe management traffic, not task state.
                const branch = sm.getBranch();
                for (let i = branch.length - 1; i >= 0 && !id; i--) {
                    const entry = branch[i];
                    if (entry.type === "message" && entry.message.role === "toolResult" && isInternal(entry.message.toolName)) continue;
                    id = entry.id;
                }
                id ??= sm.getLeafId() ?? "";
            }
            if (!sm.getEntry(id)) {
                throw new Error(`Target ${params.target ?? id} was not found; use a checkpoint name or an entry ID from context_timeline.`);
            }
            // Pi keeps one label per entry: relabeling would silently remove a checkpoint.
            const existingName = sm.getLabel(id);
            if (existingName) {
                throw new Error(`Entry ${id} already has checkpoint '${existingName}'. Use that checkpoint or choose another target.`);
            }

            pi.setLabel(id, params.name);
            return {
                content: [{
                    type: "text",
                    text: `Created checkpoint '${params.name}' at ${id}.`
                }],
                details: {}
            };
        },
    });

    registerContextTimeline(pi);

    pi.registerTool({
        name: "context_compact",
        label: "Context Compact",
        description: ContextCompactDescription,
        parameters: ContextCompactParams,
        async execute(toolCallId, params: Static<typeof ContextCompactParams>, _signal, _onUpdate, ctx) {
            const sm = ctx.sessionManager;
            const branch = sm.getBranch();
            const requestEntryId = findCompactRequest(branch, toolCallId);
            if (!requestEntryId) {
                throw new Error("context_compact: cannot locate the requesting tool call in session history.");
            }
            // Parallel or repeated requests in one step are ambiguous: cancel both.
            if (pendingCompact?.requestEntryId === requestEntryId) {
                pendingCompact.invalidated = true;
                throw new Error("context_compact: only one compact request is allowed at a time; neither request will compact.");
            }
            const root = isRootTarget(params.target);
            const targetId = resolveTargetId(sm, params.target);
            if (!sm.getEntry(targetId)) {
                throw new Error(`context_compact: target ${params.target} was not found; use a checkpoint name, an entry ID from context_timeline, or root.`);
            }
            const targetIndex = branch.findIndex((entry) => entry.id === targetId);
            if (targetIndex < 0 || targetIndex >= branch.findIndex((entry) => entry.id === requestEntryId)) {
                throw new Error(`context_compact: target ${params.target} is not earlier in the current conversation; choose a checkpoint from context_timeline or root.`);
            }
            // Folded targets would also drop the summary that covers them; targets before
            // Pi's native kept range lost their prefix. Both share one remedy and wording.
            if (locateContextTarget(sm, targetId, root).reason) {
                throw new Error(`context_compact: target ${params.target} is inside history that was already compacted; choose a later checkpoint from context_timeline or root.`);
            }
            // Validate now so the label cannot fail or duplicate a name after folding.
            const backupError = params.backupCheckpoint ? checkpointNameError(sm, params.backupCheckpoint) : undefined;
            if (backupError) throw new Error(`context_compact: backupCheckpoint: ${backupError}`);
            pendingCompact = { ...params, targetId, root, requestEntryId };
            return {
                content: [{
                    type: "text",
                    text: "compact start",
                }],
                details: {},
            };
        },
    });

    pi.on("turn_end", async (event, ctx) => {
        const request = pendingCompact;
        if (!request) return;
        pendingCompact = null;
        const cancel = (reason: string, retry = true) => {
            ctx.ui.notify(`context_compact cancelled: ${reason}`, "warning");
            const next = retry ? " If still useful, inspect timeline and retry with an updated summary." : "";
            return { entries: [...event.entries, notice(`context_compact cancelled: ${reason}\nNo compaction was applied; continue from the current path.${next}`)] };
        };
        if (request.requestEntryId !== event.messageEntryId) return cancel("the request did not complete normally.");
        if (request.invalidated) return cancel("more than one compact request was made.");
        // A tool step interrupted by the user still reports a completed assistant message.
        if (ctx.signal?.aborted || event.outcome !== "completed") return cancel("the request was interrupted.", false);
        const usageBefore = formatContextUsage(getCompactionContextUsage(ctx.sessionManager, ctx.getContextUsage()));
        const plan = planCompaction(ctx.sessionManager, request, event);
        if ("error" in plan) return cancel(plan.error);
        if (request.backupCheckpoint) {
            pi.setLabel(event.toolResultEntryIds.at(-1) ?? event.messageEntryId, request.backupCheckpoint);
        }
        const { details } = plan;
        ctx.ui.notify([
            `Compacted to ${details.target} (${details.folded} entries, ~${formatTokens(details.foldedTokens)} tokens)` +
                (details.retained ? `, kept ${details.retained} tool outputs` : ""),
            `Context usage before: ${usageBefore}`,
            `Backup checkpoint created: ${details.backupCheckpoint || "none"}`,
        ].join("\n"), "info");
        return { entries: [...event.entries, ...plan.entries], continue: true };
    });

    // turn_end consumes every request; one left here never reached its step boundary.
    pi.on("agent_end", async (_event, ctx) => {
        if (!pendingCompact) return;
        pendingCompact = null;
        ctx.ui.notify("context_compact cancelled: the request did not complete normally.", "warning");
        pi.sendMessage({
            customType: PiContextCustomMessageType,
            content: "context_compact cancelled: the request did not complete normally.\nNo compaction was applied; continue from the current path.",
            display: false,
        }, { deliverAs: "nextTurn" });
    });
}
