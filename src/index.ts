import {
  type ExtensionAPI,
  type SessionEntry,
  type SessionManager,
  DynamicBorder,
} from "@mariozechner/pi-coding-agent";
import type {
  ToolCall,
  TextContent,
  ImageContent,
} from "@mariozechner/pi-ai";
import { Type, type Static } from "@sinclair/typebox";
import { Container, Text, Spacer } from "@mariozechner/pi-tui";
import { DEFAULT_THRESHOLDS, evaluateContextHealth } from "./self-manage.js";

// Define missing types locally as they are not exported from the main entry point
interface SessionTreeNode {
  entry: SessionEntry;
  children: SessionTreeNode[];
  label?: string;
}

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

const ContextSelfManageParams = Type.Object({
  autoApply: Type.Optional(Type.Boolean({ description: "If true, automatically apply the recommended action (tag/squash) when needed." })),
  tagName: Type.Optional(Type.String({ description: "Optional explicit tag name when action is TAG." })),
  checkoutTarget: Type.Optional(Type.String({ description: "Optional checkout target when action is SQUASH. Defaults to nearest tag, otherwise root." })),
  carryoverMessage: Type.Optional(Type.String({ description: "Required for auto squash. Summary to carry to the new branch." })),
  backupTag: Type.Optional(Type.String({ description: "Optional backup tag name before auto squash." })),
  warnUsagePercent: Type.Optional(Type.Number({ description: "Override warning threshold for context usage percent." })),
  squashUsagePercent: Type.Optional(Type.Number({ description: "Override critical threshold for automatic squash recommendation." })),
  maxSegmentSteps: Type.Optional(Type.Number({ description: "Override max steps since last tag before warning." })),
});

const isInternal = (name: string) => ["context_tag", "context_log", "context_checkout", "context_self_manage"].includes(name);

const resolveTargetId = (sm: SessionManager, target: string): string => {
  if (target.toLowerCase() === "root") {
    const tree = sm.getTree();
    return tree.length > 0 ? tree[0].entry.id : target;
  }
  if (/^[0-9a-f]{8,}$/i.test(target)) return target;
  const find = (nodes: SessionTreeNode[]): string | null => {
    for (const n of nodes) {
      if (sm.getLabel(n.entry.id) === target) return n.entry.id;
      const r = find(n.children);
      if (r) return r;
    }
    return null;
  };
  // sm.getTree() returns the SDK's SessionTreeNode[], which is structurally compatible
  return find(sm.getTree()) || target;
};

const formatTokens = (n: number) => {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return Math.round(n / 1_000) + "k";
  return n.toString();
};

const getBranchTagState = (sm: SessionManager, branch: SessionEntry[]) => {
  let stepsSinceTag = 0;
  let nearestTagName = "None";
  let nearestTagId: string | null = null;

  for (let i = branch.length - 1; i >= 0; i--) {
    const id = branch[i].id;
    const label = sm.getLabel(id);
    if (label) {
      nearestTagName = label;
      nearestTagId = id;
      break;
    }
    stepsSinceTag++;
  }

  return {
    stepsSinceTag,
    nearestTagName,
    nearestTagId,
    hasAnyTagOnBranch: nearestTagId !== null,
  };
};

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "context_tag",
    label: "Context Tag",
    description: "Creates a 'Save Point' (Bookmark) in the history. Use this before trying risky changes or when a feature is stable. 'Untagged progress is risky'.",
    parameters: ContextTagParams,
    async execute(_id, params: Static<typeof ContextTagParams>, _signal, _onUpdate, ctx) {
      const sm = ctx.sessionManager as SessionManager;
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

      const { stepsSinceTag, nearestTagName } = getBranchTagState(sm, branch);

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
      await sm.branchWithSummary(tid, enrichedMessage);

      return { content: [{ type: "text", text: `Checked out ${tid}\nBackup tag created: ${params.backupTag || "none"}\nmessage: ${enrichedMessage}` }], details: {} };
    },
  });

  pi.registerTool({
    name: "context_self_manage",
    label: "Context Self Manage",
    description: "Assess context health and recommend or auto-apply context maintenance (tag or squash).",
    parameters: ContextSelfManageParams,
    async execute(_id, params: Static<typeof ContextSelfManageParams>, _signal, _onUpdate, ctx) {
      const sm = ctx.sessionManager as SessionManager;
      const branch = sm.getBranch();
      const usage = await ctx.getContextUsage();

      if (!usage) {
        return {
          content: [{ type: "text", text: "Context usage data is unavailable. Run /context or context_log later." }],
          details: {},
        };
      }

      const tagState = getBranchTagState(sm, branch);
      const health = evaluateContextHealth(
        {
          usagePercent: usage.percent,
          usageTokens: usage.tokens,
          contextWindow: usage.contextWindow,
          stepsSinceTag: tagState.stepsSinceTag,
          hasAnyTagOnBranch: tagState.hasAnyTagOnBranch,
        },
        {
          warnUsagePercent: params.warnUsagePercent,
          squashUsagePercent: params.squashUsagePercent,
          maxSegmentSteps: params.maxSegmentSteps,
        },
      );

      const thresholds = {
        ...DEFAULT_THRESHOLDS,
        warnUsagePercent: params.warnUsagePercent ?? DEFAULT_THRESHOLDS.warnUsagePercent,
        squashUsagePercent: params.squashUsagePercent ?? DEFAULT_THRESHOLDS.squashUsagePercent,
        maxSegmentSteps: params.maxSegmentSteps ?? DEFAULT_THRESHOLDS.maxSegmentSteps,
      };

      const lines: string[] = [
        `[Self Manage Context]`,
        `Health: ${health.level.toUpperCase()}`,
        `Usage: ${usage.percent.toFixed(1)}% (${formatTokens(usage.tokens)}/${formatTokens(usage.contextWindow)})`,
        `Segment: ${tagState.stepsSinceTag} steps since '${tagState.nearestTagName}'`,
        `Recommended action: ${health.recommendedAction.toUpperCase()}`,
        `Thresholds: warn=${thresholds.warnUsagePercent}% squash=${thresholds.squashUsagePercent}% segment=${thresholds.maxSegmentSteps}`,
      ];

      if (health.reasons.length > 0) {
        lines.push(`Reason(s):`);
        for (const reason of health.reasons) {
          lines.push(`- ${reason}`);
        }
      }

      if (!params.autoApply || health.recommendedAction === "none") {
        if (health.recommendedAction === "tag") {
          const suggestedTag = params.tagName ?? `milestone-${Date.now().toString().slice(-6)}`;
          lines.push(`Suggested next step: context_tag({ name: "${suggestedTag}" })`);
        }
        if (health.recommendedAction === "squash") {
          const suggestedTarget = params.checkoutTarget ?? (tagState.nearestTagId ? tagState.nearestTagName : "root");
          lines.push(`Suggested next step: context_checkout({ target: "${suggestedTarget}", message: "<carryover summary>", backupTag: "pre-squash-backup" })`);
        }

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: {
            health,
            thresholds,
          },
        };
      }

      if (health.recommendedAction === "tag") {
        const currentLeaf = sm.getLeafId();
        if (!currentLeaf) {
          lines.push("Auto-apply skipped: current leaf not found.");
          return { content: [{ type: "text", text: lines.join("\n") }], details: { health, thresholds } };
        }

        const tagName = params.tagName ?? `auto-milestone-${Date.now().toString().slice(-6)}`;
        pi.setLabel(currentLeaf, tagName);
        lines.push(`Auto-applied: created tag '${tagName}' at ${currentLeaf}.`);

        return { content: [{ type: "text", text: lines.join("\n") }], details: { health, thresholds, action: "tag", tagName } };
      }

      if (health.recommendedAction === "squash") {
        if (!params.carryoverMessage || params.carryoverMessage.trim().length === 0) {
          lines.push("Auto-apply blocked: carryoverMessage is required for squash.");
          return { content: [{ type: "text", text: lines.join("\n") }], details: { health, thresholds } };
        }

        const currentLeaf = sm.getLeafId();
        let target = params.checkoutTarget;
        if (!target) {
          target = tagState.nearestTagId ? tagState.nearestTagName : "root";
        }

        const resolvedTarget = resolveTargetId(sm, target);
        if (currentLeaf === resolvedTarget) {
          lines.push(`Auto-apply skipped: already at target '${target}'.`);
          return { content: [{ type: "text", text: lines.join("\n") }], details: { health, thresholds } };
        }

        if (params.backupTag && currentLeaf) {
          pi.setLabel(currentLeaf, params.backupTag);
        }

        const currentLabel = currentLeaf ? sm.getLabel(currentLeaf) : undefined;
        const origin = currentLabel ? `tag: ${currentLabel}` : (currentLeaf || "unknown");
        const enrichedMessage = `(summary from ${origin})\n${params.carryoverMessage}`;

        await sm.branchWithSummary(resolvedTarget, enrichedMessage);

        lines.push(`Auto-applied: checked out '${target}' (${resolvedTarget}).`);
        lines.push(`Backup tag: ${params.backupTag || "none"}`);

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: {
            health,
            thresholds,
            action: "squash",
            target,
            resolvedTarget,
            backupTag: params.backupTag,
          },
        };
      }

      return { content: [{ type: "text", text: lines.join("\n") }], details: { health, thresholds } };
    },
  });

  pi.registerCommand("context", {
    description: "Show context usage visualization",
    handler: async (args, ctx) => {
      const usage = await ctx.getContextUsage();
      if (!usage) {
        ctx.ui.notify("Context usage info not available.", "warning");
        return;
      }

      const sm = ctx.sessionManager as SessionManager;
      const branch = sm.getBranch();
      const systemPrompt = ctx.getSystemPrompt();
      const tools = pi.getActiveTools();
      const allTools = pi.getAllTools();
      const activeToolDefs = allTools.filter(t => tools.includes(t.name));

      const estimateTokens = (text: string) => Math.ceil(text.length / 4);

      let msgTokensRaw = 0;
      let toolUseTokensRaw = 0;
      let toolResultTokensRaw = 0;

      for (const entry of branch) {
        if (entry.type === "message") {
          const m = entry.message;
          if (m.role === "user") {
            if (typeof m.content === "string") msgTokensRaw += estimateTokens(m.content);
            else if (Array.isArray(m.content)) {
              for (const p of m.content) if (p.type === "text") msgTokensRaw += estimateTokens(p.text);
            }
          } else if (m.role === "assistant") {
            if (typeof m.content === "string") msgTokensRaw += estimateTokens(m.content);
            else if (Array.isArray(m.content)) {
              for (const p of m.content) {
                if (p.type === "text") msgTokensRaw += estimateTokens(p.text);
                if (p.type === "toolCall") toolUseTokensRaw += estimateTokens(JSON.stringify(p));
              }
            }
          } else if (m.role === "toolResult") {
            if (Array.isArray(m.content)) {
              for (const p of m.content) if (p.type === "text") toolResultTokensRaw += estimateTokens(p.text);
            }
          } else if (m.role === "bashExecution") {
            toolUseTokensRaw += estimateTokens(m.command || "");
          }
        } else if (entry.type === "branch_summary" || entry.type === "compaction") {
          msgTokensRaw += estimateTokens(entry.summary || "");
        }
      }

      const systemTokensRaw = estimateTokens(systemPrompt);
      const toolDefTokensRaw = estimateTokens(JSON.stringify(activeToolDefs));
      const totalActual = usage.tokens;
      const limit = usage.contextWindow;

      const totalRaw = systemTokensRaw + toolDefTokensRaw + msgTokensRaw + toolUseTokensRaw + toolResultTokensRaw;
      const ratio = totalRaw > 0 ? (totalActual / totalRaw) : 1;

      const systemTokens = Math.round(systemTokensRaw * ratio);
      const toolDefTokens = Math.round(toolDefTokensRaw * ratio);
      const msgTokens = Math.round(msgTokensRaw * ratio);
      const toolUseTokens = Math.round(toolUseTokensRaw * ratio);
      const toolResultTokens = Math.round(toolResultTokensRaw * ratio);

      await ctx.ui.custom((tui, theme, kb, done) => {
        const container = new Container();
        container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
        container.addChild(new Text(theme.fg("accent", theme.bold(" Context Usage")), 1, 0));
        container.addChild(new Spacer(1));

        // Grouped by function and color
        const categories = [
          { label: "System Prompt", value: systemTokens, color: "muted" },
          { label: "System Tools", value: toolDefTokens, color: "dim" },
          { label: "Tool Call", value: toolUseTokens + toolResultTokens, color: "success" },
          { label: "Messages", value: msgTokens, color: "accent" },
        ];

        const otherTokens = Math.max(0, totalActual - (systemTokens + toolDefTokens + msgTokens + toolUseTokens + toolResultTokens));
        if (otherTokens > 10) categories.push({ label: "Other", value: otherTokens, color: "dim" });

        categories.push({ label: "Available", value: Math.max(0, limit - totalActual), color: "borderMuted" });

        const gridWidth = 10;
        const gridHeight = 5;
        const totalBlocks = gridWidth * gridHeight;

        const blocks: { color: string, filled: boolean }[] = [];
        categories.forEach((cat) => {
          if (cat.label === "Available") return;
          let count = Math.round((cat.value / limit) * totalBlocks);
          if (count === 0 && cat.value > 0) count = 1;
          for (let i = 0; i < count && blocks.length < totalBlocks; i++) {
            blocks.push({ color: cat.color, filled: true });
          }
        });

        while (blocks.length < totalBlocks) {
          blocks.push({ color: "borderMuted", filled: false });
        }

        const gridLines: string[] = [];
        for (let r = 0; r < gridHeight; r++) {
          let rowStr = "";
          for (let c = 0; c < gridWidth; c++) {
            const b = blocks[r * gridWidth + c];
            rowStr += theme.fg(b.color as any, b.filled ? "■ " : "□ ");
          }
          gridLines.push(rowStr.trimEnd());
        }

        const totalUsageTitle = `${theme.fg("text", theme.bold("Total Usage".padEnd(16)))} ${theme.fg("text", theme.bold(formatTokens(totalActual).padStart(7)))} ${theme.fg("text", theme.bold(`(${usage.percent.toFixed(1).padStart(5)}%)`))}`;

        const catDetailLines = categories.map(cat => {
          const labelStr = cat.label.padEnd(14);
          const valStr = formatTokens(cat.value).padStart(7);
          const rowPercent = ((cat.value / limit) * 100).toFixed(1).padStart(5);
          const icon = cat.label === "Available" ? "□" : "■";
          return `${theme.fg(cat.color as any, icon)} ${theme.fg("text", labelStr)} ${theme.fg("accent", valStr)} (${rowPercent}%)`;
        });

        const allDetailLines = [totalUsageTitle, "", ...catDetailLines];

        const leftSideWidth = 20;
        const maxH = Math.max(gridLines.length, allDetailLines.length);
        for (let i = 0; i < maxH; i++) {
          const left = (gridLines[i] || "").padEnd(leftSideWidth);
          const right = allDetailLines[i] || "";
          container.addChild(new Text(`    ${left}      ${right}`, 1, 0));
        }

        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("dim", " Press any key to close"), 1, 0));
        container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

        return {
          render: (w) => container.render(w),
          invalidate: () => container.invalidate(),
          handleInput: (data) => done(undefined),
        };
      }, { overlay: true });
    }
  });
}
