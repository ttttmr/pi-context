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

- **Same task / next phase:** evaluate the compact gate; keep recent raw material when the next phase still needs it.
- **Correction, review, or feedback on recent work:** answer from the raw recent context; do not compact merely to respond. Questions about implementation choices, shortcuts, trade-offs, or known risks are exactly why the completed work should remain inspectable.
- **New task, explicit next step, or direction shift:** evaluate whether removing the completed noisy segment would help the now-known work after recovery costs. Inspect timeline when anchors are unclear; a new task alone does not require compaction.

Checkpoint marks anchors and timeline shows structure. When the compact gate passes, compact continues from the chosen continuation anchor with a summary of what happened after it. These are available choices, not a required pipeline. The target is a working-set choice, not an age choice.

## Main loop

1. Before noisy work, create a semantic checkpoint as the first context-management action. If the first job is orientation over existing history, run `context_timeline` before adding a new checkpoint.
2. When the task shape is clear, read one matching scenario reference only if it will change tool timing, anchor choice, or summary content. Skip reference loading for obvious short applications where this main skill body is enough.
3. Add checkpoints at meaningful milestones: phase boundaries, risky attempts, reusable batch methods, and interruptions.
4. Use `context_timeline` when the active path structure affects the next decision or compact target.
5. At continuation boundaries, run the compact gate before starting another known phase. If the whole requested task is complete, present the result and wait for feedback; delivery and a request for feedback are not themselves a continuation.
6. After a successful compact, continue from the injected summary instead of dragging the full raw path forward.

## Continuation boundaries

A continuation boundary is a point where the current phase has produced a stable result and the next action will use that result to start a different phase. It is not necessarily the end of the user's whole task.

Examples: investigation -> decision/plan/implementation, implementation -> validation, failed validation -> next approach, delayed result -> routing/action, received user decision -> execution, rejected branch -> replacement direction, side request -> pause/summarize mainline before switching.

A phase boundary is a chance to evaluate compaction, not a reason to compact. A stable conclusion does not make the code, tests, logs, or evidence supporting the next action obsolete. Diagnosis -> fix and implementation -> validation often share the same raw working set.

A response that presents completed work and asks the user for review, feedback, or a decision is **not** a continuation boundary: the next work is unknown, and the user may ask about details from the raw trail. Deliver the result and wait without compacting. Once feedback or an explicit next task arrives, decide whether the resulting known continuation benefits from compaction.

An actual handoff to a known next actor, process, validation, or queued phase can be a boundary when the next action is defined and needs only stable state. Do not treat a merely possible later user response as that kind of handoff.

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

Use before noisy work, a new phase, a risky attempt, switching subtasks, or after a meaningful milestone. Record actual task changes with a unique **`<scope>-<phase>`** name:

| Suffix | Agent-declared meaning |
| --- | --- |
| `-start` | Begin a task or phase with a concrete goal. Does not close earlier work. |
| `-done` | This scope has a stable result. Does not mean the whole user task is finished. |
| `-pivot` | Abandon or replace the current approach; not merely encounter an error. |
| `-pause` | Put work aside for feedback, a decision, an external result, or another task. |
| `-resume` | Return to paused work. |

Keep scope identical for related markers, such as `parser-investigation-start` and `parser-investigation-done`. Use a different scope for a different phase, such as `parser-validation-start`. Names must remain unique; use an attempt/cycle qualifier before the suffix when repeating work. Timeline shows the parsed phase next to the label but does not infer relationships between differently qualified names. Other names remain valid ordinary anchors.

Recognizing a meaningful new task, stable result, pivot, interruption, or resumption should lead to the corresponding checkpoint—not just a prose description. Do not mark every message or minor action. Avoid generic names like `start`, `checkpoint-1`, or `retry`.

### Interpreting phase markers

Phase markers are your own declarations, not a tracked state machine; timeline displays them verbatim. Use the sequence to reflect on what actually happened:

- **New task / `done → start`:** a known continuation may now benefit from summarizing the completed raw trail. Apply the compact gate before accumulating the next noisy phase.
- **Stable result / `done`:** check what was settled and what happens next. If the requested work is complete and you are awaiting feedback, deliver and wait; do not compact just because you marked it done.
- **Consecutive `start` markers:** distinguish a nested subtask, retry, task switch, or an omitted status marker. Do not assume the previous task is finished or abandoned. Mark a real pause/pivot if appropriate, not to repair an artificial state machine.
- **`pivot`:** identify the rejected approach, reusable evidence, lesson, and replacement direction. Compact only if these form stable state for a known continuation.
- **`pause → resume`:** restore the goal, constraints, and pending work; check whether intervening work is now baggage. Pausing for feedback itself is not a compact boundary.

Timeline intervals show historical content estimates, not exact active-model occupancy or reclaimable tokens. When orientation or target choice is unclear, inspect timeline. Choose the smallest sufficient working set, not automatically the most recent checkpoint. Preserve decisions, external effects, verification state, and the known next step in any compact summary.

### `context_timeline`

Use it as the structural view of the active path:

- when the current path shape affects the next decision
- when several checkpoints, branches, or task switches exist
- before choosing a non-obvious compact target
- when the thread feels cluttered and you need to distinguish useful context from baggage

When reading the timeline, ask which raw messages are still needed for the immediate next action, which paths are now baggage, and which anchor gives the most useful working set after summary injection and recovery.

### `context_compact`

Use it to replace raw history with a state summary when the next phase would benefit from a smaller working set.

Typical points to evaluate the compact gate: investigation -> execution, diagnosis -> fix, implementation -> validation, failed attempt -> next attempt, representative item -> remaining batch, completed noisy task -> a newly received user task. None requires compaction by its phase name alone.

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

Before calling `context_compact`, require all four:

1. The chosen target would actually replace a substantial low-value trail: noise, stale or rejected paths, or material actively reducing focus.
2. You can restore the useful task state in a clear summary without losing the raw details needed next.
3. There is an immediate, known continuation—not merely a possible user response or feedback request.
4. That continuation is expected to benefit **after** accounting for summary creation, likely re-reading or reconstruction, and information-loss risk. Optimize the next stretch of work, not just the size of the first post-compact request.

Keep this a brief judgment, not a token scorecard: what will I do next, which existing raw materials will it use, and what would this target remove? If the next actions will edit, review, test, or explain the same recently loaded material, usually keep it raw or defer. Externally recoverable does not mean cheap to recover. A short remaining task may not repay the transition cost; cached input can also make retaining useful context cheaper than rebuilding it.

Shared material is not an absolute veto: a small necessary raw excerpt can travel with the summary when removing a large cold trail still helps. Likewise, waiting for a reviewer is not a trigger by itself, but accumulated stale monitoring logs may justify cleanup during a long continuation. When the benefit is unclear and there is no clear context pressure, continue without compacting.

If the compact is prompted by a new user message, a direction shift, or several possible checkpoint targets, run `context_timeline` first and choose the target from visible structure rather than memory.

If the whole task is done, present the result and wait. Do not compact before or while asking for feedback, review, approval, or the user's next instruction. Compact later only after that message establishes a concrete continuation and cleanup is useful.

Checkpoint-only can be the correct outcome. Reconsider compaction when the working set changes or stale history starts interfering, not merely because a checkpointed phase finished. Conversely, do not carry a large obsolete trail indefinitely when a summary would make the known continuation more effective.

## Choosing target and backup

Choose the continuation anchor by designing the next working set:

1. Name the immediate next action.
2. Decide what must remain raw: active user intent, current constraints, still-open evidence/code context, an approved plan being executed, or details you expect to inspect directly next.
3. Decide what can become state summary or disappear: completed searches, verbose logs, failed attempts, stale branches, earlier unrelated tasks, externally recoverable data, and clear process details.
4. Inspect what lies **after** each candidate anchor: only that segment is replaced. A newly created checkpoint followed by a few useful reads may leave the old noise intact while discarding the exact material needed next.
5. Pick the anchor that gives the next stretch of work the **most useful working set after recovery**, not necessarily the smallest or newest one. An older anchor or `root` can help remove obsolete fronts, but only when restoring the active material is worthwhile. If no available cut preserves the needed raw context while removing enough noise, defer rather than copying whole files into a large summary.

Avoid targets that are too late, too early with a weak summary, or semantically wrong. If there are several checkpoints, a task switch, or uncertainty about the best working set, run `context_timeline` first. Checkpoints marked `compacted: not a compact target` are inside already-compacted history; choose a later anchor or `root`.

Use `backupCheckpoint` when raw history may still matter later. A backup is a recovery safety net, not a substitute for the summary.

## Compact summary contract

The summary is not a transcript recap. It is the state needed to resume work from the chosen anchor; older or cleaner anchors require stronger summaries.

Context tools change conversation state, not the outside world. Files, processes, browser state, tickets, databases, remote services, and other side effects stay current. If you compact to an anchor before those changes, the summary must bridge the gap between old conversation context and current external state.

A compact summary must restore:

1. **Task state:** current task, user intent, constraints, decisions, assumptions, known result/progress/failure, and—when relevant—deliberate shortcuts, temporary workarounds, trade-offs, known limitations, and questions still awaiting user feedback.
2. **External state:** changed files, created/deleted artifacts, running/stopped processes, browser actions, tickets/records, deployments, remote changes.
3. **Verification state:** commands already run, validation status, notable outputs, and remaining risks or open questions.
4. **Navigation state:** source anchors/evidence when needed, rejected leads worth avoiding, backup checkpoint guidance, and explicit next step.

If important data has a reliable external source, preserve the pointer and retrieval method rather than copying the raw data. Examples: file path and line/query, database table/query, task/job id, log path, URL, record id, branch/commit, or command to inspect status. Include raw values only when they are small, unstable, hard to retrieve, or needed for immediate reasoning.

For long-running work, shape the summary as a state capsule: goal, stable result, decisions, rejected paths, current artifacts/source pointers, active work, pending input, risks/open questions, and next action. Include why compacting is appropriate only when it helps future orientation. Avoid vague summaries like `Done`, `Investigated`, `Switching context`, or `Going back`.

Before compacting, quickly check: stable state? real continuation? worthwhile after recovery costs? target actually removes low-value history? needed raw material preserved? summary restores state after the anchor? external side effects and validation captured? explicit next step?

## After compact

1. Read the injected summary carefully and treat it as the new active state.
2. Verify it contains enough state for the next action.
3. Remember that disk and external systems were not rolled back; inspect current files/tools/services when state matters.
4. If a missing detail is cheap to reconstruct from disk, tools, or source anchors, retrieve it directly.
5. Return to the backup checkpoint only when the missing raw context cannot be reconstructed cheaply.

## Common mistakes

Avoid:

- checkpointing constantly without phase meaning
- treating checkpoint-only as a failure even while the raw context remains useful
- compacting blindly without timeline when anchor choice is unclear
- preserving obsolete raw history solely because older anchors or `root` feel risky
- discarding still-useful raw material merely because it can be reread from disk
- compacting to a fresh checkpoint that leaves the intended stale trail in its ancestors
- using an old anchor or `root` with a weak summary
- compacting merely to finish a deliverable or wait for user feedback, approval, or review, without a known continuation that benefits
- compacting immediately after a final deliverable when no next user intent is known
- carrying completed noisy phases into a long, low-overlap continuation when cleanup would help
- treating handoff or decision prompts as final answers when a continuation is expected
- writing summaries that recap history but fail to restore current task state
- assuming compact or branch navigation reverts files, processes, browser state, or remote services
- omitting decisions, constraints, external side effects, changed files, validation status, or next step
