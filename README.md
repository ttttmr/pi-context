# Pi Context: Agentic Context Management for Pi

An Agentic Context Management tool that helps AI agents keep long conversations focused by maintaining a clean working set: checkpoint useful anchors, inspect the active history structure, and compact noisy completed paths into state summaries.

Inspired by kimi-cli d-mail, it brings lossless time travel to Pi's session tree.

For more on the design philosophy, see the [blog post](https://blog.xlab.app/p/51d26495/) ([中文版本](https://blog.xlab.app/p/6a966aeb/)).

## Naming migration note

Earlier versions used more Git-like names such as `context_tag`, `context_log`, and `context_checkout`.

Current versions intentionally use conversation-native names instead:
- `context_checkpoint`
- `context_timeline`
- `context_compact`

These tools manage **conversation history**, not repository state. They should not be treated as Git commands or as replacements for real `git tag`, `git log`, or `git checkout`. Context navigation does not modify or roll back files, running processes, browser state, tickets, databases, or remote services.

## Installation

```bash
pi install npm:pi-context
```

## Usage

### For Humans

ACM (**A**gentic **C**ontext **M**anagement) works automatically with Pi >= 1.2.0; no manual `/acm` is required.

`/acm` and `/acm <task>` remain available for compatibility.

After a compaction the transcript shows a one-line "Context compacted" message (press `ctrl+o` to expand the handoff summary); earlier messages stay visible, and the backup checkpoint (or `/tree`) returns to the original context.

### Checkpoint naming and timeline estimates

Use checkpoint names ending in `-start`, `-done`, `-pivot`, `-pause`, or `-resume` to declare a task or phase change, keeping the scope prefix consistent within a phase's lifecycle (for example `parser-investigation-start` → `parser-investigation-done`). Other names remain valid ordinary anchors. Timeline displays the parsed phase next to each label, folds hidden intervals with message counts and approximate tokens using Pi's heuristic, marks already-compacted history (it cannot be a compact target), and marks off-path summaries. Interval estimates describe historical content, exclude internal context-management traffic, and are not exact current-model occupancy or reclaimable space.

Open a visual dashboard to inspect context-window usage and token distribution (similar to `claude code /context`).

```bash
/context
```

![](img/context.png)

### Session analysis (repository checkout)

Generate an offline token timeline from a saved Pi session, with checkpoint markers, compaction events, cumulative usage, and an explicitly simulated threshold-only comparison:

```bash
npm run analyze:session -- /path/to/session.jsonl --out /path/to/report
```

Open `report/session-token-chart.html` in a browser. See [session analysis documentation](tools/session-analysis/README.md) for snapshot cutoffs, simulation parameters, measurement limits, and privacy notes. This developer tool is not included in the npm extension package.

### For Agents

This extension adds the `context-management` skill, which guides agents to keep the active conversation as the smallest sufficient working set for the next step. It includes three core tools:

1. **🔖 Anchor (`context_checkpoint`)**
   Label a meaningful conversation node with a unique semantic checkpoint name, such as `parser-investigation-start` and `parser-investigation-done`.

2. **📊 Inspect (`context_timeline`)**
   View the active path as a structural map of checkpoints, summaries/compactions, branch points, user turns, and current position. Use it when orientation or compact target selection depends on history shape.

3. **⏪ Compact (`context_compact`)**
   Compact the conversation after an earlier checkpoint, history node, or `root` into a summarized continuation. The summary should restore the useful state after the target: current task, decisions, external side effects such as changed files or remote updates, validation state, source anchors, and the explicit next step.

## Development

Contributor guidance lives in [AGENTS.md](AGENTS.md) (commands, structure, conventions) and [docs/compaction.md](docs/compaction.md) (how compaction works and why). Test instructions are in [test/test.md](test/test.md).
