```bash
pi --no-skills --no-extensions --skill ./skills -e ./src/index.ts -e ./src/context.ts
```

```md
Context Tool Test Task
Strictly follow the steps below.
1. Create a checkpoint for the starting point from here.
2. Generate a random number, write it to the file /tmp/pi-context-random, and display it using cat.
3. Compact to the start. The compact summary must not include the value of the random number but must state what the next step is.
4. Find a way to guess the value of the random number without reading the file.
5. Read the file to compare and see if the guess was correct.
6. Output "Success" if the guess is correct; otherwise, output "Failure".
```

## Timeline validation

`npm test` covers checkpoint phase-suffix parsing, timeline structure without compact advice, and interval token estimates (which exclude internal context-management traffic).

## Compaction regression

`npm test` drives a real `AgentSession` with Pi's faux provider (`test/compaction.test.mjs`) and asserts the provider-visible request after compaction: prefix through the target → summary message with retained step outputs, with closed tool-call/result pairs and no rerun. It covers direct siblings, codemode scripts (whole output kept, `codemode-store` state still loadable), steering sent during the compact step (delivered after the summary), duplicate requests, invalid/folded targets, a target assistant's own tool results, repeated compaction to `root`, user interruption, backup-checkpoint recovery, timeline folding, and the summary renderer.

Range regressions verify that compacting 10 or 2,000 historical entries adds only one constant-size summary record, and that saved rules survive reopening without affecting sibling branches. Native-compaction tests exercise manual, threshold, and overflow paths through Pi's default summarizer, checking both summary inputs and file metadata for hidden content. Helper tests cover overlapping ranges, request-message provenance, and cumulative/nested file operations. `live-context-capture.test.mjs` exercises the actual live capture fixture through Node IPC with Pi's RPC stdout guard enabled, without calling a paid model.

For a manual codemode check, enable the built-in codemode extension with `codemode.mode="only"` in isolated settings and explicitly load this checkout's `src/index.ts` (not an older installed copy). In one script, print a tool result, await `context_compact` to an earlier checkpoint, then print another result. Confirm the transcript shows a "Context compacted" message, the model continues without rerunning the script, and can still `load()` stored values.

## Live compaction validation

Run the opt-in real-model test (uses existing Pi authentication and consumes tokens):

```bash
npm run test:live
# Optional model override:
PI_CONTEXT_TEST_MODEL=codex/gpt-5.6-luna npm run test:live
# Models registered by a provider extension (path-delimited list of extensions):
PI_CONTEXT_TEST_MODEL=provider/model PI_CONTEXT_TEST_EXTENSIONS=/path/to/provider-extension.ts npm run test:live
```

Keep machine-specific settings in the gitignored `.pi/live-test.json` instead of the repository; environment variables override it:

```json
{ "model": "provider/model", "extensions": ["~/path/to/provider-extension.ts"] }
```

The default is `codex/gpt-5.6-luna` with low thinking. The runner launches isolated Pi RPC processes using the locally installed Pi package and current source extension; it disables other extensions (except provider extensions passed in `PI_CONTEXT_TEST_EXTENSIONS`), skills, context files, and built-in tools. It does not change global configuration.

Four phases compact to `root` and require the model to continue to an exact marker: first compaction, a second one in the same process, one after restarting with the saved session, and one where a test extension queues a contextual message while the compact step ends (it must appear after the summary). Assertions require no aborted or errored messages, no tool or extension errors, no branch summaries, the summary on the active path and in model context, the folded prompt out of model context, and no orphan tool results.

Session files, raw RPC events, stderr, and per-phase verified results are saved under the temporary artifact directory printed at startup. This exercises real RPC and model behavior, not TUI rendering. It is excluded from `npm test`.

## Live scenario matrix

`npm run test:scenarios` runs every compaction scenario against a real model in isolated Pi RPC processes (same model/extension configuration as `test:live`; costs tokens). Each scenario sets up `start-<id>` → noisy step → `inner-<id>`, then exercises one case and checks the actual model context captured by a test-only `context` handler loaded after pi-context, raw entries, tool executions, and the model's reply. RPC `get_messages` returns canonical history, which intentionally still contains the hidden raw messages; it is not evidence of what a filtered request sends.

| Group | Scenarios |
|---|---|
| Direct tools (no codemode) | compact alone; parallel `bash` + compact (output kept, run once); parallel timeline + checkpoint + compact (management output not kept); two parallel compacts (cancelled); invalid then valid target; backup recovery; steer and follow-up during the compact step (delivered after the summary); user abort (cancelled); folded target rejected then `root` folds the earlier summary; compaction after Pi native compaction |
| `codemode.mode="on"` | codemode sibling + direct compact; compact inside a script with work before/after; direct + script compact in one message (cancelled) |
| `codemode.mode="only"` | compact only; work → compact → work; compact first; `Promise.all([bash, compact])`; `store()` before/after compact still loadable; script throws after compact (partial output kept); second compact caught or `Promise.allSettled` of two (cancelled); unawaited compact; two scripts in one message; printed compact result; invalid compact caught then valid; backup recovery |

```bash
npm run test:scenarios
PI_CONTEXT_SCENARIOS=D2,S4 npm run test:scenarios     # subset
PI_CONTEXT_SCENARIO_CONCURRENCY=4 npm run test:scenarios
```

Concurrency defaults to 1; each Pi process uses about 200 MB. Results, per-scenario RPC events and session files are written to the printed artifact directory. A cancelled step is judged at its own boundary; the model may legitimately retry afterwards. A stalled model stream (rare degenerate output) is aborted and the prompt retried once.

## Live range chains

`npm run test:range` adds real-model chains around the range implementation, using the same private model configuration and RPC harness. The test-only controls fixture is loaded after pi-context: it records filtered native preparation, actual contexts passed to the provider, and native completion. The provider observer forwards the original context/options unchanged and is restored on shutdown; native summaries bypass the ordinary `before_provider_request` event. Assertions check hidden text and paths against positive controls in raw history, preserve visible/shared file tracking, require Pi's default generator, and check tool-call/result pairs.

| Case | Chain |
|---|---|
| R1 | Direct reads → range → native split-turn summary → restart → repeated native summary |
| R2 | Same chain with nested reads through codemode only |
| R3 | 20 synthetic historical entries → real range call → native summary → summarized range rule → restart → root |
| R4 | 2,000 synthetic historical entries → real range call → native kept boundary inside hidden history → summarized range rule → restart → root |
| R5 | Actual tree navigation to backup, a sibling branch, and back to the compacted branch, with real model requests on each |
| R6 | Range → restart → genuine threshold-triggered native summary → continuation |

```bash
npm run test:range
PI_CONTEXT_SCENARIOS=R1,R4 npm run test:range
PI_CONTEXT_SCENARIO_CONCURRENCY=2 npm run test:range
```

R3/R4 seed historical custom messages while Pi is stopped; those entries are fixtures, not thousands of paid model turns. The compact calls, native summaries, reopenings, and continuation requests use the real model. Range metadata size and absence of per-entry edits are checked independently of native-summary text length. The harness waits for native compaction as well as streaming to finish, and disables prompt retries for these chains so a retry cannot hide a failed run. Test artifacts can contain the synthetic secret markers, request contexts, file paths, and timestamps; they stay in the temporary artifact directory.

## Interactive check

```bash
pi --no-skills --no-extensions -e ./src/index.ts -e ./src/context.ts
```

1. Without running `/acm`, ask the agent to checkpoint, do some noisy work, and call `context_compact` together with another tool in one step. Confirm a one-line "Context compacted" message appears (press `ctrl+o` to expand it and see the summary and kept step output) and the agent continues without rerunning the other tool.
2. Type a message while the compact step runs; confirm it is answered after the summary.
3. Run `/context` and `context_timeline`; confirm folded history is excluded from usage and shown as folded.
4. Navigate with `/tree` to the backup checkpoint and confirm the original context is restored.
5. Verify `/acm <task>` still submits the task.
