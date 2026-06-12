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

Run the following command to enable ACM (**A**gentic **C**ontext **M**anagement) for the current session.

```bash
/acm
```

Open a visual dashboard to inspect context-window usage and token distribution (similar to `claude code /context`).

```bash
/context
```

![](img/context.png)

### For Agents

This extension adds the `context-management` skill, which guides agents to keep the active conversation as the smallest sufficient working set for the next step. It includes three core tools:

1. **🔖 Anchor (`context_checkpoint`)**
   Label a meaningful conversation node with a unique semantic checkpoint name, such as `parser-fix-start` or `timeout-investigation-search`.

2. **📊 Inspect (`context_timeline`)**
   View the active path as a structural map of checkpoints, summaries/compactions, branch points, user turns, and current position. Use it when orientation or compact target selection depends on history shape.

3. **⏪ Compact (`context_compact`)**
   Create a summarized continuation branch from an earlier checkpoint, history node, or `root`. The summary should restore the useful state after the target: current task, decisions, external side effects such as changed files or remote updates, validation state, source anchors, and the explicit next step.
