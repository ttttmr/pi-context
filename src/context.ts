import {
  type ExtensionAPI,
  type SessionManager,
  DynamicBorder,
} from "@earendil-works/pi-coding-agent";
import { Container, Text, Spacer } from "@earendil-works/pi-tui";
import { estimateHistoryTokens, formatTokens, RetainedCodemodeOutputType } from "./utils.js";

export default function (pi: ExtensionAPI) {
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
        } else if (entry.type === "custom_message" && entry.customType === RetainedCodemodeOutputType) {
          toolResultTokensRaw += estimateHistoryTokens(entry);
        }
      }

      const systemTokensRaw = estimateTokens(systemPrompt);
      const toolDefTokensRaw = estimateTokens(JSON.stringify(activeToolDefs));
      const totalActual = usage.tokens;
      const limit = usage.contextWindow;
      const usagePercent = usage.percent;

      if (totalActual == null || limit == null || usagePercent == null) {
        ctx.ui.notify("Context usage info not available.", "warning");
        return;
      }

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

        const totalUsageTitle = `${theme.fg("text", theme.bold("Total Usage".padEnd(16)))} ${theme.fg("text", theme.bold(formatTokens(totalActual).padStart(7)))} ${theme.fg("text", theme.bold(`(${usagePercent.toFixed(1).padStart(5)}%)`))}`;

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
