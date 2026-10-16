import { type ExtensionAPI, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type, type Static, type TextContent, type ImageContent, type ToolCall } from "@earendil-works/pi-ai";
import { CompactionSummaryType, describeHistoryInterval, estimateHistoryTokens, formatTokens, formatContextUsage, isContextTool as isInternal, parseCheckpointPhase, RetainedCodemodeOutputType } from "./utils.js";
import { getCompactionContextUsage, getCompactionProjection, isFoldedEntry, type CompactionDetails } from "./compaction-context.js";

const ContextTimelineDescription = "Inspect the active conversation path as a structural map: checkpoints, summaries/compactions, branch points, user turns, and current position. Use when orientation or compact target selection depends on the shape of history. Folded intervals show historical token estimates, not reclaimable space.";
const ContextTimelineParams = Type.Object({
    limit: Type.Optional(Type.Number({ minimum: 1, description: "Maximum visible timeline entries (default: 50)." })),
    verbose: Type.Optional(Type.Boolean({ description: "If true, show all messages including internal context-tool traffic. If false (default), collapse to structural milestones." })),
});

/** Register context_timeline: the active path with checkpoints, folded intervals, and compact-target markers. */
export function registerContextTimeline(pi: ExtensionAPI) {
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
            const projection = getCompactionProjection(sm);
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
                // Pi's own context edits (such as recovery omissions) are bookkeeping, not history.
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
                        } else {
                            text = msg.content
                                .map((p) => p.type === "text" ? p.text : "")
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
            const hud = `Context: ${formatContextUsage(getCompactionContextUsage(sm, ctx.getContextUsage()), true)}`;

            return { content: [{ type: "text", text: hud + "\n" + (lines.join("\n") || "(Root Path Only)") }], details: {} };
        },
    });
}
