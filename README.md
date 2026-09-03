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

Run the following command to enable checkpoint-based suffix compaction for the current session. Ranged prefix/middle compaction and threshold advisories do not require this command.

```bash
/acm
```

Open a visual dashboard to inspect context-window usage and token distribution (similar to `claude code /context`).

```bash
/context
```

![](img/context.png)

### For Agents

This extension adds the `context-management` skill, which guides agents to keep the active conversation as the smallest sufficient working set for the next step. It includes five core tools:

1. **🔖 Anchor (`context_checkpoint`)**
   Label a meaningful conversation node with a unique semantic checkpoint name, such as `parser-fix-start` or `timeout-investigation-search`.

2. **📊 Inspect (`context_timeline`)**
   View the active path as a structural map of checkpoints, summaries/compactions, branch points, user turns, and current position. Use it when orientation or compact target selection depends on history shape.

3. **⏪ Compact suffix (`context_compact`) — first priority**
   Create a summarized continuation branch from an earlier checkpoint, history node, or `root`. The summary should restore the useful state after the target: current task, decisions, external side effects such as changed files or remote updates, validation state, source anchors, and the explicit next step. At a valid continuation boundary, use this before any non-context tool for the next phase.

4. **🔎 Inspect ranges (`context_range_inspect`)**
   List stable `mNNNN` message and `bN` compacted-block references only when the agent needs to select ranged-compaction boundaries. References are not injected into normal conversation messages.

5. **✂️ Compact range (`context_compact_range`) — second priority**
   When suffix compaction is not appropriate, replace completed prefix or middle ranges in the model-facing context with state summaries while preserving later messages verbatim. The agent obtains boundaries from `context_range_inspect`; original session history remains unchanged.

At 50% context usage, pi-context injects a one-time advisory that enforces this order:

1. `context_compact` for a completed suffix at a valid continuation boundary.
2. `context_compact_range` for completed prefix/middle history when the active frontier must remain raw.
3. Pi's built-in full compaction only as near-limit or overflow recovery.

The advisory never aborts the active turn and never requests full compaction.
