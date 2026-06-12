---
name: context-management
description: Use this skill for work likely to span many turns, branches, retries, research, reading several files/webpages, plan-then-execute phases, repeated cases, debugging, or interrupted/messy threads. It guides agents to maintain a clean working set with checkpoints, timeline review, and compaction at useful continuation boundaries. Usually skip for one-shot reads, bounded summaries, direct rewrites, simple lookups, or deterministic scripts.
---

# Context Management

Use this skill to maintain the active conversation as a useful **working set** for the next step. The goal is not to archive more history or compress more aggressively; it is to keep raw only the context that still needs direct reasoning, and carry the rest as compact task state when that is more efficient.

Core rhythm:

- **checkpoint before mess**
- **review timeline when structure affects the next decision**
- **compact when a state summary is a better working set than the raw trail**

Use only these tools:

- `context_checkpoint`
- `context_timeline`
- `context_compact`

## Working-set model

Before choosing a tool, ask:

- What am I trying to do next?
- What facts, constraints, or artifacts must stay raw for that next action?
- What history is useful only as a conclusion or state update?
- What history is just process noise or stale baggage?

Classify context into three forms:

- **Raw context:** user intent, constraints, code/log/error details, evidence, or plan text that you expect to inspect directly soon.
- **State summary:** decisions, findings, lessons, changed files, validation status, rejected leads, and next steps that can replace raw process.
- **Discardable process:** repetitive searches, verbose logs, abandoned hypotheses, false starts, and unrelated turns whose useful value is already captured or no longer needed.

If the active context is already small, coherent, and directly useful for the next step, do not manage it just to be tidy.

## When to use

Use this mode when the user is asking for work that may outgrow one clean thread:

- search, research, browser work, or reading many files/logs/pages/results
- several links or low-density webpages where only conclusions and next actions should survive
- investigate -> decide -> execute -> validate
- plan -> implement -> verify
- multiple approaches, retries, failed branches, or pivots
- repeated similar cases, tickets, reviews, or batch items
- a main task that may be interrupted by side tasks
- a scattered thread that should be cleaned up before continuing from a clean point
- debugging, troubleshooting, refactoring, migration, or other code-facing work that may get noisy

If one of these clearly applies, take a structural action now, usually a checkpoint. Do not merely describe the workflow. If the user has not yet provided enough task details, still create a checkpoint for the workflow shape before asking clarifying questions, and name the detected mode briefly (search/reading, planning, repeated batch, task switching/cleanup, development retry).

Usually skip this skill for one-shot reads, bounded summaries, direct rewrites, simple fact lookup, conceptual explanation, deterministic scripts, short tasks that can stay clean, or moments where the active context is already a good working set.

## Start-of-turn check

At the start of each new user message, classify it:

- **Same task / next phase**: continue; if the previous phase is complete and noisy, compact before the next phase.
- **Correction or follow-up on the last answer**: usually answer from recent context; do not compact yet.
- **New unrelated task or direction shift**: if the previous task left a complete noisy segment, inspect the timeline first when multiple checkpoints or possible anchors exist, then compact to a continuation anchor that gives the new task a clean working set.

Think of the tools as a phase pipeline: `context_checkpoint` marks useful anchors, work happens, `context_timeline` shows the structure when orientation or target choice is unclear, and `context_compact` creates a new branch from the chosen continuation anchor with a summary of what happened after it. The target is a working-set choice, not an age choice: keep raw context only when it will help the next action; summarize or drop raw process when it would distract.

This prevents both premature cleanup after final answers and endless checkpoint-only behavior that lets stale work accumulate.

## Main loop

1. Before noisy work, create a semantic checkpoint as the first context-management action, even if the next visible step is asking for missing inputs. If the first job is orientation over existing history, run `context_timeline` before adding a new checkpoint.
2. When the task shape is clear, read one matching scenario reference only if it will change tool timing, anchor choice, or summary content. Skip reference loading for obvious short applications where this main skill body is enough. Do not stop after checkpoint-only unless the prompt is intentionally lightweight.
3. Add checkpoints at meaningful milestones: phase boundaries, risky attempts, reusable batch methods, and interruptions.
4. Use `context_timeline` when the active path structure affects the next decision or compact target.
5. At phase boundaries, run the compact gate before starting another phase. If the whole requested task is complete and only the final response remains, answer and wait; let the next user message determine whether cleanup is useful.
6. After a successful compact, continue from the injected summary instead of dragging the full raw path forward.

## Read the right reference

Read **one primary reference** based on task shape when the scenario pattern will affect tool timing, anchor choice, or summary content:

- search / research / reading-heavy work, especially web search, browser operation, or low-density webpages -> `references/search-research-and-reading.md`
- development / debugging / troubleshooting / refactoring / migration -> `references/development-and-troubleshooting.md`
- planning / staged execution / todo-driven work -> `references/planning-and-execution.md`
- repeated similar items / batch work -> `references/repeated-items-and-batch-work.md`
- task switching / pause-resume / interruptions to a mainline task / scattered-thread cleanup-and-continue -> `references/task-switching-and-cleanup.md`

Also read `references/retry-branch-and-pivot.md` when multiple approaches, failed branches, comparisons, retries, or pivots become central. For code/debugging work with repeated attempts, use both `references/development-and-troubleshooting.md` and `references/retry-branch-and-pivot.md`.

## Tool policy

### `context_checkpoint`

Default move. Use it before noisy work, a new phase, a risky attempt, switching subtasks, or after a meaningful milestone.

Use semantic names so the timeline stays readable:

- `<task>-start`
- `<task>-<phase>`
- `<task>-<attempt>`
- `<task>-<milestone>`

Examples: `auth-oauth-start`, `timeout-analysis-search`, `db-migration-plan`, `parser-fix-attempt-2`.

Avoid generic names like `start`, `checkpoint-1`, `phase-1`, or `retry`.

### `context_timeline`

Use it as the structural view of the active path, not only as a rescue tool:

- when the current path shape affects the next decision
- when several checkpoints, branches, or task switches exist
- before choosing a compact target that is not obvious
- when the thread feels cluttered and you need to distinguish useful context from baggage

When reading the timeline, ask:

- What is the current task and immediate next action?
- Which prior raw messages are still needed for that next action?
- Which completed, failed, or unrelated paths are now baggage?
- Which anchor gives the smallest sufficient working set after summary injection?

### `context_compact`

Use it to replace raw history with a state summary when the next phase would benefit from a smaller working set.

Typical compact boundaries: investigation -> execution, diagnosis -> fix, implementation -> validation, failed attempt -> next attempt, representative item -> remaining batch, completed noisy task -> new user task.

Do not compact while exploration is still active, when the result is unstable, just because the skill triggered, or just because the user-visible task ended.

## Compact gate

Before calling `context_compact`, require all three:

1. The segment being left behind is noisy, stale, failed, low-value in raw form, or actively reducing focus.
2. You can restore the useful task state in a clear summary.
3. There is an immediate continuation that benefits from cleaner context.

If the compact is prompted by a new user message, a direction shift, or several possible checkpoint targets, run `context_timeline` first and choose the target from the visible structure rather than from memory.

Condition 3 means the next action is a new phase, not just more of the same exploration. Examples: run the export, implement the fix, validate, process the next item, or try the chosen next approach.

If conditions 1 and 2 are true but the whole task is done and only the final answer remains, wait. Compact later only if the next user message makes it useful.

## Choosing target and backup

Choose the continuation anchor by designing the next working set:

1. Name the immediate next action.
2. Decide what must remain raw: active user intent, current constraints, still-open evidence or code context, an approved plan being executed, or details you expect to inspect directly next.
3. Decide what can become state summary or disappear: completed searches, verbose logs, failed attempts, stale branches, earlier unrelated tasks, and process details whose useful value is already clear.
4. Pick the anchor that leaves the new branch with the **smallest sufficient context** after summary injection.
5. If an older anchor plus a stronger summary is cleaner than a recent anchor plus stale context, prefer the older anchor.

The right target may be a recent phase-start, a plan-ready checkpoint, a pre-branch checkpoint, a repeated-work baseline, an older checkpoint, or `root`. `root` is appropriate when the old path no longer contributes raw context and the summary can carry the necessary state.

Avoid targets that create a poor working set:

- too late: the new branch still contains the clutter, failed path, or unrelated task you meant to leave behind
- too early with a weak summary: the next phase loses constraints, decisions, evidence, or changed-file state it needs
- semantically wrong: the anchor preserves a context frame that no longer matches the current task

For bounded phases, choose by what should remain raw:

- target `research-start` to summarize the whole research segment
- target `research-end` to keep research raw and summarize only later clutter before follow-up research

If there are several checkpoints, a task switch, or any uncertainty about the best working set, run `context_timeline` first.

Use `backupCheckpoint` when the raw path may still matter later: long investigations, abandoned branches, risky compactions, or details that may be needed for recovery. A backup checkpoint is a recovery safety net, not a substitute for the summary; include details likely needed in the next phase because returning to backup is costly.

## Compact summary contract

The summary is not a transcript recap. It is the state needed to resume work from the chosen anchor; older or cleaner anchors require stronger summaries.

Context tools change conversation state, not the outside world. Files, processes, browser state, tickets, databases, remote services, and other side effects stay current. If you compact to an anchor before those changes, the summary must bridge the gap between old conversation context and current external state.

A compact summary must restore:

1. **Task state:** current task, user intent, constraints, decisions, assumptions, and known result/progress/failure.
2. **External state:** changed files, created/deleted artifacts, running/stopped processes, browser actions, tickets/records, deployments, remote changes.
3. **Verification state:** commands already run, validation status, notable outputs, and remaining risks or open questions.
4. **Navigation state:** source anchors/evidence when needed, rejected leads worth avoiding, backup checkpoint guidance, and the explicit next step.

Include why compacting is appropriate only when it helps future orientation. Avoid vague summaries like `Done`, `Investigated`, `Switching context`, or `Going back`.

Good examples:

- `Current task: plan mitigation for API timeouts. State: DB pool exhaustion is the likely root cause. Evidence: logs show pool wait timeouts during peak traffic; config has pool size 10; no network errors found. Rejected lead: API gateway timeout appears downstream of DB waits. Next step: propose mitigation and validation steps.`
- `Current task: validate the parser fix. State: implementation is done. External state: changed files src/parser.ts and test/parser.test.ts. Validation not yet run after the final edit. Next step: run targeted parser tests and summarize remaining edge cases. Backup: parser-fix-debug-history if exact failed attempts are needed.`

Before compacting, quickly check: stable state? real continuation? anchor gives the smallest sufficient working set? summary restores state after that anchor? external side effects and validation captured? explicit next step?

## After compact

1. Read the injected summary carefully.
2. Treat it as the new active state.
3. Before continuing, verify it contains enough state for the next action.
4. Remember that disk and external systems were not rolled back by the context move; if state matters, inspect the current files/tools/services rather than trusting the historical anchor.
5. If a missing detail is cheap to reconstruct from disk, tools, or source anchors, retrieve it directly.
6. Return to the backup checkpoint only when the missing raw context cannot be reconstructed cheaply.

## Common mistakes

Avoid:

- checkpointing constantly without phase meaning
- compacting blindly without timeline when anchor choice is unclear
- preserving too much raw history because older anchors or `root` feel risky
- using an old anchor or `root` with a weak summary that drops current task state
- compacting immediately after a final deliverable when no next user intent is known
- carrying completed noisy phases into a new task
- writing summaries that recap history but fail to restore current task state
- assuming compact or branch navigation reverts files, processes, browser state, or remote services
- omitting decisions, constraints, external side effects, changed files, validation status, or next step
