export interface CompactBranchEntry {
    id: string;
    type: string;
}

const PASSIVE_ENTRY_TYPES = new Set(["custom", "label", "session_info"]);

/**
 * Detect whether session activity after the compact turn carries new conversation
 * state. Other extensions may append passive metadata after this extension's
 * agent_end handler; those entries must not cancel the requested compaction.
 */
export function didConversationAdvance(
    branch: readonly CompactBranchEntry[],
    compactTurnLeaf: string | null,
): boolean {
    if (!compactTurnLeaf) return true;

    const compactTurnIndex = branch.findIndex((entry) => entry.id === compactTurnLeaf);
    if (compactTurnIndex === -1) return true;

    return branch
        .slice(compactTurnIndex + 1)
        .some((entry) => !PASSIVE_ENTRY_TYPES.has(entry.type));
}
