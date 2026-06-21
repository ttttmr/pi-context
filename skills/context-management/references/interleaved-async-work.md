# Interleaved Async Work

Use this reference when the hard part is **not** the external worker itself, but the current agent carrying several overlapping lines of work in one conversation.

Common examples:

- a main task continues while background jobs, subagents, reviewers, or tools may return later
- the user asks side questions while another front is still active
- progress updates, returned results, decisions, and new work are interleaved in the same thread
- several pending fronts have different next actions, and raw history starts making the current state hard to see

This is context management for the current agent. It is not a subagent-management policy. The goal is to keep the current working set clear enough to answer: **what am I doing now, what is parked, what just returned, and what raw context is still needed?**

## Mental model: fronts

Treat each overlapping line of work as a **front**.

A front may be:

- the current user-facing task
- a paused mainline task
- a background command or long-running job
- a subagent/reviewer/collaborator result that may return later
- a pending user decision
- a side request that should be answered before resuming the mainline

For each front, keep only one of these in the active working set:

- **Active raw front:** the thing you are reasoning about right now; keep necessary raw details.
- **Parked state capsule:** a paused or waiting front summarized by goal, current state, source pointers, next action, and blockers.
- **Stale process:** old logs, retries, status chatter, and abandoned paths whose lesson has already been captured.

The mistake to avoid is carrying every front raw at once.

## Working pattern

1. Identify the active front before each substantial reply or tool call.
2. If another front is still pending, keep it as a small state capsule rather than raw history.
3. When a result returns, capture it into the relevant front before responding.
4. If the returned result does not become the active front immediately, park it as state and preserve the user's current focus.
5. Before switching fronts, compact if the old front's raw process is now stale and the next front can continue from a summary.
6. If several fronts are tangled, run `context_timeline` to find the clean anchor and separate active, parked, completed, and stale paths.

## What to record per parked front

Use a short capsule:

- Front: short name for this line of work
- Goal: what this front is trying to accomplish
- State: waiting / running / returned / blocked / ready for next phase
- Latest stable result: what is known now
- Source pointers: files, links, task ids, log paths, branches, records, queries, or commands that identify where to re-check details
- Decisions and constraints: choices already made that still matter
- Rejected paths: approaches that should not be repeated
- Pending input or trigger: what would make this front active again
- Next action: what to do when resuming this front

This capsule is for future-you, not for the external worker. It should be enough to resume without rereading the interleaved raw thread.

If a front's detailed state is available from a reliable external source, keep the pointer, not the dump. For example, store the task id plus the command/log path to inspect it, not pages of status output; store the database query or record id, not every row; store the file path and relevant section, not the whole file. Copy raw details only when they are small, volatile, hard to retrieve, or needed for immediate reasoning.

## When to compact

Compact when interleaving has made raw context a worse working set:

- you are switching from one front to another after a noisy phase
- a side request arrives while the mainline is noisy but resumable from a capsule
- a background/subagent/reviewer/tool result returned and its raw logs are no longer needed
- the user has asked for status more than once and you cannot state all active fronts briefly
- a front was rejected, superseded, completed, or parked indefinitely
- the next action belongs to a different front than the recent raw history
- the active front started much earlier, and the middle of the thread is mostly completed or unrelated fronts

Do **not** compact just because async work exists. Compact when a front can safely be represented as state while another front becomes active.

## Choosing how far back to compact

Interleaved work often makes recent anchors poor targets: they may preserve the completed fronts that happened after the active front was launched. Be willing to compact aggressively when the summary can restore state.

A compact to an old anchor or even `root` is appropriate when:

- the active front can be described by a concise capsule
- completed fronts between the anchor and now no longer need raw context
- important details are recoverable from reliable source pointers
- the next action does not require inspecting the interleaved raw discussion
- you can name what remains active, what is parked, and what is done

Use a backup checkpoint for safety when the interleaved raw path may still matter, but do not keep it active just because it is long.

Before a deep compact, ask:

```text
Active now: which front am I resuming?
Parked: which fronts still wait for input/result?
Done: which fronts can be summarized or omitted?
Pointers: where can I re-check authoritative details?
Next: what is the immediate action after compacting?
```

## Handling returned results

When a delayed result appears in the middle of another thread:

1. **Capture:** identify which front it belongs to and summarize its result.
2. **Classify:** progress, stable completion, failure, decision needed, or noise.
3. **Choose focus:** decide whether this result should interrupt the current active front. If not, park it.
4. **Compact if needed:** if switching to it or away from it would drag stale logs/retries forward, compact first.
5. **Continue:** resume the chosen active front from a clean working set.

## Example capsules

```text
Front: import-test-flake
Goal: fix flaky import tests.
State: reviewer returned findings.
Latest stable result: fixed sleeps were rejected; signed retry strategy is still viable.
Source pointers: branch retry-import-tests, log tmp/import-flake.log.
Pending input or trigger: decide whether to implement bounded retries.
Next action: if accepted, implement bounded retry and rerun targeted tests.
```

```text
Front: docs-build
Goal: validate generated documentation before publishing.
State: background build running.
Latest stable result: source edits complete; validation not yet known.
Source pointers: task docs-build, output dist/docs/.
Pending input or trigger: build exit status.
Next action: on success, summarize validation; on failure, inspect first build/link error.
```

## Common mistakes

Avoid:

- treating async/subagent management as the goal instead of keeping the current agent's working set clear
- carrying several fronts raw at once
- copying externally recoverable status dumps instead of preserving reliable source pointers
- letting a returned result overwrite the user's current active request without deciding focus
- reporting status repeatedly while the real problem is that fronts are not summarized
- compacting away a front without preserving how to resume it
- avoiding a deep compact even though source pointers and capsules can restore the active state
- resuming from memory when a small front capsule would be safer
