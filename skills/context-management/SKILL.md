---
name: context-management
description: Strategies for efficient context management using context_self_manage, context_log, context_tag, and context_checkout. Learn when to assess health, tag, visualize the graph, and safely squash history. Use for complex refactoring, debugging, and long conversations.
---

# Context Management

**CRITICAL: THIS SKILL MANAGES YOUR MEMORY. WITHOUT IT, YOU WILL FORGET.**

Your context window is limited. As conversations grow, "pollution" (noise, failed attempts) degrades your reasoning.

**YOU MUST PROACTIVELY MANAGE YOUR HISTORY.**
Do not wait for the user to tell you.

## The Core Philosophy: Build, Perceive, Navigate

```
Context Window = RAM (Expensive, volatile, limited)
Context Graph  = Disk (Cheap, persistent, unlimited)

→ Move finished tasks from RAM to the Graph.
```

Manage your context window like a Git repository. You are the maintainer.

1.  **BUILD the Skeleton (`context_tag`)**:
    *   Raw conversation is a flat list. **Tags create structure.**
    *   Without tags, `context_log` is just a list of IDs. With tags, it is a **Map**.
2.  **PERCEIVE the State (`context_log`)**:
    *   Check the HUD: Is "Segment Size" too big? You are drifting.
    *   Check the Graph: Where are you? Are you in a deep branch?
3.  **NAVIGATE & MERGE (`context_checkout`)**:
    *   **Squash:** Convert a messy "feature branch" (thinking process) into a single "merge commit" (summary).
    *   **Jump:** Move between tasks or retry paths without carrying baggage.

## Quick Start: The Loop

Follow this cycle for every major task:

1.  **CHECK:** Verify state.
    `context_self_manage({})`
2.  **START:** Tag the beginning.
    `context_tag({ name: "task-start" })`
3.  **WORK:** Execute steps.
4.  **MILESTONE:** Tag intermediate stable states (e.g., "Plan done", "Part 1 done").
    `context_tag({ name: "task-plan-done" })`
5.  **SQUASH (Autonomous):** If history becomes noisy or low-density, **Squash with Backup**.
    *   *Action:* `context_checkout({ target: "task-start", message: "Summarized debugging steps...", backupTag: "pre-squash-backup" })`
    *   *Action (Optional):* `context_tag({ name: "clean-state" })`
    *   *Safety:* If you need the details later, you can checkout `pre-squash-backup`.

## Tool Reference

| Tool | Analog | Purpose | When to Use |
| :--- | :--- | :--- | :--- |
| `context_self_manage` | `git status` | Assess context health and recommend/apply next maintenance action. | At task start, after noisy work, when context may be drifting. |
| `context_tag` | `git tag` | Bookmark a stable state. | Before risky changes. Before starting a new task. |
| `context_log` | `git log` | See where you are. | When you feel lost. To find IDs for checkout. |
| `context_checkout`| `git reset --soft` | **Time Travel / Squash.** | To undo mistakes. To compress history. |

## Critical Rules

### Tag Wisely (Build The Skeleton)
Tags are the "Table of Contents". Use them to mark **Start** and **Backups**.
*   **Start:** `task-start`
*   **Backup:** `task-raw-history` (Created automatically by `backupTag`)
*   **Milestone:** `phase-1-done`


### Squash Noise, Keep Signal, Focus on Goal (Context Hygiene)
Think of your conversation as a "Feature Branch" full of messy thoughts.
**You must distinguish Signal from Noise.**

*   **Signal (High Value):** Design decisions, user constraints, final working code. -> **KEEP.**
*   **Noise (Low Value):** Failed attempts, long tool outputs, "thinking" steps. -> **SQUASH.**
*   **Focus on Goal:** Ask yourself: "Does this message help me achieve the current goal?" -> **KEEP.**

**When to Squash:**
1.  **Task Done:** Convert the messy process into one clean summary.
2.  **Low Density:** You read 2000 lines but only found 1 error.

**Safety:** Squashing is **LOSSLESS**.
By using `backupTag`, you save the "Messy Branch" forever. You can always checkout the backup tag if the summary isn't enough.
*   **Main Trunk:** Jump back to the summary.
*   **Backup Tag:** Jump back to the raw details.

### Fail Fast, Revert Faster
If you fail 3 times:
1.  **STOP.** Don't try a 4th time.
2.  `context_checkout` back to the last safe tag.
3.  Summarize the failure in the checkout message ("Tried X, failed because Y").
4.  Try a new approach from the clean state.

## Decision Matrix: When to Act

| Situation | Action | Reason |
| :--- | :--- | :--- |
| **Starting Task** | `context_tag({ name: "task-X-start" })` | Create a rollback point. |
| **Research / Logs** | `context_checkout` (Squash) | **Process is Noise.** Read 2000 lines -> Keep result. |
| **Messy Debugging** | **Squash w/ Backup** | **Cleanup.** The error logs are noise once fixed. |
| **Task Done (Candidate)**| **Squash w/ Backup** | **Assume Success.** Summary is usually enough. Backup exists if not. |
| **Goal Shift** | `context_checkout` (Squash) | Old context is irrelevant. |
| **Drift (some steps w/o tag)** | **Tag (Milestone)** | Maintain the skeleton. Don't fly blind. |

## The "Context Health" Check

If you cannot answer these, run `context_self_manage({})` and then `context_log` if needed:

| Question | Answer Source |
| :--- | :--- |
| **Where is the skeleton?** | The sequence of `tag`s in the log. |
| **Is this history useful?** | If "No" -> **SQUASH IT.** |
| **Am I in a loop?** | Repeated entries in the graph. |


## Good Checkout Messages

The `message` is your lifeline to your past self.
A good message preserves critical context that would otherwise be lost.

Structure: `[Status] + [Reason] + [Carryover Data] + [Important Changes]`

*   **Status**: What did you just finish or stop doing?
*   **Reason**: Why are you branching/moving? (e.g., "Too much noise", "Task complete", "Failed attempt")
*   **Carryover**: What specific details (e.g., IDs, file paths, user constraints) must be remembered?
*   **Important Changes**: What files or logic have been modified? (This checkout only resets *conversation history*, NOT disk files, so you must remember what changed.)

Examples:

*   *Good (Resetting after failure)*: "Abandoning the recursive approach (infinite loop). Switching back to iterative. **Important Changes**: Modified `utils/recursion.ts`. **Carryover**: The test case `test_retry_logic` is the one failing."
*   *Good (Cleaning up)*: "Completed authentication module. All tests passed. **Important Changes**: Created `auth/` directory and updated `routes.ts`. **Carryover**: The user ID is stored in `localStorage` under `auth_token`. Moving to Dashboard UI."
*   *Bad*: "Switching context." (Too vague - you will forget why)
*   *Bad*: "Done." (What is done? What did we learn?)

## Anti-Patterns

| Don't | Do Instead |
| :--- | :--- |
| **Blind Tagging** (Tagging without looking) | **Check** (`context_log`) to avoid duplicates or tagging noise. |
| **Over-Tagging** (Tagging every step) | **Tag** only major phase changes (`start`, `milestone`). |
| **Hoard** (Keep all history "just in case") | **Squash** low-density history (research, logs). |
| **Panic** (Apologize repeatedly for errors) | **Revert** (`context_checkout`) to before the error. |
| **Blind Checkout** (Guessing IDs) | **Look** (`context_log`) first to get valid IDs. |
| **Vague Summaries** ("Done", "Fixed") | **Detailed Summaries** ("Found bug in line 40. Fixed with patch X.") |

## Recipes (Copy-Paste)

### 0. The "Self-Manager" (Default Check)
**Goal:** Let the agent quickly decide what to do next.

```javascript
// Assess only
context_self_manage({})

// Auto-apply action when needed
context_self_manage({
  autoApply: true,
  carryoverMessage: "Completed noisy exploration; keeping only decisions and next actions.",
  backupTag: "pre-auto-squash"
})
```

### 1. The "Miner" (Immediate Squash)
**Goal:** Pure information gathering (Reading files, Searching web).
**Why:** The *process* of searching is irrelevant. Only the *result* matters.

```javascript
// 1. Tag BEFORE starting the noisy work
context_tag({ name: "pre-research" });

// ... (Read 5 files, search 3 sites, find 1 key fact) ...

// 2. Squash IMMEDIATELY. Do not wait for user.
context_checkout({
  target: "pre-research",
  message: "Researched logs. Found root cause: DB timeout. Irrelevant logs discarded.",
  backupTag: "raw-research-logs" // Safety backup
});
context_tag({ name: "research-done" });
```

### 2. The "Candidate" (Wait for Confirmation)
**Goal:** You finished a complex task.
**Why:** The history is noisy. The result is clean.
**Safety:** We create a backup tag automatically.

```javascript
// Squash to Summary (Optimistic Cleanup)
context_checkout({
  target: "feature-a-start", // Squash range: Start -> Now
  message: "Feature A implemented. 5 files changed. Tests passed. Revert to 'feature-a-raw-history' for full logs.",
  backupTag: "feature-a-raw-history"
});
context_tag({ name: "feature-a-candidate" });
```

### 3. The "Undo" (Revert Squash)
**Goal:** User asks about a detail you squashed away.
**Action:** Jump back to the backup tag.

```javascript
// Jump back to the raw history
context_checkout({
  target: "feature-a-raw-history",
  message: "Reverting to raw history to check specific error logs."
});
context_tag({ name: "restored-history" });
```

### 4. Branching (Alternative Approach)
**Scenario:** Method A failed (and was squashed). You want to try Method B from the clean state.
**Action:** Checkout the start point.

```javascript
// Jump back to start
context_checkout({
  target: "task-start", 
  message: "Method A failed (see summary in 'method-a-fail'). Starting Method B from clean state."
});
context_tag({ name: "method-b-start" });
```

### 5. The "Undo" (Failed Attempt)
You tried to fix a bug but broke everything.
**Goal:** Clean up a failed path.

```javascript
// Jump back to safety.
context_checkout({
  target: "pre-debug-tag",
  message: "Attempted fix using Method A failed. Error: 'Timeout'.",
  backupTag: "failed-attempt-1" // Save the failure just in case
});
context_tag({ name: "debug-retry" });
```
