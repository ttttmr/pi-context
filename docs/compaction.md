# Compaction design

How `context_compact` works, why it works this way, and what to keep in mind when changing it. Requires Pi >= 1.2.0. User-facing behavior is in the [README](../README.md); the agent-facing contract is the [skill](../skills/context-management/SKILL.md).

## Model

Compaction folds the history after a target into a handoff summary, **inside the agent run, at the end of the step that requested it**:

- One `custom_message` of type `pi-context-compaction` carries the summary, the outputs of other tool calls in the same step, and a `details.range` rule. It is model-visible and shown in the transcript (rendered as a one-line "Context compacted" title; the tool-output expand key shows the full content). No per-entry `context_edit` records are emitted.
- The `context` event filters messages covered by ancestor range rules before each model request. Raw history is never deleted or rewritten; it stays in the session file, the transcript, and exports.
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
│    · plan: one summary message with retained outputs and details.range,
│      optional backup label → return { entries, continue: true }
│
├─ Pi commits the summary; steering is drained after it
└─ next request is rebuilt; the context event applies ancestor range rules
```

`agent_end` is only a safety net: a request that never reached its `turn_end` is dropped with a `nextTurn` notice.

## Why `turn_end`

Pi's actionable `turn_end` boundary (Pi >= 0.87) runs after every tool result of the step is persisted and **before** steering is drained or the next request is built. Handlers can return `custom_message` drafts and `continue: true`. That makes the step complete and closed:

- No sibling result can arrive later, so nothing needs to be verified after the fact.
- User input sent meanwhile is queued and lands after the summary instead of racing it.
- Pi rebuilds requests from `buildSessionProjection()` and then runs the `context` event. The range filter takes effect there without touching agent state.

Folding cannot happen in `execute()`: sibling calls may still be running, and hiding the request message before their results land would orphan them.

## Target rules

Validated in `execute()` and re-checked when planning:

1. The target exists (`was not found` otherwise — models do invent targets such as `current`).
2. It is on the active path, strictly before the requesting assistant message.
3. It is in the current model context:
   - **folded by an earlier compaction** → rejected. Folding after it would also hide the summary that covers it.
   - **before Pi's native compaction kept range** → rejected. Its original prefix is no longer present in Pi's current context, so "keep everything up to the target" cannot be honored. A later checkpoint or `root` works.
4. `root` means the start of the current context. After a native compaction, Pi's summary stays visible.

Planning uses **context order** (the filtered projection), not raw path order: after a native compaction the summary leads the context while its raw entry sits later in the path. The saved rule uses active-path entry IDs; non-foldable entries, including the native summary, remain visible.

Timeline marks both kinds of unusable targets the same way (`compacted: not a compact target`; root is never marked) so agents can avoid them up front. Error messages also use one wording ("inside history that was already compacted") for both, because the remedy is the same.

### Checkpoint names

Targets resolve checkpoint names before entry IDs, so a hex-like name such as `abcdef12` still names its checkpoint. Pi stores one label per entry but does not keep labels unique (users can label in `/tree`), so a duplicated name resolves to the newest match on the active path, then to any other branch.

`context_checkpoint` and `backupCheckpoint` share one name check: non-empty, not `root`, not an existing entry ID, and not an existing checkpoint. `backupCheckpoint` is checked in `execute()` so the label at `turn_end` cannot fail or duplicate a name after folding; a sibling `context_checkpoint` in the same step cannot take the pending backup name. `context_checkpoint` also refuses to label an entry that already carries a checkpoint, because relabeling would silently remove the old one.

## Wording for users and models

The in-run design changed the implementation, not how the tools are used. Model- and user-facing text (tool and parameter descriptions, results, notices, the summary message, README, skill) keeps the 2.3 wording; it was only corrected where it described branching, and extended for genuinely new behavior (the "already compacted" target marker and errors). Do not rewrite it around a particular use case or the new mechanics.

Implementation terms stay in code comments, this document, and AGENTS.md: step, turn_end, boundary, fold, omit, range rule, projection, active path, native compaction. When adding text, decide which audience reads it first.

## What gets folded and kept

| Entry | Handling |
|---|---|
| Editable model-visible entries after the target (user, assistant, toolResult, custom_message) | Hidden by the saved range rule |
| The requesting message and its results | Omitted together, so calls and results stay paired |
| Results answering calls of the last assistant message at or before the target | Kept, otherwise the target's tool calls would be orphaned |
| System loadout, user `!` bash output, branch summaries, native compaction | Kept to preserve required state and existing behavior |
| Custom state (`codemode-store`, labels, other extensions' entries) | Untouched; it stays on the path, so no merging is needed |
| Same-step tool outputs | Copied into the summary message, labeled with tool name and arguments (codemode: output only, not script source), including errors |
| Same-step context tool output (`context_*`, or a script whose recorded calls were all context tools) | Not kept: it describes pre-fold state |

Never duplicate billable assistant or tool-result messages; copied output lives only in the custom message.

## Saved ranges and request filtering

Each new summary stores one compact rule, with no persisted list of hidden entry IDs:

```ts
details.range: {
    afterId: string | null;       // exclusive; null for root
    throughId: string;           // inclusive; leaf before the summary is committed
    keepToolResultsOf?: string;  // retained assistant whose tool results stay visible
}
```

`getCompactionHiddenIds()` reconstructs hidden IDs from all range-bearing summaries on the active ancestor path. Only foldable message/custom-message entries inside valid ranges are hidden. Each range preserves results belonging to its retained assistant; another overlapping range can still hide those results. The combined rules therefore preserve each range's exemptions without making them global exemptions.

Range rules are read from raw ancestors, including summaries hidden by later ranges or summarized by Pi's native compaction. Their effects survive session reload and native summarization. Branching naturally selects only the rules on the new active path; navigating before a range summary removes that rule's effect.

`getCompactionProjection()` applies these rules on top of Pi's session projection and is shared by target validation, timeline markers, and the `/context` dashboard. The extension writes no `context_edit` records; Pi's own (such as recovery omissions) still apply through its projection. The `context` event filters the actual request messages, matching them to projected source messages. Native preparation can match original message references; cloned request messages reserve exact matches before a unique unmatched pair can be treated as a content transform. This prevents an injected message with a colliding timestamp from stealing an original's match. Ambiguous unmatched additions are kept because the event API does not expose source-entry IDs.

## Native compaction integration

The `session_before_compact` handler filters `preparation.messagesToSummarize` and `preparation.turnPrefixMessages` with the same range rules, then rebuilds `preparation.fileOps` from the retained messages (including recorded nested tool calls). It carries forward cumulative read/modified paths from the previous default native summary. Pi's default summarizer, prompts, and manual/threshold/overflow compaction flow continue normally; the hook supplies filtered summary input rather than a replacement summary.

This mutates the shared preparation object. That behavior is verified against Pi 1.2.0, but is not an explicitly documented returned hook contract. Keep an integration regression test that observes the default summarizer's input and resulting file metadata, and rerun it when upgrading Pi.

Pi selects native compaction triggers and cut points using its canonical projection before this hook runs. That projection does not apply the extension's range rules, so trigger timing and cut-point selection may still reflect raw history. Filtering the summary input does not establish full parity with the provider-visible request.

## Cancellation

Only these cancel, and each appends a hidden `pi-context` notice and folds nothing:

- More than one compact request in one step (all are cancelled, even if the script catches the error).
- The step was interrupted. An interrupted tool step still reports a completed assistant message, so check `ctx.signal?.aborted`, not only `event.outcome`.
- The target left the model context by the boundary.

Not cancel reasons: queued user input (delivered after the summary), a script that throws after compact (partial output and the error are kept, because executed calls are not undone), additional nested tool or model calls.

## Rejected approaches

- **Abort → wait for idle → branch with `navigateTree` → restart** (pi-context <= 2.3). `navigateTree` is not allowed while streaming, so the run had to stop. The window between the abort and navigation needed an "advancement gate": a growing allow-list of safe entries that cancelled on sibling outputs, unknown entry types, and queued input. The in-run design removes that window entirely.
- **One `context_edit` omission per folded entry.** Every compaction appended a record for each hidden entry, so the session file grew with the amount of history folded (2,000 entries meant 2,000 records). One range rule in the summary's details has a constant size and is reconstructed per request.
- **Treating a native-compacted target as `root`.** It would always succeed, but silently changes what the agent asked for. Rejecting with a clear message was preferred.
- **Cancelling when a script throws after compact.** Executed calls cannot be undone, so keeping the output is more accurate than discarding the fold.

## Known limitations

- The transcript does not jump: folded history stays visible to the user, only the model no longer sees it.
- User `!` bash output and branch summaries inside the folded range stay in context.
- Other context handlers that both rewrite and add messages with colliding provenance can make source matching ambiguous; unknown additions are retained rather than deleting extension state.
- Native compaction trigger timing and cut-point selection can reflect history hidden by range rules; the hook filters the summary inputs only.
- The preparation mutation used by the native hook needs regression coverage across Pi upgrades.
- An unawaited `context_compact` in a script happens to work (registration is synchronous) but is not a supported pattern.

## Compatibility

- Sessions from pi-context <= 2.3 contain `branch_summary` entries and `pi-context-codemode-output` messages. Timeline, `/context`, and the session analyzer still recognize them.
- `/acm` remains as a no-op compatibility command (`/acm <task>` still submits the task).
- The unreleased per-entry `context_edit` implementation is not supported. Pi's projection still applies such records in old development sessions, so their model context is unchanged, but the session analyzer no longer attributes them to a compaction.
- The session analyzer confirms a compaction through the summary's `details.requestEntryId` and reads what it folded from `details.range`.

## Code map

| Concern | Location |
|---|---|
| Request lookup, target resolution | `findCompactRequest`, `findCheckpoint`, `resolveTargetId` in `src/index.ts` |
| Checkpoint and backup name rules | `checkpointNameError` in `src/index.ts` |
| Target in context / folded checks | `locateContextTarget` in `src/index.ts`, `isFoldedEntry` in `src/compaction-context.ts`, using `getCompactionProjection` |
| Saved range reconstruction and shared projection | `getCompactionHiddenIds`, `getCompactionProjection` in `src/compaction-context.ts` |
| Request filtering and usage estimates | `filterCompactionMessages`, `getCompactionContextUsage` in `src/compaction-context.ts` |
| Native summary input and file metadata | `filterNativeCompaction` in `src/compaction-context.ts`; `session_before_compact` handler in `src/index.ts` |
| Fold plan and summary content | `planCompaction`, `isManagementResult` |
| Validation and pending request | `context_compact` `execute()` |
| Boundary, cancellation, backup label | `turn_end` handler |
| Summary rendering | `registerMessageRenderer(CompactionSummaryType, …)` |
| Timeline markers | `registerContextTimeline` in `src/timeline.ts` (`foldedIds`, `summarizedIds`) |
| Editable-entry rule, task message types | `isEditableContextEntry`, `CompactionSummaryType` in `src/utils.ts` |

## Testing changes

- `test/compaction.test.mjs` drives a real `AgentSession` with Pi's faux provider and asserts the provider-visible request. Add a case here first; it is fast and deterministic. Cover repeated/overlapping ranges, session reload, branching, native summarization of older range summaries, and target tool-result preservation.
- Native integration regression coverage must inspect the default summarizer's filtered messages, split-turn prefix, and rebuilt file metadata (including previous cumulative paths), since the shared preparation mutation is verified behavior rather than an explicit returned hook contract.
- `npm run test:scenarios` runs the real-model matrix (direct and parallel calls, codemode `on` / `only` script forms, cancellation, steering, native compaction). Run it after changing the boundary, fold range, or target rules. See [test/test.md](../test/test.md).
- `npm run test:live` covers repeated compaction, resume from a saved session, and late input.
- `npm run test:range` runs longer real-model chains: direct/nested file reads through range and repeated native summaries, native kept boundaries inside hidden history, native summarization of the range-bearing message, saved-session reopenings, actual backup/sibling navigation, constant-size rules over 20/2,000 seeded entries, and threshold-triggered native compaction. Its test-only provider observer inspects the actual summarization context without changing the forwarded request.
