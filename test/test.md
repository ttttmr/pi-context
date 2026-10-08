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

## Codemode regression

`npm test` covers parent-call anchoring, opaque parent IDs, mixed codemode scripts, whole-output retention before the summary (including text/images), original-history recovery, store state, unchanged billing, long summaries and truncated nested records. It also covers cancellation for failed scripts, missing/ambiguous/mismatched compact results, duplicate compacts, parallel outer calls, invalid targets, contextual advancement, queued input, and declined navigation.

For a live check on Pi >= 0.99.0, enable the built-in codemode extension with `codemode.mode="only"` in isolated settings and explicitly load this checkout's `src/index.ts` (not an older installed copy). Print a tool result, await `context_compact` to an earlier checkpoint, then print another result. Confirm the model sees prefix → full script output → summary, continues without rerunning the script, and can still `load()` stored values. Repeat with classifier/image calls and an omitted long-summary argument. A thrown script error, a second compact request, or a new contextual message must cancel without switching the active path.

## Live command-context validation

Run the opt-in real-model test (uses existing Pi authentication and consumes tokens):

```bash
npm run test:live
# Optional model override:
PI_CONTEXT_TEST_MODEL=openai-codex/gpt-5.6-luna npm run test:live
```

The default is `openai-codex/gpt-5.6-luna` with low thinking. The runner launches isolated Pi RPC processes using the locally installed Pi package and current source extension; it disables other extensions, skills, context files, and built-in tools. It does not change global configuration.

Four phases check first-time acquisition, reuse in the same process, reacquisition after restarting with the saved session, and cancellation when a contextual message is flushed after `turn_end` but before `agent_end`. A passive test probe records actual `/acm` handler invocations without replacing command context or navigation. Assertions check summary ancestry, exact model continuation, dispatch counts, absence of orphan tool results, and absence of internal commands in user history or editor mutations. The cancellation phase must create no summary branch and retain the late contextual message on the active path. Advancement is measured from the assistant message containing the compact call; passive entries, that call's successful tool result, and an empty abort boundary do not cancel compaction.

Session files, raw RPC events, stderr, and per-phase verified results are saved under the temporary artifact directory printed at startup. The existing deliberate abort boundary may appear as an empty Codex `This operation was aborted` error before continuation; errors after continuation remain failures. This exercises real RPC and model behavior, not TUI rendering. It is excluded from `npm test`.

## Compaction advancement regression

Launch Pi with the passive-entry fixture:

```bash
pi --no-skills --no-extensions -e ./src/index.ts -e ./src/context.ts -e ./test/passive-custom-extension.ts
```

1. Without running `/acm`, ask the agent to checkpoint, inspect the timeline, and call `context_compact`. Confirm automatic command-context acquisition succeeds without changing the editor or injecting `/acm` into model history.
2. Confirm that label, session-info, and non-contextual custom entries appended while `waitForIdle()` settles do not cancel compaction.
3. Repeat while submitting a real user steering message before compaction settles; confirm that any message entry cancels compaction exactly once and creates no summary branch.
4. Confirm that the next model request contains no orphaned tool result.
5. Resume the session in a new process or run `/reload`, then compact again without manual enablement.
6. Verify `/acm <task>` still submits the task and manual `/acm` remains usable.
