import type { ContextEvent, ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type, type Static, type TextContent, type ToolCall } from "@earendil-works/pi-ai";

type AgentMessage = ContextEvent["messages"][number];

const StateEntryType = "pi-context-range-compaction";
const MessageIdPattern = /^m\d{4,}$/;
const BlockIdPattern = /^b\d+$/;
const PrunedOutput = "[Tool output pruned: duplicate, stale, or superseded. Re-run the tool if needed.]";
const PurgedInput = "[Historical failed tool input pruned]";
export const RangeCompactionTriggerPercent = 50;

export interface RangeCompactionBlock {
    id: string;
    topic: string;
    startKey: string;
    endKey: string;
    summary: string;
    active: boolean;
    consumedBlockIds: string[];
}

export interface RangeCompactionState {
    version: 1;
    nextMessageId: number;
    nextBlockId: number;
    refs: Record<string, string>;
    blocks: RangeCompactionBlock[];
    prunedToolIds: string[];
    purgedErrorToolIds: string[];
}

export interface RangeRequest {
    start: string;
    end: string;
    summary: string;
}

export interface PreparedRange {
    startIndex: number;
    endIndex: number;
    startKey: string;
    endKey: string;
    summary: string;
    consumedBlockIds: string[];
}

interface ToolRecord {
    id: string;
    name: string;
    args: Record<string, unknown>;
    assistantIndex: number;
    resultIndex?: number;
    isError?: boolean;
}

export const createRangeCompactionState = (): RangeCompactionState => ({
    version: 1,
    nextMessageId: 1,
    nextBlockId: 1,
    refs: {},
    blocks: [],
    prunedToolIds: [],
    purgedErrorToolIds: [],
});

const messageKey = (message: AgentMessage, occurrence: number): string => {
    if (message.role === "toolResult") return `tool:${message.toolCallId}`;
    return `${message.role}:${message.timestamp}:${occurrence}`;
};

export const assignMessageReferences = (
    state: RangeCompactionState,
    messages: AgentMessage[],
): { keys: string[]; refs: string[] } => {
    const occurrences = new Map<string, number>();
    const keys: string[] = [];
    const refs: string[] = [];

    for (const message of messages) {
        const prefix = `${message.role}:${message.timestamp}`;
        const occurrence = occurrences.get(prefix) ?? 0;
        occurrences.set(prefix, occurrence + 1);
        const key = messageKey(message, occurrence);
        let ref = state.refs[key];
        if (!ref) {
            ref = `m${String(state.nextMessageId++).padStart(4, "0")}`;
            state.refs[key] = ref;
        }
        keys.push(key);
        refs.push(ref);
    }

    return { keys, refs };
};

const toolCalls = (message: AgentMessage): ToolCall[] => {
    if (message.role !== "assistant" || !Array.isArray(message.content)) return [];
    return message.content.filter((part): part is ToolCall => part.type === "toolCall");
};

const expandToolGroups = (messages: AgentMessage[], startIndex: number, endIndex: number): [number, number] => {
    let start = startIndex;
    let end = endIndex;
    let changed = true;

    while (changed) {
        changed = false;
        const selectedToolIds = new Set<string>();
        for (let index = start; index <= end; index++) {
            for (const call of toolCalls(messages[index])) selectedToolIds.add(call.id);
            const message = messages[index];
            if (message.role === "toolResult") selectedToolIds.add(message.toolCallId);
        }

        for (let index = 0; index < messages.length; index++) {
            const message = messages[index];
            const belongsToGroup = message.role === "toolResult"
                ? selectedToolIds.has(message.toolCallId)
                : toolCalls(message).some((call) => selectedToolIds.has(call.id));
            if (!belongsToGroup) continue;
            if (index < start) {
                start = index;
                changed = true;
            }
            if (index > end) {
                end = index;
                changed = true;
            }
        }
    }

    return [start, end];
};

const protectedTurnStart = (messages: AgentMessage[], protectedTurns: number): number => {
    if (protectedTurns <= 0) return messages.length;
    let usersSeen = 0;
    for (let index = messages.length - 1; index >= 0; index--) {
        if (messages[index].role !== "user") continue;
        usersSeen++;
        if (usersSeen === protectedTurns) return index;
    }
    return 0;
};

export const prepareRanges = (
    state: RangeCompactionState,
    messages: AgentMessage[],
    ranges: RangeRequest[],
    protectedTurns = 1,
): PreparedRange[] => {
    if (ranges.length === 0) throw new Error("At least one range is required.");
    const { keys, refs } = assignMessageReferences(state, messages);
    const indexByRef = new Map(refs.map((ref, index) => [ref, index]));
    const indexByKey = new Map(keys.map((key, index) => [key, index]));
    const activeBlocks = state.blocks.flatMap((block) => {
        if (!block.active) return [];
        const startIndex = indexByKey.get(block.startKey);
        const endIndex = indexByKey.get(block.endKey);
        return startIndex === undefined || endIndex === undefined ? [] : [{ block, startIndex, endIndex }];
    });
    const hiddenRawIndices = new Set(activeBlocks.flatMap(({ startIndex, endIndex }) =>
        Array.from({ length: endIndex - startIndex + 1 }, (_, offset) => startIndex + offset)));
    const protectedStart = protectedTurnStart(messages, protectedTurns);

    const resolveBoundary = (reference: string, edge: "start" | "end"): number | undefined => {
        if (MessageIdPattern.test(reference)) {
            const index = indexByRef.get(reference);
            return index === undefined || hiddenRawIndices.has(index) ? undefined : index;
        }
        if (!BlockIdPattern.test(reference)) return undefined;
        const match = activeBlocks.find(({ block }) => block.id === reference);
        return match?.[edge === "start" ? "startIndex" : "endIndex"];
    };

    const prepared = ranges.map((range) => {
        let startIndex = resolveBoundary(range.start, "start");
        let endIndex = resolveBoundary(range.end, "end");
        if (startIndex === undefined || endIndex === undefined) {
            throw new Error(`Range ${range.start}..${range.end} is not visible in the current context.`);
        }
        if (startIndex > endIndex) throw new Error(`Range ${range.start}..${range.end} is reversed.`);
        if (!range.summary.trim()) throw new Error(`Range ${range.start}..${range.end} has an empty summary.`);

        [startIndex, endIndex] = expandToolGroups(messages, startIndex, endIndex);
        let expanded = true;
        while (expanded) {
            expanded = false;
            for (const block of activeBlocks) {
                if (block.endIndex < startIndex || block.startIndex > endIndex) continue;
                const nextStart = Math.min(startIndex, block.startIndex);
                const nextEnd = Math.max(endIndex, block.endIndex);
                if (nextStart !== startIndex || nextEnd !== endIndex) expanded = true;
                startIndex = nextStart;
                endIndex = nextEnd;
            }
        }
        if (endIndex >= protectedStart) {
            throw new Error(`Range ${range.start}..${range.end} overlaps the protected recent turn.`);
        }
        const consumed = activeBlocks
            .filter((block) => block.startIndex >= startIndex && block.endIndex <= endIndex)
            .map(({ block }) => block.id);
        const nested = consumed
            .map((id) => state.blocks.find((block) => block.id === id))
            .filter((block): block is RangeCompactionBlock => block !== undefined)
            .map((block) => `[Previous compacted range ${block.id}: ${block.topic}]\n${block.summary}`);
        return {
            startIndex,
            endIndex,
            startKey: keys[startIndex],
            endKey: keys[endIndex],
            summary: [range.summary.trim(), ...nested].join("\n\n"),
            consumedBlockIds: consumed,
        };
    }).sort((left, right) => left.startIndex - right.startIndex);

    for (let index = 1; index < prepared.length; index++) {
        if (prepared[index].startIndex <= prepared[index - 1].endIndex) {
            throw new Error("Compaction ranges overlap after atomic expansion.");
        }
    }
    return prepared;
};

const appendText = (message: AgentMessage, text: string): AgentMessage => {
    if (!(message.role === "user" || message.role === "assistant" || message.role === "toolResult")) return message;
    const content = typeof message.content === "string"
        ? [{ type: "text" as const, text: message.content }]
        : [...message.content];
    content.push({ type: "text", text } as TextContent);
    return { ...message, content } as AgentMessage;
};

const applyToolCleanup = (state: RangeCompactionState, messages: AgentMessage[]): AgentMessage[] => {
    const pruned = new Set(state.prunedToolIds);
    const purged = new Set(state.purgedErrorToolIds);
    return messages.map((message) => {
        if (message.role === "toolResult" && pruned.has(message.toolCallId)) {
            return { ...message, content: [{ type: "text" as const, text: PrunedOutput }] };
        }
        if (message.role !== "assistant" || !Array.isArray(message.content)) return message;
        let changed = false;
        const content = message.content.map((part) => {
            if (part.type !== "toolCall" || !purged.has(part.id)) return part;
            changed = true;
            return { ...part, arguments: { pruned: PurgedInput } };
        });
        return changed ? { ...message, content } : message;
    }) as AgentMessage[];
};

export const addRangeCompactionAdvisory = (
    messages: AgentMessage[],
    usagePercent: number | undefined,
    triggerPercent = RangeCompactionTriggerPercent,
): AgentMessage[] => {
    if (usagePercent === undefined || usagePercent < triggerPercent) return messages;
    let userIndex = -1;
    for (let index = messages.length - 1; index >= 0; index--) {
        if (messages[index].role === "user") {
            userIndex = index;
            break;
        }
    }
    if (userIndex === -1) return messages;
    const output = [...messages];
    output[userIndex] = appendText(
        output[userIndex],
        `<pi-context-range-advisory>Context usage is ${usagePercent.toFixed(1)}%. Apply context management before more task tools. Priority: (1) if a completed suffix can be replaced and an immediate continuation exists, call context_compact; (2) otherwise, if completed prefix or middle ranges can be replaced while preserving the active frontier, call context_range_inspect and then context_compact_range; (3) if neither is valid, continue without compacting. Do not request full compaction; Pi's built-in compaction is the last-resort near-limit fallback.</pi-context-range-advisory>`,
    );
    return output;
};

export const projectRangeCompactions = (
    state: RangeCompactionState,
    rawMessages: AgentMessage[],
): AgentMessage[] => {
    const messages = applyToolCleanup(state, rawMessages);
    const { keys } = assignMessageReferences(state, rawMessages);
    const indexByKey = new Map(keys.map((key, index) => [key, index]));
    const active = state.blocks.flatMap((block) => {
        if (!block.active) return [];
        const startIndex = indexByKey.get(block.startKey);
        const endIndex = indexByKey.get(block.endKey);
        if (startIndex === undefined || endIndex === undefined || startIndex > endIndex) return [];
        return [{ block, startIndex, endIndex }];
    }).sort((left, right) => left.startIndex - right.startIndex);

    const output: AgentMessage[] = [];
    let blockIndex = 0;
    for (let index = 0; index < messages.length; index++) {
        const entry = active[blockIndex];
        if (entry && index === entry.startIndex) {
            output.push({
                role: "user",
                content: [{
                    type: "text",
                    text: `[Compacted range ${entry.block.id}: ${entry.block.topic}]\n${entry.block.summary}\n\n<pi-context-compaction-id>${entry.block.id}</pi-context-compaction-id>`,
                }],
                timestamp: messages[index].timestamp,
            });
            index = entry.endIndex;
            blockIndex++;
            continue;
        }
        output.push(messages[index]);
    }
    return output;
};

const stableJson = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
    if (value && typeof value === "object") {
        return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
    }
    return JSON.stringify(value);
};

const collectToolRecords = (messages: AgentMessage[]): ToolRecord[] => {
    const records: ToolRecord[] = [];
    const byId = new Map<string, ToolRecord>();
    for (let index = 0; index < messages.length; index++) {
        const message = messages[index];
        for (const call of toolCalls(message)) {
            const record = { id: call.id, name: call.name, args: call.arguments as Record<string, unknown>, assistantIndex: index };
            records.push(record);
            byId.set(call.id, record);
        }
        if (message.role === "toolResult") {
            const record = byId.get(message.toolCallId);
            if (record) {
                record.resultIndex = index;
                record.isError = message.isError;
            }
        }
    }
    return records;
};

export const calculateToolCleanup = (messages: AgentMessage[]): { prunedToolIds: string[]; purgedErrorToolIds: string[] } => {
    const records = collectToolRecords(messages).filter((record) => record.resultIndex !== undefined);
    const successful = records.filter((record) => !record.isError);
    const pruned = new Set<string>();
    const latestByFingerprint = new Map<string, ToolRecord>();
    for (let index = successful.length - 1; index >= 0; index--) {
        const record = successful[index];
        const fingerprint = `${record.name.toLowerCase()}:${stableJson(record.args)}`;
        if (latestByFingerprint.has(fingerprint)) pruned.add(record.id);
        else latestByFingerprint.set(fingerprint, record);
    }

    const latestSuccessfulWrite = new Map<string, ToolRecord>();
    for (let index = successful.length - 1; index >= 0; index--) {
        const record = successful[index];
        if (!(record.name === "read" || record.name === "write" || record.name === "edit")) continue;
        const path = record.args.path ?? record.args.file_path ?? record.args.filePath;
        if (typeof path !== "string") continue;
        const laterWrite = latestSuccessfulWrite.get(path);
        if (laterWrite) pruned.add(record.id);
        if (record.name === "write" || record.name === "edit") latestSuccessfulWrite.set(path, record);
    }

    const userTurnByIndex: number[] = [];
    let turn = 0;
    for (const message of messages) {
        if (message.role === "user") turn++;
        userTurnByIndex.push(turn);
    }
    const purged = records
        .filter((record) => record.isError && turn - userTurnByIndex[record.assistantIndex] >= 4)
        .map((record) => record.id);
    return { prunedToolIds: [...pruned], purgedErrorToolIds: purged };
};

const RangeCompactParams = Type.Object({
    topic: Type.String({ description: "Short semantic label for this compaction batch." }),
    ranges: Type.Array(Type.Object({
        start: Type.String({ description: "First visible message or compaction reference, such as m0018 or b2." }),
        end: Type.String({ description: "Last visible message or compaction reference, such as m0031 or b4." }),
        summary: Type.String({ description: "Complete state summary replacing this range." }),
    }), { minItems: 1 }),
});

type RangeCompactParamsType = Static<typeof RangeCompactParams>;

const isState = (data: unknown): data is RangeCompactionState => {
    if (!data || typeof data !== "object") return false;
    const value = data as Partial<RangeCompactionState>;
    return value.version === 1 && Array.isArray(value.blocks) && typeof value.refs === "object";
};

export const restoreRangeCompactionState = (entries: SessionEntry[]): RangeCompactionState => {
    for (let index = entries.length - 1; index >= 0; index--) {
        const entry = entries[index];
        if (entry.type !== "custom" || entry.customType !== StateEntryType || !isState(entry.data)) continue;
        const restored = structuredClone(entry.data);
        restored.prunedToolIds ??= [];
        restored.purgedErrorToolIds ??= [];
        for (const block of restored.blocks) block.consumedBlockIds ??= [];
        return restored;
    }
    return createRangeCompactionState();
};

const setBlockActive = (state: RangeCompactionState, blockId: string, active: boolean): boolean => {
    const block = state.blocks.find((candidate) => candidate.id === blockId);
    if (!block || block.active === active) return false;
    block.active = active;
    for (const childId of block.consumedBlockIds) {
        const child = state.blocks.find((candidate) => candidate.id === childId);
        if (child) child.active = !active;
    }
    return true;
};

export const registerRangeCompaction = (
    pi: ExtensionAPI,
    options: { triggerPercent?: number } = {},
): void => {
    let state = createRangeCompactionState();
    let latestMessages: AgentMessage[] = [];
    let thresholdAdvisoryShown = false;

    const persist = () => pi.appendEntry(StateEntryType, state);
    const restore = (ctx: ExtensionContext) => {
        state = restoreRangeCompactionState(ctx.sessionManager.getBranch());
        latestMessages = [];
        thresholdAdvisoryShown = false;
    };

    pi.on("session_start", async (_event, ctx) => restore(ctx));
    pi.on("session_tree", async (_event, ctx) => restore(ctx));
    pi.on("session_compact", async () => {
        thresholdAdvisoryShown = false;
        for (const block of state.blocks) block.active = false;
        state.prunedToolIds = [];
        state.purgedErrorToolIds = [];
        persist();
    });
    pi.on("context", async (event, ctx) => {
        latestMessages = event.messages;
        const usagePercent = ctx.getContextUsage()?.percent ?? undefined;
        const triggerPercent = options.triggerPercent ?? RangeCompactionTriggerPercent;
        let showAdvisory = false;
        if (usagePercent !== undefined && usagePercent >= triggerPercent) {
            if (!thresholdAdvisoryShown) {
                const cleanup = calculateToolCleanup(event.messages);
                state.prunedToolIds = cleanup.prunedToolIds;
                state.purgedErrorToolIds = cleanup.purgedErrorToolIds;
                thresholdAdvisoryShown = true;
                showAdvisory = true;
                persist();
            }
        } else {
            thresholdAdvisoryShown = false;
        }
        const projected = projectRangeCompactions(state, event.messages);
        return {
            messages: addRangeCompactionAdvisory(
                projected,
                showAdvisory ? usagePercent : undefined,
                triggerPercent,
            ),
        };
    });

    pi.registerCommand("context-ranges", {
        description: "List, decompress, or recompress ranged context compactions",
        handler: async (args, ctx) => {
            const [action = "list", blockId] = args.trim().split(/\s+/);
            if (action === "list") {
                const lines = state.blocks.map((block) => `${block.id} ${block.active ? "active" : "inactive"} ${block.topic}`);
                ctx.ui.notify(lines.join("\n") || "No ranged compactions.", "info");
                return;
            }
            if (!(action === "decompress" || action === "recompress") || !blockId) {
                ctx.ui.notify("Usage: /context-ranges [list|decompress <bN>|recompress <bN>]", "warning");
                return;
            }
            if (!setBlockActive(state, blockId, action === "recompress")) {
                ctx.ui.notify(`Cannot ${action} ${blockId}.`, "warning");
                return;
            }
            persist();
            ctx.ui.notify(`${action === "decompress" ? "Decompressed" : "Recompacted"} ${blockId}.`, "info");
        },
    });

    pi.registerTool({
        name: "context_range_inspect",
        label: "Context Range Inspect",
        description: "List stable message and compacted-block references for selecting context_compact_range boundaries. Call immediately before ranged compaction; references are intentionally exposed only on demand so internal markers do not pollute normal responses.",
        parameters: Type.Object({
            limit: Type.Optional(Type.Number({ description: "Maximum recent messages to list (default: 80)." })),
        }),
        async execute(_id, params: { limit?: number }) {
            if (latestMessages.length === 0) throw new Error("No model context is available to inspect.");
            const { keys, refs } = assignMessageReferences(state, latestMessages);
            const hiddenKeys = new Set(state.blocks
                .filter((block) => block.active)
                .flatMap((block) => {
                    const startIndex = keys.indexOf(block.startKey);
                    const endIndex = keys.indexOf(block.endKey);
                    return startIndex === -1 || endIndex === -1
                        ? []
                        : keys.slice(startIndex, endIndex + 1);
                }));
            const limit = Math.max(1, params.limit ?? 80);
            const start = Math.max(0, latestMessages.length - limit);
            const lines = latestMessages.slice(start).flatMap((message, offset) => {
                const index = start + offset;
                if (hiddenKeys.has(keys[index])) return [];
                let text = "";
                if ("content" in message) {
                    text = typeof message.content === "string"
                        ? message.content
                        : message.content
                            .filter((part): part is TextContent => part.type === "text")
                            .map((part) => part.text)
                            .join(" ");
                } else if (message.role === "bashExecution") {
                    text = message.command;
                }
                return [`${refs[index]} [${message.role}] ${text.replace(/\s+/g, " ").slice(0, 120)}`];
            });
            const blocks = state.blocks
                .filter((block) => block.active)
                .map((block) => `${block.id} [compacted] ${block.topic}`);
            return {
                content: [{ type: "text", text: [...blocks, ...lines].join("\n") }],
                details: {},
            };
        },
    });

    pi.registerTool({
        name: "context_compact_range",
        label: "Context Compact Range",
        description: "Compact one or more completed historical ranges into state summaries while preserving later messages. Call context_range_inspect immediately beforehand to obtain stable mNNNN or bN boundaries. Recent work is protected. Batch independent ranges in one call.",
        parameters: RangeCompactParams,
        async execute(_id, params: RangeCompactParamsType) {
            if (latestMessages.length === 0) throw new Error("No model context is available to compact.");
            const prepared = prepareRanges(state, latestMessages, params.ranges);
            const cleanup = calculateToolCleanup(latestMessages);
            const nextBlockId = state.nextBlockId;
            const blocks = prepared.map((range, index) => ({
                id: `b${nextBlockId + index}`,
                topic: params.topic,
                startKey: range.startKey,
                endKey: range.endKey,
                summary: range.summary,
                active: true,
                consumedBlockIds: range.consumedBlockIds,
            }));
            state.nextBlockId += blocks.length;
            for (const block of blocks) {
                for (const consumedId of block.consumedBlockIds) setBlockActive(state, consumedId, false);
            }
            state.prunedToolIds = cleanup.prunedToolIds;
            state.purgedErrorToolIds = cleanup.purgedErrorToolIds;
            state.blocks.push(...blocks);
            persist();
            return {
                content: [{
                    type: "text",
                    text: `Compacted ${blocks.length} range(s): ${blocks.map((block) => block.id).join(", ")}. Tool cleanup: ${cleanup.prunedToolIds.length} duplicate/stale output(s) pruned, ${cleanup.purgedErrorToolIds.length} old failed input(s) purged.`,
                }],
                details: {
                    blockIds: blocks.map((block) => block.id),
                    prunedToolOutputs: cleanup.prunedToolIds.length,
                    purgedFailedInputs: cleanup.purgedErrorToolIds.length,
                },
            };
        },
    });
};
