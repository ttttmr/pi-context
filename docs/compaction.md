# Compaction design

How `context_compact` works, why it works this way, and what to keep in mind when changing it. Requires Pi >= 1.2.0. User-facing behavior is in the [README](../README.md); the agent-facing contract is the [skill](../skills/context-management/SKILL.md).

## Model

Compaction folds the history after a target into a handoff summary, **inside the agent run, at the end of the step that requested it**:

- Folded entries are hidden from the model with `context_edit` omissions (`replacement: null`). Raw history is never deleted or rewritten; it stays in the session file, the transcript, and exports.
- One `custom_message` of type `pi-context-compaction` carries the summary and the outputs of other tool calls in the same step. It is model-visible and shown in the transcript (rendered as "Context compacted").
- Compaction never branches, navigates, aborts, or starts a new run. The active path only grows.

After compaction the next request sees:

```
[system] [target and everything before it] [summary + same-step outputs] [queued input]
```

## Timeline of one compaction

```
assistant message: [bash(...), context_compact(target, summary)]
│
├─ context_compact.execute        records a request, changes nothing
│    · find the requesting assistant message (nested calls: <parent id>/<n>)
│    · a second request in the same step → mark invalid, throw
│    · validate target (see "Target rules"), store the pending request
│
├─ other tool calls finish; a codemode script keeps running after compact
│
├─ turn_end                        all results of the step are persisted,
│    · cancel?  wrong step | invalidated | ctx.signal.aborted
│      → append a hidden `pi-context` notice, fold nothing
│    · plan: context_edit for every editable, model-visible entry after the
│      target (context order), summary message with retained outputs,
│      optional backup label → return { entries, continue: true }
│
├─ Pi commits the entries; steering is drained after the summary
└─ next request is rebuilt from the session projection
```

`agent_end` is only a safety net: a request that never reached its `turn_end` is dropped with a `nextTurn` notice.

## Why `turn_end`

Pi's actionable `turn_end` boundary (Pi >= 0.87) runs after every tool result of the step is persisted and **before** steering is drained or the next request is built. Handlers can return `custom_message` / `context_edit` drafts and `continue: true`. That makes the step complete and closed:

- No sibling result can arrive later, so nothing needs to be verified after the fact.
- User input sent meanwhile is queued and lands after the summary instead of racing it.
- Pi rebuilds every request from `buildSessionProjection()`, so the edits take effect on the next request without touching agent state.

Folding cannot happen in `execute()`: sibling calls may still be running, and hiding the request message before their results land would orphan them.

## Target rules

Validated in `execute()` and re-checked when planning:

1. The target exists (`was not found` otherwise — models do invent targets such as `current`).
2. It is on the active path, strictly before the requesting assistant message.
3. It is in the current model context:
   - **folded by an earlier compaction** → rejected. Folding after it would also hide the summary that covers it.
   - **before Pi's native compaction kept range** → rejected. Pi's summary already replaced it and cannot be omitted, so "keep everything up to the target" is impossible. A later checkpoint or `root` works.
4. `root` means the start of the current context. After a native compaction, Pi's summary stays visible.

The fold range uses **context order** (the projection), not raw path order: after a native compaction the summary leads the context while its raw entry sits later in the path.

Timeline marks both kinds of unusable targets the same way (`compacted: not a compact target`; root is never marked) so agents can avoid them up front. Error messages also use one wording ("inside history that was already compacted") for both, because the remedy is the same.

## Wording for users and models

The in-run design changed the implementation, not how the tools are used. Model- and user-facing text (tool and parameter descriptions, results, notices, the summary message, README, skill) keeps the 2.3 wording; it was only corrected where it described branching, and extended for genuinely new behavior (the "already compacted" target marker and errors). Do not rewrite it around a particular use case or the new mechanics.

Implementation terms stay in code comments, this document, and AGENTS.md: step, turn_end, boundary, fold, omit, `context_edit`, projection, active path, native compaction. When adding text, decide which audience reads it first.

## What gets folded and kept

| Entry | Handling |
|---|---|
| Editable model-visible entries after the target (user, assistant, toolResult, custom_message) | Omitted with `context_edit` |
| The requesting message and its results | Omitted together, so calls and results stay paired |
| Results answering calls of the last assistant message at or before the target | Kept, otherwise the target's tool calls would be orphaned |
| System loadout, user `!` bash output, branch summaries, native compaction | Kept: Pi cannot omit them, and they carry required state |
| Custom state (`codemode-store`, labels, other extensions' entries) | Untouched; it stays on the path, so no merging is needed |
| Same-step tool outputs | Copied into the summary message, labeled with tool name and arguments (codemode: output only, not script source), including errors |
| Same-step context tool output (`context_*`, or a script whose recorded calls were all context tools) | Not kept: it describes pre-fold state |

Never duplicate billable assistant or tool-result messages; copied output lives only in the custom message.

## Cancellation

Only these cancel, and each appends a hidden `pi-context` notice and folds nothing:

- More than one compact request in one step (all are cancelled, even if the script catches the error).
- The step was interrupted. An interrupted tool step still reports a completed assistant message, so check `ctx.signal?.aborted`, not only `event.outcome`.
- The target left the model context by the boundary.

Not cancel reasons: queued user input (delivered after the summary), a script that throws after compact (partial output and the error are kept, because executed calls are not undone), additional nested tool or model calls.

## Rejected approaches

- **Abort → wait for idle → branch with `navigateTree` → restart** (pi-context <= 2.3). `navigateTree` is not allowed while streaming, so the run had to stop. The window between the abort and navigation needed an "advancement gate": a growing allow-list of safe entries that cancelled on sibling outputs, unknown entry types, and queued input. The in-run design removes that window entirely.
- **Treating a native-compacted target as `root`.** It would always succeed, but silently changes what the agent asked for. Rejecting with a clear message was preferred.
- **Cancelling when a script throws after compact.** Executed calls cannot be undone, so keeping the output is more accurate than discarding the fold.

## Known limitations

- The transcript does not jump: folded history stays visible to the user, only the model no longer sees it.
- User `!` bash output and branch summaries inside the folded range stay in context.
- Each compaction appends one `context_edit` per folded visible entry, so the session file grows.
- An unawaited `context_compact` in a script happens to work (registration is synchronous) but is not a supported pattern.

## Compatibility

- Sessions from pi-context <= 2.3 contain `branch_summary` entries and `pi-context-codemode-output` messages. Timeline, `/context`, and the session analyzer still recognize them.
- `/acm` remains as a no-op compatibility command (`/acm <task>` still submits the task).
- The session analyzer confirms new compactions through the summary message's `details.requestEntryId` and the `context_edit` entries before it.

## Code map

| Concern | Location |
|---|---|
| Request lookup, target resolution | `findCompactRequest`, `resolveTargetId` in `src/index.ts` |
| Target in context / folded checks | `locateContextTarget`, `isFoldedEntry` |
| Fold plan and summary content | `planCompaction`, `isManagementResult` |
| Validation and pending request | `context_compact` `execute()` |
| Boundary, cancellation, backup label | `turn_end` handler |
| Summary rendering | `registerMessageRenderer(CompactionSummaryType, …)` |
| Timeline markers | `context_timeline` (`foldedIds`, `summarizedIds`) |
| Editable-entry rule, task message types | `isEditableContextEntry`, `CompactionSummaryType` in `src/utils.ts` |

## Testing changes

- `test/compaction.test.mjs` drives a real `AgentSession` with Pi's faux provider and asserts the provider-visible request. Add a case here first; it is fast and deterministic.
- `npm run test:scenarios` runs the real-model matrix (direct and parallel calls, codemode `on` / `only` script forms, cancellation, steering, native compaction). Run it after changing the boundary, fold range, or target rules. See [test/test.md](../test/test.md).
- `npm run test:live` covers repeated compaction, resume from a saved session, and late input.
