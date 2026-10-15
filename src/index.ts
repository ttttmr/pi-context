import {
    type ExtensionAPI,
    type ExtensionContext,
    type SessionBoundaryDraft,
    type SessionEntry,
    type SessionTreeNode,
    type ProjectedSessionEntry,
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
import { CompactionSummaryType, describeHistoryInterval, estimateHistoryTokens, formatTokens, formatContextUsage, isContextTool as isInternal, isEditableContextEntry, parseCheckpointPhase, RetainedCodemodeOutputType } from "./utils.js";

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

const resolveTargetId = (sm: ReadonlySessionManager, target: string): string => {
    if (target.toLowerCase() === "root") {
        const tree = sm.getTree();
        return tree.length > 0 ? tree[0].entry.id : target;
    }

    // If it already looks like an ID, keep it.
    if (/^[0-9a-f]{8,}$/i.test(target)) return target;

    // Iterative DFS to avoid call stack overflows on deep histories.
    const stack: SessionTreeNode[] = [...sm.getTree()];
    while (stack.length > 0) {
        const n = stack.pop()!;
        if (sm.getLabel(n.entry.id) === target) return n.entry.id;
        if (n.children?.length) stack.push(...n.children);
    }

    // Fallback: validation reports targets that are not on the active path.
    return target;
};

/**
 * Locate a compaction target in the current model context. Pi's native compaction
 * replaces history before its kept range with a summary that cannot be omitted, so
 * a target there cannot keep exactly "everything up to the target". Root means the
 * start of the current context. Returns the context-ordered projection and index.
 */
const locateContextTarget = (sm: ReadonlySessionManager, targetId: string, root: boolean) => {
    const projection = sm.buildSessionProjection().entries;
    if (root) return { projection, index: -1 };
    const index = projection.findIndex((entry) => entry.sourceEntry.id === targetId);
    if (index < 0) return { projection, index, reason: "outside" as const };
    if (isFoldedEntry(projection[index])) return { projection, index, reason: "folded" as const };
    return { projection, index };
};

/** Folded by an earlier compaction: editable and selected, but contributing no model messages. */
const isFoldedEntry = (entry: ProjectedSessionEntry) => !entry.messages.length && isEditableContextEntry(entry.sourceEntry);

const ContextTimelineDescription = "Inspect the active conversation path as a structural map: checkpoints, summaries/compactions, branch points, user turns, and current position. Use when orientation or compact target selection depends on the shape of history. Folded intervals show historical token estimates, not reclaimable space.";
const ContextTimelineParams = Type.Object({
    limit: Type.Optional(Type.Number({ description: "Maximum visible timeline entries (default: 50)." })),
    verbose: Type.Optional(Type.Boolean({ description: "If true, show all messages including internal context-tool traffic. If false (default), collapse to structural milestones." })),
});

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

export interface CompactionDetails {
    target: string;
    targetId: string;
    requestEntryId: string;
    summary: string;
    folded: number;
    foldedTokens: number;
    retained: number;
    backupCheckpoint?: string;
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
 * Fold history at the end of the step that requested compaction. turn_end runs after
 * every tool result of that step is persisted and before steering or the next request,
 * so the step is complete and nothing else can interleave. The request message and its
 * results are folded together, so no tool call or result is orphaned.
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
    for (let i = targetIndex; i >= 0; i--) {
        const entry = projection[i].sourceEntry;
        if (entry.type !== "message" || entry.message.role !== "assistant") continue;
        for (const block of entry.message.content) if (block.type === "toolCall") keptCalls.add(block.id);
        break;
    }
    // Context order, not raw order: a native compaction summary leads the context.
    // Non-editable entries (system loadout, user bash, branch summaries, native
    // compaction) stay visible; Pi cannot omit them and they carry required state.
    const folded = projection.slice(targetIndex + 1).flatMap(({ sourceEntry, messages }) => {
        if (!messages.length || !isEditableContextEntry(sourceEntry)) return [];
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
    };
    return {
        entries: [
            ...folded.map((entry): SessionBoundaryDraft => ({ type: "context_edit", targetId: entry.id, replacement: null })),
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

    // Helper: Check if a checkpoint name already exists in the tree
    // Iterative DFS to avoid call stack overflows on deep histories.
    // Push children in reverse order to preserve left-to-right pre-order semantics.
    const findCheckpointInTree = (sm: ReadonlySessionManager, nodes: SessionTreeNode[], checkpointName: string): string | null => {
        const stack: SessionTreeNode[] = [...nodes].reverse();
        while (stack.length > 0) {
            const n = stack.pop()!;
            if (sm.getLabel(n.entry.id) === checkpointName) return n.entry.id;
            if (n.children?.length) {
                for (let i = n.children.length - 1; i >= 0; i--) {
                    stack.push(n.children[i]);
                }
            }
        }
        return null;
    };

    pi.registerTool({
        name: "context_checkpoint",
        label: "Context Checkpoint",
        description: ContextCheckpointDescription,
        parameters: ContextCheckpointParams,
        async execute(_id, params: Static<typeof ContextCheckpointParams>, _signal, _onUpdate, ctx) {
            const sm = ctx.sessionManager;

            // Deduplication check: ensure checkpoint name is unique
            const existingCheckpointId = findCheckpointInTree(sm, sm.getTree(), params.name);
            if (existingCheckpointId) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Checkpoint '${params.name}' already exists at ${existingCheckpointId}. Checkpoint names must be unique. Use a different name or remove the existing one first.`
                    }],
                    details: {}
                };
            }

            let id = params.target ? resolveTargetId(sm, params.target) : undefined;

            if (!id) {
                // Auto-resolve: Find the last interesting node to checkpoint.
                // We skip ToolResults that look awkward when checkpointed and internal-only assistant messages that look empty.
                const branch = sm.getBranch();
                for (let i = branch.length - 1; i >= 0; i--) {
                    const entry = branch[i];

                    // 1. Check ToolResults
                    if (entry.type === 'message' && entry.message.role === 'toolResult') {
                        const tr = entry.message as any;
                        if (isInternal(tr.toolName)) continue;

                        // Public tool result is a valid target
                        id = entry.id;
                        break;
                    }

                    // 2. Check Assistant messages for visibility
                    if (entry.type === 'message' && entry.message.role === 'assistant') {
                        const m = entry.message;
                        const hasInternalTool = m.content.some(c => c.type === 'toolCall' && isInternal(c.name));

                        if (!hasInternalTool) {
                            id = entry.id;
                            break;
                        }
                    }

                    id = entry.id;
                    break;
                }
                // Fallback to leaf if search failed
                if (!id) id = sm.getLeafId() ?? "";
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

    pi.registerTool({
        name: "context_timeline",
        label: "Context Timeline",
        description: ContextTimelineDescription,
        parameters: ContextTimelineParams,
        async execute(_id, params: Static<typeof ContextTimelineParams>, _signal, _onUpdate, ctx) {
            const sm = ctx.sessionManager;
            const branch = sm.getBranch();
            const currentLeafId = sm.getLeafId();
            // The read-only manager has no getChildren; index children from the tree once.
            const childrenById = new Map<string, SessionEntry[]>();
            for (const stack = [...sm.getTree()]; stack.length;) {
                const node = stack.pop()!;
                childrenById.set(node.entry.id, node.children.map((child) => child.entry));
                stack.push(...node.children);
            }
            const getChildren = (id: string) => childrenById.get(id) ?? [];
            const verbose = params.verbose ?? false;
            const limit = params.limit ?? 50;

            const backboneIds = new Set(branch.map((e) => e.id));
            const projection = sm.buildSessionProjection().entries;
            const foldedIds = new Set(projection.filter(isFoldedEntry).map((entry) => entry.sourceEntry.id));
            // Active-path history Pi's native compaction replaced with its summary: not compact targets.
            const contextIds = new Set(projection.map((entry) => entry.sourceEntry.id));
            let nativeIndex = -1;
            branch.forEach((entry, index) => { if (entry.type === "compaction") nativeIndex = index; });
            // Root stays a valid target: it means the start of the current context.
            const summarizedIds = new Set(branch.slice(1, Math.max(nativeIndex, 0))
                .filter((entry) => !contextIds.has(entry.id)).map((entry) => entry.id));
            const hiddenKind = (id: string) => foldedIds.has(id) || summarizedIds.has(id) ? "compacted: " : "";
            const sequence: SessionEntry[] = [];
            const isTaskMessage = (entry: SessionEntry) => entry.type === "custom_message" &&
                (entry.customType === RetainedCodemodeOutputType || entry.customType === CompactionSummaryType);

            branch.forEach((entry) => {
                // Context edits are bookkeeping; folded entries are marked on their targets.
                if (entry.type !== "context_edit" || entry.id === currentLeafId) sequence.push(entry);

                // Preserve side-summary logic: Show branch summaries/compactions that are off-path
                const children = getChildren(entry.id);
                children.forEach((child) => {
                    if ((child.type === "branch_summary" || child.type === "compaction") && !backboneIds.has(child.id)) {
                        sequence.push(child);
                    }
                });
            });

            const getMsgContent = (entry: SessionEntry): string => {
                if (entry.type === "branch_summary" || entry.type === "compaction") {
                    const e = entry;
                    return e.summary || "[No summary provided]";
                }
                if (entry.type === "label") {
                    return `checkpoint: ${entry.label}`;
                }
                if (entry.type === "custom_message" && entry.customType === CompactionSummaryType) {
                    const details = entry.details as CompactionDetails | undefined;
                    return details
                        ? `(compacted ${details.folded} entries after ${details.target} · ~${formatTokens(estimateHistoryTokens(entry))} tokens) ${details.summary}`
                        : `(compaction summary) ${typeof entry.content === "string" ? entry.content : ""}`;
                }
                if (entry.type === "custom_message" && entry.customType === RetainedCodemodeOutputType) {
                    const text = typeof entry.content === "string" ? entry.content
                        : entry.content.map((block) => block.type === "text" ? block.text : "[image]").join(" ");
                    return `(codemode output · ~${formatTokens(estimateHistoryTokens(entry))} tokens) ${text}`;
                }

                if (entry.type === "message") {
                    const msg = entry.message;

                    if (msg.role === "toolResult") {
                        const tr = msg;
                        if (!verbose && isInternal(tr.toolName)) return "";

                        const extractText = (content: (TextContent | ImageContent)[]): string => {
                            return content
                                .map((p) => (p.type === "text" ? p.text : ""))
                                .join(" ")
                                .trim();
                        };

                        let resText = extractText(tr.content);
                        const details = tr.details as Record<string, unknown> | undefined;
                        if ((tr.toolName === "read" || tr.toolName === "edit") && details && "path" in details && typeof details.path === "string") {
                            resText = `${details.path}: ${resText}`;
                        }
                        return `(${tr.toolName}) ${resText}`;
                    }

                    if (msg.role === "bashExecution") {
                        return `[Bash] ${msg.command}`;
                    }

                    if (msg.role === "user" || msg.role === "assistant") {
                        let text = "";
                        if (typeof msg.content === "string") {
                            text = msg.content;
                        } else if (Array.isArray(msg.content)) {
                            text = msg.content
                                .map((p: any) => {
                                    if (typeof p === "object" && p !== null && "text" in p) return (p as TextContent).text;
                                    return "";
                                })
                                .join(" ")
                                .trim();
                        }

                        let toolCallsText = "";
                        if (msg.role === "assistant") {
                            const toolCalls = msg.content.filter((c): c is ToolCall => c.type === "toolCall");

                            toolCallsText = toolCalls
                                .filter((tc) => verbose || !isInternal(tc.name))
                                .map((tc) => `call: ${tc.name}(${JSON.stringify(tc.arguments)})`)
                                .join("; ");
                        }

                        return [text, toolCallsText].filter(Boolean).join(" ");
                    }
                }
                return "";
            };

            const isInteresting = (entry: SessionEntry): boolean => {
                // 1. HEAD and Root
                if (entry.id === currentLeafId) return true;
                if (branch.length > 0 && entry.id === branch[0].id) return true;

                // 2. Explicit checkpoints (labels) - only show the checkpointed node, not the label node itself
                if (sm.getLabel(entry.id)) return true;
                if (entry.type === 'label') return false; // Hide label nodes, they are redundant

                // Folded history is summarized; only its checkpoints stay visible (marked folded).
                if (foldedIds.has(entry.id) || summarizedIds.has(entry.id)) return false;

                // 3. Structural Milestones (Summaries)
                if (entry.type === 'branch_summary' || entry.type === 'compaction') return true;
                if (isTaskMessage(entry)) return true;

                // 4. Branch Points (Forks)
                if (getChildren(entry.id).length > 1) return true;

                // 5. Natural Milestones (User Messages) - This is the key auto-tagging mechanism
                if (entry.type === 'message' && entry.message.role === 'user') return true;

                return false;
            };

            const visibleSequenceIds = new Set<string>();
            sequence.forEach(e => {
                if (verbose || isInteresting(e)) {
                    visibleSequenceIds.add(e.id);
                }
            });

            let visibleEntries = sequence.filter(e => visibleSequenceIds.has(e.id));
            if (visibleEntries.length > limit) {
                const allowedIds = new Set(visibleEntries.slice(-limit).map(e => e.id));
                visibleSequenceIds.clear();
                allowedIds.forEach(id => visibleSequenceIds.add(id));
            }

            const lines: string[] = [];
            let hiddenEntries: SessionEntry[] = [];
            let hiddenGroup = "";
            const flushHidden = () => {
                if (hiddenEntries.length) {
                    lines.push(`  :  ... (${hiddenGroup}${describeHistoryInterval(hiddenEntries)}) ...`);
                }
                hiddenEntries = [];
            };

            sequence.forEach((entry) => {
                if (!visibleSequenceIds.has(entry.id)) {
                    // Off-path summaries never contribute to active-path intervals.
                    if (backboneIds.has(entry.id) && entry.type !== "custom" && entry.type !== "label" &&
                        (entry.type !== "custom_message" || isTaskMessage(entry))) {
                        // Folded, natively summarized and live history are reported as separate intervals.
                        const group = hiddenKind(entry.id);
                        if (group !== hiddenGroup) flushHidden();
                        hiddenGroup = group;
                        hiddenEntries.push(entry);
                    }
                    return;
                }

                flushHidden();

                const isHead = entry.id === currentLeafId;
                const label = sm.getLabel(entry.id);
                const content = getMsgContent(entry).replace(/\s+/g, " ");

                let role = entry.type.toUpperCase();
                if (entry.type === "message") {
                    const m = entry.message;
                    role =
                        m.role === "assistant"
                            ? "AI"
                            : m.role === "user"
                                ? "USER"
                                : m.role === "bashExecution"
                                    ? "BASH"
                                    : "TOOL";
                } else if (entry.type === "branch_summary" || entry.type === "compaction" ||
                    (entry.type === "custom_message" && entry.customType === CompactionSummaryType)) {
                    role = "SUMMARY";
                } else if (entry.type === "custom_message" && entry.customType === RetainedCodemodeOutputType) {
                    role = "TOOL";
                }

                // hide custom messages
                if (role === "CUSTOM_MESSAGE") {
                    return
                }

                const id = entry.id;
                const isRoot = branch.length > 0 && entry.id === branch[0].id;
                const stage = label ? parseCheckpointPhase(label)?.phase : undefined;
                const meta = [isRoot ? "ROOT" : null, isHead ? "HEAD" : null,
                    !backboneIds.has(id) ? "off-path" : null,
                    foldedIds.has(id) || summarizedIds.has(id) ? "compacted: not a compact target" : null,
                    label ? `checkpoint: ${label}` : null,
                    stage ? `phase: ${stage}` : null].filter(Boolean).join(", ");

                const body = content.length > 100 ? content.slice(0, 100) + "..." : content;

                const marker = isHead ? "*" : (role === "USER" ? "•" : "|");

                lines.push(`${marker} ${id}${meta ? ` (${meta})` : ""} [${role}] ${body}`);
            });

            flushHidden();
            const hud = `Context: ${formatContextUsage(ctx.getContextUsage(), true)}`;

            return { content: [{ type: "text", text: hud + "\n" + (lines.join("\n") || "(Root Path Only)") }], details: {} };
        },
    });

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
            const root = params.target.toLowerCase() === "root";
            const targetId = resolveTargetId(sm, params.target);
            if (!sm.getEntry(targetId)) {
                throw new Error(`context_compact: target ${params.target} was not found; use a checkpoint name, an entry ID from context_timeline, or root.`);
            }
            const targetIndex = branch.findIndex((entry) => entry.id === targetId);
            if (targetIndex < 0 || targetIndex >= branch.findIndex((entry) => entry.id === requestEntryId)) {
                throw new Error(`context_compact: target ${params.target} is not earlier in the current conversation; choose a checkpoint from context_timeline or root.`);
            }
            const { reason } = locateContextTarget(sm, targetId, root);
            // Folding after an already-folded target would also drop the summary that covers it.
            if (reason === "folded") {
                throw new Error(`context_compact: target ${params.target} is inside history that was already compacted; choose a later checkpoint from context_timeline or root.`);
            }
            if (reason === "outside") {
                throw new Error(`context_compact: target ${params.target} is inside history that was already compacted; choose a later checkpoint from context_timeline or root.`);
            }
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
        const usageBefore = formatContextUsage(ctx.getContextUsage());
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
