# PROJECT KNOWLEDGE BASE

**Generated:** 2026-09-20

## OVERVIEW
Project: **pi-context** (v2.3.0)
Stack: TypeScript (ES2022 / Node16, strict, ESM), `@earendil-works/pi-coding-agent` >= 1.2.0, `@earendil-works/pi-ai` Type schemas, `@earendil-works/pi-tui` for the dashboard. Plain Node 22.19+ (Pi's engine requirement) `.mjs` for dev tooling and tests (no extra deps).

An Agentic Context Management extension for the `pi` coding agent. It lets agents structure, inspect, and clean up conversation history via named checkpoints, a structural timeline view, and checkpoint-based compaction — lossless time travel over Pi's session tree.

## STRUCTURE
*   `src/index.ts`: Extension entry. Registers the three agent tools (`context_checkpoint`, `context_timeline`, `context_compact`), the compatibility `/acm` command, the compaction summary renderer, and the in-run compaction on `turn_end`. Owns checkpoint-name rules and target resolution (`findCheckpoint`, `checkpointNameError`, `resolveTargetId`).
*   `src/timeline.ts`: `registerContextTimeline` — the `context_timeline` tool, registered from `index.ts`. Renders parsed checkpoint phases, folded intervals, history folded by compaction, and history summarized by native compaction.
*   `src/compaction-context.ts`: Saved compaction range rules, ancestor-range reconstruction, request filtering, shared `getCompactionProjection` and `isFoldedEntry` for target validation/timeline/dashboard, `CompactionDetails`, context usage estimates, and native summary input/file metadata filtering.
*   `src/context.ts`: `/context` command — TUI overlay dashboard showing token usage per category (rough `ceil(len/4)` estimates scaled to actual usage).
*   `src/utils.ts`: Shared helpers — `formatTokens`, `isContextTool`, `isEditableContextEntry`, message type constants, `formatContextUsage`, `parseCheckpointPhase`, `estimateHistoryTokens`, `describeHistoryInterval`.
*   `docs/compaction.md`: Compaction design for contributors (not published).
*   `skills/context-management/`: The agent-facing skill. `SKILL.md` teaches the checkpoint → timeline → compact rhythm, the `<scope>-<phase>` naming convention, and the compact gate; `references/` holds per-scenario guidance.
*   `tools/session-analysis/`: Repo-local offline analyzer for saved session JSONL snapshots (library `analyze-session.mjs`, CLI `session-analysis-cli.mjs`, report template `session-chart.html`). Emits interactive HTML + JSON/CSV. Not published.
*   `test/`: `node --test` unit and end-to-end tests (`*.test.mjs`; `compaction.test.mjs` drives a real `AgentSession` with Pi's faux provider), live-model tests (`live-compaction.mjs`, scenario matrix `live-scenarios.mjs`, shared RPC harness `live-rpc.mjs`; machine-specific model/extension settings in gitignored `.pi/live-test.json`), test fixtures (`*.ts` extensions), and manual scenarios (`test.md`).
*   `evals/`: Python skill-behavior eval harness (`run_context_eval.py`, `run_context_multi_turn_eval.py`), eval set definitions + notes, and historical `run-*` outputs (gitignored).

## COMMANDS
| Action | Command |
|--------|---------|
| Install | `npm install` |
| Typecheck | `npm run typecheck` |
| Test | `npm test` = typecheck + `tsc` emit to `dist/` + `node --test test/*.test.mjs` |
| Live test | `npm run test:live` (opt-in: real model, uses Pi auth, costs tokens) |
| Live scenarios | `npm run test:scenarios` (opt-in matrix: direct/parallel calls, codemode `on`/`only` script forms, cancel cases; costs tokens) |
| Live range chains | `npm run test:range` (opt-in: real native summaries, saved-session restarts, tree navigation, synthetic long-history seeds, automatic threshold; costs tokens) |
| Analyze session | `npm run analyze:session -- <session.jsonl> [--out dir]` (repo checkout only; default output `.pi/session-analysis/` is gitignored) |
| Run locally | `pi --no-skills --no-extensions -e ./src/index.ts -e ./src/context.ts --skill ./skills` |
| Skill evals | `python evals/run_context_eval.py <set\|all>`; `python evals/run_context_multi_turn_eval.py <with-skill\|both>` |

## CODING STANDARDS
*   **Language**: TypeScript ESM (`"type": "module"`); Node16 resolution means local imports carry `.js` extensions (`./utils.js`).
*   **Style**: Extension modules are `export default function (pi: ExtensionAPI)`. Tool schemas use `Type.Object` from `pi-ai`. Iterative DFS (not recursion) for session-tree walks.
*   **Rules**: `strict: true`. Use the read-only `ctx.sessionManager` type (`ExtensionContext["sessionManager"]`) instead of casting to `SessionManager`; define SDK types locally only when the main entry does not export them. No linter/formatter config — match existing style.
*   **Tests**: `.mjs` files using `node:test` + `node:assert`; they import the **compiled** `dist/` output, so run `npm test` (which recompiles) rather than `node --test` on a stale `dist`.

## WHERE TO LOOK
*   **Source**: `src/`
*   **Compaction design**: `docs/compaction.md` — in-run `turn_end` flow, saved range rules, shared projection, native summary filtering and its integration limits, target rules, fold/keep table, cancellation, rejected approaches, known limitations. Read it before changing `context_compact`, the boundary/context/native hooks, or timeline target markers.
*   **Tests**: `test/` (unit: `*.test.mjs`; manual/live scenarios: `test.md`)
*   **Skill**: `skills/context-management/SKILL.md` — the contract for when agents checkpoint, inspect, and compact. `references/` for scenario-specific guidance.
*   **Session analysis**: `tools/session-analysis/README.md` — report views, CLI options, measurement/simulation limits, privacy rules. Read it before changing analyzer behavior or interpreting output.
*   **Evals**: `evals/README.md` — eval set purposes, run matrix, scoring dimensions.

## NOTES
*   **Architecture**: The extension operates on `SessionManager`'s entry tree: `pi.setLabel` for checkpoints, and one summary `custom_message` (`pi-context-compaction`) with `details.range: { afterId: string | null, throughId: string, keepToolResultsOf?: string }` per compaction; the extension writes no `context_edit` records. The `context` event reconstructs the union of active ancestor range rules and filters only foldable message/custom-message entries; rules remain effective after native summarization or later ranges hide their summary. `getCompactionProjection` shares the same rules across target validation, timeline, and dashboard; Pi's projection still applies Pi's own `context_edit` records (such as recovery omissions). Compaction never branches or navigates; raw history stays on disk, and later navigation/branching naturally selects the rules on the active path.
*   **Checkpoint Naming**: The skill documents `<scope>-<phase>` suffixes (`start/done/pivot/pause/resume`) as an agent-facing convention; the extension only parses the suffix for timeline display and does not track phase state. Timeline interval estimates use Pi's token heuristic over historical content (excluding internal context-management traffic), describe what was folded, and are not reclaimable tokens; never recommend the nearest checkpoint as a compact target.
*   **Native Compaction**: `session_before_compact` filters `preparation.messagesToSummarize` and `turnPrefixMessages`, then rebuilds `fileOps` from retained calls plus previous native cumulative read/modified paths. Pi's default summarizer, prompts, and manual/threshold/overflow flow continue. Mutating the shared preparation object is verified on Pi 1.2.0 but is not an explicitly documented returned hook contract: retain integration regression coverage and rerun it on Pi upgrades. Native trigger timing and cut-point selection use Pi's canonical projection before the hook and may still reflect raw history; do not claim full parity with filtered requests.
*   **Compaction invariants** (details in `docs/compaction.md`): wait for all results at the requesting step's `turn_end`, validate/cancel, optionally label, and commit one range-bearing summary with `continue: true`, never branch/navigate/abort; the target must be on the active path before the request and still in model context (reject folded or native-summarized targets; `root` = start of current context, saved as `afterId: null`); plan in context order and save an exclusive `afterId` / inclusive `throughId` range; hide the request with its results so pairs stay closed; keep the target's own tool results via `keepToolResultsOf`; copy same-step non-management outputs into the summary, never duplicate billable messages; cancel only for duplicate requests in one step, an interrupted step (`ctx.signal.aborted`), or a target that left context; queued input is never a cancel reason. The redesign changed implementation, not usage: model/user-facing text keeps the 2.3 wording (corrected only where it said "branch"), and never uses implementation terms (step, boundary, fold, range rule, `context_edit`, projection, native compaction).
*   **Publishing**: `files` = `src`, `skills`, `README.md`. Source-first: Pi loads the `.ts` extensions directly; `dist/` is only for unit tests. `docs/`, `tools/`, `test/`, `evals/` are development-only.
*   **Skill authoring**: Keep `skills/**` examples generic — no task-specific data, private session details, or one-off IDs. The skill's prompting principle is proportionality: checkpoint before noisy work, timeline when orientation matters, compact only when a known continuation benefits after recovery cost. Never encourage compact after final answers.
*   **Evals side effect**: The Python eval runners temporarily remove installed `pi-context` from `~/.pi/agent/settings.json` while running — don't run them concurrently with real Pi sessions you care about.
*   **Privacy**: The session analyzer exports no message/command/result bodies, but filenames, checkpoint names, and timestamps may still be sensitive; default output goes to gitignored `.pi/`.
