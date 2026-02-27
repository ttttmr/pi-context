# Pi Context Extension

A Git-like context management tool that allows AI agents to proactively manage their context.

Inspired by kimi-cli d-mail, implementing lossless time travel on the Pi session tree.

For the design philosophy, see the [blog post](https://blog.xlab.app/p/51d26495/)
 ([中文版本](https://blog.xlab.app/p/6a966aeb/)).

## Installation

```bash
pi install npm:pi-context
```

## Usage

### For Humans

Load the skill to enable the workflow:

```bash
/skill:context-management
```

View detailed context window usage and token distribution with a visual dashboard. (like `claude code /context`)

```bash
/context
```

![](img/context.png)

### For Agents

This extension adds the `context-management` skill with four core tools:

1.  **🧭 Self Manage (`context_self_manage`)**
Automatically assess context health and recommend (or auto-apply) tagging/squashing actions.

2.  **🔖 Structure (`context_tag`)**
`git tag` Create named milestones to structure your conversation history.

3.  **📊 Monitor (`context_log`)**
`git log` Visualize your conversation history, check token usage, and see where you are in the task tree.

4.  **⏪ Compress (`context_checkout`)**
`git checkout` Move the HEAD pointer to any tag or commit ID. Compress completed tasks into a summary to free up context window space.

### Self Manage Quick Examples

```javascript
// Evaluate health and get recommendation only
context_self_manage({})

// Auto-tag when drift is detected
context_self_manage({
  autoApply: true,
  tagName: "phase-1-milestone"
})

// Auto-squash with required carryover summary
context_self_manage({
  autoApply: true,
  carryoverMessage: "Completed noisy debugging, root cause identified in auth retry flow.",
  backupTag: "debug-raw-history"
})
```
