---
name: context-management
description: "Use this skill for multi-turn, phased, or noisy work: research/reading, debugging, plan-then-execute, retries/pivots, background or asynchronous work, handoffs, user decisions, task switching, repeated items, or repeated progress checks. It keeps the conversation as a clean working set with checkpoints, timeline review, and compaction at continuation boundaries. Always use when resuming after context compaction or when a long phase reaches a decision, handoff, validation, or task-switch boundary. Usually skip simple one-shot tasks."
---

# Context Management

Use this skill to keep the active conversation as a useful **working set** for the next step. Keep raw only the context that still needs direct reasoning; carry the rest as compact task state when that is more efficient.

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
- What important data has a reliable external source I can re-check instead of carrying raw?
- What history is useful only as a conclusion, pointer, or state update?
- What history is process noise or stale baggage?

Classify context into:

- **Raw context:** user intent, constraints, code/log/error details, evidence, or plan text you expect to inspect directly soon.
- **State summary:** decisions, findings, lessons, changed files, validation status, source pointers, rejected leads, and next steps that can replace raw process.
- **Discardable process:** repetitive searches, verbose logs, abandoned hypotheses, false starts, and unrelated turns whose useful value is already captured or gone.

If the active context is already small, coherent, and directly useful for the next step, do not manage it just to be tidy.

## When to use

Use this mode when the work may outgrow one clean thread:

- search, research, browser work, or reading many files/logs/pages/results
- investigate -> decide -> execute -> validate
- plan -> implement -> verify
- background or asynchronous work, handoffs, user decisions, or delayed results
- multiple approaches, retries, failed branches, comparisons, or pivots
- repeated similar cases, tickets, reviews, or batch items
- a main task that may be interrupted by side tasks
- repeated progress/status checks that indicate active state is hard to track
- scattered threads that need cleanup before continuing
- debugging, troubleshooting, refactoring, migration, or code-facing work that may get noisy

If one of these clearly applies, take a structural action now, usually a checkpoint. Do not merely describe the workflow. If the user has not provided enough task details, still checkpoint the workflow shape before asking clarifying questions.

Usually skip this skill for one-shot reads, bounded summaries, direct rewrites, simple lookups, deterministic scripts, short tasks that can stay clean, or moments where the active context is already a good working set.

## Start-of-turn check

At the start of each new user message, classify it:

- **Same task / next phase:** continue; if the previous phase is complete and noisy, compact before the next phase.
- **Correction or follow-up:** usually answer from recent context; do not compact yet.
- **New task or direction shift:** if the previous task left a complete noisy segment, inspect timeline when anchors are unclear, then compact to a continuation anchor that gives the new task a clean working set.

Think of the tools as a phase pipeline: checkpoint marks anchors, work happens, timeline shows structure, and compact creates a new branch from the chosen continuation anchor with a summary of what happened after it. The target is a working-set choice, not an age choice.

## Main loop

1. Before noisy work, create a semantic checkpoint as the first context-management action. If the first job is orientation over existing history, run `context_timeline` before adding a new checkpoint.
2. When the task shape is clear, read one matching scenario reference only if it will change tool timing, anchor choice, or summary content. Skip reference loading for obvious short applications where this main skill body is enough.
3. Add checkpoints at meaningful milestones: phase boundaries, risky attempts, reusable batch methods, and interruptions.
4. Use `context_timeline` when the active path structure affects the next decision or compact target.
5. At continuation boundaries, run the compact gate before starting another phase. If the whole requested task is complete and only the final response remains, answer and wait.
6. After a successful compact, continue from the injected summary instead of dragging the full raw path forward.

## Continuation boundaries

A continuation boundary is a point where the current phase has produced a stable result and the next action will use that result to start a different phase. It is not necessarily the end of the user's whole task.

Examples: investigation -> decision/plan/implementation, implementation -> validation, failed validation -> next approach, delayed result -> routing/action, user decision -> execution, rejected branch -> replacement direction, side request -> pause/summarize mainline before switching.

Do not ask only "is the whole task done?" Ask "will the next action start a new phase using the stable result of this phase?" If yes, this is often a compaction boundary.

Handoffs are not final answers: if a response transfers control to the user, another actor/process, later validation, or a queued phase, compact when the prior phase was noisy and the next action needs only stable state.

## Read the right reference

Read **one primary reference** only when the scenario pattern will affect tool timing, anchor choice, or summary content:

- search / research / reading-heavy work -> `references/search-research-and-reading.md`
- development / debugging / troubleshooting / refactoring / migration -> `references/development-and-troubleshooting.md`
- planning / staged execution / todo-driven work -> `references/planning-and-execution.md`
- repeated similar items / batch work -> `references/repeated-items-and-batch-work.md`
- task switching / pause-resume / interruptions / cleanup-and-continue -> `references/task-switching-and-cleanup.md`
- interleaved async work / overlapping fronts / background results / user decisions -> `references/interleaved-async-work.md`

Also read `references/retry-branch-and-pivot.md` when multiple approaches, failed branches, comparisons, retries, or pivots become central.

## Tool policy

### `context_checkpoint`

Use before noisy work, a new phase, a risky attempt, switching subtasks, or after a meaningful milestone. Use semantic names such as `<task>-start`, `<task>-<phase>`, `<task>-<attempt>`, or `<task>-<milestone>`. Avoid generic names like `start`, `checkpoint-1`, or `retry`.

### `context_timeline`

Use it as the structural view of the active path:

- when the current path shape affects the next decision
- when several checkpoints, branches, or task switches exist
- before choosing a non-obvious compact target
- when the thread feels cluttered and you need to distinguish useful context from baggage

When reading the timeline, ask which raw messages are still needed for the immediate next action, which paths are now baggage, and which anchor gives the smallest sufficient working set after summary injection.

### `context_compact`

Use it to replace raw history with a state summary when the next phase would benefit from a smaller working set.

Typical compact boundaries: investigation -> execution, diagnosis -> fix, implementation -> validation, failed attempt -> next attempt, representative item -> remaining batch, completed noisy task -> new user task.

Strong signals to consider compaction:

- repeated progress/status checks
- inability to summarize current state, next action, and open risks in one short paragraph
- rejected, abandoned, or superseded branches
- stable result after many tool calls or long output
- returned background/asynchronous/delegated result
- material plan or approach change
- side question arriving while stale process history is active

Do not compact while exploration is still active, when the result is unstable, just because the skill triggered, or just because the user-visible task ended.

## Compact gate

Before calling `context_compact`, require all three:

1. The segment being left behind is noisy, stale, failed, low-value in raw form, or actively reducing focus.
2. You can restore the useful task state in a clear summary.
3. There is an immediate continuation that benefits from cleaner context.

If the compact is prompted by a new user message, a direction shift, or several possible checkpoint targets, run `context_timeline` first and choose the target from visible structure rather than memory.

If the whole task is done and only the final answer remains, wait. Compact later only if the next user message makes it useful.

Checkpoint-only failure mode: a checkpoint is useful because it gives you a clean anchor to compact back to later. After any checkpointed phase produces a stable result, ask what the phase settled, whether the next step is different, and whether a summary can replace the raw trail. If yes, compact; do not keep accumulating raw history just because the overall task is still active.

## Choosing target and backup

Choose the continuation anchor by designing the next working set:

1. Name the immediate next action.
2. Decide what must remain raw: active user intent, current constraints, still-open evidence/code context, an approved plan being executed, or details you expect to inspect directly next.
3. Decide what can become state summary or disappear: completed searches, verbose logs, failed attempts, stale branches, earlier unrelated tasks, externally recoverable data, and clear process details.
4. Pick the anchor that leaves the new branch with the **smallest sufficient context** after summary injection.
5. If an older anchor plus a stronger summary is cleaner than a recent anchor plus stale context, prefer the older anchor. When completed fronts fill the middle of the thread, it can be correct to compact to a much older anchor or even `root` if the summary restores the active front and source pointers.

Avoid targets that are too late, too early with a weak summary, or semantically wrong. If there are several checkpoints, a task switch, or uncertainty about the best working set, run `context_timeline` first.

Use `backupCheckpoint` when raw history may still matter later. A backup is a recovery safety net, not a substitute for the summary.

## Compact summary contract

The summary is not a transcript recap. It is the state needed to resume work from the chosen anchor; older or cleaner anchors require stronger summaries.

Context tools change conversation state, not the outside world. Files, processes, browser state, tickets, databases, remote services, and other side effects stay current. If you compact to an anchor before those changes, the summary must bridge the gap between old conversation context and current external state.

A compact summary must restore:

1. **Task state:** current task, user intent, constraints, decisions, assumptions, and known result/progress/failure.
2. **External state:** changed files, created/deleted artifacts, running/stopped processes, browser actions, tickets/records, deployments, remote changes.
3. **Verification state:** commands already run, validation status, notable outputs, and remaining risks or open questions.
4. **Navigation state:** source anchors/evidence when needed, rejected leads worth avoiding, backup checkpoint guidance, and explicit next step.

If important data has a reliable external source, preserve the pointer and retrieval method rather than copying the raw data. Examples: file path and line/query, database table/query, task/job id, log path, URL, record id, branch/commit, or command to inspect status. Include raw values only when they are small, unstable, hard to retrieve, or needed for immediate reasoning.

For long-running work, shape the summary as a state capsule: goal, stable result, decisions, rejected paths, current artifacts/source pointers, active work, pending input, risks/open questions, and next action. Include why compacting is appropriate only when it helps future orientation. Avoid vague summaries like `Done`, `Investigated`, `Switching context`, or `Going back`.

Before compacting, quickly check: stable state? real continuation? smallest sufficient working set? summary restores state after the anchor? externally recoverable data represented by pointers? external side effects and validation captured? explicit next step?

## After compact

1. Read the injected summary carefully and treat it as the new active state.
2. Verify it contains enough state for the next action.
3. Remember that disk and external systems were not rolled back; inspect current files/tools/services when state matters.
4. If a missing detail is cheap to reconstruct from disk, tools, or source anchors, retrieve it directly.
5. Return to the backup checkpoint only when the missing raw context cannot be reconstructed cheaply.

## Common mistakes

Avoid:

- checkpointing constantly without phase meaning
- checkpointing early but never compacting after a stable phase result
- compacting blindly without timeline when anchor choice is unclear
- preserving too much raw history because older anchors or `root` feel risky
- using an old anchor or `root` with a weak summary
- compacting immediately after a final deliverable when no next user intent is known
- carrying completed noisy phases into a new task
- treating handoff or decision prompts as final answers when a continuation is expected
- writing summaries that recap history but fail to restore current task state
- assuming compact or branch navigation reverts files, processes, browser state, or remote services
- omitting decisions, constraints, external side effects, changed files, validation status, or next step
