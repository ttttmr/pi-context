import {
    type ExtensionAPI,
    type SessionManager,
    type SessionEntry,
} from "@mariozechner/pi-coding-agent";
import type {
    TextContent,
    ImageContent,
    ToolCall,
} from "@mariozechner/pi-ai";
import { Type, type Static } from "@sinclair/typebox";
import { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { AutocompleteItem } from "@mariozechner/pi-tui";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { formatTokens } from "./utils.js";

// Define missing types locally as they are not exported from the main entry point
interface SessionTreeNode {
    entry: SessionEntry;
    children: SessionTreeNode[];
    label?: string;
}

const InternalTools = ["context_tag", "context_log", "context_checkout"];
let CommandCtx: ExtensionCommandContext | null = null;
let CheckoutParams: any = null;
let skillActivated = false;

const isInternal = (name: string) => InternalTools.includes(name);

// --- Config ---

const CONFIG_PATH = join(homedir(), ".pi", "agent", "pi-context.json");

interface AcmConfig {
    autoEnable: boolean;
}

function loadConfig(): AcmConfig {
    try {
        if (existsSync(CONFIG_PATH)) {
            const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
            return { autoEnable: raw.autoEnable === true };
        }
    } catch {
        // Ignore parse errors, return defaults
    }
    return { autoEnable: false };
}

function saveConfig(config: AcmConfig): void {
    const dir = dirname(CONFIG_PATH);
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }
    writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

function activateAcm(pi: ExtensionAPI, notifyFn: (msg: string, type: "info" | "warning" | "error") => void): void {
    notifyFn("Agentic Context Management enabled.", "info");
    if (!skillActivated) {
        skillActivated = true;
        pi.sendMessage({
            customType: "pi-context",
            content: "use context-management skill",
            display: false,
        }, {
            deliverAs: "followUp"
        });
    }
}

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

const ContextLogParams = Type.Object({
    limit: Type.Optional(Type.Number({ description: "History limit for visible entries (default: 50)." })),
    verbose: Type.Optional(Type.Boolean({ description: "If true, show ALL messages. If false (default), collapses intermediate AI steps and only shows 'milestones': User messages, Tags, Branch Points, and Summaries." })),
});

const ContextCheckoutParams = Type.Object({
    target: Type.String({ description: "Where to jump/squash to. Can be a tag name (e.g., 'task-start'), a commit ID, or 'root'. This is the base for your new branch." }),
    message: Type.String({ description: "The 'Carryover Message' for the new branch. A summary of your *current* progress/lessons that you want to bring with you to the new state. This ensures you don't lose key information when switching contexts. Good summary message: '[Status] + [Reason] + [Important Changes] + [Carryover Data]'" }),
    backupTag: Type.Optional(Type.String({ description: "Optional tag name to apply to the CURRENT state before checking out. Use this to create an automatic backup of the history you are about to leave/squash." })),
});

const ContextTagParams = Type.Object({
    name: Type.String({ description: "The tag/milestone name. Use meaningful names." }),
    target: Type.Optional(Type.String({ description: "The commit ID to tag. Defaults to HEAD (current state)." })),
});

export default function (pi: ExtensionAPI) {
    const ACM_SUBCOMMANDS = ["auto", "show", "path", "help"];
    const ACM_USAGE = "Usage: /acm [auto [on|off]|show|path|help] [message]";

    pi.registerCommand("acm", {
        description: "Enable agentic context management for the current session",
        getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
            const trimmed = prefix.trimStart();

            if (!trimmed.includes(" ")) {
                const matches = ACM_SUBCOMMANDS.filter(s => s.startsWith(trimmed));
                return matches.length > 0 ? matches.map(value => ({ value, label: value })) : null;
            }

            const spaceIdx = trimmed.indexOf(" ");
            const sub = trimmed.slice(0, spaceIdx);
            const rest = trimmed.slice(spaceIdx + 1);

            if (sub === "auto") {
                const options = ["on", "off"];
                const matches = options.filter(o => o.startsWith(rest));
                return matches.length > 0 ? matches.map(value => ({ value: `auto ${value}`, label: value })) : null;
            }

            return null;
        },
        handler: async (args, ctx) => {
            const trimmed = (args || "").trim();
            const normalized = trimmed.toLowerCase();

            if (normalized === "help") {
                ctx.ui.notify(ACM_USAGE, "info");
                return;
            }

            if (normalized === "show") {
                const config = loadConfig();
                const active = CommandCtx !== null || skillActivated;
                ctx.ui.notify(
                    `ACM: active=${active ? "yes" : "no"}, autoEnable=${config.autoEnable ? "on" : "off"}, config=${CONFIG_PATH}`,
                    "info"
                );
                return;
            }

            if (normalized === "path") {
                ctx.ui.notify(CONFIG_PATH, "info");
                return;
            }

            if (normalized === "auto" || normalized.startsWith("auto ")) {
                const config = loadConfig();
                const arg = normalized === "auto" ? undefined : normalized.slice(5).trim();

                if (arg === undefined) {
                    config.autoEnable = !config.autoEnable;
                } else if (arg === "on") {
                    config.autoEnable = true;
                } else if (arg === "off") {
                    config.autoEnable = false;
                } else {
                    ctx.ui.notify("Usage: /acm auto [on|off]", "warning");
                    return;
                }

                saveConfig(config);
                ctx.ui.notify(
                    `ACM auto-enable: ${config.autoEnable ? "on" : "off"}.${config.autoEnable ? " New sessions will activate automatically." : ""}`,
                    "info"
                );
                return;
            }

            // Default: enable ACM + optional message forwarding
            CommandCtx = ctx;
            activateAcm(pi, (msg, type) => ctx.ui.notify(msg, type));
            if (trimmed) {
                pi.sendUserMessage(trimmed);
            }
        }
    });

    // Helper: Check if a tag name already exists in the tree
    const findTagInTree = (sm: SessionManager, nodes: SessionTreeNode[], tagName: string): string | null => {
        for (const n of nodes) {
            if (sm.getLabel(n.entry.id) === tagName) return n.entry.id;
            const r = findTagInTree(sm, n.children, tagName);
            if (r) return r;
        }
        return null;
    };

    pi.registerTool({
        name: "context_tag",
        label: "Context Tag",
        description: "Creates a 'Save Point' (Bookmark) in the history. Use this before trying risky changes or when a feature is stable. 'Untagged progress is risky'.",
        parameters: ContextTagParams,
        async execute(_id, params: Static<typeof ContextTagParams>, _signal, _onUpdate, ctx) {
            const sm = ctx.sessionManager as SessionManager;

            // Deduplication check: ensure tag name is unique
            const existingTagId = findTagInTree(sm, sm.getTree(), params.name);
            if (existingTagId) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Tag '${params.name}' already exists at ${existingTagId}. Tag names must be unique. Use a different name or delete the existing tag first.`
                    }],
                    details: {}
                };
            }

            let id = params.target ? resolveTargetId(sm, params.target) : undefined;

            if (!id) {
                // Auto-resolve: Find the last "interesting" node to tag.
                // We skip ToolResults (which look ugly tagged) and internal-only Assistant messages (which look empty).
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
            return { content: [{ type: "text", text: `Created tag '${params.name}' at ${id}` }], details: {} };
        },
    });

    pi.registerTool({
        name: "context_log",
        label: "Context Log",
        description: "Show the entire history structure (status, message, tags, milestones). Analogous to 'git log --graph --oneline --decorate'",
        parameters: ContextLogParams,
        async execute(_id, params: Static<typeof ContextLogParams>, _signal, _onUpdate, ctx) {
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
                    return `tag: ${entry.label}`;
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

                // 2. Explicit Tags (Labels) - Only show the TAGGED node, not the label node itself
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
                const meta = [isRoot ? "ROOT" : null, isHead ? "HEAD" : null, label ? `tag: ${label}` : null].filter(Boolean).join(", ");

                const body = content.length > 100 ? content.slice(0, 100) + "..." : content;

                const marker = isHead ? "*" : (role === "USER" ? "•" : "|");

                lines.push(`${marker} ${id}${meta ? ` (${meta})` : ""} [${role}] ${body}`);
            });

            if (hiddenCount > 0) {
                lines.push(`  :  ... (${hiddenCount} hidden messages) ...`);
            }

            // --- Context Dashboard (HUD) ---
            const usage = await ctx.getContextUsage();
            let usageStr = "Unknown";
            if (usage) {
                usageStr = `${usage.percent.toFixed(1)}% (${formatTokens(usage.tokens)}/${formatTokens(usage.contextWindow)})`;
            }

            // Find the distance to the nearest tag
            let stepsSinceTag = 0;
            let nearestTagName = "None";
            for (let i = branch.length - 1; i >= 0; i--) {
                const id = branch[i].id;
                const label = sm.getLabel(id);
                if (label) {
                    nearestTagName = label;
                    break;
                }
                stepsSinceTag++;
            }

            const hud = [
                `[Context Dashboard]`,
                `• Context Usage:    ${usageStr}`,
                `• Segment Size:     ${stepsSinceTag} steps since last tag '${nearestTagName}'`,
                `---------------------------------------------------`
            ].join("\n");

            return { content: [{ type: "text", text: hud + "\n" + (lines.join("\n") || "(Root Path Only)") }], details: {} };
        },
    });

    pi.registerTool({
        name: "context_checkout",
        label: "Context Checkout",
        description: "Navigate to ANY point in the conversation history. This checkout only resets *conversation history*, NOT disk files. ALWAYS provide a detailed 'message' to bridge context.",
        parameters: ContextCheckoutParams,
        async execute(_id, params: Static<typeof ContextCheckoutParams>, _signal, _onUpdate, ctx) {
            if (!CommandCtx) {
                ctx.ui.setEditorText(`/acm ${ctx.ui.getEditorText() || "continue"}`)
                return {
                    content: [{
                        type: "text",
                        text: "Agentic context management is not enabled. Ask the user to run `/acm` in the pi to enable it, then retry."
                    }],
                    details: {}
                };
            }
            const sm = ctx.sessionManager as SessionManager;

            const tid = resolveTargetId(sm, params.target);

            const currentLeaf = sm.getLeafId();
            if (currentLeaf === tid) {
                return { content: [{ type: "text", text: `Already at target ${tid}` }], details: {} };
            }
            if (params.backupTag && currentLeaf) {
                pi.setLabel(currentLeaf, params.backupTag);
            }
            const currentLabel = currentLeaf ? sm.getLabel(currentLeaf) : undefined;
            const origin = currentLabel ? `tag: ${currentLabel}` : (currentLeaf || "unknown");

            const enrichedMessage = `(summary from ${origin})\n${params.message}`;

            const nid = await sm.branchWithSummary(tid, enrichedMessage);
            CheckoutParams = params;
            CheckoutParams.nid = nid;
            CheckoutParams.tid = tid;
            CheckoutParams.enrichedMessage = enrichedMessage;

            return { content: [{ type: "text", text: "checkout start" }], details: {} };
        },
    });

    pi.on("turn_end", async (event, ctx) => {
        if (!CheckoutParams) {
            return
        }
        ctx.abort()
    });

    pi.on("agent_end", async (_event, ctx) => {
        if (!CheckoutParams) {
            return
        }
        if (!CommandCtx) {
            return
        }

        await CommandCtx.navigateTree(CheckoutParams.nid, {
            summarize: false,
        });

        ctx.ui.notify(`Checked out ${CheckoutParams.target}${CheckoutParams.target === CheckoutParams.tid ? "" : `(${CheckoutParams.tid})`}\nBackup tag created: ${CheckoutParams.backupTag || "none"}\nmessage: ${CheckoutParams.enrichedMessage}`, "info");
        CheckoutParams = null;

        pi.sendMessage({
            customType: "pi-context",
            content: "context_checkout complete. A summary of your previous branch was injected above. Read it to understand your new state. Execute the 'Next Step' from the summary",
            display: false,
        }, {
            triggerTurn: true,
        });
    });

    pi.on("session_start", async (_event, ctx) => {
        // Reset per-session state
        CommandCtx = null;
        CheckoutParams = null;
        skillActivated = false;

        const config = loadConfig();
        if (config.autoEnable) {
            activateAcm(pi, (msg, type) => ctx.ui.notify(msg, type));
        }
    });
}
