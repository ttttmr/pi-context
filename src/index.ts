import {
    type ExtensionAPI,
    type SessionManager,
    type SessionEntry,
    type ExtensionCommandContext,
    type ContextUsage,
} from "@earendil-works/pi-coding-agent";
import {
    Type,
    type Static,
    type TextContent,
    type ImageContent,
    type ToolCall,
} from "@earendil-works/pi-ai";
import { formatTokens } from "./utils.js";

// Define missing types locally as they are not exported from the main entry point
interface SessionTreeNode {
    entry: SessionEntry;
    children: SessionTreeNode[];
    label?: string;
}

const InternalTools = ["context_checkpoint", "context_timeline", "context_compact"];
const PiContextCustomMessageType = "pi-context";
const AcmEnableFollowUp = "Agentic context management is now enabled";
let CommandCtx: ExtensionCommandContext | null = null;
let CompactParams: any = null;

const isInternal = (name: string) => InternalTools.includes(name);

const formatContextUsage = (usage: ContextUsage | undefined, includeTokens = false): string => {
    if (usage?.percent == null) return "Unknown";

    const percent = `${usage.percent.toFixed(1)}%`;
    if (!includeTokens || usage.tokens == null) return percent;

    return `${percent} (${formatTokens(usage.tokens)}/${formatTokens(usage.contextWindow)})`;
};

const PassiveCompactionEntryTypes = new Set<SessionEntry["type"]>([
    "custom",
    "label",
    "session_info",
    "model_change",
    "thinking_level_change",
]);

/**
 * Detect whether session activity after the compact turn should cancel the
 * requested compaction. Non-contextual session state is ignored; entries that
 * participate in model context, plus unknown future behavior, fail closed.
 */
export const didConversationAdvance = (
    branch: readonly SessionEntry[],
    compactTurnLeaf: string | null,
): boolean => {
    if (!compactTurnLeaf) return true;

    const compactTurnIndex = branch.findIndex((entry) => entry.id === compactTurnLeaf);
    if (compactTurnIndex === -1) return true;

    return branch
        .slice(compactTurnIndex + 1)
        .some((entry) => !PassiveCompactionEntryTypes.has(entry.type));
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

const ContextTimelineDescription = "Inspect the active conversation path as a structural map: checkpoints, summaries/compactions, branch points, user turns, and current position. Use when orientation or compact target selection depends on the shape of history.";
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
    name: Type.String({ description: "Unique semantic anchor name that encodes the task and phase/purpose, e.g. parser-fix-start or timeout-investigation-search. Avoid generic names like start, checkpoint-1, or retry." }),
    target: Type.Optional(Type.String({ description: "Optional history node ID or checkpoint name to label. Defaults to the current meaningful position near the conversation head." })),
});

export default function (pi: ExtensionAPI) {
    pi.registerCommand("acm", {
        description: "Enable agentic context management for the current session",
        handler: async (args, ctx) => {
            CommandCtx = ctx;
            ctx.ui.notify("Agentic Context Management enabled.", "info");
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
            let hiddenCount = 0;

            sequence.forEach((entry) => {
                if (!visibleSequenceIds.has(entry.id)) {
                    hiddenCount++;
                    return;
                }

                if (hiddenCount > 0) {
                    lines.push(`  :  ... (${hiddenCount} hidden messages) ...`);
                    hiddenCount = 0;
                }

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
                }

                // hide custom messages
                if (role === "CUSTOM_MESSAGE") {
                    return
                }

                const id = entry.id;
                const isRoot = branch.length > 0 && entry.id === branch[0].id;
                const meta = [isRoot ? "ROOT" : null, isHead ? "HEAD" : null, label ? `checkpoint: ${label}` : null].filter(Boolean).join(", ");

                const body = content.length > 100 ? content.slice(0, 100) + "..." : content;

                const marker = isHead ? "*" : (role === "USER" ? "•" : "|");

                lines.push(`${marker} ${id}${meta ? ` (${meta})` : ""} [${role}] ${body}`);
            });

            if (hiddenCount > 0) {
                lines.push(`  :  ... (${hiddenCount} hidden messages) ...`);
            }

            // --- Context Dashboard (HUD) ---
            const usageStr = formatContextUsage(ctx.getContextUsage(), true);

            // Find the distance to the nearest checkpoint
            let stepsSinceCheckpoint = 0;
            let nearestCheckpointName = "None";
            for (let i = branch.length - 1; i >= 0; i--) {
                const id = branch[i].id;
                const label = sm.getLabel(id);
                if (label) {
                    nearestCheckpointName = label;
                    break;
                }
                stepsSinceCheckpoint++;
            }

            const compactCue = nearestCheckpointName === "None"
                ? "create a checkpoint before the next noisy phase"
                : `if this segment has produced a stable result and another phase remains, compact to '${nearestCheckpointName}' with a handoff summary before continuing`;

            const hud = [
                `[Context Dashboard]`,
                `• Context Usage:    ${usageStr}`,
                `• Segment Size:     ${stepsSinceCheckpoint} steps since last checkpoint '${nearestCheckpointName}'`,
                `• Compact Cue:      ${compactCue}`,
                `---------------------------------------------------`
            ].join("\n");

            return { content: [{ type: "text", text: hud + "\n" + (lines.join("\n") || "(Root Path Only)") }], details: {} };
        },
    });

    pi.registerTool({
        name: "context_compact",
        label: "Context Compact",
        description: ContextCompactDescription,
        parameters: ContextCompactParams,
        async execute(_id, params: Static<typeof ContextCompactParams>, _signal, _onUpdate, ctx) {
            if (!CommandCtx) {
                const editorText = ctx.ui.getEditorText();
                const followUp = editorText
                    ? `${AcmEnableFollowUp}\n${editorText}`
                    : AcmEnableFollowUp;
                ctx.ui.setEditorText(`/acm ${followUp}`)
                return {
                    content: [{
                        type: "text",
                        text: "Agentic context management is not enabled. Ask the user to run `/acm` in the pi to enable it, then retry."
                    }],
                    details: {}
                };
            }
            const sm = ctx.sessionManager as SessionManager;
            const usageBeforeText = formatContextUsage(ctx.getContextUsage());

            const tid = resolveTargetId(sm, params.target);

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

            CompactParams = params;
            CompactParams.tid = tid;
            CompactParams.enrichedMessage = enrichedMessage;
            CompactParams.usageBeforeText = usageBeforeText;

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
        const compactTurnLeaf = sm.getLeafId();

        // `agent_end` is emitted before the core Agent is actually idle. If we
        // call pi.sendMessage({ triggerTurn: true }) inside this handler, pi still
        // sees an active stream and queues the message as steering; after
        // `agent_end` the loop has already stopped, so that queued message is not
        // drained. Defer navigation + continuation until the current run settles.
        setTimeout(async () => {
            try {
                await commandCtx.waitForIdle();

                const branch = sm.getBranch();
                if (didConversationAdvance(branch, compactTurnLeaf)) {
                    commandCtx.ui.notify("context_compact cancelled: conversation advanced before compaction completed.", "warning");
                    pi.sendMessage({
                        customType: PiContextCustomMessageType,
                        content: [
                            "context_compact cancelled: conversation advanced before the summary branch was created.",
                            "No compaction was applied; continue from the current path. If still useful, inspect timeline and retry with an updated summary.",
                        ].join("\n"),
                        display: false,
                    }, {
                        triggerTurn: true,
                        deliverAs: "followUp",
                    });
                    return;
                }

                const nid = sm.branchWithSummary(compactParams.tid, compactParams.enrichedMessage);
                compactParams.nid = nid;
                // branchWithSummary advances the leaf to the summary entry. Reset
                // it so navigateTree(nid) can rebuild agent state instead of
                // returning early as a no-op.
                sm.branch(compactParams.tid);
                await commandCtx.navigateTree(compactParams.nid, {
                    summarize: false,
                });

                const usageAfter = commandCtx.getContextUsage();
                commandCtx.ui.notify([
                    `Compacted to ${compactParams.target}${compactParams.target === compactParams.tid ? "" : `(${compactParams.tid})`}`,
                    `Context Usage: ${compactParams.usageBeforeText} -> ${formatContextUsage(usageAfter)}`,
                    `Backup checkpoint created: ${compactParams.backupCheckpoint || "none"}`,
                    `Summary: ${compactParams.enrichedMessage}`,
                ].join("\n"), "info");

                pi.sendMessage({
                    customType: PiContextCustomMessageType,
                    content: "context_compact complete. A handoff summary of your previous conversation path was injected above. Read it to understand your new state. Execute the Next Step from the summary",
                    display: false,
                }, {
                    triggerTurn: true,
                    deliverAs: "followUp",
                });
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                commandCtx.ui.notify(`context_compact failed: ${message}`, "error");
                pi.sendMessage({
                    customType: PiContextCustomMessageType,
                    content: [
                        `context_compact failed: ${message}`,
                        "No compaction was applied; continue from the current path. Retry only with a fresh timeline/summary.",
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
