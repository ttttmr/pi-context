import {
    estimateTokens,
    type ContextEvent,
    type ContextUsage,
    type ExtensionContext,
    type ProjectedSessionEntry,
    type SessionBeforeCompactEvent,
    type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { CompactionSummaryType, isEditableContextEntry } from "./utils.js";

type ReadonlySessionManager = ExtensionContext["sessionManager"];
type ContextMessage = ContextEvent["messages"][number];

/** One compact range, exclusive of afterId and inclusive of throughId, on the active path. */
export interface CompactionRange {
    afterId: string | null;
    throughId: string;
    /** Preserve results of this retained assistant's tool calls without storing a list of IDs. */
    keepToolResultsOf?: string;
}

/** Find hidden history from ancestor summaries; no per-message edits or persisted ID lists. */
export function getCompactionHiddenIds(branch: readonly SessionEntry[]): Set<string> {
    const indices = new Map(branch.map((entry, index) => [entry.id, index]));
    const results = new Map<string, number[]>();
    branch.forEach((entry, index) => {
        if (entry.type !== "message" || entry.message.role !== "toolResult") return;
        const id = entry.message.toolCallId;
        const positions = results.get(id) ?? [];
        positions.push(index);
        results.set(id, positions);
    });
    const changes = new Int32Array(branch.length + 1);
    const exemptions = new Int32Array(branch.length);
    branch.forEach((entry, summaryIndex) => {
        if (entry.type !== "custom_message" || entry.customType !== CompactionSummaryType) return;
        const range = (entry.details as { range?: CompactionRange } | undefined)?.range;
        if (!range) return; // Older summaries use Pi's persisted context_edit entries.
        const after = range.afterId === null ? -1 : indices.get(range.afterId);
        const through = indices.get(range.throughId);
        if (after === undefined || through === undefined || after >= through || through >= summaryIndex) return;
        changes[after + 1]++;
        changes[through + 1]--;
        const assistantIndex = range.keepToolResultsOf ? indices.get(range.keepToolResultsOf) : undefined;
        const assistant = assistantIndex === undefined ? undefined : branch[assistantIndex];
        if (assistantIndex === undefined || assistantIndex > after ||
            assistant?.type !== "message" || assistant.message.role !== "assistant") return;
        for (const block of assistant.message.content) {
            if (block.type !== "toolCall") continue;
            for (const index of results.get(block.id) ?? []) {
                if (index > after && index <= through) exemptions[index]++;
            }
        }
    });
    const hidden = new Set<string>();
    let active = 0;
    branch.forEach((entry, index) => {
        active += changes[index];
        if (active > exemptions[index] && isEditableContextEntry(entry)) hidden.add(entry.id);
    });
    return hidden;
}

/** Project the same compact ranges for target validation, timeline, and the context dashboard. */
export function getCompactionProjection(sm: ReadonlySessionManager): ProjectedSessionEntry[] {
    const hidden = getCompactionHiddenIds(sm.getBranch());
    return sm.buildSessionProjection().entries.map((entry) => hidden.has(entry.sourceEntry.id)
        ? { ...entry, messages: [] } : entry);
}

// Pi clones request messages before context handlers. Timestamp and role survive ordinary
// content transforms; exact content disambiguates messages sharing a timestamp. Extra
// messages from other extensions are kept. Never depend on array offsets across compaction.
const messageKey = (message: ContextMessage): string => JSON.stringify([
    message.role, message.timestamp,
    message.role === "toolResult" ? message.toolCallId :
        message.role === "custom" ? message.customType :
        message.role === "branchSummary" ? message.fromId : "",
]);

/** Filter request or native-summary messages while retaining other extensions' additions. */
export function filterCompactionMessages(sm: ReadonlySessionManager, messages: ContextMessage[]): ContextMessage[] {
    const hidden = getCompactionHiddenIds(sm.getBranch());
    if (!hidden.size) return messages;
    const sources = new Map<string, { message: ContextMessage; hidden: boolean }[]>();
    for (const entry of sm.buildSessionProjection().entries) {
        for (const message of entry.messages) {
            const key = messageKey(message);
            const bucket = sources.get(key) ?? [];
            bucket.push({ message, hidden: hidden.has(entry.sourceEntry.id) });
            sources.set(key, bucket);
        }
    }
    const incoming = new Map<string, number[]>();
    messages.forEach((message, index) => {
        const key = messageKey(message);
        const bucket = incoming.get(key) ?? [];
        bucket.push(index);
        incoming.set(key, bucket);
    });
    const omitted = new Set<number>();
    for (const [key, indices] of incoming) {
        const bucket = sources.get(key);
        if (!bucket) continue;
        const unmatched: number[] = [];
        // Native preparation retains message references; request handlers receive clones.
        for (const index of indices) {
            const sourceIndex = bucket.findIndex((source) => source.message === messages[index]);
            if (sourceIndex < 0) unmatched.push(index);
            else {
                const [source] = bucket.splice(sourceIndex, 1);
                if (source.hidden) omitted.add(index);
            }
        }
        const exactSources = new Map<string, typeof bucket>();
        for (const source of bucket) {
            const fingerprint = JSON.stringify(source.message);
            const matches = exactSources.get(fingerprint) ?? [];
            matches.push(source);
            exactSources.set(fingerprint, matches);
        }
        const transformed: number[] = [];
        // Reserve all exact matches first. An injected message must not consume the
        // provenance of an original message that occurs later in the request.
        for (const index of unmatched) {
            const matches = exactSources.get(JSON.stringify(messages[index]));
            const source = matches?.shift();
            if (!source) transformed.push(index);
            else if (source.hidden) omitted.add(index);
        }
        const remaining = [...exactSources.values()].flat();
        // A unique remaining pair identifies a content transform. Ambiguous additions
        // are preserved: the event API has no source-entry IDs to distinguish them.
        if (remaining.length === 1 && transformed.length === 1 && remaining[0].hidden) omitted.add(transformed[0]);
    }
    return messages.filter((_message, index) => !omitted.has(index));
}

/** Avoid reporting pre-compact usage until a response has measured the filtered context. */
export function getCompactionContextUsage(sm: ReadonlySessionManager, usage: ContextUsage | undefined): ContextUsage | undefined {
    if (!usage) return usage;
    const branch = sm.getBranch();
    let latest = -1;
    branch.forEach((entry, index) => {
        if (entry.type === "custom_message" && entry.customType === CompactionSummaryType &&
            (entry.details as { range?: CompactionRange } | undefined)?.range) latest = index;
    });
    if (latest < 0 || branch.slice(latest + 1).some((entry) => entry.type === "compaction" ||
        (entry.type === "message" && entry.message.role === "assistant" &&
            entry.message.stopReason !== "error" && entry.message.stopReason !== "aborted" &&
            (entry.message.usage.totalTokens || entry.message.usage.input + entry.message.usage.cacheRead + entry.message.usage.cacheWrite) > 0))) return usage;
    const tokens = getCompactionProjection(sm).reduce((total, entry) =>
        total + entry.messages.reduce((sum, message) => sum + estimateTokens(message), 0), 0);
    return { ...usage, tokens, percent: tokens / usage.contextWindow * 100 };
}

/** Feed Pi's default summarizer only visible history, including split-turn and file metadata. */
export function filterNativeCompaction(sm: ReadonlySessionManager, event: SessionBeforeCompactEvent): void {
    const { preparation } = event;
    if (!getCompactionHiddenIds(sm.getBranch()).size) return;
    preparation.messagesToSummarize = filterCompactionMessages(sm, preparation.messagesToSummarize);
    preparation.turnPrefixMessages = filterCompactionMessages(sm, preparation.turnPrefixMessages);
    const fileOps: typeof preparation.fileOps = { read: new Set(), written: new Set(), edited: new Set() };
    const previous = sm.buildSessionProjection().entries.find((entry) =>
        entry.sourceEntry.type === "compaction" && entry.messages.length)?.sourceEntry;
    if (previous?.type === "compaction" && !previous.fromHook) {
        const details = previous.details as { readFiles?: string[]; modifiedFiles?: string[] } | undefined;
        for (const path of details?.readFiles ?? []) fileOps.read.add(path);
        for (const path of details?.modifiedFiles ?? []) fileOps.edited.add(path);
    }
    // Match Pi's read/write/edit extraction, including codemode's recorded nested calls.
    for (const message of [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages]) {
        const calls = message.role === "assistant" ? message.content.filter((block) => block.type === "toolCall") :
            message.role === "toolResult" ? message.nestedCalls?.calls ?? [] : [];
        for (const call of calls) {
            const path = (call.arguments as { path?: unknown } | undefined)?.path;
            if (typeof path !== "string" || !path) continue;
            if (call.name === "read") fileOps.read.add(path);
            if (call.name === "write") fileOps.written.add(path);
            if (call.name === "edit") fileOps.edited.add(path);
        }
    }
    preparation.fileOps = fileOps;
}
