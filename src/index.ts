import {
    type ExtensionAPI,
    type SessionManager,
    type SessionEntry,
    type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
    Type,
    type Static,
    type TextContent,
    type ImageContent,
    type ToolCall,
} from "@earendil-works/pi-ai";
import { describeHistoryInterval, estimateHistoryTokens, formatTokens, formatContextUsage, isContextTool as isInternal, parseCheckpointPhase, RetainedCodemodeOutputType } from "./utils.js";

// Define missing types locally as they are not exported from the main entry point
interface SessionTreeNode {
    entry: SessionEntry;
    children: SessionTreeNode[];
    label?: string;
}

const PiContextCustomMessageType = "pi-context";

const PassiveCompactionEntryTypes = new Set<SessionEntry["type"]>([
    "custom",
    "label",
    "session_info",
    "model_change",
    "thinking_level_change",
]);

// Pi >= 0.99 records nested calls on the parent result, not as transcript messages.
// Keep this shape local so direct calls remain compatible with older Pi SDKs.
interface CompactNestedCallRecord {
    calls: { id: string; name: string; status: string }[];
}

// Retain only a successful parent result with one identifiable successful compact.
// Other nested tools/models and omitted arguments are safe because the entire
// parent output is carried forward; missing or ambiguous compact records cancel.
const findCodemodeCompactResult = (
    branch: readonly SessionEntry[],
    compactToolCallId: string,
    codemodeToolCallId: string,
) => {
    const results = branch.filter((entry) => entry.type === "message" &&
        entry.message.role === "toolResult" && entry.message.toolName === "codemode" &&
        entry.message.toolCallId === codemodeToolCallId);
    if (results.length !== 1) return undefined;
    const result = results[0];
    if (result.type !== "message" || result.message.role !== "toolResult" || result.message.isError) return undefined;
    const record = (result.message as typeof result.message & { nestedCalls?: CompactNestedCallRecord }).nestedCalls;
    if (!Array.isArray(record?.calls)) return undefined;
    const compactCalls = record.calls.filter((call) => call.name === "context_compact");
    if (compactCalls.length !== 1 || compactCalls[0].id !== compactToolCallId ||
        compactCalls[0].status !== "ok") return undefined;
    return { entry: result, message: result.message };
};

/**
 * Detect conversation advancement since the compact request, not agent_end.
 * A successful codemode result can be retained in full; other contextual
 * entries still cancel because the handoff summary does not account for them.
 */
export const didConversationAdvance = (
    branch: readonly SessionEntry[],
    requestLeaf: string | null,
    compactToolCallId?: string,
    codemodeToolCallId?: string,
): boolean => {
    if (!requestLeaf) return true;

    const requestIndex = branch.findIndex((entry) => entry.id === requestLeaf);
    if (requestIndex === -1) return true;

    const tail = branch.slice(requestIndex + 1);
    const codemodeResult = codemodeToolCallId && compactToolCallId
        ? findCodemodeCompactResult(tail, compactToolCallId, codemodeToolCallId) : undefined;
    if (codemodeToolCallId) {
        const request = branch[requestIndex];
        if (!codemodeResult || request.type !== "message" || request.message.role !== "assistant") return true;
        const calls = request.message.content.filter((block) => block.type === "toolCall");
        if (calls.length !== 1 || calls[0].id !== codemodeToolCallId || calls[0].name !== "codemode") return true;
    }
    return tail.some((entry) => {
        if (PassiveCompactionEntryTypes.has(entry.type)) return false;
        if (compactToolCallId && entry.type === "message") {
            const message = entry.message;
            if (message.role === "toolResult" && !message.isError) {
                if (!codemodeToolCallId && message.toolName === "context_compact" &&
                    message.toolCallId === compactToolCallId) return false;
                if (entry === codemodeResult?.entry) return false;
            }
            if (message.role === "assistant" && message.content.length === 0 &&
                (message.stopReason === "aborted" ||
                    (message.stopReason === "error" && message.errorMessage === "This operation was aborted"))) return false;
        }
        return true;
    });
};

// Match codemode's documented <parent id>/<n> IDs against actual transcript calls;
// parent IDs are opaque and may themselves contain slashes. Never fall back to the leaf.
const findCompactRequest = (branch: readonly SessionEntry[], toolCallId: string) => {
    for (let i = branch.length - 1; i >= 0; i--) {
        const entry = branch[i];
        if (entry.type !== "message" || entry.message.role !== "assistant") continue;
        for (const block of entry.message.content) {
            if (block.type !== "toolCall") continue;
            if (block.id === toolCallId && block.name === "context_compact") {
                return { requestLeaf: entry.id, codemodeToolCallId: undefined };
            }
            if (block.name === "codemode" && toolCallId.startsWith(`${block.id}/`) &&
                /^\d+$/.test(toolCallId.slice(block.id.length + 1))) {
                return { requestLeaf: entry.id, codemodeToolCallId: block.id };
            }
        }
    }
};

const resolveTargetId = (sm: SessionManager, target: string): string => {
    if (target.toLowerCase() === "root") {
        const tree = sm.getTree();
        return tree.length > 0 ? tree[0].entry.id : target;
    }

    // If it already looks like an ID, keep it.
    if (/^[0-9a-f]{8,}$/i.test(target)) return target;

    // Iterative DFS to avoid call stack overflows on deep histories.
    const stack: SessionTreeNode[] = [...(sm.getTree() as unknown as SessionTreeNode[])];
    while (stack.length > 0) {
        const n = stack.pop()!;
        if (sm.getLabel(n.entry.id) === target) return n.entry.id;
        if (n.children?.length) stack.push(...n.children);
    }

    // Fallback: let SessionManager deal with invalid targets downstream.
    return target;
};

const ContextTimelineDescription = "Inspect the active conversation path as a structural map: checkpoints, summaries/compactions, branch points, user turns, and current position. Use when orientation or compact target selection depends on the shape of history. Folded intervals show historical token estimates, not reclaimable space.";
const ContextTimelineParams = Type.Object({
    limit: Type.Optional(Type.Number({ description: "Maximum visible timeline entries (default: 50)." })),
    verbose: Type.Optional(Type.Boolean({ description: "If true, show all messages including internal context-tool traffic. If false (default), collapse to structural milestones." })),
});

const ContextCompactDescription = "Create a summarized continuation branch from an earlier checkpoint or history node. The selected target is the branch point; the summary must restore the useful state from the compacted path after that target. This changes conversation history only; it does not modify or roll back disk files or external systems.";
const ContextCompactParams = Type.Object({
    target: Type.String({ description: "Checkpoint name, history node ID, or root to use as the branch point for the summarized continuation." }),
    summary: Type.String({ description: "Handoff summary injected into the new continuation branch. Restore current task/state, decisions/constraints, important external side effects (changed files, processes, browser/tickets/remote state), validation status, source anchors/evidence/open questions likely needed soon, and explicit next step. Do not rely on backupCheckpoint for details needed in the next phase." }),
    backupCheckpoint: Type.Optional(Type.String({ description: "Optional checkpoint name to label the current conversation state before branching. This is only a recovery pointer; the summary must still contain the state needed to continue." })),
});

const ContextCheckpointDescription = "Create a named anchor by labeling a conversation history node. This does not branch, summarize, or affect external state; it only makes the point easy to find later in timeline or compact target selection.";
const ContextCheckpointParams = Type.Object({
    name: Type.String({ description: "Unique <scope>-<phase> name; phase suffixes: start, done (stable result), pivot (change approach), pause, resume. Keep scope consistent within a phase's lifecycle; other names remain ordinary anchors." }),
    target: Type.Optional(Type.String({ description: "Optional history node ID or checkpoint name to label. Defaults to the current meaningful position near the conversation head." })),
});

interface PendingCompactRequest extends Static<typeof ContextCompactParams> {
    tid: string;
    enrichedMessage: string;
    usageBeforeText: string;
    requestLeaf: string;
    toolCallId: string;
    codemodeToolCallId?: string;
    invalidated?: boolean;
}

export default function (pi: ExtensionAPI) {
    let CommandCtx: ExtensionCommandContext | null = null;
    let CompactParams: PendingCompactRequest | null = null;
    let runtimeActive = true;
    let pendingCommandContext: Promise<ExtensionCommandContext> | null = null;
    let resolveCommandContext: ((ctx: ExtensionCommandContext) => void) | undefined;
    let rejectCommandContext: ((error: Error) => void) | undefined;

    // sendUserMessage is fire-and-forget. Resolve from the command handler,
    // rather than assuming command dispatch has completed when it returns.
    async function ensureCommandContext(): Promise<ExtensionCommandContext> {
        if (CommandCtx) return CommandCtx;
        if (pendingCommandContext) return pendingCommandContext;

        let timeout: ReturnType<typeof setTimeout> | undefined;
        pendingCommandContext = new Promise<ExtensionCommandContext>((resolve, reject) => {
            resolveCommandContext = resolve;
            rejectCommandContext = reject;
            timeout = setTimeout(() => reject(new Error(
                "context_compact: automatic command context acquisition timed out. Requires Pi >= 0.84.2 with extension command dispatch support.",
            )), 5000);
            pi.sendUserMessage("/acm", {
                deliverAs: "followUp",
                expandPromptTemplates: true,
            });
        });
        try {
            return await pendingCommandContext;
        } finally {
            clearTimeout(timeout);
            pendingCommandContext = null;
            resolveCommandContext = undefined;
            rejectCommandContext = undefined;
        }
    }

    pi.on("session_shutdown", () => {
        runtimeActive = false;
        CommandCtx = null;
        CompactParams = null;
        rejectCommandContext?.(new Error("context_compact: session closed while acquiring command context."));
    });

    pi.registerCommand("acm", {
        description: "Enable agentic context management for the current session",
        handler: async (args, ctx) => {
            CommandCtx = ctx;
            if (resolveCommandContext) {
                resolveCommandContext(ctx);
            } else {
                ctx.ui.notify("Agentic Context Management enabled.", "info");
            }
            if (args) {
                pi.sendUserMessage(args, { deliverAs: "followUp" });
            }
        }
    });

    // Helper: Check if a checkpoint name already exists in the tree
    // Iterative DFS to avoid call stack overflows on deep histories.
    // Push children in reverse order to preserve left-to-right pre-order semantics.
    const findCheckpointInTree = (sm: SessionManager, nodes: SessionTreeNode[], checkpointName: string): string | null => {
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
            const sm = ctx.sessionManager as SessionManager;

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
            const sm = ctx.sessionManager as SessionManager;
            const branch = sm.getBranch();
            const currentLeafId = sm.getLeafId();
            const verbose = params.verbose ?? false;
            const limit = params.limit ?? 50;

            const backboneIds = new Set(branch.map((e) => e.id));
            const sequence: SessionEntry[] = [];

            branch.forEach((entry) => {
                sequence.push(entry);

                // Preserve side-summary logic: Show branch summaries/compactions that are off-path
                const children = sm.getChildren(entry.id);
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

                // 3. Structural Milestones (Summaries)
                if (entry.type === 'branch_summary' || entry.type === 'compaction') return true;
                if (entry.type === 'custom_message' && entry.customType === RetainedCodemodeOutputType) return true;

                // 4. Branch Points (Forks)
                if (sm.getChildren(entry.id).length > 1) return true;

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
            const flushHidden = () => {
                if (hiddenEntries.length) lines.push(`  :  ... (${describeHistoryInterval(hiddenEntries)}) ...`);
                hiddenEntries = [];
            };

            sequence.forEach((entry) => {
                if (!visibleSequenceIds.has(entry.id)) {
                    // Off-path summaries never contribute to active-path intervals.
                    if (backboneIds.has(entry.id) && entry.type !== "custom" && entry.type !== "label" &&
                        (entry.type !== "custom_message" || entry.customType === RetainedCodemodeOutputType)) hiddenEntries.push(entry);
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
                } else if (entry.type === "branch_summary" || entry.type === "compaction") {
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
        async execute(_id, params: Static<typeof ContextCompactParams>, _signal, _onUpdate, ctx) {
            // Anchor at the assistant request (or its codemode script), not the
            // current leaf: sibling tools/hooks may already have appended entries.
            const request = findCompactRequest(ctx.sessionManager.getBranch(), _id);
            if (!request) {
                throw new Error("context_compact: cannot locate the requesting tool call in session history.");
            }
            await ensureCommandContext();
            if (!runtimeActive || _signal?.aborted) {
                throw new Error("context_compact: cancelled before compaction started.");
            }
            const sm = ctx.sessionManager as SessionManager;
            const usageBeforeText = formatContextUsage(ctx.getContextUsage());

            if (CompactParams && (request.codemodeToolCallId || CompactParams.codemodeToolCallId)) {
                CompactParams.invalidated = true;
                throw new Error("context_compact: only one compact request is allowed per codemode script.");
            }
            const tid = resolveTargetId(sm, params.target);
            if (request.codemodeToolCallId) {
                const branch = sm.getBranch();
                const targetIndex = branch.findIndex((entry) => entry.id === tid);
                const requestIndex = branch.findIndex((entry) => entry.id === request.requestLeaf);
                if (targetIndex < 0 || targetIndex >= requestIndex) {
                    throw new Error("context_compact: codemode target must precede the script on the active path.");
                }
            }

            const currentLeaf = sm.getLeafId();
            if (currentLeaf === tid) {
                return { content: [{ type: "text", text: `Already at target ${tid}` }], details: {} };
            }
            if (params.backupCheckpoint && currentLeaf) {
                pi.setLabel(currentLeaf, params.backupCheckpoint);
            }
            const currentLabel = currentLeaf ? sm.getLabel(currentLeaf) : undefined;
            const origin = currentLabel ? `checkpoint: ${currentLabel}` : (currentLeaf || "unknown");

            const enrichedMessage = `(handoff summary from ${origin})\n${params.summary}`;

            // Awaiting this tool only schedules compaction. In codemode, all calls
            // before and after it finish before history switches; its position
            // within the script does not split the output or rerun operations.
            CompactParams = {
                ...params, tid, enrichedMessage, usageBeforeText,
                requestLeaf: request.requestLeaf,
                toolCallId: _id,
                codemodeToolCallId: request.codemodeToolCallId,
            };

            return { content: [{ type: "text", text: "compact start" }], details: {} };
        },
    });

    pi.on("turn_end", async (_event, ctx) => {
        if (!CompactParams) {
            return
        }
        ctx.abort()
    });

    pi.on("agent_end", async (_event, ctx) => {
        if (!CompactParams) {
            return
        }
        if (!CommandCtx) {
            return
        }

        const sm = ctx.sessionManager as SessionManager;
        const compactParams = CompactParams;
        const commandCtx = CommandCtx;
        CompactParams = null;
        const requestLeaf = compactParams.requestLeaf;

        // `agent_end` is emitted before the core Agent is actually idle. If we
        // call pi.sendMessage({ triggerTurn: true }) inside this handler, pi still
        // sees an active stream and queues the message as steering; after
        // `agent_end` the loop has already stopped, so that queued message is not
        // drained. Defer navigation + continuation until the current run settles.
        setTimeout(async () => {
            try {
                if (!runtimeActive) return;
                await commandCtx.waitForIdle();
                if (!runtimeActive) return;

                // Check unaccounted context after idle, before creating the branch.
                // This is not atomic across Pi's awaited session_before_tree hooks.
                const branch = sm.getBranch();
                if (compactParams.invalidated || ctx.hasPendingMessages() ||
                    didConversationAdvance(branch, requestLeaf, compactParams.toolCallId, compactParams.codemodeToolCallId)) {
                    const reason = compactParams.invalidated
                        ? "more than one compact request was made."
                        : compactParams.codemodeToolCallId
                            ? "conversation advanced or codemode did not finish with a verifiable compact result."
                            : "conversation advanced before compaction completed.";
                    commandCtx.ui.notify(`context_compact cancelled: ${reason}`, "warning");
                    pi.sendMessage({
                        customType: PiContextCustomMessageType,
                        content: [
                            `context_compact cancelled: ${reason}`,
                            "No compaction was applied; continue from the current path. If still useful, inspect timeline and retry with an updated summary.",
                        ].join("\n"),
                        display: false,
                    }, {
                        triggerTurn: true,
                        deliverAs: "followUp",
                    });
                    return;
                }

                const originalLeaf = sm.getLeafId()!;
                let nid: string;
                try {
                    let summaryTarget = compactParams.tid;
                    if (compactParams.codemodeToolCallId) {
                        const result = findCodemodeCompactResult(
                            branch.slice(branch.findIndex((entry) => entry.id === requestLeaf) + 1),
                            compactParams.toolCallId, compactParams.codemodeToolCallId,
                        )!;
                        // Model context: prefix through target -> full output -> summary.
                        // Copy returned text/images as-is, including truncation notices
                        // and paths, not script source or unprinted intermediate values.
                        // A provenance-linked custom message leaves the original calls
                        // recoverable without duplicating billable assistant/tool results.
                        sm.branch(compactParams.tid);
                        sm.appendCustomMessageEntry(RetainedCodemodeOutputType, [
                            { type: "text", text: "Output from the codemode script that already completed before compaction. Do not rerun its completed operations. The following handoff summary covers earlier history, not this output." },
                            ...result.message.content,
                        ], false, { requestEntryId: requestLeaf, resultEntryId: result.entry.id });
                        // Preserve store state with one net delta, not copies of its
                        // write log: repeated old-target compacts must not amplify it.
                        // Delete-then-set matches Pi's replay; Map keeps special keys safe.
                        const targetIndex = branch.findIndex((entry) => entry.id === compactParams.tid);
                        const prefixKeys = new Set<string>();
                        const writes = new Map<string, unknown>(), deletes = new Set<string>();
                        for (let index = 0; index < branch.length; index++) {
                            const entry = branch[index];
                            if (entry.type !== "custom" || entry.customType !== "codemode-store") continue;
                            const data = entry.data;
                            // Ignore malformed entries just as Pi's readCodemodeStore does.
                            if (typeof data !== "object" || data === null ||
                                !("set" in data) || !("delete" in data) ||
                                typeof data.set !== "object" || data.set === null ||
                                !Array.isArray(data.delete) || !data.delete.every((key: unknown) => typeof key === "string")) continue;
                            if (index <= targetIndex) {
                                for (const key of data.delete) prefixKeys.delete(key);
                                for (const key of Object.keys(data.set)) prefixKeys.add(key);
                                continue;
                            }
                            for (const key of data.delete) {
                                writes.delete(key);
                                deletes.add(key);
                            }
                            for (const [key, value] of Object.entries(data.set)) {
                                writes.set(key, value);
                                deletes.delete(key);
                            }
                        }
                        // Keys created and removed after target need no tombstone.
                        const deleted = [...deletes].filter(key => prefixKeys.has(key));
                        if (writes.size || deleted.length) {
                            sm.appendCustomEntry("codemode-store", { set: Object.fromEntries(writes), delete: deleted });
                        }
                        summaryTarget = sm.getLeafId()!;
                        sm.branch(originalLeaf);
                    }
                    nid = sm.branchWithSummary(summaryTarget, compactParams.enrichedMessage);
                } finally {
                    // Rebuild from the original live path. Navigating a custom
                    // message would move it to the editor; the summary is the leaf.
                    sm.branch(originalLeaf);
                }
                const navigation = await commandCtx.navigateTree(nid, { summarize: false });
                if (!runtimeActive) return;
                if (navigation.cancelled) {
                    throw new Error("tree navigation was cancelled; the original path was retained.");
                }

                const usageAfter = commandCtx.getContextUsage();
                commandCtx.ui.notify([
                    `Compacted to ${compactParams.target}${compactParams.target === compactParams.tid ? "" : `(${compactParams.tid})`}`,
                    `Context Usage: ${compactParams.usageBeforeText} -> ${formatContextUsage(usageAfter)}`,
                    `Backup checkpoint created: ${compactParams.backupCheckpoint || "none"}`,
                    `Summary: ${compactParams.enrichedMessage}`,
                ].join("\n"), "info");

                pi.sendMessage({
                    customType: PiContextCustomMessageType,
                    content: compactParams.codemodeToolCallId
                        ? "context_compact complete. Your previous history was summarized. Read the retained codemode output and the handoff summary. The script already completed; do not repeat its operations or a Next Step it has already satisfied. Continue with the remaining work."
                        : "context_compact complete. A handoff summary of your previous conversation path was injected above. Read it to understand your new state. Execute the Next Step from the summary",
                    display: false,
                }, {
                    triggerTurn: true,
                    deliverAs: "followUp",
                });
            } catch (err) {
                if (!runtimeActive) return;
                const message = err instanceof Error ? err.message : String(err);
                commandCtx.ui.notify(`context_compact failed: ${message}`, "error");
                pi.sendMessage({
                    customType: PiContextCustomMessageType,
                    content: [
                        `context_compact failed: ${message}`,
                        "Compaction did not finish. Inspect the current path before retrying; a recoverable summary branch may have been created.",
                    ].join("\n"),
                    display: false,
                }, {
                    triggerTurn: true,
                    deliverAs: "followUp",
                });
            }
        }, 0);
    });
}
