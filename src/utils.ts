import { estimateTokens, type ContextUsage, type SessionEntry } from "@earendil-works/pi-coding-agent";

/** Format token counts for context facts and dashboards. */
export const formatTokens = (n: number | null | undefined) => {
  if (n == null) return "N/A";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return Math.round(n / 1_000) + "k";
  return n.toString();
};

/** The retained codemode output is task context, not internal compaction traffic. */
export const RetainedCodemodeOutputType = "pi-context-codemode-output";

/** Identify internal context tools for timeline folding and interval estimates. */
export const isContextTool = (name: string) => ["context_checkpoint", "context_timeline", "context_compact"].includes(name);

/** Format Pi's window usage without confusing it with interval estimates. */
export const formatContextUsage = (usage: ContextUsage | undefined, includeTokens = false): string => {
    if (usage?.percent == null || !Number.isFinite(usage.percent)) return "Unknown";
    const percent = `${usage.percent.toFixed(1)}%`;
    if (!includeTokens || usage.tokens == null) return percent;
    return `${percent} (${formatTokens(usage.tokens)}/${formatTokens(usage.contextWindow)})`;
};

export type CheckpointPhase = "start" | "done" | "pivot" | "pause" | "resume";

/** Parse only the agreed checkpoint suffix; names without it remain ordinary anchors. */
export function parseCheckpointPhase(name: string): { scope: string; phase: CheckpointPhase } | undefined {
    const match = /^(.+)-(start|done|pivot|pause|resume)$/.exec(name);
    return match ? { scope: match[1], phase: match[2] as CheckpointPhase } : undefined;
}

/** Estimate full historical content with Pi's heuristic, not cumulative API input usage. */
export function estimateHistoryTokens(entry: SessionEntry): number {
    if (entry.type === "branch_summary" || entry.type === "compaction") return Math.ceil(entry.summary.length / 4);
    if (entry.type === "custom_message") {
        if (entry.customType.startsWith("pi-context") && entry.customType !== RetainedCodemodeOutputType) return 0;
        return estimateTokens({ role: "custom", customType: entry.customType, content: entry.content, display: false, timestamp: 0 });
    }
    if (entry.type !== "message") return 0;
    const message = entry.message;
    if (message.role === "toolResult" && isContextTool(message.toolName)) return 0;
    if (message.role === "custom" && message.customType.startsWith("pi-context") &&
        message.customType !== RetainedCodemodeOutputType) return 0;
    if (message.role === "bashExecution" && message.excludeFromContext) return 0;
    if (message.role === "assistant") {
        return estimateTokens({ ...message, content: message.content.filter(block =>
            block.type !== "toolCall" || !isContextTool(block.name)) });
    }
    return estimateTokens(message);
}

/** Describe a folded timeline interval; counts and estimates cover history, not reclaimable space. */
export function describeHistoryInterval(entries: readonly SessionEntry[]): string {
    let assistant = 0, tools = 0, user = 0;
    for (const entry of entries) {
        if (entry.type !== "message") continue;
        if (entry.message.role === "assistant") assistant++;
        if (entry.message.role === "toolResult") tools++;
        if (entry.message.role === "user") user++;
    }
    const parts = [user && `${user} user messages`, assistant && `${assistant} assistant messages`,
        tools && `${tools} tool results`].filter(Boolean);
    if (!parts.length) parts.push(`${entries.length} entries`);
    parts.push(`~${formatTokens(entries.reduce((sum, entry) => sum + estimateHistoryTokens(entry), 0))} tokens`);
    return parts.join(" · ");
}
